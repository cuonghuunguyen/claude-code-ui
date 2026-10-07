// Tabs bar (docs/spec.md "Layout"): open sessions as browser-like tabs, plus one new-session tab. Order persists per browser.
import { baseName } from "./paths.ts";

/** Id of the new-session tab; every other tab id is a session id. */
export const NEW_TAB = "new";

export const openTab = (tabs: string[], id: string) => (tabs.includes(id) ? tabs : [...tabs, id]);

/** Closes a tab only (the session's subscription is App's job); closing the active tab focuses its right neighbour, else its left one. */
export function closeTab(tabs: string[], id: string, active?: string) {
  const at = tabs.indexOf(id);
  const rest = tabs.filter((t) => t !== id);
  return { tabs: rest, active: active === id ? (rest[at] ?? rest[at - 1]) : active };
}

/** Drag reorder: `from` takes the slot of `to`. */
export function moveTab(tabs: string[], from: string, to: string) {
  const at = tabs.indexOf(to);
  if (!tabs.includes(from) || at < 0) return tabs;
  const rest = tabs.filter((t) => t !== from);
  rest.splice(at, 0, from);
  return rest;
}

/** Project groups: tabs of one project (cwd) contiguous, groups in first-seen order, tab order kept inside a group. The new-session tab and tabs of unknown projects share the group "". */
export type CwdOf = (id: string) => string | undefined;
export function groupTabs(tabs: string[], cwdOf: CwdOf) {
  const groups = new Map<string, string[]>();
  for (const id of tabs) {
    const k = cwdOf(id) ?? "";
    groups.set(k, [...(groups.get(k) ?? []), id]);
  }
  return groups;
}

/** Drag/keyboard reorder inside a group: a tab does not leave its project. */
export const moveTabIn = (tabs: string[], cwdOf: CwdOf, from: string, to: string) => ((cwdOf(from) ?? "") === (cwdOf(to) ?? "") ? moveTab(tabs, from, to) : tabs);

/** Moves a whole group one place left (-1) or right (1). */
export function moveGroup(tabs: string[], cwdOf: CwdOf, cwd: string, by: -1 | 1) {
  const groups = [...groupTabs(tabs, cwdOf)];
  const at = groups.findIndex(([k]) => k === cwd);
  const to = at + by;
  if (at < 0 || to < 0 || to >= groups.length) return groups.flatMap(([, ids]) => ids);
  [groups[at], groups[to]] = [groups[to]!, groups[at]!];
  return groups.flatMap(([, ids]) => ids);
}

/** Chip drag: the group `from` takes the slot of the group `to`. */
export function moveGroupTo(tabs: string[], cwdOf: CwdOf, from: string, to: string) {
  const groups = [...groupTabs(tabs, cwdOf)];
  const f = groups.findIndex(([k]) => k === from);
  const t = groups.findIndex(([k]) => k === to);
  if (f < 0 || t < 0) return groups.flatMap(([, ids]) => ids);
  groups.splice(t, 0, ...groups.splice(f, 1));
  return groups.flatMap(([, ids]) => ids);
}

export function replaceTab(tabs: string[], old: string, id: string) {
  const at = tabs.indexOf(old);
  if (at < 0) return openTab(tabs, id);
  return tabs.includes(id) ? tabs.filter((t) => t !== old) : tabs.map((t, i) => (i === at ? id : t));
}

/** Session tabs the daemon does not list, e.g. never prompted before a daemon restart. */
export const staleTabs = (tabs: string[], known: Set<string>) => tabs.filter((id) => id !== NEW_TAB && !known.has(id));

/** Project avatar color (OpenCode project-avatar-v2 palette). */
export const AVATAR_COLORS = ["orange", "yellow", "cyan", "green", "red", "pink", "blue", "purple", "gray"] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

function hashSlot(cwd: string) {
  let h = 0;
  for (const c of cwd) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % AVATAR_COLORS.length;
}

/** Distinct colors for up to 9 known projects (OpenCode picks an unused one): each takes its hashed color or the next free one. */
export function avatarColors(cwds: Iterable<string>) {
  const colors = new Map<string, AvatarColor>();
  const used = new Set<number>();
  for (const cwd of [...new Set(cwds)].sort()) {
    let i = hashSlot(cwd);
    for (let k = 0; k < AVATAR_COLORS.length && used.has(i); k++) i = (i + 1) % AVATAR_COLORS.length;
    used.add(i);
    colors.set(cwd, AVATAR_COLORS[i]!);
  }
  return colors;
}

export const avatarColor = (cwd: string, known?: Map<string, AvatarColor>) => known?.get(cwd) ?? AVATAR_COLORS[hashSlot(cwd)]!;

// The active tab lives in the URL hash, so a reload reopens it: a session id, or "#new" for the new-session tab.
export const tabHash = (id: string) => `#${encodeURIComponent(id)}`;
// A subagent view adds its run: `#<session id>/agent/<subagent part id>`.
const SESSION_HASH = /^#([0-9a-f-]{36})(?:\/agent\/([^/]+))?$/i;
export const tabFromHash = (hash: string) => (hash === tabHash(NEW_TAB) ? NEW_TAB : SESSION_HASH.exec(hash)?.[1]);
/** The subagent run of a subagent view's hash; undefined for the session view. */
export const runFromHash = (hash: string) => {
  const run = SESSION_HASH.exec(hash)?.[2];
  return run && decodeURIComponent(run);
};
export const runHash = (id: string, run?: string) => tabHash(id) + (run ? `/agent/${encodeURIComponent(run)}` : "");

export const projectName = baseName;

const KEY = "claude-ui.tabs";

export function loadTabs(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? [...new Set(v.filter((t): t is string => typeof t === "string"))] : [];
  } catch {
    return [];
  }
}

export function saveTabs(tabs: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {
    // Storage blocked: tabs still work for this page.
  }
}

const collapsedKey = (mode: "project" | "worktree") => (mode === "project" ? "claude-ui.tab-groups-collapsed" : "claude-ui.tab-groups-collapsed.worktree");

/** Group keys whose tab group is collapsed, per browser and grouping mode. Until by worktree has its own set, it starts from the old one (it held raw cwds before the setting existed). */
export function loadCollapsed(mode: "project" | "worktree" = "project"): Set<string> {
  try {
    const v: unknown = JSON.parse((localStorage.getItem(collapsedKey(mode)) ?? (mode === "worktree" ? localStorage.getItem(collapsedKey("project")) : null)) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(cwds: Set<string>, mode: "project" | "worktree" = "project") {
  try {
    localStorage.setItem(collapsedKey(mode), JSON.stringify([...cwds]));
  } catch {
    // Storage blocked: the groups still collapse for this page.
  }
}
