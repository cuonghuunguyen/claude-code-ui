// Tab context menu above the session items (GH-359): data, so more sections (Split, GH-356) slot in.
import type { KeyboardEvent } from "react";
import { t } from "./i18n.ts";

export type TabCommand = "closeOthers" | "closeRight" | "closeAll" | "reopen" | "pin" | "unpin" | "copyId" | "copyCwd" | "reveal" | "splitRight" | "splitDown" | "moveSide" | "moveBottom" | "goToSession" | "moveToFiles" | "moveToArtifacts" | "copyPath" | "copyRel" | "revealInFiles";
export type TabMenuEntry = { id: "moveLeft" | "moveRight" | "close" | "splitNote" | TabCommand; label: string; disabled?: boolean; testId: string };

const entry = (id: TabMenuEntry["id"], label: string, disabled = false): TabMenuEntry => ({ id, label, disabled, testId: `tab-menu-${id}` });

/** Sections of the tab context menu, a separator between sections: move, close, pin, copy and reveal, then split. The New session tab (`session` false) has the first two only. */
export function tabMenuSections(s: { session: boolean; /** Absent: pinning is not offered. */ pinned?: boolean; first: boolean; last: boolean; canOthers: boolean; canRight: boolean; canAll: boolean; canReopen: boolean; hasCwd: boolean; /** GH-401: wide screens: a session tab can move to the side or bottom panel. */ dock?: boolean; /** A pane tab (GH-395): move to a dock, go to its session; no copy or reveal. */ pane?: { label: string; /** An item tab, no dock: a file (GH-399: Move to Files, copy paths, Reveal in Files) or an artifact (GH-400: none of those). */ item?: "file" | "artifact" }; /** Split view (GH-356): absent on narrow screens, where there is no split. */ split?: { can: boolean; /** Git graph: the reason line follows the disabled items. */ whole?: boolean } }): TabMenuEntry[][] {
  const sections = [
    [entry("moveLeft", t("app.tabMenu.moveLeft"), s.first), entry("moveRight", t("app.tabMenu.moveRight"), s.last)],
    [entry("close", t("app.tabMenu.close")), entry("closeOthers", t("app.tabMenu.closeOthers"), !s.canOthers), entry("closeRight", t("app.tabMenu.closeRight"), !s.canRight), entry("closeAll", t("app.tabMenu.closeAll"), !s.canAll), entry("reopen", t("app.tabMenu.reopen"), !s.canReopen)],
  ];
  if (!s.session) return sections;
  if (s.pane) {
    const split = s.split ? [[entry("splitRight", t("app.tabMenu.splitRight"), !s.split.can), entry("splitDown", t("app.tabMenu.splitDown"), !s.split.can), ...(s.split.whole ? [entry("splitNote", t("app.tabMenu.splitNote"), true)] : [])]] : [];
    const pin = s.pinned === undefined ? [] : [[s.pinned ? entry("unpin", t("app.tabMenu.unpin")) : entry("pin", t("app.tabMenu.pin"))]];
    return [...sections, ...pin, ...[s.pane.item === "artifact" ? [entry("moveToArtifacts", t("app.tabMenu.moveToArtifacts"))] : s.pane.item === "file" ? [entry("moveToFiles", t("app.tabMenu.moveToFiles")), entry("copyPath", t("app.tabMenu.copyPath")), entry("copyRel", t("app.tabMenu.copyRel")), entry("revealInFiles", t("app.tabMenu.revealInFiles"))] : [entry("moveSide", t("app.tabMenu.movePaneSide", { pane: s.pane.label })), entry("moveBottom", t("app.tabMenu.movePaneBottom", { pane: s.pane.label }))]], [entry("goToSession", t("app.tabMenu.goToSession"))], ...split];
  }
  const pin = s.pinned === undefined ? [] : [[s.pinned ? entry("unpin", t("app.tabMenu.unpin")) : entry("pin", t("app.tabMenu.pin"))]];
  const split = s.split ? [[entry("splitRight", t("app.tabMenu.splitRight"), !s.split.can), entry("splitDown", t("app.tabMenu.splitDown"), !s.split.can)]] : [];
  const dock = s.dock ? [[entry("moveSide", t("app.tabMenu.moveSide")), entry("moveBottom", t("app.tabMenu.moveBottom"))]] : [];
  return [...sections, ...pin, ...dock, [entry("copyId", t("app.tabMenu.copyId")), entry("copyCwd", t("app.tabMenu.copyCwd"), !s.hasCwd), entry("reveal", t("app.tabMenu.reveal"))], ...split];
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
