// Tab context menu above the session items (GH-359): data, so more sections (Split, GH-356) slot in.
import type { KeyboardEvent } from "react";

export type TabCommand = "closeOthers" | "closeRight" | "closeAll" | "reopen" | "pin" | "unpin" | "copyId" | "copyCwd" | "reveal" | "splitRight" | "splitDown" | "moveSide" | "moveBottom" | "goToSession" | "moveToFiles" | "copyPath" | "copyRel" | "revealInFiles";
export type TabMenuEntry = { id: "moveLeft" | "moveRight" | "close" | "splitNote" | TabCommand; label: string; disabled?: boolean; testId: string };

const entry = (id: TabMenuEntry["id"], label: string, disabled = false): TabMenuEntry => ({ id, label, disabled, testId: `tab-menu-${id}` });

/** Sections of the tab context menu, a separator between sections: move, close, pin, copy and reveal, then split. The New session tab (`session` false) has the first two only. */
export function tabMenuSections(s: { session: boolean; /** Absent: pinning is not offered. */ pinned?: boolean; first: boolean; last: boolean; canOthers: boolean; canRight: boolean; canAll: boolean; canReopen: boolean; hasCwd: boolean; /** A pane tab (GH-395): move to a dock, go to its session; no copy or reveal. */ pane?: { label: string; /** GH-399: a file tab: no dock; Move to Files, copy paths, Reveal in Files. */ item?: boolean }; /** Split view (GH-356): absent on narrow screens, where there is no split. */ split?: { can: boolean; /** Git graph: the reason line follows the disabled items. */ whole?: boolean } }): TabMenuEntry[][] {
  const sections = [
    [entry("moveLeft", "Move left", s.first), entry("moveRight", "Move right", s.last)],
    [entry("close", "Close tab"), entry("closeOthers", "Close others", !s.canOthers), entry("closeRight", "Close to the right", !s.canRight), entry("closeAll", "Close all", !s.canAll), entry("reopen", "Reopen closed tab", !s.canReopen)],
  ];
  if (!s.session) return sections;
  if (s.pane) {
    const split = s.split ? [[entry("splitRight", "Split right", !s.split.can), entry("splitDown", "Split down", !s.split.can), ...(s.split.whole ? [entry("splitNote", "Git graph needs the whole area", true)] : [])]] : [];
    const pin = s.pinned === undefined ? [] : [[s.pinned ? entry("unpin", "Unpin tab") : entry("pin", "Pin tab")]];
    return [...sections, ...pin, s.pane.item ? [entry("moveToFiles", "Move to Files"), entry("copyPath", "Copy path"), entry("copyRel", "Copy relative path"), entry("revealInFiles", "Reveal in Files")] : [entry("moveSide", `Move ${s.pane.label} to side panel`), entry("moveBottom", `Move ${s.pane.label} to bottom panel`)], [entry("goToSession", "Go to session")], ...split];
  }
  const pin = s.pinned === undefined ? [] : [[s.pinned ? entry("unpin", "Unpin tab") : entry("pin", "Pin tab")]];
  const split = s.split ? [[entry("splitRight", "Split right", !s.split.can), entry("splitDown", "Split down", !s.split.can)]] : [];
  return [...sections, ...pin, [entry("copyId", "Copy session ID"), entry("copyCwd", "Copy cwd path", !s.hasCwd), entry("reveal", "Reveal in sidebar")], ...split];
}

/** The first item of the newest open menu that is not disabled. */
const firstItem = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')].at(-1)?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]):not([data-disabled])');

/** After a keyboard open the popup mounts a frame or two later and takes the focus itself: focus its first enabled item (Enter works at once), then once more after the focus manager ran. */
function focusFirstItem(frames = 12) {
  const item = firstItem();
  if (!item) return frames > 0 ? void requestAnimationFrame(() => focusFirstItem(frames - 1)) : undefined;
  item.focus();
  requestAnimationFrame(() => {
    const now = firstItem();
    if (now && document.activeElement !== now && (document.activeElement === document.body || now.closest('[role="menu"]')?.contains(document.activeElement))) now.focus();
  });
}

/** Shift+F10 / the ContextMenu key: opens the element's context menu at its bottom-left (Base UI opens one only on a contextmenu event) and focuses its first enabled item. True when handled. */
export function openContextMenuFromKey(e: KeyboardEvent<HTMLElement>, target: HTMLElement): boolean {
  if (!(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey))) return false;
  e.preventDefault();
  e.stopPropagation();
  const r = target.getBoundingClientRect();
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left, clientY: r.bottom }));
  focusFirstItem();
  return true;
}

/** A trusted contextmenu event within this time of the key opener is the browser's own follow-up (Firefox fires one on key release): swallowed. */
export const KEY_FOLLOWUP_MS = 600;
