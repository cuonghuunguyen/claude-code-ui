// Sidebar helpers for the session list (docs/spec.md "Layout").
import type { SessionListItem } from "@claude-ui/protocol";
import { projectName } from "./tabs.ts";

/**
 * One group per working directory whatever the input order; groups and sessions newest first.
 * A query keeps sessions whose title or project name contains it. Archived sessions show only with `archived`, and then only they.
 * With `projects` (the daemon's known projects): one group per project in that order, empty ones too (not with `archived`); other sessions are dropped.
 */
export function groupByCwd(items: SessionListItem[], query = "", projects?: string[], archived = false) {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, SessionListItem[]>(archived ? [] : projects?.map((p) => [p, []]));
  for (const s of [...items].sort((a, b) => b.lastActivity - a.lastActivity)) {
    if (s.archived !== archived) continue;
    const cwd = projectCwd(s.cwd);
    if (projects && !projects.includes(cwd)) continue;
    if (q && !s.title.toLowerCase().includes(q) && !projectName(cwd).toLowerCase().includes(q)) continue;
    const g = groups.get(cwd);
    if (g) g.push(s);
    else groups.set(cwd, [s]);
  }
  return [...groups]
    .filter(([cwd, sessions]) => sessions.length || !q || projectName(cwd).toLowerCase().includes(q))
    .map(([cwd, sessions]) => ({ cwd, sessions }));
}

/** "/p/x/" and "/p/x" are one project (as in the daemon). */
export const projectCwd = (cwd: string) => cwd.replace(/(.)\/+$/, "$1");
export const inProject = (cwd: string) => (s: SessionListItem) => projectCwd(s.cwd) === cwd;

/** `list` with one session's fields replaced: an action shows at once, before the daemon's list refetch. */
export function patchSession(list: SessionListItem[], id: string, patch: Partial<SessionListItem>) {
  return list.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/** Newest-first sessions split by calendar day of last activity, as OpenCode's Home list: Today, Yesterday, Older (Recent sessions when alone); empty days dropped. */
export function byDay(sessions: SessionListItem[], now = Date.now()) {
  const day = (ms: number) => new Date(ms).toDateString();
  const today = day(now);
  const yesterday = day(new Date(now).setDate(new Date(now).getDate() - 1));
  const groups: Record<"Today" | "Yesterday" | "Older", SessionListItem[]> = { Today: [], Yesterday: [], Older: [] };
  for (const s of sessions) {
    const d = day(s.lastActivity);
    groups[d === today ? "Today" : d === yesterday ? "Yesterday" : "Older"].push(s);
  }
  const lone = !groups.Today.length && !groups.Yesterday.length;
  return Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([title, list]) => ({ title: lone ? "Recent sessions" : title, sessions: list }));
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
