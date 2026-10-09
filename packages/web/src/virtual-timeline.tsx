import { elementScroll, measureElement, observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, LoaderCircleIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { markAppScroll } from "./scroll-rest.ts";

/** Scrolling down to this distance from the end returns to the bottom (follow output, no scroll button). */
const END_THRESHOLD = 80;

/** Scrolled within this many viewports of the top, the next older page is requested. */
const TOP_THRESHOLD = 1;

/** Height of the sticky bar, most 2 lines on a narrow screen. */
const BAR = 56;

/** A text field that opens the on-screen keyboard on a touch screen. */
const typesText = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !/^(button|checkbox|radio|range|submit|reset|file|color)$/.test(el.type)));

/** True while a text field has the focus on a touch screen (on-screen keyboard shown). */
function useTouchKeyboard() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const touch = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const onIn = (e: FocusEvent) => setOpen(touch() && typesText(e.target));
    const onOut = (e: FocusEvent) => setOpen(touch() && typesText(e.relatedTarget));
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  return open;
}

/**
 * One item: renders again only for a new item, index or `renderItem`, not for the virtualizer's own re-renders (scroll start and end,
 * which also follow a hidden tab shown again: its scroll position comes back with a scroll event).
 */
const Row = memo(function Row({ item, index, render }: { item: unknown; index: number; render: (item: never, index: number) => ReactNode }) {
  return render(item as never, index);
});

/**
 * Session timeline that renders only the items in or near the viewport (docs/spec.md "Session view UX").
 * Sticks to the bottom while at the bottom: on append, while the last item grows and when the viewport shrinks; opens at the bottom.
 * `footer` renders after the last item, not windowed (the Thinking row; pending prompts). 12px below the items, none when empty.
 * `reveal`: scrolls this item key to the top of the viewport (palette Rewind); a new object scrolls again.
 * `sticky`: items for which it returns a value pin to the top of the viewport (a button, "Go to message: <label>") once scrolled
 * above it, until the next sticky item takes over; only while scrolled up from the bottom and no on-screen keyboard is shown
 * (on a phone the bar covered most of the short viewport); activating it scrolls the item to the top and focuses it. Computed from the
 * virtualizer's measurements, so items outside the rendered window work.
 * `onReachTop`: called when scrolled within one viewport of the top (also after a commit that leaves the content short), while older pages
 * exist; the caller guards repeated calls. Prepended items keep the view in place (`anchorTo: "end"`). `loadingOlder` shows the overlay.
 * `onJump`: runs after "Jump to latest" is activated; the button turns inert at the bottom, so the caller moves the focus.
 */
export function VirtualTimeline<T>({
  items,
  itemKey,
  renderItem,
  footer,
  reveal,
  sticky,
  onJump,
  onReachTop,
  loadingOlder,
}: {
  items: T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  footer?: ReactNode;
  reveal?: { key: string };
  sticky?: (item: T, index: number) => { label: string; content: ReactNode } | undefined;
  onJump?: () => void;
  onReachTop?: (user?: boolean) => void;
  loadingOlder?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pinned: follows new output. Any scroll up away from the end leaves (OpenCode); scrolling down near the end returns.
  // Own state from scroll events, not the virtualizer's followOnAppend: that misses appends that arrive before the
  // scroll event of the previous follow (event log replay), and its scrollToEnd keeps re-aiming at the end for up to
  // 5 s while items get measured, pulling back a user who scrolls up.
  const [pinned, setPinned] = useState(true);
  const pin = useRef(true);
  const offset = useRef(0);
  // A hidden tab (zero size, or Activity hidden) keeps its position and gets it back when shown again; hidden until
  // the first layout.
  const hidden = useRef(true);
  const [stuck, setStuck] = useState(-1);
  const latest = useRef({ items, sticky, onReachTop });
  latest.current = { items, sticky, onReachTop };
  /** `user`: caused by a scroll event (the caller may retry a failed page then, not on every layout pass). */
  const reachTop = (user = false) => {
    const el = scrollRef.current;
    if (el && !hidden.current && el.clientHeight && el.scrollTop < el.clientHeight * TOP_THRESHOLD) latest.current.onReachTop?.(user);
  };
  const focusKey = useRef<string>(undefined);
  // Start padding of scrollToIndex: BAR for a reveal, 0 for the sticky button (kept across the virtualizer's re-renders).
  const padding = useRef(0);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    getItemKey: useCallback((i: number) => itemKey(items[i]!), [items, itemKey]),
    paddingStart: 16,
    scrollPaddingStart: padding.current,
    // Tab from a rendered item reaches the next one.
    overscan: 8,
    // At the end (default 1px), a measured size change keeps the end in view; a user scrolled up stays where they are.
    anchorTo: "end",
    // Until the first non-zero size (jsdom, a tab mounted hidden).
    initialRect: { width: 0, height: window.innerHeight },
    // A hidden tab (display: none) reports zero size: keep the last size and measurements, restore the position when shown.
    // A pinned timeline that changes size (a panel below grows: Edit content, a question, the prompt box) stays at the
    // bottom (GH-99): a shorter viewport fires no scroll event and, with the same items in view, no re-render.
    observeElementRect: (inst, cb) =>
      observeElementRect(inst, (rect) => {
        if (!rect.height) return void (hidden.current = true);
        cb(rect);
        const el = inst.scrollElement as HTMLElement;
        if (hidden.current) {
          hidden.current = false;
          el.scrollTop = pin.current ? el.scrollHeight : offset.current;
          markAppScroll(el);
        } else if (pin.current) {
          el.scrollTop = el.scrollHeight;
          offset.current = el.scrollTop;
          markAppScroll(el);
        }
      }),
    // The virtualizer's own scrolls (reveal, sticky button, Jump to latest, keeping the end in view) are the app's, not the user's.
    scrollToFn: (to, options, inst) => {
      elementScroll(to, options, inst);
      const el = inst.scrollElement;
      if (el) {
        const animated = options.behavior === "smooth";
        markAppScroll(el, animated ? Math.min(to + (options.adjustments ?? 0), el.scrollHeight - el.clientHeight) : el.scrollTop, animated);
      }
    },
    measureElement: (el, entry, inst) =>
      (inst.scrollElement as HTMLElement | null)?.clientHeight
        ? measureElement(el, entry, inst)
        : (inst.itemSizeCache.get(inst.options.getItemKey(inst.indexFromElement(el))) ?? inst.options.estimateSize(0)),
  });

  // A tab hidden by Activity runs this cleanup; shown again, the follow effect below takes it back to the bottom if it
  // was there (the virtualizer restores any other offset itself).
  // The last sticky item whose top is above the viewport top (-1: none). ponytail: linear scan, binary search if 10k+ items.
  const updateStuck = () => {
    const { items, sticky } = latest.current;
    const top = scrollRef.current!.scrollTop;
    let found = -1;
    if (sticky) {
      for (let i = Math.min(items.length, v.measurementsCache.length) - 1; i >= 0; i--) {
        const m = v.measurementsCache[i]!;
        // A sticky item that starts under the bar is the newest: it is in view, so nothing is stuck (no bar over its top).
        if (m.start < top + BAR && sticky(items[i]!, i)) {
          if (m.start < top - 1) found = i;
          break;
        }
      }
    }
    setStuck(found);
  };
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const onScroll = () => {
      if (!el.clientHeight) return;
      const top = el.scrollTop;
      updateStuck();
      reachTop(true);
      const dist = el.scrollHeight - el.clientHeight - top;
      const next = dist <= 1 || (top >= offset.current && (pin.current || dist <= END_THRESHOLD));
      offset.current = top;
      if (next !== pin.current) setPinned((pin.current = next));
    };
    // Capture: before the virtualizer's own listener, whose synchronous re-render runs the follow effect below.
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    hidden.current = false;
    return () => {
      el.removeEventListener("scroll", onScroll, { capture: true });
      hidden.current = true;
    };
  }, []);
  // Follows output after every commit while pinned: opening (remount = "open at the bottom"), appended items, a growing
  // last item, the Thinking row.
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    if (!pin.current || hidden.current || !el.clientHeight) return;
    el.scrollTop = el.scrollHeight;
    // A user scroll up before this scroll's event still compares with the followed position.
    offset.current = el.scrollTop;
    markAppScroll(el);
  });
  // A page that did not fill the screen (or a short session) asks for the next one at once.
  useLayoutEffect(() => {
    if (latest.current.onReachTop) reachTop();
  });
  // After every commit: new items or measurements change what is stuck; a clicked sticky item gets the focus once rendered.
  useLayoutEffect(() => {
    if (!hidden.current) updateStuck();
    if (focusKey.current === undefined) return;
    const row = scrollRef.current!.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey.current)}"]`);
    if (row) {
      focusKey.current = undefined;
      row.focus({ preventScroll: true });
    }
  });
  useLayoutEffect(() => {
    const i = reveal ? items.findIndex((item) => itemKey(item) === reveal.key) : -1;
    if (i < 0) return;
    // Unpinned first: on a freshly opened session still replaying, the follow effect would take it back to the end.
    if (pin.current) setPinned((pin.current = false));
    // The item lands below the sticky "step N" bar; the sticky button's own jump (below) puts its item at the very top.
    padding.current = latest.current.sticky ? BAR : 0;
    v.options.scrollPaddingStart = padding.current;
    v.scrollToIndex(i, { align: "start" });
  }, [reveal]);

  const keyboard = useTouchKeyboard();
  const stickyItem = !pinned && !keyboard && stuck >= 0 && stuck < items.length ? sticky?.(items[stuck]!, stuck) : undefined;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} role="log" className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        <div className="timeline mx-auto w-full max-w-[800px] px-4 pb-4 2xl:max-w-[1000px]">
          <div className="relative w-full" style={{ height: v.getTotalSize() }}>
            {v.getVirtualItems().map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                data-key={row.key}
                tabIndex={-1}
                ref={v.measureElement}
                // pt-3: the 12px gap between items, inside the measured box.
                className={`absolute inset-x-0 top-0 flex flex-col outline-none ${row.index ? "pt-3" : ""}`}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <Row item={items[row.index]!} index={row.index} render={renderItem} />
              </div>
            ))}
          </div>
          {footer && <div className={items.length ? "mt-3" : ""}>{footer}</div>}
        </div>
      </div>
      {loadingOlder && (
        <div role="status" aria-live="polite" data-testid="loading-older" className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-background/90 px-3 py-1 text-muted-foreground text-xs shadow-raised">
            <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            Loading earlier messages…
          </span>
        </div>
      )}
      {stickyItem && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
          <div className="mx-auto w-full max-w-[800px] px-4 2xl:max-w-[1000px]">
            <button
              type="button"
              aria-label={`Go to message: ${stickyItem.label.slice(0, 100)}`}
              data-testid="sticky-message"
              className="pointer-events-auto block w-full cursor-pointer rounded-b-lg bg-background px-3 py-2 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-info max-md:min-h-11 pointer-coarse:min-h-11"
              onClick={() => {
                focusKey.current = String(v.measurementsCache[stuck]!.key);
                padding.current = v.options.scrollPaddingStart = 0;
                v.scrollToIndex(stuck, { align: "start" });
              }}
            >
              <span className="line-clamp-1 max-md:line-clamp-2">{stickyItem.content}</span>
            </button>
            {/* Fade under the bar (VS Code extension stickyHeader). */}
            <div aria-hidden className="h-4 bg-gradient-to-b from-background to-transparent" />
          </div>
        </div>
      )}
      {/* OpenCode "Jump to latest": 32x28 raised button 32px above the bottom (44px on touch screens), fades and scales in. */}
      <button
        type="button"
        aria-label="Jump to latest"
        title="Jump to latest"
        data-testid="scroll-to-bottom"
        inert={pinned}
        className={`absolute bottom-8 left-1/2 z-10 flex h-7 w-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-lg bg-background/90 text-foreground shadow-raised outline-none backdrop-blur-[2px] transition-[opacity,scale,translate] duration-200 ease-out hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-info motion-reduce:transition-none pointer-coarse:size-11 ${pinned ? "pointer-events-none translate-y-2 scale-[0.8] opacity-0" : ""}`}
        onClick={() => {
          v.scrollToEnd({ behavior: matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
          onJump?.();
        }}
      >
        <ArrowDownIcon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
