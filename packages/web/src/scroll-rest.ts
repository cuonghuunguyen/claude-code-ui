/**
 * When the user last scrolled a session timeline (`[role=log]`). Every scroll event of a timeline counts (wheel, touch fling of
 * any length, scrollbar drag, keys), except the app's own scrolls, which the timeline marks with `markAppScroll` (follow the
 * output while a turn streams, reveal, jump to latest): a streaming turn does not look like a user who never stops scrolling.
 */
let lastUser = -Infinity;
/** Where the app's last own scroll put each timeline: a scroll event that lands there is the app's. */
const appTop = new WeakMap<Element, number>();

/** Smooth app scrolls under way (Jump to latest): every scroll event on the way to `top` is the app's, until it arrives, the user touches the timeline, or `until` passes. */
const smooth = new WeakMap<Element, { top: number; until: number }>();
/** Timelines with a smooth app scroll under way (for the keys). */
const active = new Set<Element>();
/** A smooth scroll that has not arrived by then is over (the browser stopped it). */
const SMOOTH_MAX = 1500;

/** The app scrolled `el` to `top` (default: where it is now, read after an instant scroll); `smooth`: an animated scroll to `top`. */
export function markAppScroll(el: Element, top = el.scrollTop, animated = false) {
  appTop.set(el, top);
  if (animated) (smooth.set(el, { top, until: performance.now() + SMOOTH_MAX }), active.add(el));
  else (smooth.delete(el), active.delete(el));
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
      if (top !== undefined && Math.abs(el.scrollTop - top) < 1) return void (smooth.delete(el), active.delete(el));
      const s = smooth.get(el);
      if (s && performance.now() < s.until) return;
      smooth.delete(el);
      active.delete(el);
      appTop.delete(el);
      lastUser = performance.now();
    },
    { capture: true, passive: true },
  );

// The user takes over a smooth app scroll: from then on its scroll events are the user's. A wheel, touch or pointer event on a
// timeline ends that timeline's; keys that scroll (focus outside a text field) end all.
const scrollKeys = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);
if (typeof document !== "undefined")
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"])
    document.addEventListener(
      type,
      (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (type === "keydown") {
          if (!t?.closest("input, textarea, select, [contenteditable]") && scrollKeys.has((e as KeyboardEvent).key)) for (const el of active) (smooth.delete(el), active.delete(el));
          return;
        }
        const el = t?.closest('[role="log"]');
        if (el) (smooth.delete(el), active.delete(el));
      },
      { capture: true, passive: true },
    );
