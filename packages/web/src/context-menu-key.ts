// Keyboard opening of context menus (GH-358, helpers of GH-359's tab menu): Shift+F10 / the ContextMenu key.
import { useRef, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { KEY_FOLLOWUP_MS, openContextMenuFromKey } from "./tab-menu.ts";

/** The browser's own contextmenu right after Shift+F10 / the ContextMenu key (Firefox fires one on key release, at another place) must not reopen the menu elsewhere. A synthetic event is untrusted and passes. */
export function swallowKeyFollowup(e: MouseEvent, keyOpenedAt: RefObject<number>) {
  if (!e.nativeEvent.isTrusted || performance.now() - keyOpenedAt.current > KEY_FOLLOWUP_MS) return;
  e.preventDefault();
  (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
}

/**
 * Props for a `ContextMenu.Trigger`: a key press inside it (a focused button of the row) opens the menu at that element's bottom-left,
 * and the browser's follow-up event is swallowed. A key already handled (a text field, an open popup) is left alone.
 */
export function useKeyContextMenu() {
  const keyOpenedAt = useRef(-Infinity);
  return {
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.defaultPrevented || !(e.target instanceof HTMLElement) || e.target instanceof HTMLInputElement) return;
      if (openContextMenuFromKey(e, e.target)) keyOpenedAt.current = performance.now();
    },
    onContextMenu: (e: MouseEvent) => swallowKeyFollowup(e, keyOpenedAt),
  };
}
