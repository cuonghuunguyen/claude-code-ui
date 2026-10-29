// Docked sessions (GH-401, docs/spec.md "Layout"): a session tab shown in the side or bottom panel instead of the tabs bar, per browser.
// The id stays in the stored tab list (`claude-ui.tabs`); this map says which dock holds it. Narrow screens ignore the map.
import { useSyncExternalStore } from "react";
import type { DockArea } from "./layout.ts";
import { closeTab } from "./tabs.ts";

export type Docked = Record<string, DockArea>;
const KEY = "claude-ui.dockedSessions";
const NONE: Docked = {};
const ID = /^[0-9a-f-]{36}$/;

/** Never throws: bad input reads as empty; keys that are no session id and unknown areas drop. */
export function parseDocked(raw: string | null): Docked {
  try {
    const v = raw === null ? undefined : (JSON.parse(raw) as Record<string, unknown>);
    if (!v || typeof v !== "object" || Array.isArray(v)) return NONE;
    const d: Docked = {};
    for (const [k, a] of Object.entries(v)) if (ID.test(k) && (a === "side" || a === "bottom")) d[k] = a;
    return Object.keys(d).length ? d : NONE;
  } catch {
    return NONE;
  }
}

/** `id` in `area` (the other area moves it). Returns `d` itself when nothing changes. */
export const dock = (d: Docked, id: string, area: DockArea): Docked => (d[id] === area ? d : { ...d, [id]: area });
export const undock = (d: Docked, id: string): Docked => {
  if (!(id in d)) return d;
  const { [id]: _, ...rest } = d;
  return Object.keys(rest).length ? rest : NONE;
};

/** What the tabs bar shows: wide without the docked ids, narrow the whole list. Every strip action (close, move, split, cleanup, next tab) reads this list. */
export const stripTabs = (tabs: string[], d: Docked, lg: boolean): string[] => (lg && tabs.some((t) => t in d) ? tabs.filter((t) => !(t in d)) : tabs);
/** The tab the main area shows once `id` is docked or gone: its right strip neighbour, else the left one, else none (the rule of closeTab). */
export const neighbourAfterDock = (tabs: string[], d: Docked, id: string): string | undefined => closeTab(tabs.filter((t) => t === id || !(t in d)), id, id).active;
/** The docked ids of `area`, in strip order. */
export const dockedIn = (tabs: readonly string[], d: Docked, area: DockArea): string[] => tabs.filter((t) => d[t] === area);

// Storage blocked: the map lasts while the page is open.
let memory: Docked | undefined;
let cache: { raw: string | null; docked: Docked } | undefined;
const listeners = new Set<() => void>();

/** Snapshot for useSyncExternalStore: the same object while the stored string is equal. */
export function loadDocked(): Docked {
  try {
    const raw = localStorage.getItem(KEY);
    if (!cache || cache.raw !== raw) cache = { raw, docked: parseDocked(raw) };
    return cache.docked;
  } catch {
    return memory ?? NONE;
  }
}

export function saveDocked(d: Docked) {
  const empty = Object.keys(d).length === 0;
  memory = empty ? NONE : d;
  try {
    if (empty) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // See `memory`.
  }
  listeners.forEach((f) => f());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export const useDocked = (): Docked => useSyncExternalStore(subscribe, loadDocked, () => NONE);
