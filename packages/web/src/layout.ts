// Pane layout per browser (docs/spec.md "Layout"): which dock area holds each pane on wide screens, their order and the side panel's side.
import { useCallback, useMemo, useSyncExternalStore } from "react";

export type PaneId = "changes" | "files" | "graph" | "terminal";
export type DockArea = "side" | "bottom";
export type DockSide = "left" | "right";
export type Layout = { side: DockSide; areas: Record<DockArea, PaneId[]> };

/** Also the order of the narrow pane switcher. */
export const PANE_IDS: PaneId[] = ["changes", "files", "graph", "terminal"];
export const PANE_LABEL: Record<PaneId, string> = { changes: "Changes", files: "Files", graph: "Git graph", terminal: "Terminal" };
export const AREA_LABEL: Record<DockArea, string> = { side: "Side panel", bottom: "Bottom panel" };
export const DEFAULT_LAYOUT: Layout = { side: "right", areas: { side: ["changes", "files", "graph"], bottom: ["terminal"] } };
export const TERMINAL_DOCKS: { value: DockArea; label: string }[] = [
  { value: "bottom", label: "Bottom" },
  { value: "side", label: "Side panel" },
];

const LAYOUT_KEY = "claude-ui.layout";
const DOCK_KEY = "claude-ui.terminalDock"; // GH-354, read once as a migration
const DEFAULT_JSON = JSON.stringify(DEFAULT_LAYOUT);
const isPane = (v: unknown): v is PaneId => PANE_IDS.includes(v as PaneId);
const defaultArea = (p: PaneId): DockArea => (DEFAULT_LAYOUT.areas.side.includes(p) ? "side" : "bottom");

/** Never throws: bad input reads as the default; unknown panes drop, duplicates keep the first, missing panes return to their default area. */
export function parseLayout(raw: string | null, legacyDock?: string | null): Layout {
  const areas: Record<DockArea, PaneId[]> = { side: [], bottom: [] };
  let side: DockSide = "right";
  let ok = false;
  try {
    const v = raw === null ? undefined : (JSON.parse(raw) as { side?: unknown; areas?: Record<string, unknown> });
    if (v && typeof v === "object" && v.areas && typeof v.areas === "object") {
      ok = true;
      side = v.side === "left" ? "left" : "right";
      const seen = new Set<PaneId>();
      for (const a of ["side", "bottom"] as const) {
        const list = v.areas[a];
        if (Array.isArray(list)) for (const p of list) if (isPane(p) && !seen.has(p)) (seen.add(p), areas[a].push(p));
      }
    }
  } catch {
    // Not JSON: default.
  }
  if (!ok) return legacyDock === "side" ? { side: "right", areas: { side: [...DEFAULT_LAYOUT.areas.side, "terminal"], bottom: [] } } : DEFAULT_LAYOUT;
  for (const p of PANE_IDS) if (!areas.side.includes(p) && !areas.bottom.includes(p)) areas[defaultArea(p)].push(p);
  return { side, areas };
}

export const areaOf = (l: Layout, p: PaneId): DockArea => (l.areas.side.includes(p) ? "side" : "bottom");

/** Moves `p` to `to`, before `before` (the end when absent or not in `to`). Returns `l` itself when nothing changes. */
export function movePane(l: Layout, p: PaneId, to: DockArea, before?: PaneId): Layout {
  const rest: Record<DockArea, PaneId[]> = { side: l.areas.side.filter((q) => q !== p), bottom: l.areas.bottom.filter((q) => q !== p) };
  const i = before && before !== p ? rest[to].indexOf(before) : -1;
  rest[to].splice(i < 0 ? rest[to].length : i, 0, p);
  const n: Layout = { ...l, areas: rest };
  return JSON.stringify(n) === JSON.stringify(l) ? l : n;
}

export const flipSide = (l: Layout): Layout => ({ ...l, side: l.side === "left" ? "right" : "left" });

/** The pane an area shows: the newest of `hist` that it holds, else files, else its first. */
export function activePane(panes: PaneId[], hist: readonly string[]): PaneId | undefined {
  for (const h of hist) if (panes.includes(h as PaneId)) return h as PaneId;
  return panes.includes("files") ? "files" : panes[0];
}

// Storage blocked: the layout lasts while the page is open.
let memory: Layout | undefined;
let cache: { raw: string | null; legacy: string | null; layout: Layout } | undefined;
const listeners = new Set<() => void>();

/** Snapshot for useSyncExternalStore: the same object while the stored strings are equal. */
export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const legacy = localStorage.getItem(DOCK_KEY);
    if (!cache || cache.raw !== raw || cache.legacy !== legacy) cache = { raw, legacy, layout: parseLayout(raw, legacy) };
    return cache.layout;
  } catch {
    return memory ?? DEFAULT_LAYOUT;
  }
}

export function saveLayout(l: Layout) {
  const json = JSON.stringify(l);
  memory = json === DEFAULT_JSON ? DEFAULT_LAYOUT : l;
  try {
    if (json === DEFAULT_JSON) localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, json);
    localStorage.removeItem(DOCK_KEY);
  } catch {
    // See `memory`.
  }
  listeners.forEach((f) => f());
}

export const resetLayout = () => saveLayout(DEFAULT_LAYOUT);

function subscribe(l: () => void) {
  listeners.add(l);
  // Another tab of this browser moved a pane.
  const onStorage = (e: StorageEvent) => (e.key === LAYOUT_KEY || e.key === DOCK_KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export const useLayout = (): Layout => useSyncExternalStore(subscribe, loadLayout, () => DEFAULT_LAYOUT);

// Terminal position (Settings › Terminal) = the dock area of the terminal pane.
export const loadTerminalDock = (): DockArea => areaOf(loadLayout(), "terminal");
export const saveTerminalDock = (d: DockArea) => saveLayout(movePane(loadLayout(), "terminal", d));
export const useTerminalDock = (): DockArea => areaOf(useLayout(), "terminal");

/** True while the viewport is at least `px` wide; follows resizes. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  // One MediaQueryList per query, not one per render (`subscribe` is stable while `query` is).
  const mql = useMemo(() => (typeof matchMedia === "function" ? matchMedia(query) : undefined), [query]);
  return useSyncExternalStore(
    useCallback(
      (l: () => void) => {
        mql?.addEventListener("change", l);
        return () => mql?.removeEventListener("change", l);
      },
      [mql],
    ),
    () => mql?.matches ?? false,
    () => false,
  );
}
