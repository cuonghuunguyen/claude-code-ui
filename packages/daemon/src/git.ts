// Git branch and diff size of a session cwd, for the status bar (`git.status`).
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { GIT_LOG_MAX_LIMIT, worktreeNameError, wslHostPath, wslPathOf, type GitCommit, type GitCommitDetail, type GitDiff, type GitFileChange, type GitLog, type GitStatus, type Worktree, type WorktreeRemoveResult, type WorktreeStatusResult } from "@claude-ui/protocol";
import { runGit } from "./git-runner.ts";
import { foreignPointer } from "./remote-path.ts";

// Read-only calls on a repository's own config: no fsmonitor hook (a program from .git/config), no transport (a partial clone's lazy fetch runs core.sshCommand), on any git version.
const READ_ONLY = ["-c", "core.fsmonitor=false", "-c", "protocol.allow=never"];
const readEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" });
/** Runs `fn`s with at most `n` running at a time, the rest in arrival order; urgent (graph) calls start before queued normal ones. */
export function limiter(n: number) {
  let active = 0;
  const urgentWaiting: (() => void)[] = [];
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>, urgent = false): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((r) => (urgent ? urgentWaiting : waiting).push(r));
    try {
      return await fn();
    } finally {
      // The slot passes to the next waiter as is.
      const next = urgentWaiting.shift() ?? waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
/**
 * Git processes of the status bar, worktree lists and history reads start at most 4 at a time: a process start blocks the
 * event loop (tens of ms on Windows), and a session list with dozens of projects started them all in one tick, which held
 * every other reply (a session's transcript, a prompt) for seconds. Spread over ticks, other replies go out between them.
 */
const gitSlot = limiter(4);
/**
 * The repository of `cwd` resolved once: canonical top, own git dir, shared git dir and the object directories its
 * `objects/info/alternates` names. File system only; null outside a work tree or without a readable `.git`.
 */
type Repo = { top: string; own: string; common: string; alternates: string[] };
async function repoOf0(cwd: string): Promise<Repo | null> {
  const top = await gitTopOf(cwd);
  if (!top) return null;
  const dirs = await gitDirsOfAsync(top);
  if (!dirs) return null;
  const own = await realAsync(dirs.own);
  const common = await realAsync(dirs.common);
  const alternates: string[] = [];
  try {
    const objects = join(common, "objects");
    for (const l of (await readFile(join(objects, "info", "alternates"), "utf8")).split("\n")) {
      const t = l.trim().replace(/^"(.*)"$/, "$1");
      if (!t || t.startsWith("#")) continue;
      // A UNC alternate to another share, or a device path: no file call (NTLM), the repository counts as unresolved.
      if (foreignPointer(t, objects)) return null;
      alternates.push(await realAsync(resolve(objects, t)));
    }
  } catch {
    // No alternates.
  }
  return { top, own, common, alternates };
}
const escapesRoots = (r: Repo, allowed: (p: string) => boolean) => ![r.top, r.own, r.common, ...r.alternates].every(allowed);
/**
 * Git looks for a repository upward and skips an invalid `.git` (an empty folder), and re-reads `.git` at every start (a
 * link swapped after the roots check would win). So git gets the repository that was resolved once: `GIT_DIR` (own git dir,
 * real path), `GIT_COMMON_DIR`, `GIT_WORK_TREE` (also overrides `core.worktree`) and a ceiling above the top, all from the same
 * values. `pins` keeps what `topIn` validated against the roots for the later calls of the same request.
 */
const pins = new Map<string, NodeJS.ProcessEnv>();
const pinFor = (r: Repo): NodeJS.ProcessEnv => {
  const up = dirname(r.top);
  return {
    GIT_DIR: r.own,
    GIT_COMMON_DIR: r.common,
    GIT_WORK_TREE: r.top,
    ...(up !== r.top && { GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES ? `${up}${delimiter}${process.env.GIT_CEILING_DIRECTORIES}` : up }),
  };
};
export const ceilingEnv = async (cwd: string): Promise<NodeJS.ProcessEnv> => {
  const top = await gitTopOf(cwd);
  if (!top) return {};
  const kept = pins.get(top);
  if (kept) return kept;
  const r = await repoOf0(top);
  return r ? pinFor(r) : {};
};
/** The repository pin (#317) for a git call made outside this module (`search.ts`, `git-readonly.ts`); file calls are async. */
export const pinEnv = ceilingEnv;
const git = async (cwd: string, ...args: string[]) => {
  const env = { ...readEnv(), ...(await ceilingEnv(cwd)) };
  return (await gitSlot(() => runGit({ cwd, args: [...READ_ONLY, ...args], env, idempotent: true }))).stdout.toString("utf8").trim();
};

/**
 * `cwd`'s own git dir and the one its worktrees share; undefined without a readable `cwd/.git`. In a linked worktree `.git`
 * is a file (`gitdir: <main>/.git/worktrees/<name>`) whose git dir names the shared one in `commondir`. File system only.
 */
export function gitDirsOf(cwd: string): { own: string; common: string } | undefined {
  const dotGit = join(cwd, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return { own: dotGit, common: dotGit };
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
    if (!gitdir) return undefined;
    // A pointer to another UNC share or a device path is never followed (an SMB lookup sends the NTLM hash).
    if (foreignPointer(gitdir.trim(), cwd)) return undefined;
    const own = resolve(cwd, gitdir.trim());
    try {
      const common = readFileSync(join(own, "commondir"), "utf8").trim();
      if (foreignPointer(common, own)) return undefined;
      return { own, common: resolve(own, common) };
    } catch {
      return { own, common: own };
    }
  } catch {
    return undefined;
  }
}

async function gitDirsOfAsync(cwd: string): Promise<{ own: string; common: string } | undefined> {
  const dotGit = join(cwd, ".git");
  try {
    if ((await stat(dotGit)).isDirectory()) return { own: dotGit, common: dotGit };
    const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1];
    if (!gitdir) return undefined;
    // A pointer to another UNC share or a device path is never followed (an SMB lookup sends the NTLM hash).
    if (foreignPointer(gitdir.trim(), cwd)) return undefined;
    const own = resolve(cwd, gitdir.trim());
    try {
      const common = (await readFile(join(own, "commondir"), "utf8")).trim();
      if (foreignPointer(common, own)) return undefined;
      return { own, common: resolve(own, common) };
    } catch {
      return { own, common: own };
    }
  } catch {
    return undefined;
  }
}

const statOf = async (p: string) => {
  try {
    const st = await stat(p);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "-";
  }
};
const MAX_STAMP_DIRS = 5000;
let uncached = 0;
/**
 * Opaque stamp of the repository's refs, from file stats only (no process): HEAD, packed-refs, reftable list, worktree HEADs
 * and every folder under refs/. A loose ref update is a lock-file rename in its folder, so the folder mtime changes; a
 * working-tree edit does not change it. "-" without a readable `.git`; "*<n>" (never equal) past 5000 folders.
 */
export async function refsStamp(cwd: string): Promise<string> {
  const top = (await gitTopOf(cwd)) ?? cwd;
  const dirs = await gitDirsOfAsync(top);
  if (!dirs) return "-";
  const parts = [await statOf(join(dirs.own, "HEAD")), await statOf(join(dirs.common, "packed-refs")), await statOf(join(dirs.common, "reftable", "tables.list"))];
  try {
    for (const n of (await readdir(join(dirs.common, "worktrees"))).sort()) parts.push(`${n}:${await statOf(join(dirs.common, "worktrees", n, "HEAD"))}`);
  } catch {
    // No linked worktree.
  }
  let count = 0;
  const walk = async (rel: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(join(dirs.common, "refs", rel), { withFileTypes: true });
    } catch {
      return true;
    }
    if (++count > MAX_STAMP_DIRS) return false;
    parts.push(`${rel}:${await statOf(join(dirs.common, "refs", rel))}`);
    for (const e of entries) if (e.isDirectory() && !(await walk(rel ? `${rel}/${e.name}` : e.name))) return false;
    return true;
  };
  if (!(await walk(""))) return `*${++uncached}`;
  return parts.join("|");
}
/** `refsStamp` of the repository `cwd` belongs to, null outside a work tree; file stats only, no git process (`git.refs`). */
export async function gitRefs(cwd: string, allowed: (p: string) => boolean): Promise<string | null> {
  return (await gitTopOf(cwd)) && !(await gitEscapes(cwd, allowed)) ? refsStamp(cwd) : null;
}
/** The full ref HEAD points to (`refs/heads/x`); undefined when detached or unreadable. */
async function headRef(top: string): Promise<string | undefined> {
  const dirs = await gitDirsOfAsync(top);
  if (!dirs) return undefined;
  try {
    return /^ref: (refs\/heads\/\S+)\s*$/.exec(await readFile(join(dirs.own, "HEAD"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/** While a graph request runs, status polls are answered from the last status (no git process) so the graph gets the processes. */
let graphActive = 0;
let idle: (() => void)[] = [];
async function graphTask<T>(fn: () => Promise<T>): Promise<T> {
  graphActive++;
  try {
    return await fn();
  } finally {
    if (--graphActive === 0) for (const r of idle.splice(0)) r();
  }
}
const graphIdle = () => (graphActive ? new Promise<void>((r) => idle.push(r)) : Promise.resolve());
const lru = <V>(max: number) => {
  const m = new Map<string, V>();
  return {
    get(k: string): V | undefined {
      const v = m.get(k);
      if (v !== undefined) {
        m.delete(k);
        m.set(k, v);
      }
      return v;
    },
    set(k: string, v: V) {
      m.delete(k);
      m.set(k, v);
      if (m.size > max) m.delete(m.keys().next().value!);
    },
  };
};
const lastStatus = new Map<string, GitStatus>();

/** null outside a git work tree. Lines added/removed: staged and unstaged changes of tracked files against HEAD (the empty tree before the first commit). */
export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  if (graphActive) {
    const last = lastStatus.get(cwd);
    if (last) return { ...last, refs: await refsStamp(cwd) };
    await graphIdle();
  }
  let branch: string;
  try {
    branch = (await git(cwd, "branch", "--show-current")) || (await git(cwd, "rev-parse", "--short", "HEAD"));
  } catch {
    lastStatus.delete(cwd);
    return null;
  }
  const base = await git(cwd, "rev-parse", "--verify", "-q", "HEAD").catch(() => git(cwd, "hash-object", "-t", "tree", "/dev/null"));
  let added = 0;
  let removed = 0;
  // Binary files count "-": no lines.
  for (const line of (await git(cwd, "diff", "--no-ext-diff", "--no-textconv", "--numstat", base).catch(() => "")).split("\n")) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  const s = { branch, added, removed, refs: await refsStamp(cwd) };
  lastStatus.set(cwd, s);
  return s;
}

/**
 * Worktrees of the repository `cwd` belongs to (`git worktree list`), the main worktree first; null outside a repo.
 * From a linked worktree too. Left out: a bare main repo and prunable entries (directory deleted). Detached: `branch` is the short hash.
 */
export async function listWorktrees(cwd: string): Promise<Worktree[] | null> {
  // A WSL project opened by its UNC path: git runs in the distro and prints POSIX paths; they map back to the UNC form.
  const wsl = wslPathOf(cwd);
  // -z (git 2.36+): fields end with NUL, entries with an empty field, so a path may hold a newline. Older git: newline-separated.
  let out: string;
  let sep = "\0";
  try {
    out = await git(cwd, "worktree", "list", "--porcelain", "-z");
  } catch {
    try {
      out = await git(cwd, "worktree", "list", "--porcelain");
      sep = "\n";
    } catch {
      return null;
    }
  }
  return out.split(sep + sep).flatMap((entry, i) => {
    const lines = entry.split(sep);
    const field = (k: string) => lines.find((l) => l === k || l.startsWith(`${k} `))?.slice(k.length + 1);
    // git prints forward slashes on Windows; every other path here is native.
    const raw = field("worktree");
    const path = raw && (wsl ? wslHostPath(wsl.root, raw) : process.platform === "win32" ? normalize(raw) : raw);
    if (!path || field("bare") !== undefined || field("prunable") !== undefined) return [];
    const branch = field("branch")?.replace(/^refs\/heads\//, "") ?? field("HEAD")?.slice(0, 7);
    return [{ path, ...(branch && { branch }), main: i === 0, ...(field("locked") !== undefined && { locked: true as const }) }];
  });
}

// ---- Worktree create / remove (docs/spec.md "Worktrees") ----

export type WorktreeErrorCode = "not_git" | "cwd_not_allowed" | "bad_name" | "bad_base" | "exists" | "not_worktree" | "not_removable" | "has_sessions_running" | "git_failed" | "bad_request" | "not_found" | "too_large" | "busy" | "stale" | "remote_not_allowed";
export class WorktreeError extends Error {
  constructor(readonly code: WorktreeErrorCode, message: string, readonly size?: number) {
    super(message);
  }
}

/** git with a timeout, no shell; failure becomes a WorktreeError git_failed with the first stderr line. */
async function run(cwd: string, args: string[], timeout = 30_000, env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }, urgent = false, idempotent = false): Promise<string> {
  try {
    return (await gitSlot(() => runGit({ cwd, args, timeout, env, idempotent }), urgent)).stdout.toString("utf8").trim();
  } catch (e) {
    const err = e as { killed?: boolean; stderr?: string; message: string };
    throw new WorktreeError("git_failed", err.killed ? `git ${args[0]} timed out` : (err.stderr?.split("\n").find((l) => l.trim()) ?? err.message));
  }
}
const ok = (cwd: string, ...args: string[]) => run(cwd, args).then(() => true, () => false);
const inside = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
export const realAsync = (p: string) => realpath(p).catch(() => p);
export const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// ponytail: in-process lock per repository; two daemon processes on one repo rely on git's own failure (mapped to `exists`).
const locks = new Map<string, Promise<unknown>>();
function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => locks.get(key) === tail && locks.delete(key));
  return next;
}

/** The main worktree (canonical) of the repository `cwd` belongs to, and all its worktrees (canonical paths). */
async function repoOf(cwd: string): Promise<{ main: string; list: Listed[] }> {
  const list = await listWorktrees(cwd);
  const main = list?.find((w) => w.main);
  // A repository with a separate git dir or a submodule lists the git dir as main: no `.git` entry there, nothing is created in it.
  if (!list || !main || !exists(join(main.path, ".git"))) throw new WorktreeError("not_git", "Not in a git repository with its own .git");
  return { main: real(main.path), list: list.map((w) => ({ ...w, raw: w.path, path: real(w.path) })) };
}
/** A listed worktree with git's own spelling of its path (`raw`, not resolved through links). */
type Listed = Worktree & { raw: string };

/** `<main>/.claude/worktrees`, the folder this app creates worktrees in. */
const worktreesDir = (main: string) => join(main, ".claude", "worktrees");

/** `worktree.*` of the Claude settings: local > project (of the main checkout) > user; per key the first file that sets it. */
function worktreeSettings(claudeDir: string, main: string): { baseRef?: unknown; symlinkDirectories?: unknown } {
  const out: { baseRef?: unknown; symlinkDirectories?: unknown } = {};
  for (const f of [join(main, ".claude", "settings.local.json"), join(main, ".claude", "settings.json"), join(claudeDir, "settings.json")]) {
    try {
      const w = JSON.parse(readFileSync(f, "utf8"))?.worktree;
      if (w && typeof w === "object") {
        out.baseRef ??= w.baseRef;
        out.symlinkDirectories ??= w.symlinkDirectories;
      }
    } catch {}
  }
  return out;
}

const ADJECTIVES = ["brave", "calm", "clever", "eager", "fancy", "gentle", "happy", "jolly", "keen", "lively", "mellow", "nimble", "proud", "quick", "quiet", "rapid", "shiny", "silent", "sunny", "swift", "tidy", "vivid", "witty", "zesty"];
const NOUNS = ["badger", "beacon", "cedar", "comet", "dolphin", "falcon", "forest", "glacier", "harbor", "island", "lantern", "meadow", "otter", "panda", "pebble", "river", "robin", "summit", "tiger", "valley", "willow", "wolf", "yarrow", "zebra"];
const pick = (l: string[]) => l[Math.floor(Math.random() * l.length)]!;

export type CreateWorktreeOptions = {
  name?: string;
  /** Default `worktree-<name>`. GH-79 part 5: an explicit branch name. */
  branch?: string;
  /** Default: origin/<default> after a fetch (see docs/spec.md "Worktrees"). GH-79 part 5: an explicit start point. */
  base?: string;
  /** Roots predicate: the main checkout and the new path must pass it. */
  allowed: (path: string) => boolean;
  /** Claude config dir, for user settings `worktree.*`. */
  claudeDir: string;
  /** Runs under the repository lock once the worktree is ready (GH-79 part 5: the worker's session and link). When it throws, the new worktree and its branch are removed and the error is rethrown. */
  onCreated?: (r: { path: string; branch: string }) => void;
};

/** `git worktree add` under `<main>/.claude/worktrees/<name>` (docs/spec.md "Worktrees"); throws WorktreeError. */
export async function createWorktree(cwd: string, o: CreateWorktreeOptions): Promise<{ path: string; branch: string }> {
  const { main } = await repoOf(cwd);
  if (!o.allowed(main)) throw new WorktreeError("cwd_not_allowed", "The repository is outside the allowed roots");
  return locked(main, async () => {
    // The directory must really be inside the repository: a .claude (or worktrees) symlink to elsewhere is refused.
    const claude = join(main, ".claude");
    if (exists(claude) && real(claude) !== claude) throw new WorktreeError("cwd_not_allowed", ".claude is a link; refusing to create worktrees through it");
    const dir = worktreesDir(main);
    mkdirSync(dir, { recursive: true });
    const rdir = real(dir);
    if (rdir !== dir) throw new WorktreeError("cwd_not_allowed", ".claude/worktrees is a link; refusing to create worktrees through it");

    const free = async (n: string) => !exists(join(rdir, n)) && !(await ok(main, "rev-parse", "--verify", "-q", `refs/heads/${o.branch ?? `worktree-${n}`}`));
    let name = o.name;
    if (name !== undefined) {
      const bad = worktreeNameError(name);
      if (bad) throw new WorktreeError("bad_name", bad);
    } else {
      for (let i = 0; i < 26 && !name; i++) {
        const n = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
        if (await free(n)) name = n;
      }
      if (!name) throw new WorktreeError("exists", "No free generated worktree name");
    }
    const branch = o.branch ?? `worktree-${name}`;
    if (!(await ok(main, "check-ref-format", "--branch", branch))) throw new WorktreeError("bad_name", `Not a valid branch name: ${branch}`);
    if (await ok(main, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)) throw new WorktreeError("exists", `Branch ${branch} already exists`);
    const path = join(rdir, name);
    if (exists(path)) throw new WorktreeError("exists", `${path} already exists`);
    if (!o.allowed(path)) throw new WorktreeError("cwd_not_allowed", "The new worktree would be outside the allowed roots");

    const settings = worktreeSettings(o.claudeDir, main);
    let base: string;
    if (o.base !== undefined) {
      if (!(await ok(main, "rev-parse", "--verify", "-q", "--end-of-options", `${o.base}^{commit}`))) throw new WorktreeError("bad_base", `Not a commit: ${o.base}`);
      base = o.base;
    } else {
      base = "HEAD";
      const head = settings.baseRef === "head" ? undefined : await run(main, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => undefined);
      const def = head?.replace(/^refs\/remotes\/origin\//, "");
      if (def) {
        const remote = `refs/remotes/origin/${def}`;
        try {
          await run(main, ["fetch", "--quiet", "origin", "--", `refs/heads/${def}:${remote}`], 120_000);
          base = remote;
        } catch (e) {
          console.warn(`worktree: fetch of origin/${def} failed (${(e as Error).message}); using the local copy`);
          if (await ok(main, "rev-parse", "--verify", "-q", "--end-of-options", `${remote}^{commit}`)) base = remote;
        }
      }
    }
    // The branch first: `git branch` fails atomically when the name exists (a branch a user made after the check above is never touched).
    // `worktree add -b` would keep its branch on failure (git 2.43), and could not tell ours from a user's.
    try {
      await run(main, ["branch", "--no-track", "--", branch, base]);
    } catch (e) {
      if (await ok(main, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)) throw new WorktreeError("exists", `Branch ${branch} already exists`);
      throw e;
    }
    try {
      await run(main, ["worktree", "add", "--quiet", "--", path, branch]);
    } catch (e) {
      // Delete only the branch this call created (git refuses when a worktree has it checked out meanwhile: it is kept).
      await run(main, ["branch", "-D", "--", branch]).catch((x) => console.warn(`worktree: branch ${branch} of a failed create kept: ${x.message}`));
      if (exists(path)) throw new WorktreeError("exists", `${name} already exists`);
      throw e;
    }

    // `worktree.symlinkDirectories`: each entry relative, inside the repository, existing; anything else is skipped with a warning.
    const dirs = Array.isArray(settings.symlinkDirectories) ? settings.symlinkDirectories : [];
    for (const d of dirs) {
      try {
        if (typeof d !== "string" || !d || isAbsolute(d) || d.split(/[\\/]/).includes("..")) throw new Error("not a relative path inside the repository");
        const src = realpathSync(join(main, d));
        if (!inside(main, src) || src === main) throw new Error("outside the repository");
        const dst = join(path, d);
        if (exists(dst)) throw new Error("already exists in the worktree");
        mkdirSync(dirname(dst), { recursive: true });
        symlinkSync(src, dst, process.platform === "win32" ? "junction" : undefined);
      } catch (e) {
        console.warn(`worktree: symlinkDirectories entry ${JSON.stringify(d)} skipped: ${(e as Error).message}`);
      }
    }
    // Keep the main checkout's `git add -A` from adding the worktrees as embedded repositories (local only, never committed).
    try {
      const dir = await run(main, ["rev-parse", "--git-common-dir"]);
      const w = wslPathOf(main);
      const common = real(w && dir.startsWith("/") ? wslHostPath(w.root, dir) : resolve(main, dir));
      const file = join(common, "info", "exclude");
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!text.split(/\r?\n/).includes("/.claude/worktrees/")) {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}/.claude/worktrees/\n`);
      }
    } catch (e) {
      console.warn(`worktree: could not update info/exclude: ${(e as Error).message}`);
    }
    if (o.onCreated)
      try {
        o.onCreated({ path, branch });
      } catch (e) {
        await run(main, ["worktree", "remove", "--force", "--", path]).catch((x) => console.warn(`worktree: rollback of ${path} failed: ${x.message}`));
        await run(main, ["branch", "-D", "--", branch]).catch((x) => console.warn(`worktree: rollback of branch ${branch} failed: ${x.message}`));
        await run(main, ["worktree", "prune"]).catch(() => {});
        throw e;
      }
    return { path, branch };
  });
}

/** The linked worktree `path` (as requested) of `list`; not_worktree for an unknown path or the main worktree. */
function linked(list: Listed[], path: string): Listed {
  const p = real(path);
  const w = list.find((x) => x.path === p);
  if (!w) throw new WorktreeError("not_worktree", "Not a worktree of this repository");
  if (w.main) throw new WorktreeError("not_worktree", "The main worktree cannot be removed");
  return w;
}

const isLink = (p: string) => lstat(p).then((s) => s.isSymbolicLink(), () => false);
/** Why `w` cannot be removed, from git and the file system only (sessions and roots are added by callers). */
async function blockOf(w: Listed, requested: string, list: Listed[]): Promise<"locked" | "symlink" | "contains_worktree" | undefined> {
  if (w.locked) return "locked";
  if ((await isLink(requested)) || (await isLink(w.raw))) return "symlink";
  // Another linked worktree inside it: its files are untracked here (and `.claude/worktrees/` is excluded), removal would delete its work.
  if (list.some((x) => x !== w && !x.main && x.path !== w.path && inside(w.path, x.path))) return "contains_worktree";
  return undefined;
}
const BLOCK_ERROR = { locked: "The worktree is locked (git worktree lock); unlock it first", symlink: "The worktree path is a symbolic link", contains_worktree: "The worktree contains another worktree; remove that one first" };

export type RemoveOptions = {
  /** Called once the worktree is validated, inside the repository lock, before any other await (the server's `removing` mark). */
  mark?: (w: Worktree) => void;
  /** The caller's session cleanup (refuses with has_sessions_running), run after every check passed. */
  beforeRemove?: () => Promise<void>;
  expectSafe?: boolean;
  /** Work listed: more uncommitted files, commits ahead or ignored files now is `stale`. */
  expect?: { uncommitted: number; ahead: number; ignored: number };
  deleteBranch?: boolean;
};

/**
 * Removes a linked worktree inside the roots (made by this app, by hand or by another tool): directory, then its `worktree-*` branch, then prune.
 * Refused: the main worktree, a locked one, a symlink path, one whose git dirs are outside the roots. `deleteBranch`: a kept branch goes with `-d` (git refuses an unmerged one: `branchKept`).
 */
export async function removeWorktree(cwd: string, path: string, allowed: (path: string) => boolean, o: RemoveOptions = {}): Promise<WorktreeRemoveResult> {
  const first = await repoOf(cwd);
  return locked(first.main, async () => {
    // Re-read inside the lock: a concurrent remove may have removed it.
    const { main, list } = await repoOf(cwd);
    const w = linked(list, path);
    const block = await blockOf(w, path, list);
    if (block) throw new WorktreeError("not_removable", BLOCK_ERROR[block]);
    if (!allowed(w.path) || (await gitEscapes(w.path, allowed))) throw new WorktreeError("cwd_not_allowed", "The worktree is outside the allowed roots");
    o.mark?.(w);
    // Checked before anything closes, and again once the sessions and terminals are gone (a shell could write in between).
    const verify = async () => {
      if (!o.expectSafe && !o.expect) return;
      const st = await statusOf(main, w, path, allowed, list);
      const e = o.expect;
      if ((o.expectSafe && st.safety !== "safe") || st.blocked || (e && (st.uncommitted > e.uncommitted || st.ahead > e.ahead || st.ignored > e.ignored)))
        throw new WorktreeError("stale", `Changed since the list: ${st.uncommitted} files, ${st.ahead} commits${st.ignored ? `, ${st.ignored} ignored files` : ""}`);
    };
    await verify();
    await o.beforeRemove?.();
    await verify();
    const detached = !(await gok(w.path, "symbolic-ref", "-q", "HEAD"));
    await run(main, ["worktree", "remove", "--force", "--", w.path]);
    let branchKept: string | undefined;
    if (w.branch?.startsWith("worktree-")) await run(main, ["branch", "-D", "--", w.branch]).catch((e) => console.warn(`worktree: branch ${w.branch} kept: ${e.message}`));
    else if (o.deleteBranch && w.branch && !detached) await run(main, ["branch", "-d", "--", w.branch]).catch((e) => void (branchKept = e.message));
    await run(main, ["worktree", "prune"]).catch(() => {});
    return branchKept ? { branchKept } : {};
  });
}

/** Pure: `safety` of a status without it. */
export function classify(st: Omit<WorktreeStatusResult, "safety">): WorktreeStatusResult {
  return { ...st, safety: st.blocked ? "blocked" : st.uncommitted || st.ahead ? "has_work" : "safe" };
}

const count = async (cwd: string, args: string[]) => Number(await g(cwd, ["rev-list", "--count", ...args])) || 0;

/** What removing `w` loses and whether it may be removed (WorktreeStatusResult); `running` is the caller's to fill. */
async function statusOf(main: string, w: Listed, requested: string, allowed: (p: string) => boolean, list: Listed[]): Promise<WorktreeStatusResult> {
  const name = w.branch ?? basename(w.path);
  const zero = { uncommitted: 0, untracked: 0, commits: 0, ahead: 0, ignored: 0, branch: name, branchMerged: false, running: 0 };
  // No git runs in a worktree whose git dirs are outside the roots.
  if (!allowed(w.path) || (await gitEscapes(w.path, allowed))) return classify({ ...zero, blocked: "outside_roots" });
  const blocked = await blockOf(w, requested, list);
  const all = (await g(w.path, ["status", "--porcelain", "--ignored"])).split("\n").filter((l) => l.trim());
  const lines = all.filter((l) => !l.startsWith("!! "));
  // Ignored files only; an ignored directory git reports as a whole (node_modules/, build output) is not counted.
  const ignored = all.filter((l) => l.startsWith("!! ") && !l.endsWith("/")).length;
  const detached = !(await gok(w.path, "symbolic-ref", "-q", "HEAD"));
  const keeps = !detached && !w.branch?.startsWith("worktree-");
  let commits = 0;
  if (detached) commits = await count(w.path, ["HEAD", "--not", "--branches", "--remotes"]);
  else if (!keeps) commits = await count(w.path, ["HEAD", "--not", `--exclude=${w.branch}`, "--branches", "--remotes"]);
  // Saved refs: the base branch, the upstream and same-name remote branches.
  const refs: string[] = [];
  const base = await defaultBranch(main);
  if (base) refs.push(base);
  if (!detached && w.branch) {
    const up = await g(main, ["for-each-ref", "--format=%(upstream)", "--", `refs/heads/${w.branch}`]).catch(() => "");
    if (up) refs.push(up);
    const same = await g(main, ["for-each-ref", "--format=%(refname)", "--", `refs/remotes/*/${w.branch}`]).catch(() => "");
    refs.push(...same.split("\n").filter(Boolean));
  }
  let ahead: number;
  if (refs.length) ahead = await count(w.path, ["HEAD", "--not", ...refs]);
  else if (!keeps) ahead = commits;
  else ahead = await count(w.path, ["HEAD", "--not", `--exclude=${w.branch}`, "--branches", "--remotes"]);
  const branchMerged = keeps && refs.length > 0 && (await count(w.path, [`refs/heads/${w.branch}`, "--not", ...refs])) === 0;
  const t = Number(await g(w.path, ["log", "-1", "--format=%ct", "HEAD"]).catch(() => "")) * 1000;
  return classify({ uncommitted: lines.length, untracked: lines.filter((l) => l.startsWith("?? ")).length, commits, ahead, ignored, branch: name, branchMerged, ...(t > 0 && { headTime: t }), running: 0, ...(blocked && { blocked }) });
}

/** What removing `path` loses and whether it may (WorktreeStatusResult). `allowed`: the roots check; sessions are the caller's. */
export async function worktreeStatus(cwd: string, path: string, allowed: (p: string) => boolean): Promise<WorktreeStatusResult> {
  const { main, list } = await repoOf(cwd);
  return statusOf(main, linked(list, path), path, allowed, list);
}

// ---- Commit graph (docs/spec.md "Layout") ----

const LOG_DEFAULT = 200;
const MAX_FILTER = 200;
const MAX_SUBJECT = 1000;
const MAX_COMMIT_FILES = 3000;
const MAX_BRANCHES = 2000;
const SAFE = [...READ_ONLY, "-c", "log.showSignature=false", "-c", "core.quotePath=false"];
/** Every git call of the graph: SAFE config first, no lazy fetch. */
const g = async (cwd: string, args: string[]) => run(cwd, [...SAFE, ...args], 30_000, { ...readEnv(), ...(await ceilingEnv(cwd)) }, true, true);
const gok = (cwd: string, ...args: string[]) => g(cwd, args).then(() => true, () => false);
const bad = (m: string) => new WorktreeError("bad_request", m);

/** A full object name (SHA-1 or SHA-256). */
export const isHash = (h: unknown): h is string => typeof h === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(h);
const filterText = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || v.length > MAX_FILTER || /[\0\n\r]/.test(v)) throw bad(`Invalid ${what} filter`);
  return v.trim() || undefined;
};
const repoPath = (p: unknown): string => {
  if (typeof p !== "string" || !p || p.length > 4096 || p.includes("\0") || p.includes("\\") || p.startsWith("/") || p.startsWith("-") || p.split("/").includes("..")) throw bad("Invalid path");
  return p;
};
const intIn = (v: unknown, min: number, max: number, def: number, what: string): number => {
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`Invalid ${what}`);
  return v;
};

/**
 * The canonical repository top of `cwd` (the first folder up with a `.git` entry), null outside a work tree. File system only,
 * like `gitDirsOf`: a `safe.directory` refusal shows as `git_failed` from the next git call instead of not-a-repo.
 */
export async function gitTopOf(cwd: string): Promise<string | null> {
  let d = resolve(cwd);
  for (;;) {
    if (await lstat(join(d, ".git")).then(() => true, () => false)) return realAsync(d);
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}
/** The canonical repository top of `cwd`, null outside a work tree. */
export async function gitTop(cwd: string): Promise<string | null> {
  return gitTopOf(cwd);
}
/**
 * True when the repository of `cwd` is not entirely inside the roots (`allowed` gets canonical paths): its top, its own git
 * dir, the one its worktrees share (`gitDirsOf`, resolved through links) or an object directory of `objects/info/alternates`. A project inside the roots whose `.git` is a
 * symlink or a `gitdir:` file to elsewhere, or a linked worktree whose main repository is outside, would show that repository.
 * File system only; false outside a work tree.
 */
export async function gitEscapes(cwd: string, allowed: (p: string) => boolean): Promise<boolean> {
  const top = await gitTopOf(cwd);
  if (!top) return false;
  if (!allowed(top)) return true;
  const r = await repoOf0(top);
  // A `.git` entry exists but cannot be resolved (no gitdir line, unreadable, foreign pointer): outside, fail closed.
  return r ? escapesRoots(r, allowed) : true;
}
/**
 * A cwd inside the roots whose repository (top, git dirs, alternates) is outside must not expose files outside the roots
 * through git objects. The values checked are the ones git then gets (`pins`): no gap for a `.git` swap.
 */
export async function topIn(cwd: string, allowed: (p: string) => boolean): Promise<string | null> {
  const top = await gitTopOf(cwd);
  if (!top) return null;
  if (!allowed(top)) throw new WorktreeError("cwd_not_allowed", "The repository is outside the allowed roots");
  const r = await repoOf0(top);
  if (!r) throw new WorktreeError("cwd_not_allowed", "The repository is outside the allowed roots");
  if (escapesRoots(r, allowed)) throw new WorktreeError("cwd_not_allowed", "The repository is outside the allowed roots");
  pins.delete(top);
  pins.set(top, pinFor(r));
  if (pins.size > 64) pins.delete(pins.keys().next().value!);
  return top;
}

/** `HEAD -> x` (attached) lists HEAD first, then x; a bare `HEAD` (detached) goes last, so refs[0] === "HEAD" means attached. */
const refList = (d: string) => {
  const parts = d.split(", ").filter(Boolean);
  const names = parts.filter((r) => r !== "HEAD").flatMap((r) => (r.startsWith("HEAD -> ") ? ["HEAD", r.slice(8)] : [r.startsWith("tag: ") ? r.slice(5) : r]));
  return parts.includes("HEAD") ? [...names, "HEAD"] : names;
};
const commitOf = (f: string[]): GitCommit => ({
  hash: f[0]!,
  parents: f[1]!.split(" ").filter(Boolean),
  author: f[2]!,
  email: f[3]!,
  time: Number(f[4]),
  subject: f[6]!.slice(0, MAX_SUBJECT),
  refs: refList(f[5]!),
});

const logCache = lru<{ stamp: string; out: string }>(16);
const branchCache = lru<{ stamp: string; list: string[] }>(8);
const commitCache = lru<GitCommitDetail>(64);
const cacheable = (stamp: string) => stamp !== "-" && !stamp.startsWith("*");
const branchList = async (top: string, stamp?: string) => {
  const hit = stamp && cacheable(stamp) ? branchCache.get(top) : undefined;
  if (hit && hit.stamp === stamp) return hit.list;
  const refs = await g(top, ["for-each-ref", "--format=%(refname)", `--count=${MAX_BRANCHES}`, "refs/heads", "refs/remotes"]);
  const list = refs.split("\n").filter((r) => r && !/^refs\/remotes\/[^/]+\/HEAD$/.test(r));
  if (stamp) branchCache.set(top, { stamp, list });
  return list;
};
export type GitLogOptions = { skip?: number; limit?: number; ref?: string; author?: string; text?: string; fresh?: boolean; allowed: (p: string) => boolean };
const NO_COMMITS = /does not have any commits|bad revision 'HEAD'|unknown revision or path not in the working tree/;
/** One page of the history, newest first in topological order; null outside a git work tree. */
export async function gitLog(cwd: string, o: GitLogOptions): Promise<GitLog | null> {
  const skip = intIn(o.skip, 0, 1_000_000, 0, "skip");
  const limit = intIn(o.limit, 1, GIT_LOG_MAX_LIMIT, LOG_DEFAULT, "limit");
  const author = filterText(o.author, "author");
  const text = filterText(o.text, "text");
  const top = await topIn(cwd, o.allowed);
  if (!top) return null;
  return graphTask(async () => {
    // Taken before any git call: a ref that moves meanwhile gives a stamp older than the data, never newer.
    const stamp = await refsStamp(top);
    const head = await headRef(top);
    const first = (log: GitLog, branches: string[]): GitLog => (skip === 0 ? { ...log, branches, refs: stamp, ...optional("head", head) } : log);
    const branches = skip === 0 ? branchList(top, o.fresh ? undefined : stamp) : undefined;
    // A rejection of the branch list would be unhandled while the ref is checked.
    branches?.catch(() => {});
    let ref: string | undefined;
    if (o.ref !== undefined) ref = o.ref === "HEAD" ? o.ref : await checkBranchRef(top, o.ref, await branches);
    const format = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s";
    const parse = (out: string) => out.split("\0").filter(Boolean).map((r) => commitOf(r.split("\x1f")));
    // A hash-like filter shows that one commit when it names one; else it filters by message text.
    if (text && /^[0-9a-f]{4,64}$/i.test(text)) {
      try {
        const one = parse(await g(top, ["log", "--decorate=full", "-z", format, "-1", "--no-walk", "--end-of-options", `${text}^{commit}`, "--"]));
        if (one.length === 1) return first({ commits: one, more: false }, branches ? await branches : []);
      } catch {
        // Not a commit: filter by text.
      }
    }
    const args = ["log", "--topo-order", "--decorate=full", "-z", format, `--skip=${skip}`, `--max-count=${limit + 1}`];
    if (author || text) args.push("--fixed-strings", "--regexp-ignore-case");
    if (author) args.push(`--author=${author}`);
    if (text) args.push(`--grep=${text}`);
    args.push(...(ref ? ["--end-of-options", ref] : ["--all"]), "--");
    const key = `${top}\0${args.join("\0")}`;
    let out: string;
    const hit = !o.fresh && cacheable(stamp) ? logCache.get(key) : undefined;
    if (hit && hit.stamp === stamp) out = hit.out;
    else {
      try {
        out = await g(top, args);
      } catch (e) {
        if (e instanceof WorktreeError && NO_COMMITS.test(e.message)) {
          if (ref === "HEAD" || /does not have any commits/.test(e.message)) return first({ commits: [], more: false }, ref === "HEAD" ? await branches! : []);
        }
        throw e;
      }
      if (cacheable(stamp)) logCache.set(key, { stamp, out });
    }
    const all = parse(out);
    return first({ commits: all.slice(0, limit), more: all.length > limit }, branches ? await branches : []);
  });
}
const optional = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));

/** `diff -z --name-status` output; a copy counts as a rename. */
function parseNameStatus(z: string): GitFileChange[] {
  const n = z.split("\0");
  const files: GitFileChange[] = [];
  for (let i = 0; i < n.length && n[i]; ) {
    const st = n[i++]!;
    if (st[0] === "R" || st[0] === "C") {
      files.push({ status: "R", oldPath: n[i++]!, path: n[i++]! });
    } else files.push({ status: st[0] === "A" || st[0] === "D" ? st[0] : "M", path: n[i++]! });
  }
  return files;
}
/** `diff -z --numstat` output by (new) path; a binary file has no counts. */
function parseNumstat(z: string): Map<string, { added?: number; removed?: number }> {
  const stats = new Map<string, { added?: number; removed?: number }>();
  const m = z.split("\0");
  for (let i = 0; i < m.length && m[i]; i++) {
    const [a, r, p] = m[i]!.split("\t");
    let path = p!;
    if (p === "") {
      i += 2;
      path = m[i]!;
    }
    stats.set(path, a === "-" ? {} : { added: Number(a), removed: Number(r) });
  }
  return stats;
}

/** `diff-tree -z --raw --numstat` output: all raw records (`:modes ids status`, path, and an old path for R/C), then all numstat records. A copy counts as a rename. */
function parseRawNumstat(z: string): { files: GitFileChange[]; stats: Map<string, { added?: number; removed?: number }> } {
  const t = z.split("\0");
  const files: GitFileChange[] = [];
  let i = 0;
  while (i < t.length && t[i]!.startsWith(":")) {
    const st = t[i++]!.split(" ").at(-1)![0];
    if (st === "R" || st === "C") {
      files.push({ status: "R", oldPath: t[i++]!, path: t[i++]! });
    } else files.push({ status: st === "A" || st === "D" ? st : "M", path: t[i++]! });
  }
  return { files, stats: parseNumstat(t.slice(i).join("\0")) };
}

/** Files of a commit against its first parent (a root commit: against nothing); one git process. */
async function commitFiles(top: string, hash: string, base: string | undefined): Promise<{ files: GitFileChange[]; truncated?: boolean }> {
  const tail = base ? [base, hash] : ["--root", hash];
  const { files, stats } = parseRawNumstat(await g(top, ["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--no-ext-diff", "--no-textconv", "--raw", "--numstat", ...tail]));
  const cut = files.length > MAX_COMMIT_FILES;
  const list = files.slice(0, MAX_COMMIT_FILES).map((f) => ({ ...f, ...stats.get(f.path) }));
  return { files: list, ...(cut && { truncated: true }) };
}

/** Header, message and changed files of one commit (no refs: decorating is slow with thousands of refs); null outside a git work tree. */
export async function gitShow(cwd: string, hash: string, allowed: (p: string) => boolean): Promise<GitCommitDetail | null> {
  if (!isHash(hash)) throw bad("Invalid commit hash");
  const top = await topIn(cwd, allowed);
  if (!top) return null;
  const key = `${top}\0${hash}`;
  const hit = commitCache.get(key);
  if (hit) return hit;
  return graphTask(async () => {
    let out: string;
    try {
      out = await g(top, ["show", "-s", "-z", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B", "--end-of-options", `${hash}^{commit}`]);
    } catch (e) {
      if (e instanceof WorktreeError && /bad object|bad revision|unknown revision|not a valid|does not exist|ambiguous|expected commit type/i.test(e.message)) throw new WorktreeError("not_found", "No such commit");
      throw e;
    }
    const f = out.split("\0")[0]!.split("\x1f");
    const message = f.slice(7).join("\x1f").trimEnd();
    const c: GitCommit = { hash: f[0]!, parents: f[1]!.split(" ").filter(Boolean), author: f[2]!, email: f[3]!, time: Number(f[4]), subject: message.split("\n")[0]!.slice(0, MAX_SUBJECT), refs: [] };
    const detail: GitCommitDetail = { ...c, message, committer: f[5]!, committerTime: Number(f[6]), ...(await commitFiles(top, hash, c.parents[0])) };
    commitCache.set(key, detail);
    return detail;
  });
}

/** A blob at a commit, checked (hash, path, repository inside `allowed`, exists, is a blob, at most `max`) but not read: its size comes from `git cat-file -s`. */
export type BlobRef = { top: string; obj: string; size: number; max: number };
export async function gitBlobRef(cwd: string, hash: string, path: string, allowed: (p: string) => boolean, max: number): Promise<BlobRef> {
  if (!isHash(hash)) throw bad("Invalid commit hash");
  const p = repoPath(path);
  const top = await topIn(cwd, allowed);
  if (!top) throw new WorktreeError("not_git", "Not in a git repository");
  const obj = `${hash}:${p}`;
  if (!(await gok(top, "cat-file", "-e", obj))) throw new WorktreeError("not_found", `No such file at that commit: ${p}`);
  if ((await g(top, ["cat-file", "-t", obj])) !== "blob") throw new WorktreeError("not_found", `Not a file: ${p}`);
  const size = Number(await g(top, ["cat-file", "-s", obj]));
  if (size > max) throw new WorktreeError("too_large", `larger than ${max} bytes: ${p}`, size);
  return { top, obj, size, max };
}
/** The bytes of a checked blob. */
export async function gitBlobRead(ref: BlobRef): Promise<Buffer> {
  try {
    const env = { ...readEnv(), ...(await ceilingEnv(ref.top)) };
    return (await gitSlot(() => runGit({ cwd: ref.top, args: [...SAFE, "cat-file", "blob", ref.obj], maxBuffer: ref.max + 1, env, timeout: 30_000, idempotent: true }), true)).stdout;
  } catch (e) {
    throw new WorktreeError("git_failed", (e as Error).message.split("\n")[0]!);
  }
}
/** The bytes of `path` (relative to the repository top) at commit `hash`; WorktreeError not_found / too_large (with `size`). */
export async function gitFileAt(cwd: string, hash: string, path: string, allowed: (p: string) => boolean, max: number): Promise<Buffer> {
  if (!isHash(hash)) throw bad("Invalid commit hash");
  const p = repoPath(path);
  const top = await topIn(cwd, allowed);
  if (!top) throw new WorktreeError("not_git", "Not in a git repository");
  const obj = `${hash}:${p}`;
  return graphTask(async () => {
    // One process: `cat-file --batch` prints `<oid> <type> <size>` then the bytes, or `<obj> missing`. A line break in the name cannot go through its input.
    const odd = /[\n\r]/.test(p);
    const args = [...SAFE, "cat-file", ...(odd ? ["blob", obj] : ["--batch"])];
    const first = (e: { stderr?: string; message: string }) => e.stderr?.split("\n").find((l) => l.trim()) ?? e.message.split("\n")[0]!;
    let stdout: Buffer;
    try {
      const env = { ...readEnv(), ...(await ceilingEnv(top)) };
      stdout = (await gitSlot(() => runGit({ cwd: top, args, input: odd ? undefined : `${obj}\n`, maxBuffer: max + 512, env, timeout: 30_000, idempotent: true }), true)).stdout;
    } catch (e) {
      const err = e as { code?: string | number; stdout?: Buffer; stderr?: string; killed?: boolean; message: string };
      const overflow = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      if (odd && overflow) throw new WorktreeError("too_large", `larger than ${max} bytes: ${p}`);
      if (odd && /not a valid object|does not exist|bad object|ambiguous|bad file/i.test(err.stderr ?? "")) throw new WorktreeError("not_found", `No such file at that commit: ${p}`);
      if (odd || !overflow || !err.stdout) throw new WorktreeError("git_failed", err.killed ? "git cat-file timed out" : first(err));
      // Output past the limit: the header is enough to answer too_large.
      stdout = err.stdout;
    }
    if (odd) return stdout;
    const nl = stdout.indexOf(10);
    const head = stdout.subarray(0, nl < 0 ? stdout.length : nl).toString("utf8").split(" ");
    if (head.at(-1) === "missing" || head.at(-1) === "ambiguous") throw new WorktreeError("not_found", `No such file at that commit: ${p}`);
    if (head[1] !== "blob") throw new WorktreeError("not_found", `Not a file: ${p}`);
    const size = Number(head[2]);
    if (size > max) throw new WorktreeError("too_large", `larger than ${max} bytes: ${p}`, size);
    return stdout.subarray(nl + 1, nl + 1 + size);
  });
}

/** `refs/heads/x` / `refs/remotes/o/x` to `x` / `o/x`. */
export const shortRef = (r: string) => r.replace(/^refs\/(heads|remotes)\//, "");
/** A full branch ref the caller named: refs/heads or refs/remotes, a valid name, existing. */
async function checkBranchRef(top: string, ref: unknown, branches?: string[]): Promise<string> {
  const shaped = typeof ref === "string" && ref.length <= 255 && /^refs\/(heads|remotes)\/[^\0-\x20\x7f~^:?*[\\]+$/.test(ref) && !ref.includes("..") && !ref.includes("@{") && !ref.endsWith("/") && !ref.endsWith(".lock") && !ref.endsWith(".");
  if (!shaped) throw bad("Unknown branch");
  // A ref of the branch list exists and is valid: no process. Others (past the list's cap, or no list) are asked of git.
  if (branches?.includes(ref)) return ref;
  if (!(await gok(top, "check-ref-format", ref)) || !(await gok(top, "show-ref", "--verify", "-q", "--", ref))) throw bad("Unknown branch");
  return ref;
}
/** origin/HEAD's target, else main, else master (local); no fetch. */
async function defaultBranch(top: string): Promise<string | undefined> {
  const remote = await g(top, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => "");
  for (const ref of [remote, "refs/heads/main", "refs/heads/master"]) if (ref && (await gok(top, "show-ref", "--verify", "-q", "--", ref))) return ref;
  return undefined;
}

const MAX_UNTRACKED_STATS = 1000;
const MAX_UNTRACKED_BYTES = 1 << 20;
/** Lines of an untracked text file; undefined for a binary, large or non-regular file (git's NUL-in-the-first-8000-bytes rule). */
async function untrackedLines(top: string, path: string): Promise<number | undefined> {
  try {
    const p = join(top, path);
    const st = await lstat(p);
    if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) return undefined;
    const fh = await open(p, "r");
    try {
      const b = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(b, 0, st.size, 0);
      const t = b.subarray(0, bytesRead);
      if (t.subarray(0, 8000).includes(0)) return undefined;
      let n = 0;
      for (const c of t) if (c === 10) n++;
      return t.length > 0 && t[t.length - 1] !== 10 ? n + 1 : n;
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

export type GitDiffOptions = { base: unknown; ref?: unknown; allowed: (p: string) => boolean };
/** The working tree (staged, unstaged, untracked) against HEAD or a merge base (docs/spec.md "Layout", changes tab); null outside a git work tree. */
export async function gitDiff(cwd: string, o: GitDiffOptions): Promise<GitDiff | null> {
  if (o.base !== "head" && o.base !== "branch") throw bad("Invalid base");
  if (o.ref !== undefined && typeof o.ref !== "string") throw bad("Invalid ref");
  const top = await topIn(cwd, o.allowed);
  if (!top) return null;
  const prefix = await g(cwd, ["rev-parse", "--show-prefix"]);
  const head = await g(top, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).catch(() => "");
  let base: string | undefined;
  let ref: string | undefined;
  let branches: string[] | undefined;
  if (o.base === "head") base = head || undefined;
  else {
    if (!head) throw new WorktreeError("bad_base", "No commits yet");
    ref = o.ref === undefined ? await defaultBranch(top) : await checkBranchRef(top, o.ref);
    if (!ref) throw new WorktreeError("bad_base", "No default branch (origin/HEAD, main or master): pick a branch");
    const target = ref;
    base = await g(top, ["merge-base", "--end-of-options", head, target]).catch(() => {
      throw new WorktreeError("bad_base", `No common history with ${shortRef(target)}`);
    });
    branches = await branchList(top);
  }
  const target = base ?? (await g(top, ["hash-object", "-t", "tree", "/dev/null"]));
  const pre = ["diff", "-M", "-z", "--no-ext-diff", "--no-textconv", "--no-color"];
  const [names, nums, others] = await Promise.all([
    g(top, [...pre, "--name-status", target, "--"]),
    g(top, [...pre, "--numstat", target, "--"]),
    g(top, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name"]),
  ]);
  const stats = parseNumstat(nums);
  const files: GitFileChange[] = parseNameStatus(names).map((f) => ({ ...f, ...stats.get(f.path) }));
  const byPath = (x: GitFileChange, y: GitFileChange) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);
  files.sort(byPath);
  // Tracked files first: a flood of untracked files is cut before any edit.
  const untracked = others.split("\0").filter(Boolean).sort();
  const room = Math.max(0, MAX_COMMIT_FILES - files.length);
  const cut = files.length + untracked.length > MAX_COMMIT_FILES;
  const kept = untracked.slice(0, room);
  // Line counts in small batches, off the event loop (up to 1000 files of 1 MiB).
  for (let i = 0; i < kept.length; i += 16) {
    const batch = kept.slice(i, i + 16);
    const counts = await Promise.all(batch.map((path, j) => (i + j < MAX_UNTRACKED_STATS ? untrackedLines(top, path) : undefined)));
    batch.forEach((path, j) => files.push({ status: "A", path, untracked: true, ...(counts[j] !== undefined && { added: counts[j], removed: 0 }) }));
  }
  files.sort(byPath);
  return { prefix, ...(base && { base }), ...(ref && { ref }), files: files.slice(0, MAX_COMMIT_FILES), ...(branches && { branches }), ...(cut && { truncated: true }) };
}
