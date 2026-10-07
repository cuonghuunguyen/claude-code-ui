// Whether a Bash tool call is only read-only git (docs/spec.md "Permission tiers"): the one Bash shape a coordinator may settle.
// An allowlist grammar: one fixed program (git), no quoting, no expansion, no redirection, exact option names. Any doubt = false.
import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { Worker } from "node:worker_threads";
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
 * inside the cwd (always high to Write). No result cache: every read looks again.
 * The daemon uses repoSafetyAsync (git runs off the event loop); repoSafety (synchronous) is for tests and direct tier() calls.
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
/** Per git process; past it the scan fails, and a failed scan is unsafe. */
const GIT_TIMEOUT_MS = 5000;

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

const gitOpts = (cwd: string) => ({
  cwd,
  encoding: "utf8" as const,
  timeout: GIT_TIMEOUT_MS,
  windowsHide: true,
  maxBuffer: 1 << 30,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
});
const CONFIG_ARGS = ["config", "--list", "-z", "--show-scope", "--show-origin"];
const LS_ARGS = ["ls-files", "-z", "--format=%(objectmode)"];
const gitSync = (cwd: string, args: string[]) => execFileSync("git", args, { ...gitOpts(cwd), stdio: ["ignore", "pipe", "ignore"] });
/**
 * Git off the event loop. Even an async spawn creates the process on the main thread, and on Windows under load (antivirus)
 * that alone held the loop for hundreds of ms; so git runs in a worker thread (plain JS, eval'd: nothing to bundle), which
 * blocks only itself. Calls queue there one at a time. If the thread cannot start or dies, an async execFile is the fallback.
 */
const GIT_THREAD = `
const { parentPort } = require("node:worker_threads");
const { execFileSync } = require("node:child_process");
parentPort.on("message", ({ id, args, opts }) => {
  try {
    parentPort.postMessage({ id, out: execFileSync("git", args, { ...opts, stdio: ["ignore", "pipe", "ignore"] }) });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});`;
let thread: Worker | undefined;
let threadBroken = false;
let nextCall = 0;
const calls = new Map<number, { ok: (out: string) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
function gitThread(): Worker | undefined {
  if (thread || threadBroken) return thread;
  try {
    const w = new Worker(GIT_THREAD, { eval: true });
    w.on("message", ({ id, out, error }: { id: number; out?: string; error?: string }) => {
      const c = calls.get(id);
      if (!c) return;
      calls.delete(id);
      clearTimeout(c.timer);
      if (error === undefined) c.ok(out ?? "");
      else c.fail(new Error(error));
    });
    const down = (e: unknown) => {
      if (thread === w) thread = undefined;
      for (const [id, c] of calls) {
        calls.delete(id);
        clearTimeout(c.timer);
        c.fail(new Error(`git thread stopped: ${String(e)}`));
      }
    };
    w.on("error", down);
    w.on("exit", down);
    // After the listeners: a listener added later refs the port again, and the thread would keep the daemon from exiting.
    w.unref();
    thread = w;
  } catch {
    threadBroken = true;
  }
  return thread;
}
const gitAsync = (cwd: string, args: string[]) =>
  new Promise<string>((ok, fail) => {
    const w = gitThread();
    if (!w) {
      const child = execFile("git", args, gitOpts(cwd), (err, stdout) => (err ? fail(err) : ok(stdout)));
      child.stdin?.end();
      return;
    }
    const id = ++nextCall;
    // Queued calls wait their turn in the thread: allow for the queue, then fail closed.
    const timer = setTimeout(() => {
      calls.delete(id);
      fail(new Error("git timed out"));
    }, 4 * GIT_TIMEOUT_MS);
    timer.unref();
    calls.set(id, { ok, fail, timer });
    w.postMessage({ id, args, opts: gitOpts(cwd) });
  });

/** Whether some folder from `dir` up holds a `.git`: git would find a repository there. */
function inRepo(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (lstatSync(join(d, ".git"), { throwIfNoEntry: false })) return true;
    if (dirname(d) === d) return false;
  }
}

/** The steps both readers share; only how git runs and how folders are listed differ. */
type Scan = { top: string; out: RepoSafety; flag: (why: string) => void; inside: (p: string) => boolean };
function begin(cwd: string): Scan {
  const out: RepoSafety = { unsafe: false, failed: false, why: [], protectedPaths: [] };
  const flag = (why: string) => {
    out.unsafe = true;
    out.why.push(why);
  };
  const top = realpathSync(cwd);
  const inside = (p: string) => {
    const rel = relative(top, realish(p));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  // A trailing `;` is common on Windows and names nothing; elsewhere an empty entry is the current folder.
  if (pathEntries.some((e, i) => (e === "" ? !(process.platform === "win32" && i === pathEntries.length - 1) : !absolute(e)))) flag("PATH has a relative entry");
  return { top, out, flag, inside };
}

/** `git config --list -z --show-scope --show-origin`: scope NUL origin NUL key NL value NUL, repeated (includes expanded). */
function readConfig({ top, out, flag, inside }: Scan, text: string) {
  const fields = text.split("\u0000");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const scope = fields[i]!;
    const origin = fields[i + 1]!;
    const entry = fields[i + 2]!;
    const nl = entry.indexOf("\n");
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase();
    const v = (nl < 0 ? "" : entry.slice(nl + 1)).trim();
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
}

/** One folder's entries during the walk: false = stop (flagged). node_modules is not entered: git never runs anything from a
 * nested repository there unless it is a gitlink (the index check), and a low Write cannot create a `.git` or `.gitmodules`. */
function visit({ top, flag }: Scan, d: string, depth: number, entries: Dirent[], seen: { n: number }, down: (dir: string) => void): boolean {
  for (const e of entries) {
    if (++seen.n > WALK_LIMIT) return (flag("worktree too large to check"), false);
    const n = e.name.toLowerCase();
    if (n === ".git" && depth > 0) return (flag(`nested repository ${relative(top, d) || "."}`), false);
    if (n === ".gitmodules") return (flag(relative(top, join(d, e.name))), false);
    if (e.isDirectory() && !(depth === 0 && n === ".git") && n !== "node_modules") down(join(d, e.name));
  }
  return true;
}

const failClosed = (s: Scan | undefined): RepoSafety => {
  const out = s?.out ?? { unsafe: false, failed: false, why: [], protectedPaths: [] };
  out.failed = out.unsafe = true;
  out.why.push("could not read the repository's config or index");
  return out;
};
const gitlinks = (s: Scan, modes: string) => {
  if (modes.split("\u0000").includes("160000")) s.flag("a submodule (gitlink) in the index");
};

/** Synchronous read: blocks the event loop for two git processes. Tests and direct tier() calls only; the daemon awaits repoSafetyAsync. */
export function repoSafety(cwd: string): RepoSafety {
  let s: Scan | undefined;
  try {
    s = begin(cwd);
    readConfig(s, gitSync(s.top, CONFIG_ARGS));
    const seen = { n: 0 };
    const walk = (d: string, depth: number): boolean => {
      const subs: string[] = [];
      if (!visit(s!, d, depth, readdirSync(d, { withFileTypes: true }), seen, (x) => subs.push(x))) return false;
      return subs.every((x) => walk(x, depth + 1));
    };
    if (!s.out.unsafe) walk(s.top, 0);
    if (!s.out.unsafe) {
      let modes = "";
      try {
        modes = gitSync(s.top, LS_ARGS);
      } catch (e) {
        if (inRepo(s.top)) throw e;
      }
      gitlinks(s, modes);
    }
    return s.out;
  } catch {
    return failClosed(s);
  }
}

/** A scan in flight is shared for at most this long: a request that arrives later gets a scan of its own. */
const SHARE_MS = 1000;
const inFlight = new Map<string, { at: number; p: Promise<RepoSafety> }>();
/**
 * The same facts as repoSafety, with git and the walk off the event loop. Never rejects: any failure, and a git process past
 * 5 s, is a failed (unsafe) result. A read shares the scan of the same cwd in flight only when that scan started after `since`
 * (performance.now(); default: 1 s ago), so a change the caller knows of (Session's epoch) is never answered by an older scan.
 * Nothing is kept after a scan completes.
 */
export function repoSafetyAsync(cwd: string, since = performance.now() - SHARE_MS): Promise<RepoSafety> {
  const running = inFlight.get(cwd);
  if (running && running.at > Math.max(since, performance.now() - SHARE_MS)) return running.p;
  const p = (async () => {
    let s: Scan | undefined;
    try {
      s = begin(cwd);
      readConfig(s, await gitAsync(s.top, CONFIG_ARGS));
      const seen = { n: 0 };
      const walk = async (d: string, depth: number): Promise<boolean> => {
        const subs: string[] = [];
        if (!visit(s!, d, depth, await readdir(d, { withFileTypes: true }), seen, (x) => subs.push(x))) return false;
        for (const x of subs) if (!(await walk(x, depth + 1))) return false;
        return true;
      };
      if (!s.out.unsafe) await walk(s.top, 0);
      if (!s.out.unsafe) {
        let modes = "";
        try {
          modes = await gitAsync(s.top, LS_ARGS);
        } catch (e) {
          if (inRepo(s.top)) throw e;
        }
        gitlinks(s, modes);
      }
      return s.out;
    } catch {
      return failClosed(s);
    }
  })().finally(() => {
    if (inFlight.get(cwd)?.p === p) inFlight.delete(cwd);
  });
  inFlight.set(cwd, { at: performance.now(), p });
  return p;
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

/**
 * Whether the Bash tool input is a chain (`&&`, `||`, `;`) of read-only git commands to run in `cwd`, which holds a `.git`.
 * `safety`: the repository facts already read for this decision (repoSafetyAsync); absent, they are read synchronously.
 */
export function gitReadOnly(input: unknown, cwd: string, safety?: RepoSafety): boolean {
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
    const execUnsafe = () => (unsafe ??= (safety ?? repoSafety(cwd)).unsafe);
    return segs.every((s) => s.trim() !== "" && !/[&|]/.test(s) && segmentOk(s, cwd, execUnsafe));
  } catch {
    return false;
  }
}
