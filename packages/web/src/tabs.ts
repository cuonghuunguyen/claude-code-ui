// Tabs bar (docs/spec.md "Layout"): open sessions as browser-like tabs, plus one new-session tab. Order persists per browser.
import { baseName } from "./paths.ts";
import { ownerOf, parseRef } from "./pane-ref.ts";

/** Id of the new-session tab; every other tab id is a session id. */
export const NEW_TAB = "new";

/** Id of the Focus page's pinned tab (docs/spec.md "Focus"): never in the stored tab list, never closable. */
export const FOCUS_TAB = "focus";

export const openTab = (tabs: string[], id: string) => (tabs.includes(id) ? tabs : [...tabs, id]);

/** Closes a tab only (the session's subscription is App's job); closing the active tab focuses its right neighbour, else its left one. */
export function closeTab(tabs: string[], id: string, active?: string) {
  const at = tabs.indexOf(id);
  const rest = tabs.filter((t) => t !== id);
  return { tabs: rest, active: active === id ? (rest[at] ?? rest[at - 1]) : active };
}

/** Closes several tabs at once (a group). An active tab among them is replaced by the first tab after it, else the last one before it (Chrome), else none. */
export function closeMany(tabs: string[], ids: string[], active?: string) {
  const gone = new Set(ids);
  const rest = tabs.filter((t) => !gone.has(t));
  if (!active || !gone.has(active)) return { tabs: rest, active };
  const at = tabs.indexOf(active);
  return { tabs: rest, active: tabs.slice(at + 1).find((t) => !gone.has(t)) ?? tabs.slice(0, at).reverse().find((t) => !gone.has(t)) };
}

/** Bulk close targets (tab menu: Close others / to the right / all) in strip order; pinned tabs never. */
export function closeTargets(tabs: string[], pinned: ReadonlySet<string>, id: string, kind: "others" | "right" | "all") {
  const from = kind === "right" ? tabs.slice(tabs.indexOf(id) + 1) : tabs;
  return from.filter((t) => !pinned.has(t) && (kind !== "others" || t !== id));
}

/** Tabs of every group but `key` (chip menu: Close other groups), pinned ones excluded. */
export const otherGroupTargets = (tabs: string[], pinned: ReadonlySet<string>, cwdOf: CwdOf, key: string) => tabs.filter((t) => (cwdOf(t) ?? "") !== key && !pinned.has(t));

/** The tab one step from `active` in `order` (by +1 or -1); none past either end (no wrap) or when `active` is not in the order. */
export const stepNoWrap = (order: string[], active: string | undefined, by: 1 | -1) => {
  const at = active === undefined ? -1 : order.indexOf(active);
  return at < 0 ? undefined : order[at + by];
};

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

/**
 * True when every tab's group key is final, so the strip may draw group chips and the stored list may be regrouped (GH-196).
 * Needs the first session list (`listLoaded`) and, per tab, either its session known (`known`) or its subscribe failed (`failed`: any error but unknown_session and a dropped connection; there is no timeout, and such a tab would otherwise hide every chip until it is closed; such a tab keeps the group "" like the new-session tab). The new-session tab has no session and is always final.
 */
export function keysFinal(tabs: string[], listLoaded: boolean, known: (id: string) => boolean, failed: ReadonlySet<string> = new Set()) {
  return listLoaded && tabs.every((id) => id === NEW_TAB || known(ownerOf(id)) || failed.has(ownerOf(id)));
}

/** Drag/keyboard reorder inside a group: a tab does not leave its project, and (with `pinned`) a pinned tab does not cross the unpinned ones. */
export const moveTabIn = (tabs: string[], cwdOf: CwdOf, from: string, to: string, pinned?: ReadonlySet<string>) =>
  (cwdOf(from) ?? "") === (cwdOf(to) ?? "") && !(pinned && pinned.has(from) !== pinned.has(to)) ? moveTab(tabs, from, to) : tabs;

/** Pinned tabs first inside each group (GH-359), both parts in their own order. */
export const pinOrder = (tabs: string[], pinned: ReadonlySet<string>, cwdOf: CwdOf) =>
  [...groupTabs(tabs, cwdOf).values()].flatMap((ids) => [...ids.filter((t) => pinned.has(t)), ...ids.filter((t) => !pinned.has(t))]);

/** Pin or unpin `id`: it goes to the end of its group's pinned block when pinned, right after the block when unpinned. */
export function setPinned(tabs: string[], pinned: string[], id: string, on: boolean, cwdOf: CwdOf) {
  const next = on ? [...pinned.filter((t) => t !== id), id] : pinned.filter((t) => t !== id);
  if (!tabs.includes(id)) return { tabs, pinned: next };
  const others = new Set(pinned.filter((t) => t !== id));
  const key = cwdOf(id) ?? "";
  const rest = tabs.filter((t) => t !== id);
  const group = rest.map((t, i) => [t, i] as const).filter(([t]) => (cwdOf(t) ?? "") === key);
  const lastPinned = group.filter(([t]) => others.has(t)).at(-1)?.[1];
  const at = lastPinned !== undefined ? lastPinned + 1 : (group[0]?.[1] ?? tabs.indexOf(id));
  rest.splice(at, 0, id);
  return { tabs: pinOrder(rest, new Set(next), cwdOf), pinned: next };
}

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

/** Opens a pane tab right of its owner's tab; without one, after the last tab of the owner's group (`cwdOf(ref)` is the owner's group); else at the end. Unchanged when open. */
export function insertPaneTab(tabs: string[], ref: string, cwdOf: CwdOf) {
  if (tabs.includes(ref)) return tabs;
  let at = tabs.indexOf(ownerOf(ref));
  if (at < 0) {
    const key = cwdOf(ref);
    if (key !== undefined) tabs.forEach((t, i) => (cwdOf(t) ?? "") === key && (at = i));
  }
  if (at < 0) return [...tabs, ref];
  const next = [...tabs];
  next.splice(at + 1, 0, ref);
  return next;
}

export function replaceTab(tabs: string[], old: string, id: string) {
  const at = tabs.indexOf(old);
  if (at < 0) return openTab(tabs, id);
  return tabs.includes(id) ? tabs.filter((t) => t !== old) : tabs.map((t, i) => (i === at ? id : t));
}

/** Session tabs the daemon does not list, e.g. never prompted before a daemon restart. */
export const staleTabs = (tabs: string[], known: Set<string>) => tabs.filter((id) => id !== NEW_TAB && !known.has(ownerOf(id)));

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

// The active tab lives in the URL hash, so a reload reopens it: a session id, "#new" for the new-session tab, "#focus" for the Focus page.
export const tabHash = (id: string) => `#${encodeURIComponent(id)}`;
// A subagent view adds its run: `#<session id>/agent/<subagent part id>`.
const SESSION_HASH = /^#([0-9a-f-]{36})(?:\/agent\/([^/]+))?$/i;
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
};
/** A pane ref's hash is `#plan%3A<uuid>` (`#plan:<uuid>` reads too). */
export const tabFromHash = (hash: string) => {
  if (hash === tabHash(NEW_TAB)) return NEW_TAB;
  if (hash === tabHash(FOCUS_TAB)) return FOCUS_TAB;
  const raw = safeDecode(hash.slice(1));
  return parseRef(raw) ? raw : SESSION_HASH.exec(hash)?.[1];
};
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

const PINNED_KEY = "claude-ui.pinned-tabs";

/** Pinned session tabs (GH-359), per browser. */
export function loadPinned(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]");
    return Array.isArray(v) ? [...new Set(v.filter((t): t is string => typeof t === "string"))] : [];
  } catch {
    return [];
  }
}

export function savePinned(ids: string[]) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked: the tabs stay pinned for this page.
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
