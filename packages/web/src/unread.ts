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
