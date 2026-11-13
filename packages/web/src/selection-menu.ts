/** Where the floating selection menu goes (viewport px, `position: fixed`). */
export type MenuPlace = { left: number; top: number; transform: string };
type Box = { left: number; top: number; width: number; height: number; right: number; bottom: number };

/** Desktop: above the anchor, centered on x; below when the top would leave the viewport. Coarse pointer: below. The center stays 48px (or half the menu width + 8px) from the edges. */
export function menuPosition(rect: Box, view: { width: number; height: number }, coarse: boolean, menuWidth = 0): MenuPlace {
  // The menu is centered on x: keep its whole width (plus 8px) inside the viewport.
  const edge = Math.max(48, menuWidth / 2 + 8);
  const left = Math.min(Math.max(rect.left + rect.width / 2, edge), view.width - edge);
  if (!coarse && rect.top - 8 >= 8 + 32) return { left, top: rect.top - 8, transform: "translate(-50%, -100%)" };
  return { left, top: rect.bottom + 8, transform: "translateX(-50%)" };
}
