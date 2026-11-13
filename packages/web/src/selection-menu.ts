/** Where the floating selection menu goes (viewport px, `position: fixed`). */
export type MenuPlace = { left: number; top: number; transform: string };
type Box = { left: number; top: number; width: number; height: number; right: number; bottom: number };

/** Desktop: above the anchor, centered on x; below when the top would leave the viewport. Coarse pointer: below. x stays 48px from the edges. */
export function menuPosition(rect: Box, view: { width: number; height: number }, coarse: boolean): MenuPlace {
  const left = Math.min(Math.max(rect.left + rect.width / 2, 48), view.width - 48);
  if (!coarse && rect.top - 8 >= 8 + 32) return { left, top: rect.top - 8, transform: "translate(-50%, -100%)" };
  return { left, top: rect.bottom + 8, transform: "translateX(-50%)" };
}
