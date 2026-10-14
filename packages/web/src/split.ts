// Split view (docs/spec.md "Split view", GH-356): the session area shows two session tabs side by side or stacked. `activeId` stays the single source of truth for "the current session": the active split always shows it.
import { FOCUS_TAB, NEW_TAB, closeTab } from "./tabs.ts";

export type SplitDir = "row" | "col";
/** `ids`: session tab per split in screen order (left/top first). `at`: index of the active split. `ratio`: size share of `ids[0]`. `runs`: subagent view per non-active split tab. */
export type Split = { dir: SplitDir; ids: string[]; at: number; ratio: number; runs?: Record<string, string> };

export const MAX_SPLITS = 2;
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

export const isSession = (id: unknown): id is string => typeof id === "string" && !!id && id !== NEW_TAB && id !== FOCUS_TAB;
export const clampRatio = (r: number) => (Number.isFinite(r) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, r)) : 0.5);

/** Ratio for a share of `px` of the container, never leaving a split below `minPx` (when the container allows both). */
export function ratioFor(px: number, total: number, minPx: number) {
  if (total <= 0) return 0.5;
  const lo = Math.min(MAX_RATIO, Math.max(MIN_RATIO, minPx / total));
  const hi = Math.max(MIN_RATIO, Math.min(MAX_RATIO, 1 - minPx / total));
  return lo > hi ? 0.5 : Math.min(hi, Math.max(lo, px / total));
}

/** Never throws: anything invalid reads as no split; ids deduped, `at` and `ratio` clamped. */
export function parseSplit(raw: string | null): Split | undefined {
  try {
    const v = raw === null ? undefined : (JSON.parse(raw) as Partial<Split> | null);
    if (!v || typeof v !== "object" || !Array.isArray(v.ids)) return undefined;
    const ids = [...new Set(v.ids.filter(isSession))].slice(0, MAX_SPLITS);
    if (ids.length < 2) return undefined;
    const at = typeof v.at === "number" && Number.isInteger(v.at) ? Math.min(ids.length - 1, Math.max(0, v.at)) : 0;
    const runs: Record<string, string> = {};
    if (v.runs && typeof v.runs === "object") for (const [k, r] of Object.entries(v.runs)) if (ids.includes(k) && typeof r === "string") runs[k] = r;
    return { dir: v.dir === "col" ? "col" : "row", ids, at, ratio: typeof v.ratio === "number" ? clampRatio(v.ratio) : 0.5, ...(Object.keys(runs).length ? { runs } : {}) };
  } catch {
    return undefined;
  }
}

/** Applied each render: drops closed tabs, puts the active tab in the active split. Same object when nothing changes. An active tab that is no session (New session, Focus page) suspends the split. */
export function followSplit(s: Split | undefined, activeId: string | undefined, tabs: readonly string[]): Split | undefined {
  if (!s) return undefined;
  if (!isSession(activeId)) return s;
  const open = s.ids.map((id) => (tabs.includes(id) ? id : undefined));
  let ids: (string | undefined)[] = open;
  let at = s.at;
  const hit = open.indexOf(activeId);
  if (hit >= 0) at = hit;
  else {
    at = Math.min(s.at, s.ids.length - 1);
    ids = open.map((id, i) => (i === at ? activeId : id));
  }
  const kept = ids.filter((id): id is string => !!id);
  if (kept.length < 2) return undefined;
  at = kept.indexOf(activeId);
  const runs = s.runs && Object.keys(s.runs).some((k) => !kept.includes(k)) ? Object.fromEntries(Object.entries(s.runs).filter(([k]) => kept.includes(k))) : s.runs;
  if (at === s.at && kept.length === s.ids.length && kept.every((id, i) => id === s.ids[i]) && runs === s.runs) return s;
  return { ...s, ids: kept, at, runs };
}

/** At least two session tabs exist (New session and Focus page do not count). */
export const canSplit = (tabs: readonly string[]) => tabs.filter(isSession).length >= 2;

/** Puts `t` in a new split in direction `dir` (before: left/top) and focuses it. The other split keeps the active tab, else the other existing split's tab, else the neighbour of `t` in the strip. */
export function splitTo(s: Split | undefined, tabs: readonly string[], activeId: string | undefined, t: string, dir: SplitDir, before = false): { split: Split; active: string } | undefined {
  if (!isSession(t) || !tabs.includes(t)) return undefined;
  const other = s?.ids.find((id) => id !== t && tabs.includes(id));
  const x = (isSession(activeId) && activeId !== t ? activeId : undefined) ?? other ?? closeTab(tabs.filter(isSession), t, t).active;
  if (!x) return undefined;
  return { split: { dir, ids: before ? [t, x] : [x, t], at: before ? 0 : 1, ratio: s?.ratio ?? 0.5, runs: s?.runs }, active: t };
}

/** Shows `t` in split `i`; `t` shown in the other split: the two swap. */
export function placeIn(s: Split, t: string, i: number): Split {
  const j = s.ids.indexOf(t);
  const ids = [...s.ids];
  if (j >= 0) [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  else ids[i] = t;
  return { ...s, ids, at: i };
}

export const nextSplit = (s: Split, by: 1 | -1) => s.ids[(s.at + by + s.ids.length) % s.ids.length]!;

/** Tab to activate after closing the active split's tab: the strip neighbour that is in no split, else the other split's tab (the split ends). */
export function nextAfterClose(tabs: readonly string[], id: string, s: Split): string | undefined {
  const others = s.ids.filter((x) => x !== id);
  const free = tabs.filter((t) => t === id || !others.includes(t));
  return closeTab(free, id, id).active ?? others[0];
}

/** Which part of a rect a dragged tab is over: the outer third next to an edge splits there, the middle replaces. */
export function dropZone(r: { left: number; top: number; width: number; height: number }, x: number, y: number): "left" | "right" | "top" | "bottom" | "center" {
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
  if (edge >= 0.33) return "center";
  if (edge === fx) return "left";
  if (edge === 1 - fx) return "right";
  return edge === fy ? "top" : "bottom";
}

const SPLIT_KEY = "claude-ui.split";
let memory: Split | undefined;

// Storage blocked: the split lasts while the page is open.
export function loadSplit(): Split | undefined {
  try {
    return parseSplit(localStorage.getItem(SPLIT_KEY));
  } catch {
    return memory;
  }
}

export function saveSplit(s: Split | undefined) {
  memory = s;
  try {
    if (s) localStorage.setItem(SPLIT_KEY, JSON.stringify(s));
    else localStorage.removeItem(SPLIT_KEY);
  } catch {
    // See `memory`.
  }
}
