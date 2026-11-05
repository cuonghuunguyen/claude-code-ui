// Git writes of the Changes tab (docs/spec.md "Layout", Changes tab; wire `git.commitFiles`): started by a click, so the
// repository's hooks run like in a terminal; they never prompt. Later Git ops (rollback, checkout) extend this module.
import { randomUUID } from "node:crypto";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitCommitted, GitOperation, GitOperationKind, GitStash } from "@claude-ui/protocol";
import { gitOperation, gitRefs, hostOf, isHash, pinScope, repoPath, topIn, WorktreeError } from "./git.ts";
import { branchInfo, branchRef, exclusive, gitBranch, HARDEN, MAX_ERROR, tidy, writeEnv, type RemoteOptions } from "./git-remote.ts";
import { runGit } from "./git-runner.ts";

/** Test seam: the timeout of a write (hooks may run tests). */
export const writeConfig = { timeout: 300_000 };
const MAX_PATHS = 10_000;
const MAX_MESSAGE = 65_536;
const MAX_OUTPUT = 8000;

type Failure = Error & { stderr?: string; stdout?: Buffer; killed?: boolean; code?: number | string };
type Run = { out: string; code: number };
/** One git call of a write. `soft`: exit code 1 is an answer, not a failure. Failure text: stdout and stderr (hooks print on either). */
async function run(top: string, args: string[], env: NodeJS.ProcessEnv, o: { input?: string; soft?: boolean } = {}): Promise<Run> {
  try {
    const r = await runGit({ cwd: top, args: [...HARDEN, ...args], env, input: o.input, timeout: writeConfig.timeout, killTree: true });
    return { out: tidy(`${r.stdout.toString("utf8")}\n${r.stderr}`, MAX_OUTPUT), code: 0 };
  } catch (e) {
    const err = e as Failure;
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
      const name = `claude-ui-commit-${randomUUID()}.index`;
      // git's own view of the path for GIT_INDEX_FILE; the daemon's view for the clean-up.
      const gitPath = (await run(top, ["rev-parse", "--git-path", name], env)).out;
      const hostPath = hostOf(top, gitPath);
      const tmp = { ...env, GIT_INDEX_FILE: gitPath };
      let out: string;
      try {
        await run(top, head.code === 1 ? ["read-tree", "--empty"] : ["read-tree", "HEAD"], tmp);
        if (files.length) await run(top, [...LITERAL, "add", "-A", ...FROM_STDIN], tmp, { input: files.join("\0") });
        out = (await run(top, ["commit", "-F", "-", ...(amend ? ["--amend"] : [])], tmp, { input: message })).out;
      } finally {
        await rm(hostPath, { force: true }).catch(() => {});
        await rm(`${hostPath}.lock`, { force: true }).catch(() => {});
      }
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

// ---- Stash (docs/spec.md "Layout", Graph tab; wire `git.stash*`) ----

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

const unfinished = async (top: string) => {
  const op = await gitOperation(top);
  if (op) throw bad(op.conflicted.length ? "Resolve the conflicts first" : `Finish or abort the ${op.kind} first`);
};

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
      await unfinished(top);
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
export async function gitStash(cwd: string, verb: "apply" | "pop" | "drop", o: { index: unknown; hash: unknown } & RemoteOptions): Promise<Written | null> {
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
        // shortcut: no "snapshot before" yet, Local history and Timeline (#565) is not on this base; call it here before the drop.
        const { out } = await run(top, ["stash", "drop", ref], env);
        return { output: out, refs: await gitRefs(top, o.allowed) };
      }
      await unfinished(top);
      return runStop(top, ["stash", verb, ref], env, o.allowed);
    });
  });
}
