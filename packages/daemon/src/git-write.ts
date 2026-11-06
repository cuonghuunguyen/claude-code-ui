// Git writes of the Changes tab (docs/spec.md "Layout", Changes tab; wire `git.commitFiles`): started by a click, so the
// repository's hooks run like in a terminal; they never prompt. Later Git ops (rollback, checkout) extend this module.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitCommitMenu, GitCommitted, GitOperation, GitOperationKind, GitRollbackFile, GitRollbackPreview, GitStash, HistoryReason } from "@claude-ui/protocol";
import { gitOperation, gitRefs, hostOf, isHash, pinScope, repoPath, topIn, WorktreeError } from "./git.ts";
import { branchInfo, branchRef, exclusive, gitBranch, HARDEN, MAX_ERROR, tidy, writeEnv, type RemoteOptions } from "./git-remote.ts";
import { openChecked, OPEN_READ, readAll, sameFile } from "./fd-check.ts";
import { runGit } from "./git-runner.ts";
import { MAX_BYTES } from "./local-history.ts";

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
export async function gitAbort(cwd: string, o: { kind: unknown; snapshot: Snapshot } & RemoteOptions): Promise<Written | null> {
  const kind = kindOf(o.kind);
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return exclusive(top, async () => {
      const env = await writeEnvNoEditor(top);
      const op = await sameOperation(top, kind);
      // Conflict markers and the work the abort drops (tracked changes vs HEAD) go to Local history first.
      snapFiles(top, new Set([...op.conflicted, ...(kind === "conflict" ? [] : await nameList(top, ["diff", "--name-only", "-z", "--no-renames", "HEAD"], env))]), "abort", o.snapshot);
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
async function commitInfo(top: string, hash: string, env: NodeJS.ProcessEnv, hard: boolean): Promise<{ menu: GitCommitMenu; lost: string[] }> {
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
  if (blocked) return { menu: { ...info, why: { undo: blocked, revert: blocked, cherryPick: blocked, reset: blocked } }, lost: [] };
  const current = shortRef(headRef);
  const why: NonNullable<GitCommitMenu["why"]> = {};
  let lost: string[] = [];
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
    const paths = (lost = [...lose].sort());
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
  return { menu: info, lost };
}

/** Commit menu data of `hash`; null outside a work tree. Read-only: no lock. */
export async function gitCommitMenu(cwd: string, o: { hash: unknown; hard?: unknown } & RemoteOptions): Promise<GitCommitMenu | null> {
  if (!isHash(o.hash)) throw bad("Invalid commit hash");
  const hash = o.hash;
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return (await commitInfo(top, hash, await writeEnv(top), o.hard === true)).menu;
  });
}

type CommitAction = { hash: unknown; headRef: unknown; headHash: unknown; argv: unknown; mode?: unknown; dirty?: unknown; snapshot: Snapshot } & RemoteOptions;
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
      const { menu: info, lost } = await commitInfo(top, hash, env, o.mode === "hard");
      if (o.headRef !== info.headRef || o.headHash !== info.headHash) throw new WorktreeError("stale", "HEAD moved since the menu opened: reopen it");
      const argv = action === "reset" ? info.reset?.[o.mode as "soft" | "mixed" | "hard"] : info[action];
      if (!argv) throw bad(info.why?.[action] ?? `${action} is not available`);
      if (shown.length !== argv.length || shown.some((a, i) => a !== argv[i])) throw new WorktreeError("stale", "The command changed since the menu opened");
      if (o.mode === "hard" && o.dirty !== info.dirty) throw new WorktreeError("stale", "Files changed since the dialog opened: reopen it");
      if (o.mode === "hard") snapFiles(top, lost, "reset", o.snapshot);
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

const MAX_HUNK_LINES = 100_000;
const NO_EOL = "\\ No newline at end of file";
type WireHunk = { newStart: number; lines: string[] };
const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+/g) ?? [];
const bare = (l: string) => l.replace(/\r?\n$/, "");
const eolOf = (l: string) => /\r?\n$/.exec(l)?.[0] ?? "";

/**
 * `text` with one hunk of a unified diff undone (the hunk's `+` lines replaced by its `-` lines), or undefined when the lines
 * at `newStart` are not the hunk's new side (the file changed since the diff). `lines`: unified-diff lines without newline,
 * `\ No newline at end of file` after the last line of a side. `newStart`: unified convention (1-based; a pure deletion,
 * which has no new line, names the line before it). Line ends: the restored lines take the first end of the replaced region.
 * shortcut: one end style per hunk, a file with mixed LF and CRLF inside one hunk is normalised there, when it matters per-line.
 */
export function revertHunk(text: string, hunk: WireHunk): string | undefined {
  const file = splitLines(text);
  const now: { t: string; noEol: boolean }[] = [];
  const was: { t: string; noEol: boolean }[] = [];
  let last: "both" | "-" | "+" = "both";
  for (const l of hunk.lines) {
    if (l === NO_EOL) {
      for (const side of last === "both" ? [now, was] : last === "+" ? [now] : [was]) if (side.length) side[side.length - 1]!.noEol = true;
      continue;
    }
    const t = l.slice(1);
    last = l[0] === " " ? "both" : (l[0] as "-" | "+");
    if (l[0] !== "-") now.push({ t, noEol: false });
    if (l[0] !== "+") was.push({ t, noEol: false });
  }
  const start = now.length ? hunk.newStart - 1 : hunk.newStart;
  if (start < 0 || start + now.length > file.length) return undefined;
  const region = file.slice(start, start + now.length);
  if (!now.every((n, i) => bare(region[i]!) === n.t && (eolOf(region[i]!) === "") === n.noEol)) return undefined;
  const eol = region.map(eolOf).find(Boolean) ?? file.map(eolOf).find(Boolean) ?? "\n";
  // A context line keeps the file's own line; a removed line gets the region's end, none when the old side has no final newline.
  let ctx = 0;
  const restored: string[] = [];
  let k = 0;
  for (const l of hunk.lines) {
    if (l === NO_EOL || l[0] === "+") {
      if (l[0] === "+") ctx++;
      continue;
    }
    const w = was[k++]!;
    restored.push(l[0] === " " ? region[ctx++]! : w.t + (w.noEol ? "" : eol));
  }
  return [...file.slice(0, start), ...restored, ...file.slice(start + now.length)].join("");
}

type Entry = { path: string; kind: GitRollbackFile["kind"]; oldPath?: string; unmerged: boolean; untracked: boolean };
/** The porcelain v2 records of the repository, those naming one of `files` (either side of a rename), as file entries. */
function entriesOf(status: string, files: Set<string>): { entries: Entry[]; records: string[] } {
  const entries: Entry[] = [];
  const records: string[] = [];
  const parts = status.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const r = parts[i]!;
    const tag = r[0];
    if (tag === "?") {
      const path = r.slice(2);
      if (!files.has(path)) continue;
      records.push(r);
      // One row per path: an index delete with an untracked copy of the same path stays the tracked entry.
      if (!entries.some((e) => e.path === path)) entries.push({ path, kind: "A", unmerged: false, untracked: true });
    } else if (tag === "1" || tag === "u" || tag === "2") {
      const f = r.split(" ");
      const path = f.slice(tag === "1" ? 8 : tag === "2" ? 9 : 10).join(" ");
      const oldPath = tag === "2" ? parts[++i] : undefined;
      if (!files.has(path) && !(oldPath !== undefined && files.has(oldPath))) continue;
      const [x, y] = [f[1]![0]!, f[1]![1]!];
      const kind = tag === "2" ? "R" : x === "A" ? "A" : x === "D" || y === "D" ? "D" : "M";
      entries.push({ path, kind, ...(oldPath !== undefined && { oldPath }), unmerged: tag === "u", untracked: false });
      records.push(oldPath === undefined ? r : `${r}\0${oldPath}`);
    }
  }
  return { entries, records };
}

/** Local history entry (`localHistory.before`) of a file about to change (GH-565, GH-606). */
type Snapshot = (hostPath: string, reason: HistoryReason, content?: string) => void;
type Common = { allowed: RemoteOptions["allowed"]; snapshot: Snapshot };
/** Snapshots the repository paths that are plain files on disk now; deleted files, links and folders have no content to keep. */
function snapFiles(top: string, paths: Iterable<string>, reason: HistoryReason, snap: Snapshot) {
  for (const p of paths) {
    const host = hostOf(top, p);
    if (existsSync(host) && lstatSync(host).isFile()) snap(host, reason);
  }
}
/** Raw NUL-separated name list of a git call (`run` keeps only the last 8000 chars of text). */
async function nameList(top: string, args: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  return (await run(top, args, env, { raw: true })).out.split("\0").filter(Boolean);
}
/** The validated repository-relative paths of a rollback. */
function fileSet(paths: unknown): Set<string> {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS) throw bad("paths must be a list of 1 to 10000 paths");
  return new Set(paths.map(repoPath));
}
/** The classification and the token of `paths` (inside the lock for a rollback). */
async function classify(top: string, env: NodeJS.ProcessEnv, paths: unknown): Promise<{ entries: Entry[]; token: string }> {
  const files = fileSet(paths);
  if ((await ask(top, ["rev-parse", "--verify", "-q", "HEAD"], env)).code === 1) throw bad("No commit to roll back to");
  const head = (await run(top, ["rev-parse", "HEAD"], env)).out;
  const status = (await run(top, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], env)).out;
  const { entries, records } = entriesOf(status, files);
  if (entries.some((e) => e.unmerged)) throw bad("Resolve the conflict first");
  const h = createHash("sha256").update(head).update("\0").update(records.join("\0"));
  for (const e of entries) for (const p of [e.path, e.oldPath]) {
    if (p === undefined) continue;
    try {
      const st = lstatSync(hostOf(top, p));
      h.update(`\0${p}:${st.size}:${st.mtimeMs}`);
    } catch { /* absent */ }
  }
  return { entries, token: h.digest("hex") };
}

/** What a rollback of `paths` would do: the files git status lists for them, and the token a rollback must present. Null outside a work tree. */
export async function gitRollbackPreview(cwd: string, o: { paths: unknown } & Common): Promise<GitRollbackPreview | null> {
  fileSet(o.paths);
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    const { entries, token } = await classify(top, await writeEnv(top), o.paths);
    return { files: entries.map(({ path, kind, oldPath }) => ({ path, kind, ...(oldPath !== undefined && { oldPath }) })), token };
  });
}

/**
 * Rolls `paths` back to HEAD (work tree and index), like IntelliJ's Rollback; `token` is the preview's, a different state is
 * `stale`. Added files stay as untracked files unless `deleteAdded`; a rename's target is always removed. Every file that
 * changes or goes gets a local history entry first. Null outside a work tree.
 */
export async function gitRollback(cwd: string, o: { paths: unknown; token: unknown; deleteAdded?: unknown } & Common): Promise<{ output: string } | null> {
  if (typeof o.token !== "string") throw bad("token must be text");
  if (o.deleteAdded !== undefined && typeof o.deleteAdded !== "boolean") throw bad("deleteAdded must be a boolean");
  fileSet(o.paths);
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    const env = await writeEnv(top);
    return exclusive(top, async () => {
      const { entries, token } = await classify(top, env, o.paths);
      if (token !== o.token) throw new WorktreeError("stale", "The files changed since the dialog opened: reopen it");
      const drop = o.deleteAdded === true;
      const restore: string[] = []; // known to git: HEAD's version, or removed when HEAD has none
      const unstage: string[] = [];
      const track: string[] = []; // untracked files to delete: git must know them first
      const changing: string[] = [];
      for (const e of entries) {
        if (e.kind === "A" && !drop) {
          if (!e.untracked) unstage.push(e.path);
          continue;
        }
        (e.untracked ? track : restore).push(e.path);
        changing.push(e.path);
        if (e.oldPath !== undefined) (restore.push(e.oldPath), changing.push(e.oldPath));
      }
      snapFiles(top, changing, "rollback", o.snapshot);
      const batch = async (cmd: string[], list: string[]) => list.length ? (await run(top, [...LITERAL, ...cmd, ...FROM_STDIN], env, { input: list.join("\0") })).out : "";
      const out = [
        await batch(["add", "-A"], track),
        await batch(["restore", "--source=HEAD", "--staged", "--worktree"], [...restore, ...track]),
        await batch(["restore", "--source=HEAD", "--staged"], unstage),
      ];
      return { output: tidy(out.filter(Boolean).join("\n"), MAX_OUTPUT) };
    });
  });
}

/** Undoes one hunk of the diff of `path` in the work tree only (the index stays): see `revertHunk`. `stale` when the lines no longer match. */
export async function gitRollbackHunk(cwd: string, o: { path: unknown; hunk: unknown; maxBytes: number } & Common): Promise<{ output: string } | null> {
  const path = repoPath(o.path);
  const h = o.hunk as WireHunk | null;
  if (!h || typeof h !== "object" || !Number.isInteger(h.newStart) || h.newStart < 0 || !Array.isArray(h.lines) || !h.lines.length || h.lines.length > MAX_HUNK_LINES
    || h.lines.some((l) => typeof l !== "string" || (l !== NO_EOL && !/^[ +-]/.test(l)) || /[\n\0]/.test(l)) || !h.lines.some((l) => l[0] === "-" || l[0] === "+")) throw bad("hunk must be a start and unified diff lines with a change");
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    const env = await writeEnv(top);
    return exclusive(top, async () => {
      if ((await run(top, [...LITERAL, "ls-files", "-u", "-z", "--", path], env)).out) throw bad("Resolve the conflict first");
      const file = hostOf(top, path);
      if (!o.allowed(file)) throw new WorktreeError("cwd_not_allowed", `outside the allowlisted roots: ${path}`);
      let fd: number | undefined;
      try {
        fd = openChecked(file, OPEN_READ);
        const st = fstatSync(fd);
        if (!st.isFile()) throw bad(`not a file: ${path}`);
        if (st.size > o.maxBytes) throw bad(`larger than ${o.maxBytes} bytes: ${path}`);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(readAll(fd, st.size));
        } catch {
          throw bad(`not UTF-8 text: ${path}`);
        }
        const bom = text.startsWith("\uFEFF");
        const next = revertHunk(bom ? text.slice(1) : text, h);
        if (next === undefined) throw new WorktreeError("stale", "The file changed since the diff was shown");
        o.snapshot(file, "rollback");
        // Atomic: a temp file beside the target (same mode), renamed over it; any error leaves the original. A path swapped for a link meanwhile is replaced, never followed.
        const tmp = `${file}.claude-ui-${randomUUID()}.tmp`;
        try {
          writeFileSync(tmp, bom ? `\uFEFF${next}` : next, { flag: "wx", mode: st.mode & 0o7777 });
          chmodSync(tmp, st.mode & 0o7777);
          if (!sameFile(fd, file)) throw Object.assign(new Error("changed during the request"), { code: "ECHANGED" });
          renameSync(tmp, file);
        } catch (e) {
          rmSync(tmp, { force: true });
          throw e;
        }
      } catch (e) {
        if (e instanceof WorktreeError) throw e;
        throw new WorktreeError("git_failed", (e as { code?: string }).code === "ECHANGED" ? `changed during the request: ${path}` : String(e));
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      return { output: "" };
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
async function switchTo(top: string, args: string[], smart: boolean, env: NodeJS.ProcessEnv, allowed: (p: string) => boolean, snap: Snapshot): Promise<Written> {
  const lc = { ...env, LC_ALL: "C" };
  try {
    const { out } = await run(top, ["switch", ...args], lc);
    return { output: out, refs: await gitRefs(top, allowed) };
  } catch (e) {
    if (!(e instanceof WorktreeError) || e.code !== "git_failed" || !LOCAL_CHANGES.test(e.message)) throw e;
    if (!smart) throw new WorktreeError("local_changes", e.message);
  }
  const from = (await run(top, ["symbolic-ref", "--short", "-q", "HEAD"], env, { soft: true }).catch(() => ({ out: "" }))).out || "HEAD";
  snapFiles(top, await nameList(top, ["diff", "--name-only", "-z", "--no-renames", "HEAD"], env), "checkout", snap);
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
export async function gitBranchCreate(cwd: string, o: { name: unknown; at?: unknown; checkout?: unknown; smart?: unknown; snapshot: Snapshot } & RemoteOptions): Promise<Written | null> {
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
    return switchTo(top, ["-c", name, ...(at ? [at] : [])], smart, env, o.allowed, o.snapshot);
  });
}

/** Checks out a local branch (`refs/heads/x`), or a remote branch (`refs/remotes/r/b`) as a new local branch that tracks it. */
export async function gitCheckout(cwd: string, o: { ref: unknown; smart?: unknown; snapshot: Snapshot } & RemoteOptions): Promise<Written | null> {
  const remote = typeof o.ref === "string" && REMOTE_REF.test(o.ref) && !o.ref.endsWith("/HEAD") && o.ref.length <= 255 && !o.ref.includes("..") && !o.ref.includes("@{");
  const ref = remote ? (o.ref as string) : branchRef(o.ref);
  const smart = smartOf(o.smart);
  return switching(cwd, o, async (top, env) => {
    if (remote) {
      if ((await run(top, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], env, { soft: true })).code !== 0) throw bad("Not a remote branch");
      return switchTo(top, ["--track", ref], smart, env, o.allowed, o.snapshot);
    }
    return switchTo(top, ["--no-guess", ref.slice("refs/heads/".length)], smart, env, o.allowed, o.snapshot);
  });
}

// ---- Stash (docs/spec.md "Layout", Graph tab; wire `git.stash*`) ----

/**
 * Local history entries of what a dropped stash holds: its tracked changes (`<hash>^1..<hash>`) and, when it has one, its untracked-files commit (`<hash>^3`),
 * each with the stashed text. Non-files, links and blobs over the history limit are skipped before reading.
 * shortcut: one `cat-file` per file, upgrade to `cat-file --batch` when a drop is slow.
 */
async function snapStash(top: string, hash: string, env: NodeJS.ProcessEnv, snap: Snapshot) {
  const from = async (rev: string, paths: string[]) => {
    if (!paths.length) return;
    const rows = (await run(top, [...LITERAL, "ls-tree", "-r", "-z", "-l", rev, "--", ...paths], env, { raw: true })).out.split("\0").filter(Boolean);
    for (const row of rows) {
      const tab = row.indexOf("\t");
      const [mode, type, oid, size] = row.slice(0, tab).split(/ +/);
      if (type !== "blob" || mode === "120000" || Number(size) > MAX_BYTES) continue;
      const blob = await runGit({ cwd: top, args: [...HARDEN, "cat-file", "blob", oid!], env, timeout: writeConfig.timeout, killTree: true });
      snap(hostOf(top, row.slice(tab + 1)), "stash-drop", blob.stdout.toString("utf8"));
    }
  };
  await from(hash, await nameList(top, ["diff", "--name-only", "-z", "--no-renames", `${hash}^1`, hash], env));
  if ((await ask(top, ["rev-parse", "-q", "--verify", `${hash}^3`], env)).out) await from(`${hash}^3`, await nameList(top, [...LITERAL, "ls-tree", "-r", "-z", "--name-only", `${hash}^3`], env));
}

/** The Graph tab's stash list, newest first. Not cached: `refsStamp` misses a drop of a non-top entry. Null outside a work tree. */
export async function gitStashList(cwd: string, o: RemoteOptions): Promise<GitStash[] | null> {
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    // shortcut: first 500 entries only, upgrade when someone keeps more
    // Raw stdout: `run` keeps only the last 8000 chars, which cuts a long list.
    const out = (await runGit({ cwd: top, args: [...HARDEN, "stash", "list", "-z", "--max-count=500", "--format=%H%x1f%gs%x1f%ct"], env: await writeEnv(top), timeout: writeConfig.timeout, killTree: true })).stdout.toString("utf8");
    return out.split("\0").filter(Boolean).map((row, index) => {
      const [hash, message, time] = row.trim().split("\x1f");
      return { index, hash, message, time: Number(time) };
    });
  });
}

/** `git stash push [--include-untracked] [-m message]`. Nothing to save (the stash ref did not move) is `bad_request`. Null outside a work tree. */
export async function gitStashPush(cwd: string, o: { message?: unknown; includeUntracked?: unknown } & RemoteOptions): Promise<Written | null> {
  const message = o.message === undefined ? "" : o.message;
  if (typeof message !== "string" || message.length > 4096 || message.includes("\0")) throw bad("message must be text of at most 4096 characters");
  if (o.includeUntracked !== undefined && typeof o.includeUntracked !== "boolean") throw bad("includeUntracked must be a boolean");
  const text = message.trim();
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return exclusive(top, async () => {
      const env = await writeEnv(top);
      await refuseOperation(top);
      const before = (await ask(top, ["rev-parse", "-q", "--verify", "refs/stash"], env)).out;
      const { out } = await run(top, ["stash", "push", ...(o.includeUntracked ? ["--include-untracked"] : []), ...(text ? ["-m", text] : [])], env);
      if ((await ask(top, ["rev-parse", "-q", "--verify", "refs/stash"], env)).out === before) throw bad("No local changes to save");
      return { output: out, refs: await gitRefs(top, o.allowed) };
    });
  });
}

/**
 * `git stash apply|pop|drop stash@{index}`; `hash` is the entry's commit as the list showed it: a stash pushed or dropped elsewhere shifts the
 * indices, then `stale`. Apply and pop stopping on conflicts is a success with `operation`. Drop is allowed during an unfinished operation. Null outside a work tree.
 */
export async function gitStash(cwd: string, verb: "apply" | "pop" | "drop", o: { index: unknown; hash: unknown; snapshot: Snapshot } & RemoteOptions): Promise<Written | null> {
  const { index, hash } = o;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 9999 || !isHash(hash)) throw bad("index and hash must be a stash position and its commit hash");
  const ref = `stash@{${index}}`;
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    return exclusive(top, async () => {
      const env = await writeEnv(top);
      // A missing entry exits 128, not 1: both mean the list changed.
      const now = await ask(top, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], env).then((r) => r.out, () => "");
      if (now !== hash) throw new WorktreeError("stale", "The stash list changed: reload");
      if (verb === "drop") {
        await snapStash(top, hash, env, o.snapshot);
        const { out } = await run(top, ["stash", "drop", ref], env);
        return { output: out, refs: await gitRefs(top, o.allowed) };
      }
      await refuseOperation(top);
      return runStop(top, ["stash", verb, ref], env, o.allowed);
    });
  });
}
