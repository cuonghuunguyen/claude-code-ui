import { useSyncExternalStore } from "react";

// One MediaQueryList per (query, matchMedia function): tests swap matchMedia; each call to it makes a new list.
const cache = new Map<string, { fn: typeof window.matchMedia; mq: MediaQueryList }>();
const list = (query: string) => {
  const fn = window.matchMedia;
  if (!fn) return undefined;
  const hit = cache.get(query);
  if (hit?.fn === fn) return hit.mq;
  const mq = fn.call(window, query);
  cache.set(query, { fn, mq });
  return mq;
};
const watch = (query: string) => ({
  subscribe: (cb: () => void) => {
    const mq = list(query);
    mq?.addEventListener?.("change", cb);
    return () => mq?.removeEventListener?.("change", cb);
  },
  snapshot: () => !!list(query)?.matches,
});

// Tailwind's `md` (48rem) and `sm` (40rem) in the same unit, so JS and the `max-md:` / `max-sm:` classes agree whatever the root font size.
const NARROW = watch("(width < 48rem)");
const PHONE = watch("(width < 40rem)");

/** True below `md` (phone and narrow tablet widths). No matchMedia (some tests): wide. */
export const useNarrow = () => useSyncExternalStore(NARROW.subscribe, NARROW.snapshot);

/** True below `sm` (phones): the session header row, the toolbar choosers and the long status line give way to a compact layout. No matchMedia: wide. */
export const usePhone = () => useSyncExternalStore(PHONE.subscribe, PHONE.snapshot);
