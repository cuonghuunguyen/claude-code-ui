// Pure parts of the sidebar context menus (GH-358): menu entries, bulk worker targets, idle sessions to archive.
import type { SessionListItem, SessionState } from "@claude-ui/protocol";
import type { SessionGroup, WorktreeRow } from "./sessions.ts";
import { t } from "./i18n.ts";

export type MenuEntry =
  | { kind: "item"; id: string; label: string; onSelect: () => void; disabled?: boolean; destructive?: boolean }
  | { kind: "check"; id: string; label: string; checked: boolean; onChange: (on: boolean) => void }
  | { kind: "label"; label: string }
  | { kind: "sep" };

const DAY = 86_400_000;
export const ARCHIVE_DAYS = [1, 7, 30] as const;
export const daysLabel = (d: number) => t("sidebar.days", { count: d });

/** Ends and doubled separators dropped (a section may be empty). */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e.kind === "sep" && (!out.length || out.at(-1)!.kind === "sep")) continue;
    out.push(e);
  }
  while (out.at(-1)?.kind === "sep") out.pop();
  return out;
}

/**
 * Workers a bulk action acts on: `finished` = idle or error with a CLI process to close; `closed` = idle with no CLI process (Remove closed workers).
 * An error worker without a CLI is neither: Remove on its own row covers it.
 */
export function workerCounts(ws: SessionListItem[], state: (s: SessionListItem) => SessionState): { finished: string[]; closed: string[] } {
  const finished: string[] = [];
  const closed: string[] = [];
  for (const w of ws) {
    const st = state(w);
    if (st === "closed") closed.push(w.id);
    else if ((st === "idle" || st === "error") && w.live !== false) finished.push(w.id);
  }
  return { finished, closed };
}

/**
 * Sessions "Archive idle sessions older than N days" archives: not archived, with a transcript, not running or waiting for input, not the open
 * one, last active more than `days` ago. A coordinator counts only when it and all its workers qualify; its workers are archived with it.
 */
export function idleTargets(sessions: SessionListItem[], workers: Map<string, SessionListItem[]>, o: { days: number; now: number; activeId?: string; state: (s: SessionListItem) => SessionState }): string[] {
  const limit = o.now - o.days * DAY;
  const ok = (s: SessionListItem) => {
    const st = o.state(s);
    return !s.archived && s.transcript && st !== "running" && st !== "needs_input" && s.id !== o.activeId && s.lastActivity < limit;
  };
  const ids: string[] = [];
  for (const s of sessions) {
    const ws = workers.get(s.id) ?? [];
    if (ok(s) && ws.every(ok)) ids.push(s.id, ...ws.map((w) => w.id));
  }
  return ids;
}

/** Every session a project row lists (its own and those of its worktree rows) or one worktree row lists. */
export const groupSessions = (g: SessionGroup | WorktreeRow): SessionListItem[] => ("worktrees" in g ? [...g.sessions, ...g.worktrees.flatMap((r) => r.sessions)] : g.sessions);

/** At most `max` names, then "+k more". */
export function confirmNames(names: string[], max = 10) {
  return names.length > max ? t("sidebar.namesMore", { names: names.slice(0, max).join(", "), count: names.length - max }) : names.join(", ");
}


/** Menu of a project or worktree row (also the kebab below md). `prefix`: test id prefix, e.g. "group-menu-". */
export function groupEntries(o: {
  prefix: string;
  newSession?: () => void;
  /** `quick`: "New worktree", at once with a generated name; else "Create worktree…", the modal. */
  newWorktree?: (quick: boolean) => void;
  archivedView: boolean;
  onlyActive: boolean;
  setOnlyActive: (on: boolean) => void;
  archiveCount: (days: number) => number;
  onArchive: (days: number) => void;
  /** Copy path (GH-456): the folder path as its side sees it, the row tooltip. */
  copyPath?: () => void;
  /** "Clean up…" (GH-377): the Clean up dialog scoped to this project. */
  cleanUp?: () => void;
  /** Last section (Remove from list, Delete worktree…). */
  tail?: { id: string; label: string; onSelect: () => void };
}): MenuEntry[] {
  const p = o.prefix;
  const e: MenuEntry[] = [];
  if (o.newSession) e.push({ kind: "item", id: `${p}new-session`, label: t("sidebar.menu.newSession"), onSelect: o.newSession });
  if (o.newWorktree) {
    const nw = o.newWorktree;
    e.push({ kind: "item", id: `${p}new-worktree`, label: t("sidebar.menu.newWorktree"), onSelect: () => nw(true) }, { kind: "item", id: `${p}create-worktree`, label: t("sidebar.menu.createWorktree"), onSelect: () => nw(false) });
  }
  if (o.copyPath) e.push({ kind: "sep" }, { kind: "item", id: `${p}copy-path`, label: t("sidebar.menu.copyPath"), onSelect: o.copyPath });
  if (!o.archivedView) {
    e.push({ kind: "sep" }, { kind: "check", id: `${p}hide-inactive`, label: t("sidebar.menu.hideInactive"), checked: o.onlyActive, onChange: o.setOnlyActive }, { kind: "label", label: t("sidebar.menu.archiveIdleOlder") });
    for (const d of ARCHIVE_DAYS) {
      const n = o.archiveCount(d);
      e.push({ kind: "item", id: `${p}archive-${d}`, label: `${daysLabel(d)} (${n})…`, disabled: n === 0, onSelect: () => o.onArchive(d) });
    }
  }
  if (o.cleanUp) e.push({ kind: "sep" }, { kind: "item", id: `${p}cleanup`, label: t("sidebar.menu.cleanUp"), onSelect: o.cleanUp });
  if (o.tail) e.push({ kind: "sep" }, { kind: "item", id: o.tail.id, label: o.tail.label, destructive: true, onSelect: o.tail.onSelect });
  return tidy(e);
}

/** Bulk worker actions of a coordinator (the N workers row); `finished` / `closed` are the ids workerCounts returned. */
export function workerEntries(prefix: string, c: { finished: string[]; closed: string[] }, on: { close: () => void; remove: () => void; cleanUp?: () => void }): MenuEntry[] {
  return [
    { kind: "item", id: `${prefix}close-finished`, label: t("sidebar.action.closeFinished", { count: c.finished.length }), disabled: !c.finished.length, onSelect: on.close },
    { kind: "item", id: `${prefix}remove-closed`, label: t("sidebar.action.removeClosed", { count: c.closed.length }), disabled: !c.closed.length, destructive: true, onSelect: on.remove },
    ...(on.cleanUp ? [{ kind: "item" as const, id: `${prefix}cleanup`, label: t("sidebar.action.cleanUpWorkers"), onSelect: on.cleanUp }] : []),
  ];
}
