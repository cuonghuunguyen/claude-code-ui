// Whether a Bash tool call is only read-only git (docs/spec.md "Permission tiers"): the one Bash shape a coordinator may settle.
// An allowlist grammar: one fixed program (git), no quoting, no expansion, no redirection, exact option names. Any doubt = false.
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { deniedRead, pathLow } from "./risk-tier.ts";

/** One option: `value` absent = takes none; else the value must match (when `optional`, the bare option is fine too). */
type Opt = { value: RegExp; optional: boolean } | undefined;
const FLAG: Opt = undefined;
const val = (value: RegExp, optional = false): Opt => ({ value, optional });
const N = /^\d{1,6}$/;
/** A value of `--author=`, `--since=` ...: no space, no `{}`, no leading or inner `~`, no `$ ' " \ * ? [ ]` (the command charset already refuses those). */
const FREE = /^[A-Za-z0-9._/@^:=,+%-]{1,200}$/;
/** `--format` / `--pretty`: `%G...` placeholders run gpg. */
const FORMAT = /^(?!.*%G)[A-Za-z0-9._/@^:=,+%-]{1,200}$/;
const words = (...v: string[]) => new RegExp(`^(?:${v.join("|")})$`);

const entries = (names: string[], o: Opt): [string, Opt][] => names.map((n) => [n, o]);

/** git status. Exact names: git's own abbreviations (`--out` for `--output`) are never reached. */
export const STATUS: Record<string, Opt> = Object.fromEntries([
  ...entries(["-s", "--short", "-b", "--branch", "--long", "-u", "-uno", "-unormal", "-uall", "--no-renames", "--ahead-behind", "--no-ahead-behind", "--show-stash", "-z"], FLAG),
  ["--porcelain", val(words("v1", "v2"), true)],
  ["--untracked-files", val(words("no", "normal", "all"), true)],
  ["--ignored", val(words("traditional", "matching", "no"), true)],
]);

/** diff, log, show. Not listed on purpose: --output, --ext-diff, --textconv, --no-index, --show-signature, -O, --stdin, --remerge-diff, --exec, -L, -G, -S. */
export const DIFF: Record<string, Opt> = Object.fromEntries([
  ...entries(
    ["-p", "-u", "--patch", "--no-patch", "-s", "--raw", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--compact-summary", "--no-color", "-w", "-b", "--ignore-all-space", "--ignore-space-change", "--ignore-blank-lines", "--full-index", "--relative", "--no-relative", "--check", "--minimal", "--patience", "--histogram", "-a", "--text", "--no-ext-diff", "--no-textconv", "-z", "--no-renames"],
    FLAG,
  ),
  ["--stat", val(/^\d{1,4}(,\d{1,4}){0,2}$/, true)],
  ["--color", val(words("never", "always", "auto"), true)],
  ["--word-diff", val(words("plain", "color", "porcelain", "none"), true)],
  ["--find-renames", val(/^\d{1,3}%?$/, true)],
  ["--diff-filter", val(/^[ACDMRTUXBacdmrtuxb]+$/)],
  ["--unified", val(N)],
  ["--abbrev", val(N, true)],
]);

export const LOG: Record<string, Opt> = Object.fromEntries([
  ...entries(
    ["--oneline", "--graph", "--no-decorate", "--abbrev-commit", "--no-abbrev-commit", "--branches", "--tags", "--remotes", "--no-merges", "--merges", "--first-parent", "--reverse", "--topo-order", "--date-order", "--follow", "--left-right", "--cherry-pick", "--boundary", "-i", "--regexp-ignore-case"],
    FLAG,
  ),
  ["--decorate", val(words("short", "full", "auto", "no"), true)],
  ["--max-count", val(N)],
  ["--skip", val(N)],
  ...["--since", "--until", "--after", "--before", "--author", "--committer", "--grep"].map((n): [string, Opt] => [n, val(FREE)]),
  ["--date", val(words("relative", "iso", "iso-strict", "rfc", "short", "local", "default", "raw", "unix", "human"))],
  ["--format", val(FORMAT)],
  ["--pretty", val(FORMAT)],
]);

const DIFF_ONLY: Record<string, Opt> = Object.fromEntries([...entries(["--cached", "--staged", "--merge-base"], FLAG)]);

/** Letters that may be bundled (`-sb`): flags without a value. */
const BUNDLE: Record<string, string> = { status: "sbz", diff: "pusbwaz", log: "pusbwaz", show: "pusbwaz" };

type Cmd = "status" | "log" | "show" | "diff";
const TABLES: Record<Cmd, Record<string, Opt>> = {
  status: STATUS,
  log: { ...DIFF, ...LOG },
  show: { ...DIFF, ...LOG },
  diff: { ...DIFF, ...DIFF_ONLY },
};

/**
 * Whether the repository at `cwd` is plain (docs/spec.md "Permission tiers"): nothing a worker can influence decides what git
 * runs. Not plain (`unsafe`) when ANY of:
 * - a config key that makes git run something (core.hooksPath, core.fsmonitor, diff.external, textconv, diff and filter
 *   programs, gpg.program) is set at any scope, unless its value is one absolute path outside the cwd, or (system and global
 *   scope only) one of the few values Git for Windows and `git lfs install` write (KNOWN);
 * - an include.path / includeIf.*.path whose target is not an absolute file outside the cwd;
 * - the worktree holds a `.gitmodules` file or a nested `.git` entry at any depth, or its index holds a gitlink (a submodule);
 * - PATH has an empty or relative entry (a bare program name could then resolve into the cwd);
 * - any of it cannot be read in time (`failed`: fail closed).
 * Then git status, diff, log and show are high and so is every Write in the cwd. `protectedPaths`: what a config value names
 * inside the cwd (always high to Write). Read anew on every decision: no cache, a worker's last Write is always seen (oneDecision
 * shares one read between the checks of a single synchronous decision). Synchronous on purpose: the settle-time check
 * (Session.coordinatorSettle) decides and settles in one step, with no await in between.
 */
export type RepoSafety = { unsafe: boolean; failed: boolean; why: string[]; protectedPaths: string[] };

/** Program values the user's own system or global config may hold without making a repository unsafe (bare names via PATH). */
const KNOWN: Record<string, string> = {
  "filter.lfs.clean": "git-lfs clean -- %f",
  "filter.lfs.smudge": "git-lfs smudge -- %f",
  "filter.lfs.process": "git-lfs filter-process",
  "diff.astextplain.textconv": "astextplain",
};
const BOOL = /^(true|false|yes|no|on|off|0|1)$/i;
const RUNS = /^(core\.hookspath|core\.fsmonitor|diff\.external|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|gpg\.program|gpg\..+\.program)$/;
const INCLUDE = /^(include\.path|includeif\..+\.path)$/;
/** A full walk of a big tree costs more than a tier decision may: past this many entries, unsafe. */
const WALK_LIMIT = 50_000;

/** The real path of `p`, a missing tail resolved through its nearest existing ancestor (8.3 short names and symlinks expand); `/c/x` is `C:/x` on Windows. */
function realish(p: string): string {
  let q = resolve(process.platform === "win32" ? p.replace(/^[/\\]([A-Za-z])[/\\]/, "$1:/") : p);
  const rest: string[] = [];
  while (!lstatSync(q, { throwIfNoEntry: false })) {
    const up = dirname(q);
    if (up === q) return q;
    rest.unshift(basename(q));
    q = up;
  }
  return join(realpathSync.native(q), ...rest);
}

/** `~` and `~/x` are the user's home (git's own expansion); `/c/x` and `C:/x` are absolute on Windows. */
const expandHome = (v: string) => (v === "~" || /^~[/\\]/.test(v) ? join(homedir(), v.slice(1)) : v);
const absolute = (v: string) => isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v) || (process.platform === "win32" && /^[/\\][A-Za-z][/\\]/.test(v));

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 1 << 30,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Whether some folder from `dir` up holds a `.git`: git would find a repository there. */
function inRepo(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (lstatSync(join(d, ".git"), { throwIfNoEntry: false })) return true;
    if (dirname(d) === d) return false;
  }
}

let memo: Map<string, RepoSafety> | undefined;
/** Runs `fn` (synchronous) with one repoSafety read per cwd: a coordinator's check and its settle-time check see the same facts. */
export function oneDecision<T>(fn: () => T): T {
  if (memo) return fn();
  memo = new Map();
  try {
    return fn();
  } finally {
    memo = undefined;
  }
}

export function repoSafety(cwd: string): RepoSafety {
  const hit = memo?.get(cwd);
  if (hit) return hit;
  const out: RepoSafety = { unsafe: false, failed: false, why: [], protectedPaths: [] };
  const flag = (why: string) => {
    out.unsafe = true;
    out.why.push(why);
  };
  try {
    const top = realpathSync(cwd);
    const inside = (p: string) => {
      const rel = relative(top, realish(p));
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    const pathEntries = (process.env.PATH ?? "").split(delimiter);
    // A trailing `;` is common on Windows and names nothing; elsewhere an empty entry is the current folder.
    const pathBad = pathEntries.some((e, i) => (e === "" ? !(process.platform === "win32" && i === pathEntries.length - 1) : !absolute(e)));
    if (pathBad) flag("PATH has a relative entry");

    // Output: scope NUL origin NUL key NL value NUL, repeated. Includes are expanded: their keys are listed too.
    const fields = git(top, ["config", "--list", "-z", "--show-scope", "--show-origin"]).split("\u0000");
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const scope = fields[i]!;
      const origin = fields[i + 1]!;
      const entry = fields[i + 2]!;
      const nl = entry.indexOf("\n");
      const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase();
      const value = nl < 0 ? "" : entry.slice(nl + 1);
      const v = value.trim();
      const originDir = origin.startsWith("file:") ? dirname(resolve(top, origin.slice(5))) : undefined;
      // What a value names inside the cwd: a Write there is always high. A program's or an include's path-like words, and the
      // whole value of a key that names a file or folder (core.attributesFile, core.excludesFile, commit.template ...).
      const named = RUNS.test(key) || INCLUDE.test(key) ? v.split(/\s+/).filter((t) => absolute(t) || t.startsWith("~") || t.startsWith(".") || /[/\\]/.test(t)) : /(file|template)$/.test(key) && v && !BOOL.test(v) ? [v] : [];
      for (const tok of named) {
        const p = resolve(INCLUDE.test(key) && originDir ? originDir : top, expandHome(tok));
        if (inside(p)) out.protectedPaths.push(realish(p));
      }
      if (INCLUDE.test(key)) {
        // A relative include is relative to the file that holds it; an included file inside the cwd is worker-writable config.
        if (!v) continue;
        const target = expandHome(v);
        if (absolute(target) ? inside(target) : !originDir || inside(resolve(originDir, target))) flag(`${key} into the worktree`);
      } else if (RUNS.test(key)) {
        // core.fsmonitor takes a boolean (git's own daemon); an empty program value names none (an empty hooksPath is the top folder).
        if ((v === "" && key !== "core.hookspath") || (key === "core.fsmonitor" && BOOL.test(v))) continue;
        if ((scope === "system" || scope === "global") && KNOWN[key] === v) continue;
        const one = expandHome(v);
        // A program: one token (arguments could name a file the worker wrote). A hooks folder: any absolute path.
        if ((key === "core.hookspath" || /^[^\s'"]+$/.test(v)) && absolute(one) && !inside(one)) continue;
        flag(`${scope} ${key}`);
      }
    }

    // The worktree's shape: submodules and nested repositories have their own config and hooks.
    let seen = 0;
    const walk = (d: string, depth: number): boolean => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (++seen > WALK_LIMIT) return (flag("worktree too large to check"), false);
        const n = e.name.toLowerCase();
        if (n === ".git" && depth > 0) return (flag(`nested repository ${relative(top, d) || "."}`), false);
        if (n === ".gitmodules") return (flag(`${relative(top, join(d, e.name))}`), false);
        // node_modules: git never runs anything from a nested repository there unless it is a gitlink (the index check below),
        // and a low Write cannot create a `.git` or `.gitmodules` at any depth.
        if (e.isDirectory() && !(depth === 0 && n === ".git") && n !== "node_modules" && !walk(join(d, e.name), depth + 1)) return false;
      }
      return true;
    };
    if (!out.unsafe) walk(top, 0);
    if (!out.unsafe) {
      let modes = "";
      try {
        modes = git(top, ["ls-files", "-z", "--format=%(objectmode)"]);
      } catch (e) {
        if (inRepo(top)) throw e;
      }
      if (modes.split("\u0000").includes("160000")) flag("a submodule (gitlink) in the index");
    }
  } catch {
    out.failed = true;
    flag("could not read the repository's config or index");
  }
  memo?.set(cwd, out);
  return out;
}

const MAX_COMMAND = 1000;
const MAX_SEGMENTS = 5;
/** No quotes, `$`, backtick, `\`, `* ? [ ]`, `# ! < > ( )`, tab, newline, NUL or non-ASCII: what is parsed here is what bash runs. */
const CHARSET = /^[A-Za-z0-9 ._/@^~:=,+%{}&|;-]+$/;
const GLOBAL_OPTS = new Set(["--no-pager", "--no-optional-locks"]);
const REV_PARSE = new Set(["HEAD", "--abbrev-ref", "--short", "--show-toplevel", "--is-inside-work-tree"]);

/** `-3`, `-n 5`, `-n5`, `-U3`, `-M50%`: options with an attached number. */
function numbered(tok: string, cmd: Cmd): boolean {
  if (cmd === "status") return false;
  if (/^-U\d{1,6}$/.test(tok)) return true;
  if (/^-M(\d{1,3}%?)?$/.test(tok)) return true;
  return cmd !== "diff" && (/^-\d{1,6}$/.test(tok) || /^-n\d{1,6}$/.test(tok));
}

/** Whether `tok` (before any `--`) is an allowed option. */
function optionOk(tok: string, cmd: Cmd): boolean {
  if (numbered(tok, cmd)) return true;
  const table = TABLES[cmd];
  const eq = tok.indexOf("=");
  const name = eq < 0 ? tok : tok.slice(0, eq);
  if (Object.hasOwn(table, name)) {
    const o = table[name];
    if (eq < 0) return !o || o.optional;
    return !!o && o.value.test(tok.slice(eq + 1));
  }
  // `-sb`: letters of value-less flags only; a lone long option never reaches here.
  return eq < 0 && /^-[A-Za-z]{2,}$/.test(tok) && [...tok.slice(1)].every((c) => BUNDLE[cmd]!.includes(c));
}

/**
 * A revision or a path: no leading `~` `:` `/` or drive, no `..` segment, `~` only after a name character, `{}` only as `@{name}`,
 * no denied name in its path part (after the first `:`), and a path that exists on disk passes the read path check.
 * `isPath`: after `--`, so the whole token is a path.
 */
function positionalOk(tok: string, cwd: string, isPath: boolean): boolean {
  // Refs are shared by every worktree: a stash (stash -u keeps untracked files, `.env` included, in its ^3 tree) and raw ref names are not for a worker.
  if (!isPath && /stash|refs\//i.test(tok)) return false;
  if (!tok || /^[~:/\\]/.test(tok) || /^[A-Za-z]:/.test(tok)) return false;
  for (let i = 0; i < tok.length; i++) if (tok[i] === "~" && !(i > 0 && /[A-Za-z0-9_^}]/.test(tok[i - 1]!))) return false;
  // `@{u}`, `HEAD@{1}`, `@{-1}`; `{1..3}` would be a brace expansion.
  if (/[{}]/.test(tok.replace(/@\{(?!.*\.\.)[A-Za-z0-9.-]+\}/g, ""))) return false;
  const all = tok.split(/[/:]/);
  if (all.includes("..")) return false;
  const colon = isPath ? -1 : tok.indexOf(":");
  const head = colon < 0 ? (isPath ? "" : tok) : tok.slice(0, colon);
  const path = isPath ? tok : colon < 0 ? "" : tok.slice(colon + 1);
  // A bare token is a revision or a pathspec: names are denied (`.env`), its `~` is a revision's.
  if (head && deniedRead(head.split("/"), true)) return false;
  if (path && deniedRead(path.split("/"))) return false;
  for (const part of [head, path]) {
    if (part && lstatSync(resolve(cwd, part), { throwIfNoEntry: false }) && !pathLow(part, cwd, false)) return false;
  }
  return true;
}

function segmentOk(seg: string, cwd: string, execUnsafe: () => boolean): boolean {
  const w = seg.trim().split(/ +/);
  if (w[0] !== "git") return false;
  let i = 1;
  while (w[i]?.startsWith("-")) {
    if (!GLOBAL_OPTS.has(w[i]!)) return false;
    i++;
  }
  const sub = w[i++];
  const rest = w.slice(i);
  if (sub === "branch") return rest.length === 1 && rest[0] === "--show-current";
  if (sub === "rev-parse") return rest.length > 0 && rest.every((a) => REV_PARSE.has(a));
  if (sub !== "status" && sub !== "log" && sub !== "show" && sub !== "diff") return false;
  // These run hooks and config-defined programs: only in a plain repository (repoSafety).
  if (execUnsafe()) return false;
  let dashes = false;
  for (let k = 0; k < rest.length; k++) {
    const tok = rest[k]!;
    if (dashes) {
      if (!positionalOk(tok, cwd, true)) return false;
    } else if (tok === "--") dashes = true;
    else if (tok === "-n" && sub !== "status" && sub !== "diff") {
      if (!N.test(rest[++k] ?? "")) return false;
    } else if (tok.startsWith("-")) {
      if (!optionOk(tok, sub)) return false;
    } else if (!positionalOk(tok, cwd, false)) return false;
  }
  return true;
}

/** Whether the Bash tool input is a chain (`&&`, `||`, `;`) of read-only git commands to run in `cwd`, which holds a `.git`. */
export function gitReadOnly(input: unknown, cwd: string): boolean {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const o = input as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== "command" && k !== "description" && k !== "timeout")) return false;
    const cmd = o.command;
    if (typeof cmd !== "string" || !cmd || cmd.length > MAX_COMMAND || !CHARSET.test(cmd)) return false;
    // Git finds the repository from the cwd upward: needs its own `.git`, so it never walks into a parent repository.
    if (!lstatSync(join(cwd, ".git"), { throwIfNoEntry: false })) return false;
    const segs = cmd.split(/\s*(?:&&|\|\||;)\s*/);
    if (segs.length > MAX_SEGMENTS) return false;
    let unsafe: boolean | undefined;
    const execUnsafe = () => (unsafe ??= repoSafety(cwd).unsafe);
    return segs.every((s) => s.trim() !== "" && !/[&|]/.test(s) && segmentOk(s, cwd, execUnsafe));
  } catch {
    return false;
  }
}
