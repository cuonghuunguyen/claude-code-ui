import { useEffect, useState, type RefObject } from "react";

/** Distance one way before the direction counts: a thumb rest or a momentum wobble must not flicker the dock. */
export const SLOP = 24;
/** Within this of the end the reader is at the bottom: the dock is back. */
export const NEAR_END = 80;

export type Scroll = { hidden: boolean; last: number; anchor: number; dir: -1 | 0 | 1 };
export const SCROLL_START: Scroll = { hidden: false, last: 0, anchor: 0, dir: 0 };

/**
 * Hide-on-scroll (GH-166 phone): scrolling up through the transcript hides the prompt dock, scrolling down or reaching the end brings it back.
 * `top` is the scroller's scrollTop, `toEnd` the distance left to its end; `keep` forces the dock shown (it has focus, a turn runs).
 */
export function scrolled(s: Scroll, top: number, toEnd: number, keep: boolean): Scroll {
  if (keep || toEnd < NEAR_END) return { hidden: false, last: top, anchor: top, dir: 0 };
  if (top === s.last) return s;
  const dir = top < s.last ? -1 : 1;
  const anchor = dir === s.dir ? s.anchor : s.last;
  const moved = Math.abs(top - anchor);
  return { hidden: moved >= SLOP ? dir < 0 : s.hidden, last: top, anchor, dir };
}

/**
 * True while the reader scrolls up through the transcript of `card` (the element holding the `role="log"` scroller): the caller hides the dock.
 * Only while `enabled`; `keep` shows it regardless.
 */
export function useHideOnScroll(card: RefObject<HTMLElement | null>, enabled: boolean, keep: boolean) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const el = card.current;
    if (!el || !enabled || keep) return void setHidden(false);
    let s = SCROLL_START;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.getAttribute?.("role") !== "log") return;
      s = scrolled(s, t.scrollTop, t.scrollHeight - t.clientHeight - t.scrollTop, false);
      setHidden(s.hidden);
    };
    // Capture: scroll events do not bubble.
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll, { capture: true });
      setHidden(false);
    };
  }, [card, enabled, keep]);
  return hidden;
}
