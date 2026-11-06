// Annotate (GH-564): "show this commit in the Graph", per repository path (`GitRepo.path`, the key of a GraphPanel). The request waits until a panel takes it: the pane may not be mounted yet.
import { useSyncExternalStore } from "react";

export type GraphFocus = { hash: string; seq: number };
const focus = new Map<string, GraphFocus>();
const acked = new Map<string, number>();
const subs = new Set<() => void>();
let seq = 0;
const notify = () => subs.forEach((s) => s());

export function focusCommit(repoPath: string, hash: string): void {
  focus.set(repoPath, { hash, seq: ++seq });
  notify();
}
/** The panel carried the request out. */
export function ackGraphFocus(repoPath: string, f: GraphFocus): void {
  acked.set(repoPath, f.seq);
  notify();
}
const pending = (path: string) => {
  const f = focus.get(path);
  return f && f.seq > (acked.get(path) ?? 0) ? f : undefined;
};
const subscribe = (cb: () => void) => (subs.add(cb), () => void subs.delete(cb));
/** The request of `repoPath` no panel has taken yet. */
export const useGraphFocus = (repoPath: string): GraphFocus | undefined => useSyncExternalStore(subscribe, () => pending(repoPath));
