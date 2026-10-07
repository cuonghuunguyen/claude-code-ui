// The only boundary between a coordinator model and a worker's permission request (docs/spec.md "Permission tiers"): a
// coordinator may settle a `low` request, every other request is the user's. Unknown -> high. Any error -> high.
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Tier = "low" | "high";
export type TierContext = { cwd: string; blockedPath?: string; defaultToNo?: boolean; requiresUserInteraction?: boolean };

/** Read-only tools and the input field holding their path (absent field = the cwd for Glob; Grep needs one). */
const READ_FIELD: Record<string, string> = { Read: "file_path", NotebookRead: "notebook_path", LS: "path", Glob: "path", Grep: "path" };
const WRITE_FIELD: Record<string, string> = { Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };
/** Agent config, git internals (hooks, core.fsmonitor), editor tasks, secrets: high at any depth, any case. */
const DENY_DIRS = new Set([".git", ".claude", ".vscode", ".idea"]);
// HEAD, packed-refs, commondir, gitdir: git repo control files; with objects/ and refs/ they make a folder a repo for a later git command.
const DENY_NAMES = new Set([".mcp.json", "claude.md", "claude.local.md", "agents.md", ".envrc", ".npmrc", "head", "packed-refs", "commondir", "gitdir"]);
const denied = (seg: string) => {
  const s = seg.toLowerCase();
  return DENY_DIRS.has(s) || DENY_NAMES.has(s) || s.startsWith(".env") || s.endsWith(".pem") || s.endsWith(".key")
    // Windows/macOS aliasing: NTFS streams (a:b), 8.3 names (PROGRA~1), trailing dot or space, HFS+ ignorable code points.
    || /[:~]|[. ]$|\p{Default_Ignorable_Code_Point}/u.test(s);
};
const dotdot = (p: string) => p.split(/[/\\]/).includes("..");

/**
 * Inside the real cwd (symlinks resolved, a missing tail resolved through its nearest existing ancestor) and not denied.
 * ponytail: checked at settle time, the CLI writes later; a path swapped to a symlink in between escapes (TOCTOU). Closing it
 * needs the write itself to go through the daemon. `cwdOk`: the cwd itself passes (a read; not a write, not a Grep of every file).
 * A `~` path is never expanded here: its first segment holds `~`, which the deny rule refuses.
 */
function pathLow(p: unknown, cwd: string, write: boolean, cwdOk = !write): boolean {
  if (typeof p !== "string" || !p || p.includes("\0") || dotdot(p)) return false;
  const target = resolve(cwd, p);
  let base = target;
  const rest: string[] = [];
  while (!lstatSync(base, { throwIfNoEntry: false })) {
    rest.unshift(basename(base));
    if (dirname(base) === base) return false;
    base = dirname(base);
  }
  // Throws on a dangling symlink: caught by tier() -> high.
  const real = join(realpathSync(base), ...rest);
  const rel = relative(realpathSync(cwd), real);
  if (rel === "") return cwdOk;
  if (rel.split(sep)[0] === ".." || isAbsolute(rel)) return false;
  // Both the real path and the path as written (a symlinked `.git` inside the cwd): either denied = high.
  const raw = relative(cwd, target);
  if ([...rel.split(sep), ...(raw.startsWith("..") ? [] : raw.split(sep))].some(denied)) return false;
  if (!write) return true;
  // A repo layout: `config` next to HEAD, objects or refs, or objects/refs next to a `config` (in either order the config
  // would be repo config: core.fsmonitor, diff.external run on a later git command the user approves).
  const has = (dir: string, n: string) => !!lstatSync(join(dir, n), { throwIfNoEntry: false });
  const segs = rel.split(sep);
  const realCwd = realpathSync(cwd);
  for (let i = 0; i < segs.length; i++) {
    const dir = join(realCwd, ...segs.slice(0, i));
    const seg = segs[i]!.toLowerCase();
    if (seg === "config" && i === segs.length - 1 && ["HEAD", "objects", "refs"].some((n) => has(dir, n))) return false;
    if ((seg === "objects" || seg === "refs") && has(dir, "config")) return false;
  }
  // A hard link shares its content with a file that may be outside the cwd.
  return !(!rest.length && lstatSync(real).nlink > 1);
}

/** A glob relative to the cwd: no absolute start, no `..`, no `~`. */
const globLow = (g: unknown) => g === undefined || (typeof g === "string" && !!g && !isAbsolute(g) && !/^([\\/]|[A-Za-z]:)/.test(g) && !dotdot(g) && !g.startsWith("~"));

function classify(tool: string, input: Record<string, unknown>, ctx: TierContext): Tier {
  if (ctx.blockedPath || ctx.defaultToNo === true || ctx.requiresUserInteraction === true) return "high";
  if (tool === "TodoWrite" || tool === "WebSearch") return "low";
  if (Object.hasOwn(READ_FIELD, tool)) {
    const p = input[READ_FIELD[tool]!];
    // Grep reads file contents: a search of the whole cwd may hit `.env` and other denied files, so it names a path below the cwd.
    const pathOk = tool === "Glob" && p === undefined ? true : pathLow(p, ctx.cwd, false, tool !== "Grep");
    const globOk =
      tool === "Glob" ? input.pattern !== undefined && globLow(input.pattern) : tool === "Grep" ? input.glob === undefined || (globLow(input.glob) && !(input.glob as string).split(/[/\\]/).some(denied)) : true;
    return pathOk && globOk ? "low" : "high";
  }
  if (Object.hasOwn(WRITE_FIELD, tool)) return pathLow(input[WRITE_FIELD[tool]!], ctx.cwd, true) ? "low" : "high";
  // Bash (every command: a low Write can build a git repo layout whose config runs code on `git status`), mcp__*, ExitPlanMode,
  // Agent, WebFetch, Skill and every unknown name.
  return "high";
}

export function tier(tool: string, input: unknown, ctx: TierContext): Tier {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return "high";
    return classify(tool, input as Record<string, unknown>, ctx);
  } catch {
    return "high";
  }
}
