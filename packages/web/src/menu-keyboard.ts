import { useRef } from "react";

/** Menus opened from the keyboard (Enter, Space, Shift+F10) put the focus on the first item, so Enter works at once. */
export function useKeyboardOpen() {
  const kb = useRef(false);
  const popup = useRef<HTMLDivElement | null>(null);
  // Shift+F10 / the Menu key: browsers differ in the contextmenu event they send after it (button, coordinates), so the key itself is the sign.
  const hint = useRef(false);
  return {
    popup,
    /** Spread on the element the menu opens from. */
    trigger: {
      onKeyDown: (e: { key: string; shiftKey: boolean }) => void (hint.current = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)),
      onPointerDown: () => void (hint.current = false),
    },
    root: {
      onOpenChange: (open: boolean, details: { event: Event }) => {
        const e = details.event as MouseEvent;
        kb.current = open && (hint.current || e.type === "keydown" || (e.type === "click" && e.detail === 0) || (e.type === "contextmenu" && e.button === 0));
      },
      onOpenChangeComplete: (open: boolean) => {
        const first = () => popup.current?.querySelector<HTMLElement>('[role="menuitem"]');
        if (open && kb.current) {
          first()?.focus();
          // The focus manager may put the focus on the popup after this; take it back once.
          requestAnimationFrame(() => document.activeElement !== first() && popup.current?.contains(document.activeElement) !== false && first()?.focus());
        }
        kb.current = false;
        hint.current = false;
      },
    },
  };
}

export const MENU_BUTTON =
  "grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground pointer-coarse:size-11 [&_svg]:size-4";
