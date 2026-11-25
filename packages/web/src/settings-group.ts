// The remembered Settings group, outside the dialog so App can set it (saveGroup) without importing the dialog (a lazy chunk).
const GROUP_KEY = "claude-ui.settingsGroup";
/** Groups merged into larger ones: a remembered old id opens the group that holds its section now. */
const MOVED: Record<string, string> = { timeline: "general", sending: "general", screen: "general", changes: "layout", sidebar: "layout", tabs: "layout", terminal: "layout", guide: "about" };
export const loadGroup = () => {
  try {
    const id = localStorage.getItem(GROUP_KEY) ?? undefined;
    return id && (MOVED[id] ?? id);
  } catch {
    return undefined;
  }
};
export const storeGroup = (id: string) => {
  try {
    localStorage.setItem(GROUP_KEY, id);
  } catch {
    // Storage blocked: the group lasts while the page is open.
  }
};
/** Set by `saveGroup`: the next open lands on the stored group's settings, not on the list of groups (below md). */
let landOnGroup = false;
/** True once after `saveGroup`: the dialog opens on that group's settings. */
export const takeLandOnGroup = () => {
  const was = landOnGroup;
  landOnGroup = false;
  return was;
};
/** Settings opens at this group next time, on its settings also below md (also the Create worktree modal's "Open Settings › Jira", the model picker's "Connect a provider…"). */
export const saveGroup = (id: string) => {
  storeGroup(id);
  landOnGroup = true;
};


/** An event asking App to open Settings at a group (the commit box's "Open settings" link has no App callback). */
export const OPEN_SETTINGS_EVENT = "claude-ui:open-settings";
export const askSettings = (group: string) => dispatchEvent(new CustomEvent<string>(OPEN_SETTINGS_EVENT, { detail: group }));
