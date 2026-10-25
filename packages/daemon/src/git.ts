// Git branch and diff size of a session cwd, for the status bar (`git.status`).
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { BRANCH_MAX, branchFolder, GIT_LOG_MAX_LIMIT, worktreeNameError, type BranchRow, type WorktreeBranchesResult, wslHostPath, wslPathOf, type GitCommit, type GitCommitDetail, type GitDiff, type GitRepo, type GitReposResult, type Settings, type GitFileChange, type GitLog, type GitStatus, type Worktree, type WorktreeRemoveResult, type WorktreeStatusResult, isRemoteOf, pullRequestOf, remoteRepoOf, type PullRequestBranchesResult } from "@claude-ui/protocol";
import { runGit } from "./git-runner.ts";
import { foreignPointer } from "./remote-path.ts";

// Read-only calls on a repository's own config: no fsmonitor hook (a program from .git/config), no transport (a partial clone's lazy fetch runs core.sshCommand), on any git version.
const READ_ONLY = ["-c", "core.fsmonitor=false", "-c", "protocol.allow=never"];
/** Parent reads never start git inside a submodule (`git status` there runs unpinned with the submodule's own config); a moved gitlink still shows. `git.ignoreSubmodules` on: `--ignore-submodules` (a moved gitlink is hidden too). */
const NO_SUBMODULE_STATUS = "--ignore-submodules=dirty";
const submoduleFlag = (ignore?: boolean) => (ignore ? "--ignore-submodules" : NO_SUBMODULE_STATUS);
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
  const r = await repoRead(top);
  return r === "foreign" ? null : r;
}
/** `"foreign"`: a pointer to another UNC share or a device path, never followed; null: no readable `.git`. */
async function repoRead(top: string): Promise<Repo | "foreign" | null> {
  const dirs = await readDotGit(top);
  if (dirs === "foreign") return dirs;
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
      if (foreignPointer(t, objects)) return "foreign";
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

async function readDotGit(cwd: string): Promise<{ own: string; common: string } | "foreign" | undefined> {
  const dotGit = join(cwd, ".git");
  try {
    if ((await stat(dotGit)).isDirectory()) return { own: dotGit, common: dotGit };
    const gitdir = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"))?.[1];
    if (!gitdir) return undefined;
    // A pointer to another UNC share or a device path is never followed (an SMB lookup sends the NTLM hash).
    if (foreignPointer(gitdir.trim(), cwd)) return "foreign";
    const own = resolve(cwd, gitdir.trim());
    try {
      const common = (await readFile(join(own, "commondir"), "utf8")).trim();
      if (foreignPointer(common, own)) return "foreign";
      return { own, common: resolve(own, common) };
    } catch {
      return { own, common: own };
    }
  } catch {
    return undefined;
  }
}
async function gitDirsOfAsync(cwd: string): Promise<{ own: string; common: string } | undefined> {
  const r = await readDotGit(cwd);
  return r === "foreign" ? undefined : r;
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
export async function gitStatus(cwd: string, o: { ignoreSubmodules?: boolean } = {}): Promise<GitStatus | null> {
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
  // Binary files have no counts; a gitlink row has none either.
  const { files, stats } = parseRawNumstat(await git(cwd, "diff", "--no-ext-diff", "--no-textconv", submoduleFlag(o.ignoreSubmodules), "--no-abbrev", "-z", "--raw", "--numstat", base).catch(() => ""));
  for (const f of files) {
    if (f.submodule) continue;
    const c = stats.get(f.path);
    added += c?.added ?? 0;
    removed += c?.removed ?? 0;
  }
  const s = { branch, added, removed, files: files.length, refs: await refsStamp(cwd) };
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

export type WorktreeErrorCode = "not_git" | "cwd_not_allowed" | "bad_name" | "bad_base" | "exists" | "not_worktree" | "not_removable" | "has_sessions_running" | "git_failed" | "bad_request" | "not_found" | "too_large" | "busy" | "stale" | "remote_not_allowed" | "pr_other_repo" | "pr_not_found" | "pr_unsupported";
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

/** Git config key of the Created branch mark (ADR 0005): a branch claude-ui created for a new worktree; removal deletes it. */
const createdKey = (branch: string) => `branch.${branch}.claudeUiCreated`;
const CONFIG_TRIES = 5;
/**
 * Marks `branch` a Created branch, right after `git branch` under the repository lock. A held `config.lock` (another git
 * writing the config) is retried; on failure the create still succeeds without the mark, with a warning.
 */
async function markCreated(main: string, branch: string): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await run(main, ["config", "--type=bool", "--", createdKey(branch), "true"]);
      return;
    } catch (e) {
      if (i < CONFIG_TRIES && /config\.lock|could not lock/i.test((e as Error).message)) {
        await new Promise((r) => setTimeout(r, 50 * i));
        continue;
      }
      console.warn(`worktree: ${createdKey(branch)} not set, the branch stays when its worktree is deleted: ${(e as Error).message}`);
      return;
    }
  }
}
/** A Created branch: marked in git config, or a legacy `worktree-*` branch of a claude-ui before the mark. */
async function isCreated(main: string, branch: string): Promise<boolean> {
  if (branch.startsWith("worktree-")) return true;
  return (await g(main, ["config", "--type=bool", "--get", "--", createdKey(branch)]).catch(() => "")) === "true";
}

export type CreateWorktreeOptions = {
  /** The folder; default: `branch` with `/` replaced by `-`, else generated. */
  name?: string;
  /** Default `worktree-<name>`. GH-79 part 5 / GH-447: an explicit new branch name (may contain `/`). */
  branch?: string;
  /** GH-447 Branch source: check out this existing branch (`refs/heads/x`, or `refs/remotes/<remote>/x` as a new local `x` tracking it); no name, branch or base. */
  checkout?: string;
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

    if (o.checkout !== undefined) return checkoutIn(main, rdir, o);
    const free = async (n: string) => !exists(join(rdir, n)) && !(await ok(main, "rev-parse", "--verify", "-q", `refs/heads/${o.branch ?? `worktree-${n}`}`));
    if (o.branch !== undefined && (!o.branch || o.branch.startsWith("-") || o.branch.length > BRANCH_MAX)) throw new WorktreeError("bad_name", `Not a valid branch name: ${o.branch}`);
    let name = o.name ?? (o.branch !== undefined ? branchFolder(o.branch) : undefined);
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
    await markCreated(main, branch);
    try {
      await run(main, ["worktree", "add", "--quiet", "--", path, branch]);
    } catch (e) {
      // Delete only the branch this call created (git refuses when a worktree has it checked out meanwhile: it is kept).
      await run(main, ["branch", "-D", "--", branch]).catch((x) => console.warn(`worktree: branch ${branch} of a failed create kept: ${x.message}`));
      if (exists(path)) throw new WorktreeError("exists", `${name} already exists`);
      throw e;
    }

    return finishCreate(main, path, branch, settings, o, true);
  });
}

/** After `git worktree add`: `symlinkDirectories`, the info/exclude line, the caller's step (rolled back when it throws). */
async function finishCreate(main: string, path: string, branch: string, settings: ReturnType<typeof worktreeSettings>, o: CreateWorktreeOptions, ours: boolean): Promise<{ path: string; branch: string }> {
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
        if (ours) await run(main, ["branch", "-D", "--", branch]).catch((x) => console.warn(`worktree: rollback of branch ${branch} failed: ${x.message}`));
        await run(main, ["worktree", "prune"]).catch(() => {});
        throw e;
      }
    return { path, branch };
}

/** Branch source Branch: `git worktree add` of an existing branch; a remote-only one first gets a local branch of the same name tracking it. Never marked. */
async function checkoutIn(main: string, rdir: string, o: CreateWorktreeOptions): Promise<{ path: string; branch: string }> {
  if (o.name !== undefined || o.branch !== undefined || o.base !== undefined) throw bad("checkout takes no name, branch or base");
  const ref = await checkBranchRef(main, o.checkout);
  const m = /^refs\/(heads|remotes)\/(.+)$/.exec(ref)!;
  const remote = m[1] === "remotes";
  // refs/remotes/<remote>/<x>: the remote is the longest configured remote name the ref starts with.
  let branch = m[2]!;
  if (remote) {
    const remotes = (await run(main, ["remote"]).catch(() => "")).split("\n").filter(Boolean).sort((a, b) => b.length - a.length);
    const r = remotes.find((x) => branch.startsWith(`${x}/`));
    if (!r) throw bad("Unknown remote branch");
    branch = branch.slice(r.length + 1);
    if (!branch || branch === "HEAD") throw bad("Unknown remote branch");
    if (await ok(main, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)) throw new WorktreeError("exists", `Branch ${branch} already exists locally: pick it from the list`);
  }
  const holder = (await repoOf(main)).list.find((w) => w.branch === branch);
  if (holder) throw new WorktreeError("exists", `Branch ${branch} is checked out in worktree ${basename(holder.path)}`);
  const name = branchFolder(branch);
  const bad1 = worktreeNameError(name);
  if (bad1) throw new WorktreeError("bad_name", `Folder ${name}: ${bad1}`);
  const path = join(rdir, name);
  if (exists(path)) throw new WorktreeError("exists", `${name} already exists`);
  if (!o.allowed(path)) throw new WorktreeError("cwd_not_allowed", "The new worktree would be outside the allowed roots");
  const settings = worktreeSettings(o.claudeDir, main);
  if (remote) {
    try {
      await run(main, ["branch", "--track", "--", branch, ref]);
    } catch (e) {
      if (await ok(main, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)) throw new WorktreeError("exists", `Branch ${branch} already exists`);
      throw e;
    }
  }
  try {
    await run(main, ["worktree", "add", "--quiet", "--", path, branch]);
  } catch (e) {
    if (remote) await run(main, ["branch", "-D", "--", branch]).catch((x) => console.warn(`worktree: branch ${branch} of a failed checkout kept: ${x.message}`));
    if (exists(path)) throw new WorktreeError("exists", `${name} already exists`);
    throw e;
  }
  // A local branch the user had stays on rollback; a tracking branch this call made goes.
  return finishCreate(main, path, branch, settings, o, remote);
}

/** The default start point as the Base picker shows it (no fetch): `origin/<default>`, else `HEAD`. */
async function defaultBaseName(main: string, claudeDir: string): Promise<string> {
  if (worktreeSettings(claudeDir, main).baseRef === "head") return "HEAD";
  const head = await g(main, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => "");
  return head ? shortRef(head) : "HEAD";
}

export type ListBranchesOptions = { allowed: (p: string) => boolean; claudeDir: string; fetch?: boolean };
/**
 * Local and remote branches of `cwd`'s repository for the Create worktree modal (newest commit first, one row per name; `origin`
 * preferred for the remote), each with the worktree it is checked out in. `fetch`: `git fetch --prune origin` first (2 min); a
 * failure (offline) lists the local refs with `fetchError`.
 */
export async function listBranches(cwd: string, o: ListBranchesOptions): Promise<WorktreeBranchesResult> {
  const { main, list } = await repoOf(cwd);
  if (!o.allowed(main) || (await gitEscapes(main, o.allowed))) throw new WorktreeError("cwd_not_allowed", "The repository is outside the allowed roots");
  let fetchError: string | undefined;
  let fetched = false;
  if (o.fetch) {
    const remotes = (await g(main, ["remote"]).catch(() => "")).split("\n");
    if (remotes.includes("origin"))
      try {
        await run(main, ["fetch", "--quiet", "--prune", "origin"], 120_000);
        fetched = true;
      } catch (e) {
        fetchError = (e as Error).message;
      }
  }
  const remotes = (await g(main, ["remote"]).catch(() => "")).split("\n").filter(Boolean).sort((a, b) => b.length - a.length);
  const refs = (await g(main, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", `--count=${MAX_BRANCHES}`, "refs/heads", "refs/remotes"])).split("\n").filter(Boolean);
  const holders = new Map(list.filter((w) => w.branch).map((w) => [w.branch!, w.path] as const));
  const rows = new Map<string, BranchRow>();
  for (const ref of refs) {
    let name: string;
    if (ref.startsWith("refs/heads/")) name = ref.slice(11);
    else {
      const rest = ref.slice(13);
      const r = remotes.find((x) => rest.startsWith(`${x}/`));
      if (!r) continue;
      name = rest.slice(r.length + 1);
      if (!name || name === "HEAD") continue;
      const row = rows.get(name);
      if (row?.remote?.startsWith("refs/remotes/origin/") && r !== "origin") continue;
      if (row) row.remote = ref;
      else rows.set(name, { name, local: false, remote: ref });
      continue;
    }
    const row = rows.get(name);
    if (row) row.local = true;
    else rows.set(name, { name, local: true });
  }
  for (const row of rows.values()) {
    const at = row.local ? holders.get(row.name) : undefined;
    if (at) row.worktree = at;
  }
  return { branches: [...rows.values()], defaultBase: await defaultBaseName(main, o.claudeDir), ...(fetched && { fetched }), ...(fetchError && { fetchError }) };
}

/**
 * A pasted pull request link: the branches of `origin` whose head is the pull request's head commit. One `git ls-remote origin`
 * (30 s, git's own credentials, no prompt) reads the host's pull request ref (GitHub `refs/pull/<n>/head`, GitLab
 * `refs/merge-requests/<n>/head`, Bitbucket Server `refs/pull-requests/<n>/from`) and every branch head. The link must name
 * `origin`'s repository (its configured URL, before `insteadOf`).
 */
export async function pullRequestBranches(cwd: string, text: string, o: { allowed: (p: string) => boolean }): Promise<PullRequestBranchesResult> {
  const link = pullRequestOf(text);
  if (!link) throw new WorktreeError("bad_request", "Not a pull request link");
  const { main } = await repoOf(cwd);
  if (!o.allowed(main) || (await gitEscapes(main, o.allowed))) throw new WorktreeError("cwd_not_allowed", "The repository is outside the allowed roots");
  const remote = await g(main, ["config", "--get", "remote.origin.url"]).catch(() => "");
  if (!remote) throw new WorktreeError("pr_other_repo", "This repository has no origin remote");
  if (!isRemoteOf(link, remote)) {
    const r = remoteRepoOf(remote);
    throw new WorktreeError("pr_other_repo", `Pull request #${link.number} is in ${link.repo} on ${link.host}, not in this repository${r ? ` (${r.path} on ${r.host})` : ""}`);
  }
  if (!link.refs.length) throw new WorktreeError("pr_unsupported", `${link.host} publishes no pull request refs: paste the branch name instead`);
  const out = await run(main, ["ls-remote", "origin", ...link.refs, "refs/heads/*"]);
  const heads = new Map<string, string[]>();
  let head: string | undefined;
  for (const line of out.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (link.refs.includes(ref)) head = sha;
    else if (ref.startsWith("refs/heads/")) heads.set(sha, [...(heads.get(sha) ?? []), ref.slice(11)]);
  }
  if (!head) throw new WorktreeError("pr_not_found", `origin has no pull request #${link.number}`);
  return { number: link.number, branches: heads.get(head) ?? [] };
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
 * Removes a linked worktree inside the roots (made by this app, by hand or by another tool): directory, then its Created branch (marked, or legacy `worktree-*`), then prune.
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
    if (w.branch && !detached && (await isCreated(main, w.branch))) await run(main, ["branch", "-D", "--", w.branch]).catch((e) => console.warn(`worktree: branch ${w.branch} kept: ${e.message}`));
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

/** Counts stop here: a huge untracked tree is "at least this much" (the web app shows `1000+`). */
export const STATUS_CAP = 1000;
/** Counts of `git status --porcelain -z --ignored=matching -uall`: changed or untracked files, the untracked part, ignored files (not directories). */
export function parseStatus(out: string): { uncommitted: number; untracked: number; ignored: number } {
  const c = { uncommitted: 0, untracked: 0, ignored: 0 };
  const f = out.split("\0");
  for (let i = 0; i < f.length; i++) {
    let e = f[i]!;
    // The runner trims the output: the first entry of " M file" lost its leading space.
    if (i === 0 && e[2] !== " ") e = ` ${e}`;
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    // A rename or copy is followed by its source path as a field of its own.
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") i++;
    if (xy === "!!") {
      if (!e.endsWith("/")) c.ignored = Math.min(STATUS_CAP, c.ignored + 1);
      continue;
    }
    c.uncommitted = Math.min(STATUS_CAP, c.uncommitted + 1);
    if (xy === "??") c.untracked = Math.min(STATUS_CAP, c.untracked + 1);
  }
  return c;
}

/** What removing `w` loses and whether it may be removed (WorktreeStatusResult); `running` is the caller's to fill. */
async function statusOf(main: string, w: Listed, requested: string, allowed: (p: string) => boolean, list: Listed[]): Promise<WorktreeStatusResult> {
  const name = w.branch ?? basename(w.path);
  const zero = { uncommitted: 0, untracked: 0, commits: 0, ahead: 0, ignored: 0, branch: name, branchMerged: false, running: 0 };
  // No git runs in a worktree whose git dirs are outside the roots.
  if (!allowed(w.path) || (await gitEscapes(w.path, allowed))) return classify({ ...zero, blocked: "outside_roots" });
  const blocked = await blockOf(w, requested, list);
  // Per file (-uall) and NUL separated (-z: names needing quotes stay exact). Ignored directories git reports whole (node_modules/, build output) are not counted.
  const { uncommitted, untracked, ignored } = parseStatus(await g(w.path, ["status", "--porcelain", "-z", "--ignored=matching", "-uall"]));
  const detached = !(await gok(w.path, "symbolic-ref", "-q", "HEAD"));
  const keeps = !detached && !(w.branch && (await isCreated(main, w.branch)));
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
  return classify({ uncommitted, untracked, commits, ahead, ignored, branch: name, branchMerged, ...(t > 0 && { headTime: t }), running: 0, ...(blocked && { blocked }), ...(!detached && !keeps && { createdBranch: true as const }) });
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

/** `diff -z --numstat` output by (new) path; a binary file has no counts. */
function parseNumstat(z: string): Map<string, { added?: number; removed?: number }> {
  const stats = new Map<string, { added?: number; removed?: number }>();
  const m = z.split("\0");
  for (let i = 0; i < m.length && m[i]; i++) {
    const [a, r, ...rest] = m[i]!.split("\t");
    // -z paths are not quoted: a tab in the name stays in the path.
    const p = rest.join("\t");
    let path = p;
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
    const [srcMode, dstMode, srcId, dstId, code] = t[i++]!.slice(1).split(" ") as [string, string, string, string, string];
    const st = code[0];
    const zero = (id: string) => /^0+$/.test(id);
    const from = srcMode === "160000" && !zero(srcId) ? { from: srcId } : {};
    const to = dstMode === "160000" && !zero(dstId) ? { to: dstId } : {};
    const submodule = srcMode === "160000" || dstMode === "160000" ? { submodule: { ...from, ...to } } : {};
    if (st === "R" || st === "C") {
      files.push({ status: "R", oldPath: t[i++]!, path: t[i++]!, ...submodule });
    } else files.push({ status: st === "A" || st === "D" ? st : "M", path: t[i++]!, ...submodule });
  }
  return { files, stats: parseNumstat(t.slice(i).join("\0")) };
}

/** Line counts onto the rows; a gitlink row has none. */
const withStats = (files: GitFileChange[], stats: Map<string, { added?: number; removed?: number }>): GitFileChange[] => files.map((f) => (f.submodule ? f : { ...f, ...stats.get(f.path) }));

/** Files of a commit against its first parent (a root commit: against nothing); one git process. */
async function commitFiles(top: string, hash: string, base: string | undefined): Promise<{ files: GitFileChange[]; truncated?: boolean }> {
  const tail = base ? [base, hash] : ["--root", hash];
  const { files, stats } = parseRawNumstat(await g(top, ["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--no-ext-diff", "--no-textconv", "--raw", "--numstat", ...tail]));
  const cut = files.length > MAX_COMMIT_FILES;
  const list = withStats(files.slice(0, MAX_COMMIT_FILES), stats);
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

const SUBMODULE = () => bad("Submodule: open its repository");
/** Whether `p` is a gitlink (submodule) at `hash`; asked only after a read found no blob there. */
async function isGitlink(top: string, hash: string, p: string): Promise<boolean> {
  return (await g(top, ["ls-tree", "-z", "--full-tree", "--end-of-options", hash, "--", p]).catch(() => "")).startsWith("160000 ");
}

/** A blob at a commit, checked (hash, path, repository inside `allowed`, exists, is a blob, at most `max`) but not read: its size comes from `git cat-file -s`. */
export type BlobRef = { top: string; obj: string; size: number; max: number };
export async function gitBlobRef(cwd: string, hash: string, path: string, allowed: (p: string) => boolean, max: number): Promise<BlobRef> {
  if (!isHash(hash)) throw bad("Invalid commit hash");
  const p = repoPath(path);
  const top = await topIn(cwd, allowed);
  if (!top) throw new WorktreeError("not_git", "Not in a git repository");
  const obj = `${hash}:${p}`;
  if (!(await gok(top, "cat-file", "-e", obj))) {
    if (await isGitlink(top, hash, p)) throw SUBMODULE();
    throw new WorktreeError("not_found", `No such file at that commit: ${p}`);
  }
  if ((await g(top, ["cat-file", "-t", obj])) !== "blob") {
    if (await isGitlink(top, hash, p)) throw SUBMODULE();
    throw new WorktreeError("not_found", `Not a file: ${p}`);
  }
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
      if (odd && /not a valid object|does not exist|bad object|ambiguous|bad file/i.test(err.stderr ?? "")) {
        if (await isGitlink(top, hash, p)) throw SUBMODULE();
        throw new WorktreeError("not_found", `No such file at that commit: ${p}`);
      }
      if (odd || !overflow || !err.stdout) throw new WorktreeError("git_failed", err.killed ? "git cat-file timed out" : first(err));
      // Output past the limit: the header is enough to answer too_large.
      stdout = err.stdout;
    }
    if (odd) return stdout;
    const nl = stdout.indexOf(10);
    const head = stdout.subarray(0, nl < 0 ? stdout.length : nl).toString("utf8").split(" ");
    if (head.at(-1) === "missing" || head.at(-1) === "ambiguous") {
      if (await isGitlink(top, hash, p)) throw SUBMODULE();
      throw new WorktreeError("not_found", `No such file at that commit: ${p}`);
    }
    if (head[1] !== "blob") {
      if (await isGitlink(top, hash, p)) throw SUBMODULE();
      throw new WorktreeError("not_found", `Not a file: ${p}`);
    }
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

export type GitDiffOptions = { base: unknown; ref?: unknown; allowed: (p: string) => boolean; ignoreSubmodules?: boolean };
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
  const [tracked, others] = await Promise.all([
    g(top, [...pre, submoduleFlag(o.ignoreSubmodules), "--no-abbrev", "--raw", "--numstat", target, "--"]),
    g(top, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name"]),
  ]);
  const parsed = parseRawNumstat(tracked);
  const files = withStats(parsed.files, parsed.stats);
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

const GITMODULES_MAX = 1024 * 1024;
const GITMODULES_SECTIONS = 1000;
function gitConfigValue(raw: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[++i]!;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n;
    } else if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "#" || c === ";")) break;
    else out += c;
  }
  return out.trim();
}
/**
 * The submodules a `.gitmodules` names, with git's rules where VS Code's regex parser differs: section and key names are
 * case-insensitive, quoted values take `\"` and `\\`, `#` and `;` start a comment outside quotes, a trailing `\` continues the
 * line, the last value of a key wins. Only `[submodule "name"]` sections with a path and a url count.
 */
export function parseGitmodules(text: string): { name: string; path: string; url: string }[] {
  const sections = new Map<string, { path?: string; url?: string }>();
  let cur: { path?: string; url?: string } | undefined;
  for (const line0 of text.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    const line = line0.trim();
    if (!line || line[0] === "#" || line[0] === ";") continue;
    const head = /^\[\s*([^\s\]"]+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (head) {
      if (head[1]!.toLowerCase() === "submodule" && head[2] !== undefined) {
        const name = head[2].replace(/\\(.)/g, "$1");
        if (!sections.has(name) && sections.size >= GITMODULES_SECTIONS) cur = undefined;
        else sections.set(name, (cur = sections.get(name) ?? {}));
      } else cur = undefined;
      continue;
    }
    const kv = /^([A-Za-z][-A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line);
    if (!kv || !cur) continue;
    const k = kv[1]!.toLowerCase();
    if (k === "path" || k === "url") cur[k] = gitConfigValue(kv[2]!);
  }
  return [...sections].flatMap(([name, v]) => (v.path && v.url ? [{ name, path: v.path, url: v.url }] : []));
}

export const REPO_CAPS = { entries: 20_000, ms: 2_000, count: 50 };
export type ListReposOptions = { settings: Settings["git"]; openFiles?: string[]; allowed: (p: string) => boolean; caps?: { entries: number; ms: number; count: number }; now?: () => number };
const sameName: (a: string, b: string) => boolean = process.platform === "win32" || process.platform === "darwin" ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
const byBytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const submodulePath = (p: string) => !p.includes("\0") && !isAbsolute(p) && !/^([\\/]|[A-Za-z]:)/.test(p) && p.split(/[\\/]/).every((seg) => seg !== ".." && seg.toLowerCase() !== ".git");
type RepoEntry = { path: string; kind: GitRepo["kind"]; parent?: string; outsideRoots?: true; own?: string };

/**
 * The repositories of `cwd` as VS Code finds them (docs/spec.md "git.repos"): its own, nested ones from a bounded folder scan,
 * `scanRepositories`, open files and `.gitmodules`. File system calls only (never a git process); `cwd` is canonical and already allowed.
 */
export async function listRepos(cwd: string, o: ListReposOptions): Promise<GitReposResult> {
  const caps = o.caps ?? REPO_CAPS;
  const now = o.now ?? Date.now;
  const cfg = o.settings;
  const found = new Map<string, RepoEntry>();
  const truncated: NonNullable<GitReposResult["truncated"]> = {};
  const ignored = await Promise.all(cfg.ignoredRepositories.map((e) => realAsync(resolve(cwd, e))));
  const add = async (dir: string, kind: GitRepo["kind"], parent?: string): Promise<void> => {
    if (!(await lstat(join(dir, ".git")).then(() => true, () => false))) return;
    const top = await realAsync(dir);
    const have = found.get(top);
    if (have) {
      if (kind === "submodule" && have.kind === "nested") Object.assign(have, { kind, parent });
      return;
    }
    const r = await repoRead(top);
    if (r === null) return;
    let outside = r === "foreign";
    if (r !== "foreign") {
      if (kind !== "main" && r.own !== r.common) return;
      outside = escapesRoots(r, o.allowed);
    }
    if (kind !== "main" && ignored.some((i) => sameName(i, top))) return;
    if (found.size >= caps.count) {
      truncated.scan ??= "count";
      return;
    }
    found.set(top, { path: top, kind, ...(parent && { parent }), ...(outside && { outsideRoots: true as const }), ...(r !== "foreign" && { own: r.own }) });
  };

  const own = await gitTopOf(cwd);
  if (own && (own === cwd || cfg.openRepositoryInParentFolders !== "never")) await add(own, "main");

  const auto = cfg.autoRepositoryDetection;
  if (auto === true || auto === "subFolders") {
    const start = now();
    let seen = 0;
    const max = cfg.repositoryScanMaxDepth;
    const queue = [{ dir: cwd, depth: 0 }];
    for (let i = 0; i < queue.length; i++) {
      const { dir, depth } = queue[i]!;
      if (max !== -1 && depth >= max) continue;
      if (now() - start > caps.ms) {
        truncated.scan ??= "time";
        break;
      }
      const list = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
      if (!list) continue;
      seen += list.length;
      if (seen > caps.entries) {
        truncated.scan ??= "entries";
        break;
      }
      for (const e of list) {
        if (!e.isDirectory() || sameName(e.name, ".git") || cfg.repositoryScanIgnoredFolders.some((n) => sameName(n, e.name))) continue;
        const child = join(dir, e.name);
        queue.push({ dir: child, depth: depth + 1 });
        await add(child, "nested");
      }
    }
    for (const entry of cfg.scanRepositories) {
      const p = resolve(cwd, entry);
      if (inside(cwd, p) && inside(cwd, await realAsync(p))) await add(p, "nested");
    }
  }
  if (auto === true || auto === "openEditors") {
    for (const f of o.openFiles ?? []) {
      const rf = await realAsync(f);
      if (!inside(cwd, rf)) continue;
      const t = await gitTopOf(dirname(rf));
      if (t && inside(cwd, t)) await add(t, "nested");
    }
  }

  if (cfg.detectSubmodules) {
    const done = new Set<string>();
    for (;;) {
      const next = [...found.values()].find((e) => !e.outsideRoots && !done.has(e.path));
      if (!next) break;
      done.add(next.path);
      const file = join(next.path, ".gitmodules");
      const st = await stat(file).catch(() => undefined);
      if (!st?.isFile() || st.size > GITMODULES_MAX || !inside(next.path, await realAsync(file))) continue;
      const subs = parseGitmodules(await readFile(file, "utf8").catch(() => ""));
      if (subs.length > cfg.detectSubmodulesLimit) (truncated.submodules ??= []).push({ repo: next.path, count: subs.length });
      for (const sub of subs.slice(0, cfg.detectSubmodulesLimit)) {
        if (!submodulePath(sub.path)) continue;
        const abs = resolve(next.path, sub.path);
        if (!inside(next.path, abs) || !inside(next.path, await realAsync(abs))) continue;
        await add(abs, "submodule", next.path);
      }
    }
  }

  const all = [...found.values()];
  for (const e of all) {
    if (e.parent) continue;
    let best: RepoEntry | undefined;
    for (const c of all) if (c !== e && inside(c.path, e.path) && (!best || c.path.length > best.path.length)) best = c;
    if (best && e.kind !== "main") e.parent = best.path;
  }
  const kids = (path: string | undefined) => all.filter((e) => e.parent === path).sort((a, b) => (a.kind === "main" ? -1 : b.kind === "main" ? 1 : a.kind === b.kind ? 0 : a.kind === "submodule" ? -1 : 1) || byBytes(a.path, b.path));
  const ordered: RepoEntry[] = [];
  const walk = (e: RepoEntry) => {
    ordered.push(e);
    for (const c of kids(e.path)) walk(c);
  };
  for (const e of all.filter((x) => !x.parent || !found.has(x.parent)).sort((a, b) => (a.kind === "main" ? -1 : b.kind === "main" ? 1 : 0) || byBytes(a.path, b.path))) walk(e);

  const repos: GitRepo[] = [];
  for (const e of ordered) {
    let branch: string | undefined;
    if (!e.outsideRoots && e.own) {
      const head = (await readFile(join(e.own, "HEAD"), "utf8").catch(() => "")).trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
      branch = ref ?? (/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ? head.slice(0, 7) : undefined);
    }
    repos.push({ path: e.path, rel: relative(cwd, e.path).split(sep).join("/"), kind: e.kind, ...(e.parent && { parent: e.parent }), ...(branch && { branch }), ...(e.outsideRoots && { outsideRoots: true as const }) });
  }
  return { repos, ...((truncated.scan || truncated.submodules) && { truncated }) };
}
