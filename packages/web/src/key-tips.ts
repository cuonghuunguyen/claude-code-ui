// Key promoter (docs/spec.md "Keyboard shortcuts" › Shortcut tips): per-browser click counters and the tips switch. Nothing reaches the daemon.
import { useSyncExternalStore } from "react";

export const KEY_TIPS_KEY = "claude-ui.key-tips";
/** Click counts that show a tip. */
export const TIP_AT: readonly number[] = [2, 5, 10];
const MAX = TIP_AT[TIP_AT.length - 1]!;

export type KeyTipsState = { v: 1; off?: true; counts: Record<string, number>; learned: string[] };
export const EMPTY: KeyTipsState = { v: 1, counts: {}, learned: [] };
const fresh = (): KeyTipsState => ({ v: 1, counts: {}, learned: [] });

export function parseKeyTips(raw: string | null): KeyTipsState {
  if (!raw) return fresh();
  try {
    const o = JSON.parse(raw) as Partial<KeyTipsState> | null;
    if (!o || typeof o !== "object" || o.v !== 1) return fresh();
    const counts: Record<string, number> = {};
    if (o.counts && typeof o.counts === "object") for (const [k, n] of Object.entries(o.counts)) if (Number.isInteger(n) && n >= 1 && n <= MAX) counts[k] = n;
    const learned = Array.isArray(o.learned) ? [...new Set(o.learned.filter((x): x is string => typeof x === "string"))] : [];
    return o.off === true ? { v: 1, off: true, counts, learned } : { v: 1, counts, learned };
  } catch {
    return fresh();
  }
}

/** One click on a command: the new state and whether a tip shows. Same state object when nothing changes. */
export function countClick(s: KeyTipsState, id: string): { state: KeyTipsState; tip: boolean } {
  const cur = s.counts[id] ?? 0;
  if (s.off || s.learned.includes(id) || cur >= MAX) return { state: s, tip: false };
  const n = cur + 1;
  return { state: { ...s, counts: { ...s.counts, [id]: n } }, tip: TIP_AT.includes(n) };
}

export const markUsed = (s: KeyTipsState, id: string): KeyTipsState => (s.learned.includes(id) ? s : { ...s, learned: [...s.learned, id] });
/** Clears counts and learned commands and turns tips on. */
export const resetKeyTips = (): KeyTipsState => fresh();
export function withOff(s: KeyTipsState, off: boolean): KeyTipsState {
  if (off) return { ...s, off: true };
  const { off: _, ...rest } = s;
  return rest;
}

let memory: KeyTipsState = fresh(); // storage blocked: lasts for this page
const listeners = new Set<() => void>();

export function loadKeyTips(storage: Storage = localStorage): KeyTipsState {
  try {
    return parseKeyTips(storage.getItem(KEY_TIPS_KEY));
  } catch {
    return memory;
  }
}

export function saveKeyTips(s: KeyTipsState, storage: Storage = localStorage) {
  memory = s;
  try {
    storage.setItem(KEY_TIPS_KEY, JSON.stringify(s));
  } catch {
    // See `memory`.
  }
  listeners.forEach((l) => l());
}

/** Counts a click; true when a tip shows. */
export const recordClick = (id: string): boolean => {
  const cur = loadKeyTips();
  const r = countClick(cur, id);
  if (r.state !== cur) saveKeyTips(r.state);
  return r.tip;
};
export const markKeyUsed = (id: string) => {
  const s = loadKeyTips();
  const n = markUsed(s, id);
  if (n !== s) saveKeyTips(n);
};
export const setKeyTipsOn = (on: boolean) => saveKeyTips(withOff(loadKeyTips(), !on));
export const resetAllKeyTips = () => saveKeyTips(resetKeyTips());

export function subscribeKeyTips(l: () => void) {
  listeners.add(l);
  // Another tab of this browser changed it.
  const onStorage = (e: StorageEvent) => (e.key === KEY_TIPS_KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
/** On/off; re-renders on a change here or in another tab. The snapshot is a primitive so useSyncExternalStore stays stable. */
export const useKeyTipsOn = () => useSyncExternalStore(subscribeKeyTips, () => !loadKeyTips().off, () => false);
