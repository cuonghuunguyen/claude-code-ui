// Tabs bar (docs/spec.md "Layout"): open sessions as browser-like tabs, plus one new-session tab. Order persists per browser.

/** Id of the new-session tab; every other tab id is a session id. */
export const NEW_TAB = "new";

export const openTab = (tabs: string[], id: string) => (tabs.includes(id) ? tabs : [...tabs, id]);

/** Closes a tab only (the session keeps running); closing the active tab focuses its right neighbour, else its left one. */
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

export function replaceTab(tabs: string[], old: string, id: string) {
  const at = tabs.indexOf(old);
  if (at < 0) return openTab(tabs, id);
  return tabs.includes(id) ? tabs.filter((t) => t !== old) : tabs.map((t, i) => (i === at ? id : t));
}

/** Project avatar color (OpenCode project-avatar-v2 palette), stable per working directory. */
export const AVATAR_COLORS = ["orange", "yellow", "cyan", "green", "red", "pink", "blue", "purple", "gray"] as const;

export function avatarColor(cwd: string) {
  let h = 0;
  for (const c of cwd) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}

export const projectName = (cwd: string) => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

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
