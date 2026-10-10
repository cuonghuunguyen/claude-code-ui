// Latest refs stamp per folder (docs/spec.md "Layout", Graph tab): fed by git.status replies, read by the Graph tab.
import { useSyncExternalStore } from "react";

const stamps = new Map<string, string>();
const subs = new Set<() => void>();

/** Records `stamp` for `cwd` and notifies when it changed; an undefined stamp (an old daemon) is ignored. */
export function noteRefs(cwd: string, stamp: string | undefined): void {
  if (stamp === undefined || stamps.get(cwd) === stamp) return;
  stamps.set(cwd, stamp);
  for (const s of [...subs]) s();
}
export const refsOf = (cwd: string): string | undefined => stamps.get(cwd);
export const subscribeRefs = (cb: () => void) => {
  subs.add(cb);
  return () => void subs.delete(cb);
};
export const useRefsStamp = (cwd: string): string | undefined => useSyncExternalStore(subscribeRefs, () => stamps.get(cwd));
