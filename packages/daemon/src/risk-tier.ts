// The only boundary between a coordinator model and a worker's permission request (docs/spec.md "Permission tiers"): a
// coordinator may settle a `low` request, every other request is the user's. Unknown -> high. Any error -> high.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitReadOnly, repoSafety, repoSafetyAsync, type RepoSafety } from "./git-readonly.ts";

export type Tier = "low" | "high";
export type TierContext = {
  cwd: string;
  blockedPath?: string;
  defaultToNo?: boolean;
  requiresUserInteraction?: boolean;
  /** The CLI runs with CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1: every Bash command starts in `cwd`, so a read-only git command is judged by it. */
  bashCwdPinned?: boolean;
  /** The repository facts for this decision (repoSafetyAsync, via tierAsync). Absent: read synchronously (tests, direct calls). */
  safety?: RepoSafety;
  /** tierAsync: share a repository scan in flight only if it started after this (performance.now()). */
  since?: number;
};

/** Read-only tools and the input field holding their path (absent field = the cwd for Glob; Grep needs one). */
const READ_FIELD: Record<string, string> = { Read: "file_path", NotebookRead: "notebook_path", LS: "path", Glob: "path", Grep: "path" };
const WRITE_FIELD: Record<string, string> = { Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };
/** Agent config, git internals (hooks, core.fsmonitor), editor tasks, secrets: high at any depth, any case. */
const DENY_DIRS = new Set([".git", ".claude", ".vscode", ".idea"]);
// HEAD, packed-refs, commondir, gitdir: git repo control files; with objects/ and refs/ they make a folder a repo for a later git command.
const DENY_NAMES = new Set([".mcp.json", "claude.md", "claude.local.md", "agents.md", ".envrc", ".npmrc", "head", "packed-refs", "commondir", "gitdir", "token", "vapid.json", "push-subscriptions.json"]);
// token, vapid.json, push-subscriptions.json: the daemon config folder (a test daemon with XDG_CONFIG_HOME in a scratch folder): its token controls the daemon, and WebSearch (low) could carry a read secret out.
const GIT_LAYOUT = new Set(["head", "packed-refs", "commondir", "gitdir"]);
/** Agent docs: readable although `.claude` and `claude.md` / `agents.md` are denied (reads only, GH-163). */
const AGENT_DOCS = new Set(["claude.md", "agents.md"]);
/** Windows/macOS aliasing: NTFS streams (a:b), 8.3 names (PROGRA~1), trailing dot or space, HFS+ ignorable code points. */
const aliased = (seg: string) => /[:~]|[. ]$|\p{Default_Ignorable_Code_Point}/u.test(seg.toLowerCase());
/** The name rules without the aliasing ones. */
export const deniedName = (seg: string, revision = false) => {
  const s = seg.toLowerCase();
  // `revision`: a git revision token, where HEAD is the usual name (those four names matter for writes: a bare repo layout).
  return DENY_DIRS.has(s) || (DENY_NAMES.has(s) && !(revision && GIT_LAYOUT.has(s))) || s.startsWith(".env") || s.endsWith(".pem") || s.endsWith(".key");
};
const denied = (seg: string) => deniedName(seg) || aliased(seg);
/**
 * Reads: `.claude/skills/**` below a root (those first two segments) and CLAUDE.md / AGENTS.md as the last segment are agent
 * docs; every other segment, and the aliasing rules for every segment, hold as for writes. `nameOnly`: skip the aliasing
 * rules (a git revision such as HEAD~1 is not a path).
 */
export function deniedRead(segs: string[], nameOnly = false): boolean {
  const skills = segs[0]?.toLowerCase() === ".claude" && segs[1]?.toLowerCase() === "skills";
  return segs.some((seg, i) => {
    const exempt = (skills && i < 2) || (i === segs.length - 1 && AGENT_DOCS.has(seg.toLowerCase()));
    return exempt ? !nameOnly && aliased(seg) : nameOnly ? deniedName(seg, true) : denied(seg);
  });
}

/**
 * `<main>` when the real cwd is `<main>/.claude/worktrees/<name>`, `<main>/.git` is a directory and the cwd's `.git` file points
 * into `<main>/.git/worktrees/` (the layout the daemon creates). The `.git` file is not low-writable, so a worker cannot forge it.
 * Any throw is the caller's: tier() turns it into high.
 */
export function mainCheckoutOf(cwd: string): string | undefined {
  const real = realpathSync(cwd);
  const wt = dirname(real);
  if (basename(wt).toLowerCase() !== "worktrees" || basename(dirname(wt)).toLowerCase() !== ".claude") return;
  const main = dirname(dirname(wt));
  if (!lstatSync(join(main, ".git"), { throwIfNoEntry: false })?.isDirectory()) return;
  const dotGit = lstatSync(join(real, ".git"), { throwIfNoEntry: false });
  if (!dotGit?.isFile() || dotGit.size > 4096) return;
  const m = /^gitdir: (.+?)\s*$/m.exec(readFileSync(join(real, ".git"), "utf8"));
  if (!m) return;
  const rel = relative(realpathSync(join(main, ".git", "worktrees")), realpathSync(resolve(real, m[1]!)));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep) ? main : undefined;
}
const dotdot = (p: string) => p.split(/[/\\]/).includes("..");

/**
 * Inside the real cwd (symlinks resolved, a missing tail resolved through its nearest existing ancestor) and not denied.
 * ponytail: checked at settle time, the CLI writes later; a path swapped to a symlink in between escapes (TOCTOU). Closing it
 * needs the write itself to go through the daemon. `cwdOk`: the cwd itself passes (a read; not a write, not a Grep of every file).
 * A `~` path is never expanded here: its first segment holds `~`, which the deny rule refuses.
 */
export function pathLow(p: unknown, cwd: string, write: boolean, cwdOk = !write, roots: string[] = [cwd], safety?: RepoSafety): boolean {
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
  // Reads may lie in more than one root (the cwd, then the main checkout); the first root that holds the path decides. Writes: the cwd.
  for (const root of write ? [cwd] : roots) {
    const realRoot = realpathSync(root);
    const rel = relative(realRoot, real);
    if (rel === "") return cwdOk;
    if (rel.split(sep)[0] === ".." || isAbsolute(rel)) continue;
    // Both the real path and the path as written (a symlinked `.git` inside the root): either denied = high.
    const raw = relative(root, target);
    const rawSegs = raw.startsWith("..") || isAbsolute(raw) ? [] : raw.split(sep);
    const segs0 = rel.split(sep);
    if (write ? [...rel.split(sep), ...rawSegs].some(denied) : deniedRead(rel.split(sep)) || (rawSegs.length > 0 && deniedRead(rawSegs))) return false;
    if (!write) return !(isDir(real) && treeHasDenied(real));
    // A repo layout: `config` next to HEAD, objects or refs, or objects/refs next to a `config` (in either order the config
    // would be repo config: core.fsmonitor, diff.external run on a later git command the user approves).
    // Git's control files and hook folders by name, at any depth (a submodule's `sub/.husky/_` too); then no Write is low in a
    // repository that is not plain (hooks, programs or includes in its config, submodules, nested repositories, unreadable), nor into what its config names.
    if ([...segs0, ...rawSegs].some(gitControl) || gitRunsIt(real, cwd, safety)) return false;
    const has = (dir: string, n: string) => !!lstatSync(join(dir, n), { throwIfNoEntry: false });
    const segs = segs0;
    for (let i = 0; i < segs.length; i++) {
      const dir = join(realRoot, ...segs.slice(0, i));
      const seg = segs[i]!.toLowerCase();
      if (seg === "config" && i === segs.length - 1 && ["HEAD", "objects", "refs"].some((n) => has(dir, n))) return false;
      if ((seg === "objects" || seg === "refs") && has(dir, "config")) return false;
    }
    // A hard link shares its content with a file that may be outside the cwd.
    return !(!rest.length && lstatSync(real).nlink > 1);
  }
  return false;
}

const isDir = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
const TREE_LIMIT = 3000;
/** Whether the folder holds (below it) an entry on the deny list, or too many to look: a Grep of it would read those files. */
function treeHasDenied(dir: string): boolean {
  let seen = 0;
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (++seen > TREE_LIMIT || deniedName(e.name, true) && !AGENT_DOCS.has(e.name.toLowerCase())) return true;
      if (e.isDirectory() && walk(join(d, e.name))) return true;
    }
    return false;
  };
  return walk(dir);
}
/**
 * Git's own control files and hook folders, by name at any depth: .gitmodules, .gitattributes, .gitconfig, .gitignore, .githooks*,
 * .husky*, hooks, .lfsconfig. `.github` and `.gitlab*` hold CI files, not git's: a push (high) is what runs them.
 */
const gitControl = (seg: string) => {
  const g = seg.toLowerCase();
  return g === "hooks" || g.startsWith(".husky") || g === ".lfsconfig" || (g.startsWith(".git") && g !== ".github" && !g.startsWith(".gitlab"));
};
/** Whether a Write must be high because git could run it: the repository is not plain (repoSafety), or its config names the path. */
function gitRunsIt(real: string, cwd: string, safety?: RepoSafety): boolean {
  const s = safety ?? repoSafety(cwd);
  return (
    s.unsafe ||
    s.protectedPaths.some((d) => {
      const rel = relative(d, real);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    })
  );
}

/** A glob relative to the cwd: no absolute start, no `..`, no `~`. */
const globLow = (g: unknown) => g === undefined || (typeof g === "string" && !!g && !isAbsolute(g) && !/^([\\/]|[A-Za-z]:)/.test(g) && !dotdot(g) && !g.startsWith("~"));

function classify(tool: string, input: Record<string, unknown>, ctx: TierContext): Tier {
  if (ctx.blockedPath || ctx.defaultToNo === true || ctx.requiresUserInteraction === true) return "high";
  if (tool === "TodoWrite" || tool === "WebSearch") return "low";
  if (Object.hasOwn(READ_FIELD, tool)) {
    const p = input[READ_FIELD[tool]!];
    const main = mainCheckoutOf(ctx.cwd);
    // Grep reads file contents: a search of the whole root may hit `.env` and other denied files, so it names a path below it.
    const pathOk = tool === "Glob" && p === undefined ? true : pathLow(p, ctx.cwd, false, tool !== "Grep", main ? [ctx.cwd, main] : [ctx.cwd]);
    const globOk =
      tool === "Glob" ? input.pattern !== undefined && globLow(input.pattern) : tool === "Grep" ? input.glob === undefined || (globLow(input.glob) && !(input.glob as string).split(/[/\\]/).some(denied)) : true;
    return pathOk && globOk ? "low" : "high";
  }
  if (Object.hasOwn(WRITE_FIELD, tool)) return pathLow(input[WRITE_FIELD[tool]!], ctx.cwd, true, false, [ctx.cwd], ctx.safety) ? "low" : "high";
  // Bash: only a read-only git command, and only when the CLI's shell cwd is pinned to the cwd (git-readonly.ts). Every other
  // command can run code the worker wrote. mcp__*, ExitPlanMode, Agent, WebFetch, Skill and every unknown name: high.
  if (tool === "Bash") return ctx.bashCwdPinned === true && gitReadOnly(input, ctx.cwd, ctx.safety) ? "low" : "high";
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

/**
 * tier() with the repository facts read off the event loop (repoSafetyAsync) when the tool needs them (a write, a pinned Bash).
 * Never rejects: any error is high. What the daemon calls; tier() with `ctx.safety` then decides synchronously.
 */
export async function tierAsync(tool: string, input: unknown, ctx: TierContext): Promise<Tier> {
  try {
    const needs = Object.hasOwn(WRITE_FIELD, tool) || (tool === "Bash" && ctx.bashCwdPinned === true);
    const safety = needs && !ctx.safety ? await repoSafetyAsync(ctx.cwd, ctx.since) : ctx.safety;
    return tier(tool, input, { ...ctx, ...(safety ? { safety } : {}) });
  } catch {
    return "high";
  }
}
