// Git writes of the Changes tab (docs/spec.md "Layout", Changes tab; wire `git.commitFiles`): started by a click, so the
// repository's hooks run like in a terminal; they never prompt. Later Git ops (rollback, checkout) extend this module.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { wslHostPath, wslPathOf } from "@claude-ui/protocol";
import type { GitCommitted } from "@claude-ui/protocol";
import { gitRefs, pinScope, repoPath, topIn, WorktreeError } from "./git.ts";
import { exclusive, gitBranch, HARDEN, MAX_ERROR, tidy, writeEnv, type RemoteOptions } from "./git-remote.ts";
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

/** The daemon's view of a path git printed (a WSL repository's git prints POSIX). */
function hostOf(top: string, gitPath: string): string {
  const w = wslPathOf(top);
  return w ? wslHostPath(w.root, gitPath) : resolve(top, gitPath);
}

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
      if ((await run(top, ["ls-files", "-u", "-z"], env)).out) throw bad("Resolve the conflicts first");
      for (const [state, op] of [["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]]) {
        if ((await ask(top, ["rev-parse", "--verify", "-q", state], env)).code === 0) throw bad(`Finish or abort the ${op} first`);
      }
      const [merge, apply] = (await run(top, ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"], env)).out.split("\n");
      if (existsSync(hostOf(top, merge))) throw bad("Finish or abort the rebase first");
      if (existsSync(hostOf(top, apply))) throw bad(`Finish or abort the ${existsSync(hostOf(top, `${apply}/applying`)) ? "am" : "rebase"} first`);
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
