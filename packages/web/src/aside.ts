// Aside popups (docs/spec.md "Aside"): state and geometry helpers; the popup itself is aside-popup.tsx.
import type { SessionListItem, SessionInfo } from "@claude-ui/protocol";
import { t } from "./i18n.ts";

export type Rect = { x: number; y: number; w: number; h: number };

/** One open Aside popup. Array order = stacking order, last on top. `from`: the Aside question's part id (its timeline starts there). */
export type AsideState = { id: string; ownerId: string; title: string; from: string; minimized: boolean; readOnly: boolean; /** Position and size once moved or resized; absent: the cascade slot. */ rect?: Rect };

/** Tall enough for a permission panel (command, rules, reason box, buttons) under the header and the project row. */
export const DEFAULT_SIZE = { w: 480, h: 520 };
export const ASIDE_MIN = { w: 320, h: 240 };
export const HEADER_MIN_VISIBLE = 40;

/** Moves `id` to the top of the stack. */
export const raise = (list: AsideState[], id: string) => {
  const a = list.find((x) => x.id === id);
  return a && list.at(-1) !== a ? [...list.filter((x) => x !== a), a] : list;
};

export const setMinimized = (list: AsideState[], id: string, minimized: boolean) => list.map((a) => (a.id === id && a.minimized !== minimized ? { ...a, minimized } : a));

/** Top-left of the `index`th popup: 24 px steps from the top right corner of an `area` wide main area. */
export const cascade = (index: number, area: { w: number } = { w: 1200 }, size = DEFAULT_SIZE): { x: number; y: number } => ({
  x: Math.max(0, area.w - size.w - 24 - (index % 6) * 24),
  // More than a header (44 px) per step: a popup never covers the header buttons of the one below it.
  y: 24 + (index % 6) * 56,
});

/** Keeps the header inside the viewport (at least HEADER_MIN_VISIBLE px of it) and the size at least ASIDE_MIN. */
export function clampRect(r: Rect, viewport: { w: number; h: number }): Rect {
  const w = Math.max(ASIDE_MIN.w, Math.min(r.w, viewport.w));
  const h = Math.max(ASIDE_MIN.h, Math.min(r.h, viewport.h));
  return {
    w,
    h,
    x: Math.min(Math.max(r.x, HEADER_MIN_VISIBLE - w), viewport.w - HEADER_MIN_VISIBLE),
    y: Math.min(Math.max(r.y, 0), viewport.h - HEADER_MIN_VISIBLE),
  };
}

/** Focus lists an Aside's requests as its own session (the list never has it): "Aside: <title>". */
export const asideItem = (a: AsideState, info: SessionInfo): SessionListItem => ({ ...info, id: a.id, title: t("session.asidePopup.title", { title: a.title }), lastActivity: 0, archived: false, transcript: true });
