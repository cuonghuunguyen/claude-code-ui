// Sidebar helpers for the session list (docs/spec.md "Layout").
import type { SessionListItem } from "@claude-ui/protocol";

/** Groups keep the list order: input sorted by last activity gives the most recent group first. */
export function groupByCwd(items: SessionListItem[]) {
  const groups = new Map<string, SessionListItem[]>();
  for (const s of items) groups.set(s.cwd, [...(groups.get(s.cwd) ?? []), s]);
  return [...groups].map(([cwd, sessions]) => ({ cwd, sessions }));
}

export function timeAgo(ms: number, now = Date.now()) {
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}
