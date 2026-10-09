/**
 * When the user last scrolled a session timeline (`[role=log]`). Every scroll event of a timeline counts (wheel, touch fling of
 * any length, scrollbar drag, keys), except the app's own scrolls, which the timeline marks with `markAppScroll` (follow the
 * output while a turn streams, reveal, jump to latest): a streaming turn does not look like a user who never stops scrolling.
 */
let lastUser = -Infinity;
/** Where the app's last own scroll put each timeline: a scroll event that lands there is the app's. */
const appTop = new WeakMap<Element, number>();

/** The app scrolled `el` to `top` (default: where it is now, read after an instant scroll). */
export function markAppScroll(el: Element, top = el.scrollTop) {
  appTop.set(el, top);
}

/** Milliseconds since the user last scrolled a timeline (Infinity: never). */
export const sinceUserScroll = () => performance.now() - lastUser;

/** For tests. */
export function resetScrollRest() {
  lastUser = -Infinity;
}

if (typeof document !== "undefined")
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target;
      if (!(el instanceof Element) || el.getAttribute("role") !== "log") return;
      const top = appTop.get(el);
      if (top !== undefined && Math.abs(el.scrollTop - top) < 1) return;
      appTop.delete(el);
      lastUser = performance.now();
    },
    { capture: true, passive: true },
  );
