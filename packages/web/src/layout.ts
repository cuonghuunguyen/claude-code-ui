// Pane layout per browser (docs/spec.md "Layout"): where the terminal panel docks on wide screens. Movable panes (#355) extend this.
import { useSyncExternalStore } from "react";

export type DockArea = "bottom" | "side";
export const TERMINAL_DOCKS: { value: DockArea; label: string }[] = [
  { value: "bottom", label: "Bottom" },
  { value: "side", label: "Side panel" },
];

const DOCK_KEY = "claude-ui.terminalDock";
// Storage blocked: the choice lasts while the page is open.
let memory: DockArea | undefined;
const listeners = new Set<() => void>();

export function loadTerminalDock(): DockArea {
  try {
    return localStorage.getItem(DOCK_KEY) === "side" ? "side" : "bottom";
  } catch {
    return memory ?? "bottom";
  }
}

export function saveTerminalDock(d: DockArea) {
  memory = d;
  try {
    if (d === "bottom") localStorage.removeItem(DOCK_KEY);
    else localStorage.setItem(DOCK_KEY, d);
  } catch {
    // See `memory`.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  // Another tab of this browser moved the terminal.
  const onStorage = (e: StorageEvent) => (e.key === DOCK_KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

/** Where the terminal docks on wide screens; re-renders when it is saved here or in another tab. */
export const useTerminalDock = (): DockArea => useSyncExternalStore(subscribe, loadTerminalDock, () => "bottom");

/** True while the viewport is at least `px` wide; follows resizes. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  return useSyncExternalStore(
    (l) => {
      if (typeof matchMedia !== "function") return () => {};
      const m = matchMedia(query);
      m.addEventListener("change", l);
      return () => m.removeEventListener("change", l);
    },
    () => typeof matchMedia === "function" && matchMedia(query).matches,
    () => false,
  );
}
