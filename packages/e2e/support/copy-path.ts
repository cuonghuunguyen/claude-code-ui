import type { Memo } from "../steps/fixtures.ts";

/** Folder name of the worktree the "own worktree" step made (the step stores it in the scenario memo). */
export function memoWorktreePath(memo: Memo): string {
  if (!memo.worktree) throw new Error("no scratch worktree: add the step 'the scratch project is a git repository with its own worktree'");
  return memo.worktree;
}
