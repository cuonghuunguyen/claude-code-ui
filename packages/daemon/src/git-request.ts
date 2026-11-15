import { WorktreeError } from "./git.ts";

/** What a git request needs from the daemon. Injected: the unit test passes fakes, the daemon passes its own. */
export type GitRequestContext = {
  /** Canonical path inside an allowlisted root, else undefined. */
  allowed: (path: unknown) => string | undefined;
  /** Path callback for git.ts, git-write.ts and git-remote.ts. */
  inside: (path: string) => boolean;
  /** Top of the repository that holds `cwd`, null when none. */
  topOf: (cwd: string) => Promise<string | null>;
  /** Cached worktree statuses of this repository are outdated. */
  markStale: (cwd: string) => void;
};
export type GitFailure = { code: string; message: string; size?: number };
export type GitOutcome = { result: object } | { error: GitFailure };

/** A refusal an operation raises that is no WorktreeError: decoded file is binary or not UTF-8, null result, bad input. */
export class GitRequestError extends Error {
  constructor(readonly code: string, message: string, readonly size?: number) {
    super(message);
  }
}

export type GitOp = { write: boolean; run: (cwd: string, inside: (path: string) => boolean) => Promise<object> };
export const read = (run: GitOp["run"]): GitOp => ({ write: false, run });
export const write = (run: GitOp["run"]): GitOp => ({ write: true, run });

export const NOT_TOP = "Not a repository top";

/** The one error map: WorktreeError and GitRequestError keep code and size; anything else is git_failed. */
export function gitFailure(e: unknown): GitFailure {
  if (e instanceof WorktreeError || e instanceof GitRequestError) return { code: e.code, message: e.message, size: e.size };
  return { code: "git_failed", message: (e as Error).message, size: undefined };
}

/** A failed write may still have changed the repository (a hook, a partial fetch, a pull stopped by a conflict, a remote tag delete after the local one). Only `bad_request` is raised before git runs. */
export const staleAfterFailure = (code: string) => code !== "bad_request";

/** Root check, top check (`exact: true`), run, error map, stale marking. Never throws. */
export async function gitRequest(ctx: GitRequestContext, msg: { cwd?: unknown; exact?: unknown }, op: GitOp): Promise<GitOutcome> {
  const cwd = ctx.allowed(msg.cwd);
  if (!cwd) return { error: { code: "cwd_not_allowed", message: `outside the allowlisted roots: ${String(msg.cwd)}` } };
  // `exact: true` and `cwd` is not its repository's top (an uninitialised submodule folder would answer for the superproject). Both sides canonical.
  try {
    if (msg.exact === true && (await ctx.topOf(cwd)) !== cwd) return { error: { code: "not_git", message: NOT_TOP } };
  } catch (e) {
    return { error: gitFailure(e) };
  }
  try {
    const result = await op.run(cwd, ctx.inside);
    if (op.write) ctx.markStale(cwd);
    return { result };
  } catch (e) {
    const error = gitFailure(e);
    if (op.write && staleAfterFailure(error.code)) ctx.markStale(cwd);
    return { error };
  }
}
