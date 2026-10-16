// Unread markers (docs/spec.md "Layout", "Session view UX"): a session needed input or finished since this browser last showed it.
import type { SessionView } from "./store.ts";

/** Where this browser last showed a session in a focused, visible tab. Seqs are per daemon run, hence the epoch. */
export type Seen = { epoch?: string; seq: number };

export const isUnread = (v: SessionView, seen: Seen | undefined) => v.attentionSeq > (seen && seen.epoch === v.logEpoch ? seen.seq : 0);

export const seenNow = (v: SessionView): Seen => ({ epoch: v.logEpoch, seq: v.lastSeq });

export const tabTitle = (unread: number) => (unread ? `(${unread}) Claude UI` : "Claude UI");

const KEY = "claude-ui.seen";

export function loadSeen(): Record<string, Seen> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveSeen(seen: Record<string, Seen>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    // Storage blocked: markers still work for this tab.
  }
}

/**
 * Clean up tabs (GH-378): per session, the list's `lastActivity` (timestamp of the last user or assistant transcript entry, else the
 * transcript file's mtime) when this browser last showed it. Where the attention seq cannot tell (no view, or a view of another daemon
 * run than this browser's seen mark), the unread state is lastActivity against this record.
 */
export type ShownActivity = Record<string, number>;
const SHOWN_KEY = "claude-ui.shown-activity";

const parseShown = (raw: string | null): ShownActivity => {
  try {
    const v = JSON.parse(raw ?? "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])));
  } catch {
    return {};
  }
};

export function loadShownActivity(): ShownActivity {
  try {
    return parseShown(localStorage.getItem(SHOWN_KEY));
  } catch {
    return {};
  }
}

/** Merges with the stored records (max per session): two windows of one browser do not erase each other's. */
export function saveShownActivity(a: ShownActivity): void {
  try {
    const merged = parseShown(localStorage.getItem(SHOWN_KEY));
    for (const [id, t] of Object.entries(a)) merged[id] = Math.max(t, merged[id] ?? 0);
    localStorage.setItem(SHOWN_KEY, JSON.stringify(merged));
  } catch {
    // Blocked storage: such tabs stay "unknown" for the cleanup rules.
  }
}

/** Drops the records of sessions not in `keep`, here and in storage (open tabs and the closed-tab stack, like `claude-ui.tab-used`). */
export function pruneShownActivity(a: ShownActivity, keep: ReadonlySet<string>): ShownActivity {
  try {
    const stored = parseShown(localStorage.getItem(SHOWN_KEY));
    if (Object.keys(stored).some((id) => !keep.has(id))) localStorage.setItem(SHOWN_KEY, JSON.stringify(Object.fromEntries(Object.entries(stored).filter(([id]) => keep.has(id)))));
  } catch {
    // Blocked storage: nothing stored to prune.
  }
  return Object.keys(a).some((id) => !keep.has(id)) ? Object.fromEntries(Object.entries(a).filter(([id]) => keep.has(id))) : a;
}

/** Unread state of a session without a view from its list lastActivity; undefined = unknown (this browser has no record of showing it). */
export const closedUnread = (lastActivity: number, shown: number | undefined): boolean | undefined => (shown === undefined ? undefined : lastActivity > shown);

/**
 * Unread state of an open tab (GH-378); undefined = unknown. The view's attention seq covers only its daemon run (log epoch): it decides
 * alone when this browser's seen mark is of that run. Otherwise (daemon restarted, session loaded by another client, no view) unseen
 * attention of this run is unread, and earlier output is judged by `lastActivity` against the shown record.
 */
export function tabUnread(v: SessionView | undefined, seen: Seen | undefined, lastActivity: number | undefined, shown: number | undefined): boolean | undefined {
  if (v && seen?.epoch !== undefined && seen.epoch === v.logEpoch) return isUnread(v, seen);
  if (v && isUnread(v, seen)) return true;
  return lastActivity === undefined ? undefined : closedUnread(lastActivity, shown);
}
