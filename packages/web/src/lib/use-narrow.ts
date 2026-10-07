import { useSyncExternalStore } from "react";

/** Tailwind's `md` (48rem) in the same unit, so JS and the `max-md:` classes agree whatever the root font size. */
const QUERY = "(width < 48rem)";

// One MediaQueryList per matchMedia function (tests swap it); each call to matchMedia makes a new one.
let cached: { fn: typeof window.matchMedia; mq: MediaQueryList } | undefined;
const list = () => {
  const fn = window.matchMedia;
  if (!fn) return undefined;
  if (cached?.fn !== fn) cached = { fn, mq: fn.call(window, QUERY) };
  return cached.mq;
};
const subscribe = (cb: () => void) => {
  const mq = list();
  mq?.addEventListener("change", cb);
  return () => mq?.removeEventListener("change", cb);
};

/** True below `md` (phone and narrow tablet widths). No matchMedia (some tests): wide. */
export const useNarrow = () => useSyncExternalStore(subscribe, () => !!list()?.matches);
