// Sidebar helpers for the session list (docs/spec.md "Layout").
import type { SessionListItem } from "@claude-ui/protocol";
import { projectName } from "./tabs.ts";

/**
 * One group per working directory whatever the input order; groups and sessions newest first.
 * A query keeps sessions whose title or project name contains it.
 */
export function groupByCwd(items: SessionListItem[], query = "") {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, SessionListItem[]>();
  for (const s of [...items].sort((a, b) => b.lastActivity - a.lastActivity)) {
    const cwd = s.cwd.replace(/(.)\/+$/, "$1");
    if (q && !s.title.toLowerCase().includes(q) && !projectName(cwd).toLowerCase().includes(q)) continue;
    const g = groups.get(cwd);
    if (g) g.push(s);
    else groups.set(cwd, [s]);
  }
  return [...groups].map(([cwd, sessions]) => ({ cwd, sessions }));
}

export function timeAgo(ms: number, now = Date.now()) {
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

const KEY = "claude-ui.collapsed";

/** Working directories whose sidebar group is collapsed in this browser. */
export function loadCollapsed(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(cwds: Set<string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...cwds]));
  } catch {
    // Storage blocked: collapsing still works for this page.
  }
}
