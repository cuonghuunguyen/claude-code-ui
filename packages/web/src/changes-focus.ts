// GH-722: what the Changes tab shows right now, for the palette: the selected row (Add to prompt) and whether a diff has selected lines (Send selection).
// A tiny external store: App reads it with `useChangesFocus`; changes-panel.tsx writes it.
import { useSyncExternalStore } from "react";

export type ChangesFocus = { selected?: { path: string; cwd: string; deleted: boolean }; hasDiffSelection: boolean };
const EMPTY: ChangesFocus = { hasDiffSelection: false };
let state = EMPTY;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export const changesFocus = () => state;

/** The Changes tab's selected row; `undefined`: none (empty list or the tab is gone). */
export function setChangesSelected(selected: ChangesFocus["selected"]) {
  const a = state.selected;
  if (a?.path === selected?.path && a?.cwd === selected?.cwd && a?.deleted === selected?.deleted) return;
  state = { ...state, selected };
  emit();
}

// One flag per diff on screen (a narrow screen expands several): any with selected lines counts.
const withSelection = new Set<symbol>();
export function setDiffSelection(id: symbol, on: boolean) {
  if (on === withSelection.has(id)) return;
  if (on) withSelection.add(id);
  else withSelection.delete(id);
  state = { ...state, hasDiffSelection: withSelection.size > 0 };
  emit();
}

export const useChangesFocus = () => useSyncExternalStore(subscribe, changesFocus, changesFocus);

export function resetChangesFocusForTests() {
  withSelection.clear();
  state = EMPTY;
  emit();
}
