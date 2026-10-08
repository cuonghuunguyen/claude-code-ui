// Sidebar helpers for the session list (docs/spec.md "Layout").
import type { SessionListItem, Worktree, WorktreeStatusResult } from "@claude-ui/protocol";
import { projectName } from "./tabs.ts";

/** `idle`: sessions the "Show only active sessions" setting hides from the row (activeOnly). */
export type WorktreeRow = Worktree & { sessions: SessionListItem[]; idle?: number };
/**
 * `cwd`: the project the group shows (the main checkout when it is added). `members`: the added projects of its repository.
 * `worktrees`: one row per worktree when the repository has linked ones (main first, then by branch); `sessions` then holds only
 * sessions of no row.
 */
export type SessionGroup = { cwd: string; members: string[]; sessions: SessionListItem[]; worktrees: WorktreeRow[]; idle?: number };

/** The added project whose worktree list holds `cwd` (a worktree path), else `cwd`. */
export const projectOf = (cwd: string, worktrees: Record<string, Worktree[]> = {}) =>
  worktrees[cwd] ? cwd : (Object.keys(worktrees).find((p) => worktrees[p]!.some((w) => w.path === cwd)) ?? cwd);

/**
 * Whether the web app may remove `w`: a linked worktree inside the roots directly under `<main>/.claude/worktrees` (the ones it creates).
 * A worktree made by hand or by another tool is never offered; the daemon refuses it too.
 */
export function removableWorktree(list: Worktree[], w: Worktree) {
  const main = list.find((x) => x.main);
  if (!main || w.main || w.outsideRoots) return false;
  const dir = `${main.path.replace(/[\\/]+$/, "")}/.claude/worktrees/`;
  const p = w.path.replace(/\\/g, "/");
  const d = dir.replace(/\\/g, "/");
  return p.startsWith(d) && p.length > d.length && !p.slice(d.length).includes("/");
}

/** Remove worktree confirmation text (Claude Code CLI wording). */
export function removeWorktreeText({ uncommitted, commits, branch }: WorktreeStatusResult) {
  const lost = [uncommitted && `${uncommitted} uncommitted ${uncommitted === 1 ? "file" : "files"}`, commits && `${commits} ${commits === 1 ? "commit" : "commits"}`].filter(Boolean);
  return lost.length ? `You have ${lost.join(" and ")} on ${branch}. All will be lost if you remove.` : "Clean up the worktree directory.";
}

/** "<project> · <branch>" for a cwd that is a linked worktree of an added project's repository; undefined otherwise (main checkout, non-git, unknown). */
export function worktreeName(cwd: string, worktrees: Record<string, Worktree[]> = {}) {
  for (const list of Object.values(worktrees)) {
    const w = list.find((x) => x.path === cwd);
    const main = list.find((x) => x.main);
    if (w && !w.main && main) return `${projectName(main.path)} · ${w.branch ?? projectName(cwd)}`;
  }
}

/** The main worktree of a project in a git repository, else the project itself: projects of one repository share it. */
export const repoOf = (cwd: string, worktrees: Record<string, Worktree[]> = {}) => worktrees[cwd]?.find((w) => w.main)?.path ?? cwd;

/**
 * The sidebar search: `@project=<name>` (quotes for spaces) anywhere in the query names a project; the rest is `text`.
 * An empty value or a token inside a word is plain text.
 */
export function parseSessionQuery(query: string): { project?: string; text: string } {
  const m = /(^|\s)@project=(?:"([^"]+)"|([^\s"]\S*))(?=\s|$)/.exec(query);
  if (!m) return { text: query.trim() };
  const text = (query.slice(0, m.index) + " " + query.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { project: m[2] ?? m[3], text };
}

/**
 * The search text `/resume` fills in: `@project=<name> <text>`; a name with spaces is quoted. The syntax has no escape: a name that cannot be
 * written (a `"` in a quoted name or first) falls back to a plain text search of the name without quotes; an empty name gives just `text`.
 */
export function resumeSearchText(name: string, text = "") {
  const spaced = /\s/.test(name);
  if (!name.trim()) return text;
  if (spaced || name.startsWith('"')) {
    const plain = name.replace(/"/g, "").trim();
    return spaced && !name.includes('"') ? `@project="${name}" ${text}` : `${plain} ${text}`.trimStart();
  }
  return `@project=${name} ${text}`;
}

/**
 * One group per working directory (per repository with `worktrees`) whatever the input order; groups and sessions newest first.
 * `@project=<name>` in the query (parseSessionQuery) keeps only the group with a project (its main checkout or an added worktree) of that name (case-insensitive), worktree rows included; with several tokens the first one counts.
 * A query keeps sessions whose title, project name or worktree branch contains it. Archived sessions show only with `archived`, and then only they.
 * With `projects` (the daemon's known projects): one group per project in that order, empty ones too (not with `archived`); other sessions
 * are dropped, except those of the projects' worktrees (`worktrees`: session.list's, docs/spec.md "Projects").
 * `workers` (nestWorkers): a coordinator also matches the query by the title or name of one of its workers.
 */
export function groupByCwd(items: SessionListItem[], query = "", projects?: string[], archived = false, worktrees: Record<string, Worktree[]> = {}, workers?: Map<string, SessionListItem[]>): SessionGroup[] {
  const { project, text } = parseSessionQuery(query);
  const q = text.toLowerCase();
  const inScope = (g: SessionGroup) => !project || [g.cwd, ...g.members].some((c) => projectName(c).toLowerCase() === project.toLowerCase());
  const has = (text: string | undefined) => !!text && text.toLowerCase().includes(q);
  const groups = new Map<string, SessionGroup>();
  // Session cwd → its group and worktree row.
  const at = new Map<string, { g: SessionGroup; row?: WorktreeRow }>();
  const add = (cwd: string) => {
    const key = repoOf(cwd, worktrees);
    let g = groups.get(key);
    if (!g) {
      const wts = worktrees[cwd] ?? [];
      const rows = wts.some((w) => !w.main) ? wts.map((w) => ({ ...w, sessions: [] })).sort(byRow) : [];
      groups.set(key, (g = { cwd, members: [], sessions: [], worktrees: rows }));
      for (const row of rows) at.set(row.path, { g, row });
    }
    g.members.push(cwd);
    if (cwd === key) g.cwd = cwd;
    if (!at.has(cwd)) at.set(cwd, { g });
    return at.get(cwd)!;
  };
  projects?.forEach(add);
  for (const s of [...items].sort((a, b) => b.lastActivity - a.lastActivity)) {
    if (s.archived !== archived) continue;
    const cwd = projectCwd(s.cwd);
    const found = at.get(cwd) ?? (projects ? undefined : add(cwd));
    if (!found) continue;
    if (!inScope(found.g)) continue;
    if (q && !has(s.title) && !has(projectName(found.g.cwd)) && !has(found.row?.branch) && !workers?.get(s.id)?.some((w) => has(w.title) || has(w.workerName))) continue;
    (found.row ?? found.g).sessions.push(s);
  }
  return [...groups.values()].filter(inScope).flatMap((g) => {
    const named = !q || has(projectName(g.cwd));
    // Empty rows show unless archived; while searching, only those the project name or branch matches.
    const rows = g.worktrees.filter((r) => r.sessions.length || (!archived && (named || has(r.branch))));
    const count = g.sessions.length + rows.reduce((n, r) => n + r.sessions.length, 0);
    return count || (!archived && (named || rows.length)) ? [{ ...g, worktrees: rows }] : [];
  });
}

/** Workers (coordinatorId) of a coordinator listed in the same view (archived flag) by coordinator ID, by name; every other session in `top`. */
export function nestWorkers(items: SessionListItem[], archived: boolean) {
  const ids = new Set(items.filter((s) => s.archived === archived).map((s) => s.id));
  const top: SessionListItem[] = [];
  const workers = new Map<string, SessionListItem[]>();
  for (const s of items)
    if (s.coordinatorId && s.archived === archived && ids.has(s.coordinatorId)) workers.set(s.coordinatorId, [...(workers.get(s.coordinatorId) ?? []), s]);
    else top.push(s);
  for (const l of workers.values()) l.sort((a, b) => (a.workerName ?? a.title).localeCompare(b.workerName ?? b.title));
  return { top, workers };
}

/** Main checkout first, then by branch (directory when detached without one). */
export const byRow = (a: Worktree, b: Worktree) => Number(b.main) - Number(a.main) || (a.branch ?? a.path).localeCompare(b.branch ?? b.path);

/** "/p/x/" and "/p/x" are one project (as in the daemon). */
export const projectCwd = (cwd: string) => cwd.replace(/(.)\/+$/, "$1");
export const inProject = (cwd: string) => (s: SessionListItem) => projectCwd(s.cwd) === cwd;

/** `list` with one session's fields replaced: an action shows at once, before the daemon's list refetch. */
export function patchSession(list: SessionListItem[], id: string, patch: Partial<SessionListItem>) {
  return list.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/** Sessions a group or worktree row lists first; "Load more" adds `MORE`. */
export const SHOWN = 5;
export const MORE = 10;

/** The `limit` newest sessions, plus any for which `always` holds (active, running, needs input); `hidden`: the first one cut off, else undefined. */
export function limitSessions(sessions: SessionListItem[], limit: number, always: (s: SessionListItem) => boolean) {
  const shown = sessions.filter((s, i) => i < limit || always(s));
  return { shown, hidden: sessions.length > shown.length ? sessions.find((s) => !shown.includes(s)) : undefined };
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

/** A worktree row's collapse key: not its path alone, which is also the project's key for the main checkout. */
export const rowKey = (path: string) => `worktree:${path}`;
/** The collapse key of the workers of coordinator `id` in the normal or the archived view. */
export const workerKey = (id: string, archived: boolean) => `${archived ? "archived:" : ""}coordinator:${id}`;

/** Every collapse key of the view: project groups, worktree rows, worker groups (Collapse all). */
export function collapseKeys(groups: SessionGroup[], workers: Map<string, SessionListItem[]>, archived: boolean) {
  return [...groups.flatMap((g) => [g.cwd, ...g.worktrees.map((r) => rowKey(r.path))]), ...[...workers.keys()].map((id) => workerKey(id, archived))];
}

/** The collapse keys that hide session `id` (its group, worktree row, coordinator's worker group); undefined when the groups do not list it. */
export function revealKeys(id: string, groups: SessionGroup[], workers: Map<string, SessionListItem[]>, archived: boolean) {
  const coordinator = [...workers].find(([, ws]) => ws.some((w) => w.id === id))?.[0];
  const top = coordinator ?? id;
  for (const g of groups) {
    if (g.sessions.some((s) => s.id === top)) return [g.cwd, ...(coordinator ? [workerKey(coordinator, archived)] : [])];
    const r = g.worktrees.find((r) => r.sessions.some((s) => s.id === top));
    if (r) return [g.cwd, rowKey(r.path), ...(coordinator ? [workerKey(coordinator, archived)] : [])];
  }
}

export type SidebarSort = "recent" | "name";
/** `recent` keeps the daemon's order; `name`: A to Z by project name (stable). */
export const sortGroups = (groups: SessionGroup[], sort: SidebarSort) =>
  sort === "name" ? [...groups].sort((a, b) => projectName(a.cwd).localeCompare(projectName(b.cwd), undefined, { sensitivity: "base" })) : groups;

/** Workers that `keep` holds for; a coordinator with none drops out. */
export function activeWorkers(workers: Map<string, SessionListItem[]>, keep: (s: SessionListItem) => boolean) {
  const out = new Map<string, SessionListItem[]>();
  for (const [id, ws] of workers) if (ws.some(keep)) out.set(id, ws.filter(keep));
  return out;
}

/**
 * "Show only active sessions": groups with only the sessions `keep` holds for (running, needs input, the open one), or whose workers it
 * holds for. A project or worktree row with none is dropped; `idle` counts what each keeps out (workers included), `idleTotal` is the sum.
 */
export function activeOnly(groups: SessionGroup[], workers: Map<string, SessionListItem[]>, keep: (s: SessionListItem) => boolean): { groups: SessionGroup[]; idleTotal: number } {
  const kept = (s: SessionListItem) => keep(s) || !!workers.get(s.id)?.some(keep);
  // Hidden sessions of a list: those not kept, with all their workers, and the idle workers of a kept coordinator.
  const idleOf = (l: SessionListItem[]) => l.reduce((n, s) => n + (kept(s) ? (workers.get(s.id) ?? []).filter((w) => !keep(w)).length : 1 + (workers.get(s.id)?.length ?? 0)), 0);
  let idleTotal = 0;
  const out: SessionGroup[] = [];
  for (const g of groups) {
    const rows = g.worktrees.map((r) => ({ ...r, sessions: r.sessions.filter(kept), idle: idleOf(r.sessions) })).filter((r) => r.sessions.length);
    const sessions = g.sessions.filter(kept);
    const idle = idleOf(g.sessions) + g.worktrees.reduce((n, r) => n + idleOf(r.sessions), 0);
    idleTotal += idle;
    if (sessions.length || rows.length) out.push({ ...g, sessions, worktrees: rows, idle });
  }
  return { groups: out, idleTotal };
}

/** Sidebar view settings, per browser (docs/spec.md "Layout"). */
export type SidebarView = { alwaysSelect: boolean; dayHeaders: boolean; onlyActive: boolean; sort: SidebarSort };
const VIEW_KEY = "claude-ui.sidebarView";
/** Fired on `window` by saveSidebarView. */
export const VIEW_EVENT = "claude-ui:sidebar-view";
const VIEW_DEFAULT: SidebarView = { alwaysSelect: false, dayHeaders: true, onlyActive: false, sort: "recent" };

export function loadSidebarView(): SidebarView {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, unknown>;
    const bool = (k: "alwaysSelect" | "dayHeaders" | "onlyActive") => (typeof v[k] === "boolean" ? (v[k] as boolean) : VIEW_DEFAULT[k]);
    return { alwaysSelect: bool("alwaysSelect"), dayHeaders: bool("dayHeaders"), onlyActive: bool("onlyActive"), sort: v.sort === "name" ? "name" : "recent" };
  } catch {
    return VIEW_DEFAULT;
  }
}

export function saveSidebarView(view: SidebarView) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    // The sidebar and the Settings dialog both write it: the mounted list follows.
    window.dispatchEvent(new Event(VIEW_EVENT));
  } catch {
    // Storage blocked: the settings still apply to this page.
  }
}
