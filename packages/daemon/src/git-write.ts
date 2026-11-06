// Git writes of the Changes tab (docs/spec.md "Layout", Changes tab; wire `git.commitFiles`): started by a click, so the
// repository's hooks run like in a terminal; they never prompt. Later Git ops (rollback, checkout) extend this module.
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitCommitMenu, GitCommitted, GitOperation, GitOperationKind } from "@claude-ui/protocol";
import { gitOperation, gitRefs, hostOf, isHash, pinScope, repoPath, topIn, WorktreeError } from "./git.ts";
import { branchInfo, branchRef, exclusive, gitBranch, HARDEN, MAX_ERROR, tidy, writeEnv, type RemoteOptions } from "./git-remote.ts";
import { runGit } from "./git-runner.ts";

/** Test seam: the timeout of a write (hooks may run tests). */
export const writeConfig = { timeout: 300_000 };
/** Test seam: what `gitCommitDiff` hands to the prompt (characters; bytes git may print before the patch is dropped). */
export const diffConfig = { maxChars: 60_000, maxBuffer: 4 << 20 };
const MAX_PATHS = 10_000;
const MAX_MESSAGE = 65_536;
const MAX_OUTPUT = 8000;

type Failure = Error & { stderr?: string; stdout?: Buffer; killed?: boolean; code?: number | string };
type Run = { out: string; code: number };
/** One git call of a write. `soft`: exit code 1 is an answer, not a failure. Failure text: stdout and stderr (hooks print on either). */
async function run(top: string, args: string[], env: NodeJS.ProcessEnv, o: { input?: string; soft?: boolean; raw?: boolean; maxBuffer?: number } = {}): Promise<Run> {
  try {
    const r = await runGit({ cwd: top, args: [...HARDEN, ...args], env, input: o.input, timeout: writeConfig.timeout, killTree: true, maxBuffer: o.maxBuffer });
    return { out: o.raw ? r.stdout.toString("utf8") : tidy(`${r.stdout.toString("utf8")}\n${r.stderr}`, MAX_OUTPUT), code: 0 };
  } catch (e) {
    const err = e as Failure;
    // `maxBuffer` set: output over it is an answer (code -1), not a failure. `raw`: stdout as git printed it.
    if (o.maxBuffer && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { out: "", code: -1 };
    if (err.killed) throw new WorktreeError("git_failed", `git ${args.find((a) => !a.startsWith("-"))} timed out after ${Math.round(writeConfig.timeout / 1000)} s`);
    if (o.soft && err.code === 1) return { out: "", code: 1 };
    const text = tidy(`${err.stdout?.toString("utf8") ?? ""}\n${err.stderr ?? ""}`, MAX_ERROR) || tidy(err.message, MAX_ERROR);
    throw new WorktreeError("git_failed", text);
  }
}
const bad = (m: string) => new WorktreeError("bad_request", m);
const ask = async (top: string, args: string[], env: NodeJS.ProcessEnv) => (await run(top, args, env, { soft: true }));

const LITERAL = ["--literal-pathspecs"];
const FROM_STDIN = ["--pathspec-from-file=-", "--pathspec-file-nul"];

/**
 * Runs `fn` with a temporary index (`GIT_INDEX_FILE` in `tmp`) that starts from HEAD (`--empty` when `unborn`) and takes
 * `files` with their working-tree content; the file and its `.lock` are removed afterwards, also on failure.
 */
async function withCheckedIndex<T>(top: string, env: NodeJS.ProcessEnv, unborn: boolean, files: string[], fn: (tmp: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const name = `claude-ui-commit-${randomUUID()}.index`;
  // git's own view of the path for GIT_INDEX_FILE; the daemon's view for the clean-up.
  const gitPath = (await run(top, ["rev-parse", "--git-path", name], env)).out;
  const hostPath = hostOf(top, gitPath);
  const tmp = { ...env, GIT_INDEX_FILE: gitPath };
  try {
    await run(top, unborn ? ["read-tree", "--empty"] : ["read-tree", "HEAD"], tmp);
    if (files.length) await run(top, [...LITERAL, "add", "-A", ...FROM_STDIN], tmp, { input: files.join("\0") });
    return await fn(tmp);
  } finally {
    await rm(hostPath, { force: true }).catch(() => {});
    await rm(`${hostPath}.lock`, { force: true }).catch(() => {});
  }
}

/**
 * Commits exactly `paths` (relative to the repository top; a rename names both sides) with their working-tree content, like
 * `git commit --only -- <paths>` but also for untracked files: a temporary index starts from HEAD, takes the paths, and
 * is committed; other entries of the real index and the work tree stay. `amend` rewrites HEAD (no path: its message only).
 * Needs git 2.26 (`--pathspec-from-file`). `push`: also returns the push dialog data of HEAD's branch. Null outside a work tree.
 */
export async function gitCommitFiles(cwd: string, o: { paths: unknown; message: unknown; amend?: unknown; push?: unknown } & RemoteOptions): Promise<GitCommitted | null> {
  const { paths, message } = o;
  if (!Array.isArray(paths) || paths.length > MAX_PATHS) throw bad("paths must be a list of at most 10000 paths");
  const files = paths.map(repoPath);
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE || message.includes("\0")) throw bad("message must be non-empty text");
  if ((o.amend !== undefined && typeof o.amend !== "boolean") || (o.push !== undefined && typeof o.push !== "boolean")) throw bad("amend and push must be booleans");
  const amend = o.amend === true;
  if (!files.length && !amend) throw bad("No file to commit");
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    const env = await writeEnv(top);
    let branchRef: string | undefined;
    const committed = await exclusive(top, async () => {
      const head = await ask(top, ["rev-parse", "--verify", "-q", "HEAD"], env);
      if (amend && head.code === 1) throw bad("No commit to amend");
      // The temporary index starts from HEAD: it has no conflict entries, and the final `reset` would clear the real index's
      // ones; a merge commit would lose its second parent. Committing inside these states is the conflict banner's job.
      const op = await gitOperation(top);
      if (op) throw bad(op.conflicted.length ? "Resolve the conflicts first" : `Finish or abort the ${op.kind} first`);
      if (o.push) {
        const sym = await ask(top, ["symbolic-ref", "-q", "HEAD"], env);
        if (sym.code === 1) throw bad("HEAD is detached: use Commit");
        branchRef = sym.out;
      }
      let out = await withCheckedIndex(top, env, head.code === 1, files, async (tmp) => (await run(top, ["commit", "-F", "-", ...(amend ? ["--amend"] : [])], tmp, { input: message })).out);
      // The commit is made: the real index takes HEAD's entries of the committed paths; a failure keeps the commit and says so.
      if (files.length) {
        try {
          await run(top, [...LITERAL, "reset", "-q", ...FROM_STDIN], env, { input: files.join("\0") });
        } catch (e) {
          out += `\nThe index of the committed files was not updated: ${(e as Error).message}`;
        }
      }
      return { hash: (await run(top, ["rev-parse", "HEAD"], env)).out, output: tidy(out, MAX_OUTPUT), refs: await gitRefs(top, o.allowed) };
    });
    return branchRef ? { ...committed, push: (await gitBranch(top, branchRef, o)) ?? undefined } : committed;
  });
}

// ---- Merge, rebase, and the conflict banner's Continue and Abort (docs/spec.md "Layout", Graph and Changes tabs) ----

/** The reply of a merge, rebase, continue or abort. */
export type Written = { output: string; refs: string | null; operation?: GitOperation };
/** Continue runs `<kind> --continue`, which would open an editor for the message: the one the operation already has stays. */
const writeEnvNoEditor = async (top: string): Promise<NodeJS.ProcessEnv> => ({ ...(await writeEnv(top)), GIT_EDITOR: "true" });

/** One git call that may stop on conflicts: git fails and the repository has conflicted files = a stop (a success with `operation`), else the failure. */
async function runStop(top: string, args: string[], env: NodeJS.ProcessEnv, allowed: (p: string) => boolean): Promise<Written> {
  try {
    const { out } = await run(top, args, env);
    return { output: out, refs: await gitRefs(top, allowed) };
  } catch (e) {
    if (!(e instanceof WorktreeError) || e.code !== "git_failed") throw e;
    // A state that stays without conflicts (a failed hook, an empty cherry-pick) is a failure; the banner shows from the next read.
    const operation = await gitOperation(top).catch(() => undefined);
    if (!operation?.conflicted.length) throw e;
    return { output: e.message, refs: await gitRefs(top, allowed), operation };
  }
}

type MergeRebase = { ref: unknown; local: unknown; headRef: unknown; headHash: unknown; argv: unknown } & RemoteOptions;
/**
 * `git merge --no-edit <ref>` or `git rebase <ref>` of HEAD, as the branch menu showed it (`gitBranch`): the daemon runs only the argv it computes again
 * to the same words, against the same branch and HEAD. A stop on conflicts is a success whose reply has `operation`. Null outside a work tree.
 */
export async function gitMergeRebase(cwd: string, verb: "merge" | "rebase", o: MergeRebase): Promise<Written | null> {
  const ref = branchRef(o.ref);
  if (!isHash(o.local) || !isHash(o.headHash) || typeof o.headRef !== "string") throw bad("ref, local, headRef and headHash must be a branch, commit hashes and the shown HEAD");
  if (!Array.isArray(o.argv) || o.argv.length > 64 || !o.argv.every((a) => typeof a === "string")) throw bad("Missing command");
  const shown = o.argv as string[];
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return exclusive(top, async () => {
      const env = await writeEnvNoEditor(top);
      const info = await branchInfo(top, ref, env, new Set());
      if (o.local !== info.local) throw new WorktreeError("stale", `${ref.slice(11)} moved since the menu opened: reopen it`);
      if (o.headRef !== info.headRef || o.headHash !== info.headHash) throw new WorktreeError("stale", "HEAD moved since the menu opened: reopen it");
      const argv = info[verb];
      if (!argv) throw bad(info.why?.[verb] ?? `${verb} is not available`);
      if (shown.length !== argv.length || shown.some((a, i) => a !== argv[i])) throw new WorktreeError("stale", "The command changed since the menu opened");
      return runStop(top, argv.slice(HARDEN.length), env, o.allowed);
    });
  });
}

const MARKER_MAX = 8 << 20;
const MARKER = /^(<{7}|>{7})(\s|$)/m;
/** Conflicted paths whose text still has a conflict marker line. Skips what git cannot have merged as text: a link, a missing file, a folder (submodule), a binary, a file over 8 MiB. */
async function withMarkers(top: string, files: string[]): Promise<string[]> {
  const hit: string[] = [];
  for (const f of files) {
    try {
      const p = join(top, f);
      const st = await lstat(p);
      if (!st.isFile() || st.size > MARKER_MAX) continue;
      const fh = await open(p, "r");
      try {
        const b = Buffer.alloc(st.size);
        const { bytesRead } = await fh.read(b, 0, st.size, 0);
        const t = b.subarray(0, bytesRead);
        // shortcut: default conflict-marker-size 7 only, upgrade when a repo sets the attribute.
        if (!t.subarray(0, 8000).includes(0) && MARKER.test(t.toString("utf8"))) hit.push(f);
      } finally {
        await fh.close();
      }
    } catch {
      // gone or unreadable: nothing to check
    }
  }
  return hit;
}

/** The unfinished operation as the banner showed it (`kind`), else `stale`. */
async function sameOperation(top: string, kind: GitOperationKind): Promise<GitOperation> {
  const op = await gitOperation(top);
  if (!op) throw new WorktreeError("stale", "No git operation is in progress: reload");
  if (op.kind !== kind) throw new WorktreeError("stale", "The repository changed: reload");
  return op;
}
const KINDS = new Set<string>(["merge", "rebase", "cherry-pick", "revert", "am", "conflict"]);
const kindOf = (k: unknown): GitOperationKind => {
  if (typeof k !== "string" || !KINDS.has(k)) throw bad("Unknown operation");
  return k as GitOperationKind;
};

/**
 * Conflict banner Continue: the conflicted files count as resolved (`add -A`, so a deletion counts too) unless a conflict marker line remains, then
 * `<kind> --continue`; a rebase may stop again on the next commit (`operation` in the reply). Kind `conflict` (no operation, only unmerged entries) clears
 * the unmerged entries (`reset`) and keeps the work tree. Null outside a work tree.
 */
export async function gitContinue(cwd: string, o: { kind: unknown } & RemoteOptions): Promise<Written | null> {
  const kind = kindOf(o.kind);
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return exclusive(top, async () => {
      const env = await writeEnvNoEditor(top);
      const files = (await sameOperation(top, kind)).conflicted;
      const marked = await withMarkers(top, files);
      if (marked.length) throw bad(`Conflict markers remain in ${marked.slice(0, 3).join(", ")}${marked.length > 3 ? ` (+${marked.length - 3} more)` : ""}`);
      const input = files.join("\0");
      if (files.length) await run(top, [...LITERAL, ...(kind === "conflict" ? ["reset", "-q"] : ["add", "-A"]), ...FROM_STDIN], env, { input });
      if (kind === "conflict") return { output: "", refs: await gitRefs(top, o.allowed) };
      return runStop(top, [kind, "--continue"], env, o.allowed);
    });
  });
}

/** Conflict banner Abort: `<kind> --abort`; kind `conflict`: the conflicted paths back to HEAD (other work stays; a failed `stash pop` keeps its entry). Null outside a work tree. */
export async function gitAbort(cwd: string, o: { kind: unknown } & RemoteOptions): Promise<Written | null> {
  const kind = kindOf(o.kind);
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return exclusive(top, async () => {
      const env = await writeEnvNoEditor(top);
      const op = await sameOperation(top, kind);
      if (kind !== "conflict") return { output: (await run(top, [kind, "--abort"], env)).out, refs: await gitRefs(top, o.allowed) };
      // Only the conflicted paths go back to HEAD (`reset --merge` would also drop other staged work). One that HEAD lacks (added by the stash) is removed.
      const files = op.conflicted;
      const inHead = new Set((await run(top, [...LITERAL, "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...files], env)).out.split("\0").filter(Boolean));
      const tracked = files.filter((f) => inHead.has(f));
      const added = files.filter((f) => !inHead.has(f));
      if (tracked.length) await run(top, [...LITERAL, "restore", "--source=HEAD", "--staged", "--worktree", ...FROM_STDIN], env, { input: tracked.join("\0") });
      if (added.length) {
        await run(top, [...LITERAL, "rm", "-q", "-f", "--cached", ...FROM_STDIN], env, { input: added.join("\0") });
        await Promise.all(added.map((f) => rm(join(top, f), { force: true })));
      }
      return { output: "", refs: await gitRefs(top, o.allowed) };
    });
  });
}

// ---- Graph commit menu: Undo Commit, Revert Commit, Cherry-Pick, Reset Current Branch to Here (docs/spec.md "Layout", Graph tab) ----

const MAX_LOSE = 50;
const shortRef = (r: string) => r.replace(/^refs\/(heads|remotes)\//, "");

/** Everything the commit menu shows for `hash` and the exact argv of each action, re-read from git. `hard`: also the files a hard reset would lose. */
async function commitInfo(top: string, hash: string, env: NodeJS.ProcessEnv, hard: boolean): Promise<GitCommitMenu> {
  const known = await ask(top, ["rev-parse", "--verify", "-q", `${hash}^{commit}`], env);
  if (known.code === 1) throw bad("Unknown commit");
  const parents = (await run(top, ["rev-list", "--parents", "-n", "1", hash], env)).out.split(" ").length - 1;
  const head = (await ask(top, ["rev-parse", "--verify", "-q", "HEAD"], env)).out;
  const headRef = (await ask(top, ["symbolic-ref", "-q", "HEAD"], env)).out;
  const info: GitCommitMenu = { hash, parents };
  if (headRef) info.headRef = headRef;
  if (head) info.headHash = head;
  const op = await gitOperation(top);
  const blocked = !headRef ? "HEAD is detached" : !head ? "No commits yet" : op ? (op.conflicted.length ? "Resolve the conflicts first" : `Finish or abort the ${op.kind} first`) : undefined;
  if (blocked) return { ...info, why: { undo: blocked, revert: blocked, cherryPick: blocked, reset: blocked } };
  const current = shortRef(headRef);
  const why: NonNullable<GitCommitMenu["why"]> = {};
  const ancestor = async (a: string, b: string) => {
    try {
      return (await ask(top, ["merge-base", "--is-ancestor", a, b], env)).code === 0;
    } catch {
      return false; // an upstream that is gone: nothing is known to be pushed
    }
  };
  const upstream = (await run(top, ["for-each-ref", "--format=%(upstream)", headRef], env)).out;
  if (hash !== head) why.undo = "Only the current commit";
  else if (parents === 0) why.undo = "This is the first commit";
  else if (upstream && (await ancestor("HEAD", upstream))) why.undo = `Already pushed to ${shortRef(upstream)}`;
  else info.undo = [...HARDEN, "reset", "--soft", "HEAD~1"];
  if (parents > 1) why.revert = "Merge commit: revert it in a terminal";
  else if (!(await ancestor(hash, "HEAD"))) why.revert = `Not on ${current}`;
  else info.revert = [...HARDEN, "revert", "--no-edit", hash];
  if (parents > 1) why.cherryPick = "Merge commit: cherry-pick it in a terminal";
  else if (await ancestor(hash, "HEAD")) why.cherryPick = `Already on ${current}`;
  else info.cherryPick = [...HARDEN, "cherry-pick", hash];
  // --no-recurse-submodules: a user's `submodule.recurse=true` would reset submodule work the preview does not list.
  info.reset = { soft: [...HARDEN, "reset", "--soft", hash], mixed: [...HARDEN, "reset", "--mixed", hash], hard: [...HARDEN, "reset", "--hard", "--no-recurse-submodules", hash] };
  if (hard) {
    // Tracked changes of the index and work tree, plus untracked files the target tree would overwrite.
    // Raw stdout: `run` keeps only the last 8000 chars, which would cut the list the dialog and the fingerprint rest on.
    const names = async (...a: string[]) => {
      const r = await runGit({ cwd: top, args: [...HARDEN, "diff", "--no-renames", "--name-only", "-z", ...a], env, timeout: writeConfig.timeout, killTree: true }).catch((e: Failure) => {
        throw new WorktreeError("git_failed", tidy(`${e.stdout?.toString("utf8") ?? ""}\n${e.stderr ?? ""}` || e.message, MAX_ERROR));
      });
      return r.stdout.toString("utf8").split("\0").filter(Boolean);
    };
    const lose = new Set(await names("HEAD"));
    for (const f of await names("--diff-filter=A", "HEAD", hash)) if (await lstat(join(top, f)).then(() => true, () => false)) lose.add(f);
    const paths = [...lose].sort();
    const h = createHash("sha256").update(head);
    for (const f of paths) {
      const st = await lstat(join(top, f)).catch(() => undefined);
      h.update(`\0${f}\0${st ? `${st.size}:${st.mtimeMs}` : "-"}`);
    }
    info.lose = paths.slice(0, MAX_LOSE);
    info.loseCount = paths.length;
    info.dirty = h.digest("hex");
  }
  if (Object.keys(why).length) info.why = why;
  return info;
}

/** Commit menu data of `hash`; null outside a work tree. Read-only: no lock. */
export async function gitCommitMenu(cwd: string, o: { hash: unknown; hard?: unknown } & RemoteOptions): Promise<GitCommitMenu | null> {
  if (!isHash(o.hash)) throw bad("Invalid commit hash");
  const hash = o.hash;
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return commitInfo(top, hash, await writeEnv(top), o.hard === true);
  });
}

type CommitAction = { hash: unknown; headRef: unknown; headHash: unknown; argv: unknown; mode?: unknown; dirty?: unknown } & RemoteOptions;
/**
 * Undo Commit, Revert Commit, Cherry-Pick or Reset Current Branch to Here, as the menu showed it (`gitCommitMenu`): the daemon runs only the argv it computes
 * again to the same words, against the same HEAD; a hard reset also needs the same lost files (`dirty`). A stop on conflicts is a success whose reply has `operation`.
 */
export async function gitCommitAction(cwd: string, action: "undo" | "revert" | "cherryPick" | "reset", o: CommitAction): Promise<Written | null> {
  if (!isHash(o.hash) || !isHash(o.headHash) || typeof o.headRef !== "string") throw bad("hash, headRef and headHash must be a commit, the shown branch and its commit");
  if (!Array.isArray(o.argv) || o.argv.length > 64 || !o.argv.every((a) => typeof a === "string")) throw bad("Missing command");
  if (action === "reset" && o.mode !== "soft" && o.mode !== "mixed" && o.mode !== "hard") throw bad("mode must be soft, mixed or hard");
  if (action === "reset" && o.mode === "hard" && typeof o.dirty !== "string") throw bad("A hard reset needs the files the dialog showed");
  const { hash, shown } = { hash: o.hash, shown: o.argv as string[] };
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return exclusive(top, async () => {
      const env = await writeEnvNoEditor(top);
      const info = await commitInfo(top, hash, env, o.mode === "hard");
      if (o.headRef !== info.headRef || o.headHash !== info.headHash) throw new WorktreeError("stale", "HEAD moved since the menu opened: reopen it");
      const argv = action === "reset" ? info.reset?.[o.mode as "soft" | "mixed" | "hard"] : info[action];
      if (!argv) throw bad(info.why?.[action] ?? `${action} is not available`);
      if (shown.length !== argv.length || shown.some((a, i) => a !== argv[i])) throw new WorktreeError("stale", "The command changed since the menu opened");
      if (o.mode === "hard" && o.dirty !== info.dirty) throw new WorktreeError("stale", "Files changed since the dialog opened: reopen it");
      // shortcut: no "snapshot before" yet; Local history and Timeline (#565) hook in here, before reset --hard.
      return runStop(top, argv.slice(HARDEN.length), env, o.allowed);
    });
  });
}

export type CommitDiff = { diff: string; /** Characters before the cut. */ total: number; /** `chars`: the patch was cut to `diffConfig.maxChars`; `patch`: too big, only the file list is given. */ cut?: "chars" | "patch" };

/**
 * The diff Commit would record for `paths` (same temporary index as `gitCommitFiles`: untracked, deleted and renamed files
 * included, unchecked files and the real index untouched), as a file list and patch capped at `diffConfig.maxChars`.
 * No repository lock: it writes only its own index file. Null outside a work tree.
 */
export async function gitCommitDiff(cwd: string, o: { paths: unknown } & Pick<RemoteOptions, "allowed">): Promise<CommitDiff | null> {
  if (!Array.isArray(o.paths) || o.paths.length > MAX_PATHS) throw bad("paths must be a list of at most 10000 paths");
  const files = o.paths.map(repoPath);
  if (!files.length) throw bad("No file to describe");
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    const env = await writeEnv(top);
    const unborn = (await ask(top, ["rev-parse", "--verify", "-q", "HEAD"], env)).code === 1;
    return withCheckedIndex(top, env, unborn, files, async (tmp) => {
      const base = ["diff", "--cached", "-M", "--no-ext-diff", "--no-textconv", "--no-color", "--stat-width=200"];
      const full = await run(top, [...base, "--patch-with-stat"], tmp, { raw: true, maxBuffer: diffConfig.maxBuffer, soft: true });
      if (full.code === -1) {
        const list = (await run(top, [...base, "--stat", "--summary"], tmp, { raw: true })).out;
        return { diff: list.slice(0, diffConfig.maxChars), total: list.length, cut: "patch" as const };
      }
      if (full.out.length <= diffConfig.maxChars) return { diff: full.out, total: full.out.length };
      const cut = full.out.slice(0, diffConfig.maxChars);
      return { diff: cut.slice(0, cut.lastIndexOf("\n") + 1), total: full.out.length, cut: "chars" as const };
    });
  });
}

// ---- New branch, checkout and Smart checkout (GH-561) ----

/** git's refusal when tracked local changes would be lost; the switch runs with `LC_ALL=C`, so the text is English. */
const LOCAL_CHANGES = /Your local changes to the following files would be overwritten by checkout/;
const REMOTE_REF = /^refs\/remotes\/[^\0-\x20\x7f~^:?*[\\/][^\0-\x20\x7f~^:?*[\\]*\/[^\0-\x20\x7f~^:?*[\\]+$/;

/** The refusals shared by both requests: a boolean `smart`, and no unfinished operation. */
const refuseOperation = async (top: string) => {
  const op = await gitOperation(top);
  if (op) throw bad(op.conflicted.length ? "Resolve the conflicts first" : `Finish or abort the ${op.kind} first`);
};

/**
 * `git switch <args>`. Tracked changes that would be overwritten: `local_changes` (the UI offers Smart checkout), or with `smart` stash them,
 * switch and `stash pop` (a conflict stops like a merge: `operation`). Staged state is not restored (plain `pop`, no `--index`).
 */
async function switchTo(top: string, args: string[], smart: boolean, env: NodeJS.ProcessEnv, allowed: (p: string) => boolean): Promise<Written> {
  const lc = { ...env, LC_ALL: "C" };
  try {
    const { out } = await run(top, ["switch", ...args], lc);
    return { output: out, refs: await gitRefs(top, allowed) };
  } catch (e) {
    if (!(e instanceof WorktreeError) || e.code !== "git_failed" || !LOCAL_CHANGES.test(e.message)) throw e;
    if (!smart) throw new WorktreeError("local_changes", e.message);
  }
  const from = (await run(top, ["symbolic-ref", "--short", "-q", "HEAD"], env, { soft: true }).catch(() => ({ out: "" }))).out || "HEAD";
  // shortcut: no "snapshot before" call yet, Local history and Timeline (#565) is not on this base; call it before the stash push when it lands.
  await run(top, ["stash", "push", "-m", `claude-ui smart checkout ${from} -> ${args[args.length - 1]}`], env);
  const stash = (await run(top, ["rev-parse", "refs/stash"], env)).out;
  let switched: string;
  try {
    switched = (await run(top, ["switch", ...args], lc)).out;
  } catch (e) {
    const back = await run(top, ["stash", "pop"], env).then(() => "", () => "\nYour changes are kept in the stash: run git stash pop in a terminal.");
    throw back && e instanceof WorktreeError ? new WorktreeError(e.code, e.message + back) : e;
  }
  // Another process may have pushed a stash since: popping would apply its entry.
  if ((await run(top, ["rev-parse", "-q", "--verify", "refs/stash"], env, { soft: true })).out !== stash) {
    return { output: `${switched}\nYour changes stay in the stash: run git stash pop in a terminal.`, refs: await gitRefs(top, allowed) };
  }
  try {
    const popped = await runStop(top, ["stash", "pop"], env, allowed);
    return { ...popped, output: `${switched}\n${popped.output}`.trim() };
  } catch (e) {
    throw new WorktreeError("git_failed", `${(e as Error).message}\nYour changes are kept in the stash: run git stash pop in a terminal.`);
  }
}

/** Shared frame of both requests: pin, top, lock, no unfinished operation. */
async function switching(cwd: string, o: RemoteOptions, fn: (top: string, env: NodeJS.ProcessEnv) => Promise<Written>): Promise<Written | null> {
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return exclusive(top, async () => {
      await refuseOperation(top);
      return fn(top, await writeEnvNoEditor(top));
    });
  });
}
const smartOf = (s: unknown) => {
  if (s !== undefined && typeof s !== "boolean") throw bad("smart must be a boolean");
  return s === true;
};

/** `git branch <name> <at|HEAD>`, or with `checkout` `git switch -c <name> [<at>]`. `at`: a full commit hash. */
export async function gitBranchCreate(cwd: string, o: { name: unknown; at?: unknown; checkout?: unknown; smart?: unknown } & RemoteOptions): Promise<Written | null> {
  const { name, at } = o;
  if (typeof name !== "string" || !name || name.length > 255 || name.startsWith("-") || name.includes("\0")) throw bad("Not a valid branch name");
  if (at !== undefined && !isHash(at)) throw bad("at must be a commit hash");
  if (o.checkout !== undefined && typeof o.checkout !== "boolean") throw bad("checkout must be a boolean");
  const smart = smartOf(o.smart);
  return switching(cwd, o, async (top, env) => {
    await run(top, ["check-ref-format", "--branch", name], env).catch(() => {
      throw bad("Not a valid branch name");
    });
    if (!o.checkout) return { output: (await run(top, ["branch", name, ...(at ? [at] : ["HEAD"])], env)).out, refs: await gitRefs(top, o.allowed) };
    return switchTo(top, ["-c", name, ...(at ? [at] : [])], smart, env, o.allowed);
  });
}

/** Checks out a local branch (`refs/heads/x`), or a remote branch (`refs/remotes/r/b`) as a new local branch that tracks it. */
export async function gitCheckout(cwd: string, o: { ref: unknown; smart?: unknown } & RemoteOptions): Promise<Written | null> {
  const remote = typeof o.ref === "string" && REMOTE_REF.test(o.ref) && !o.ref.endsWith("/HEAD") && o.ref.length <= 255 && !o.ref.includes("..") && !o.ref.includes("@{");
  const ref = remote ? (o.ref as string) : branchRef(o.ref);
  const smart = smartOf(o.smart);
  return switching(cwd, o, async (top, env) => {
    if (remote) {
      if ((await run(top, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], env, { soft: true })).code !== 0) throw bad("Not a remote branch");
      return switchTo(top, ["--track", ref], smart, env, o.allowed);
    }
    return switchTo(top, ["--no-guess", ref.slice("refs/heads/".length)], smart, env, o.allowed);
  });
}
