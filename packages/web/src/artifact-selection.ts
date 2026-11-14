// The selected row per session of the Artifacts pane (artifacts-pane.tsx), outside React so "Move to Artifacts" (App) can preselect without App state, and without App importing the pane.
// `detail`: below 720 px the preview shows instead of the list.
export type Pick = { partId: string; detail: boolean };
export const picked = new Map<string, Pick>();
const listeners = new Set<() => void>();
export function selectArtifact(owner: string, partId: string, detail = false): void {
  picked.set(owner, { partId, detail });
  listeners.forEach((l) => l());
}
/** A forgotten (deleted or unknown) session keeps no selection. */
export function forgetArtifactSelection(owner: string): void {
  if (picked.delete(owner)) listeners.forEach((l) => l());
}
/** Tests: a fresh start. */
export function resetArtifactSelection(): void {
  picked.clear();
  listeners.forEach((l) => l());
}
export const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
