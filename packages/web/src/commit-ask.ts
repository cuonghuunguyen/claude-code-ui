// App shortcuts Commit and Push (shortcuts.ts git.commit, git.push): the app reveals the Changes tab and asks the shown commit box.
// Kept out of commit-box.tsx so App.tsx does not load the Changes tab's code. A box that mounts right after the ask takes it.
export type CommitAsk = "commit" | "push";
export const COMMIT_ASK_EVENT = "claude-ui:commit-ask";
let pending: { what: CommitAsk; at: number } | undefined;

export function askCommitBox(what: CommitAsk) {
  pending = { what, at: Date.now() };
  // After the reveal renders: a box shown by it (mounted or unhidden) takes the ask.
  setTimeout(() => dispatchEvent(new Event(COMMIT_ASK_EVENT)));
}

/** The pending ask, once; an ask older than 2 s is dropped (no commit box came, e.g. the Changes tab is not in Uncommitted mode). */
export function takeCommitAsk(): CommitAsk | undefined {
  const p = pending;
  pending = undefined;
  return p && Date.now() - p.at < 2000 ? p.what : undefined;
}
