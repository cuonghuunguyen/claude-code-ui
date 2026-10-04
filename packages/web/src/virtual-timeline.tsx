import { measureElement, observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Scroll distance from the end that still counts as "at the bottom" (follow output, no scroll button). */
const END_THRESHOLD = 80;

/**
 * Session timeline that renders only the items in or near the viewport (docs/spec.md "Session view UX").
 * Sticks to the bottom while at the bottom: on append and while the last item grows; opens at the bottom.
 * `footer` renders after the last item, not windowed (the Thinking row).
 * `reveal`: scrolls this item key to the top of the viewport (palette Rewind); a new object scrolls again.
 */
export function VirtualTimeline<T>({
  items,
  itemKey,
  renderItem,
  footer,
  reveal,
}: {
  items: T[];
  itemKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  footer?: ReactNode;
  reveal?: { key: string };
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pinned: follows new output. Leaves only when the user scrolls up away from the end, returns at the end.
  // Own state from scroll events, not the virtualizer's followOnAppend: that misses appends that arrive before the
  // scroll event of the previous follow (event log replay), and its scrollToEnd keeps re-aiming at the end for up to
  // 5 s while items get measured, pulling back a user who scrolls up.
  const [pinned, setPinned] = useState(true);
  const pin = useRef(true);
  const offset = useRef(0);
  // A hidden tab (zero size, or Activity hidden) keeps its position and gets it back when shown again; hidden until
  // the first layout.
  const hidden = useRef(true);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    getItemKey: useCallback((i: number) => itemKey(items[i]!), [items]),
    paddingStart: 16,
    // Tab from a rendered item reaches the next one.
    overscan: 8,
    // At the end, a measured size change keeps the end in view.
    anchorTo: "end",
    scrollEndThreshold: END_THRESHOLD,
    // Until the first non-zero size (jsdom, a tab mounted hidden).
    initialRect: { width: 0, height: window.innerHeight },
    // A hidden tab (display: none) reports zero size: keep the last size and measurements, restore the position when shown.
    observeElementRect: (inst, cb) =>
      observeElementRect(inst, (rect) => {
        if (!rect.height) return void (hidden.current = true);
        cb(rect);
        if (!hidden.current) return;
        hidden.current = false;
        const el = inst.scrollElement as HTMLElement;
        el.scrollTop = pin.current ? el.scrollHeight : offset.current;
      }),
    measureElement: (el, entry, inst) =>
      (inst.scrollElement as HTMLElement | null)?.clientHeight
        ? measureElement(el, entry, inst)
        : (inst.itemSizeCache.get(inst.options.getItemKey(inst.indexFromElement(el))) ?? inst.options.estimateSize(0)),
  });

  // A tab hidden by Activity runs this cleanup; shown again, the follow effect below takes it back to the bottom if it
  // was there (the virtualizer restores any other offset itself).
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const onScroll = () => {
      if (!el.clientHeight) return;
      const top = el.scrollTop;
      const next = el.scrollHeight - el.clientHeight - top <= END_THRESHOLD || (pin.current && top >= offset.current);
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
    if (pin.current && !hidden.current && el.clientHeight) el.scrollTop = el.scrollHeight;
  });
  useLayoutEffect(() => {
    const i = reveal ? items.findIndex((item) => itemKey(item) === reveal.key) : -1;
    if (i >= 0) v.scrollToIndex(i, { align: "start" });
  }, [reveal]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} role="log" className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        <div className="timeline mx-auto w-full max-w-[800px] px-4 pb-4 2xl:max-w-[1000px]">
          <div className="relative w-full" style={{ height: v.getTotalSize() }}>
            {v.getVirtualItems().map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                ref={v.measureElement}
                // pt-3: the 12px gap between items, inside the measured box.
                className={`absolute inset-x-0 top-0 flex flex-col ${row.index ? "pt-3" : ""}`}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {renderItem(items[row.index]!, row.index)}
              </div>
            ))}
          </div>
          {footer && <div className="mt-3">{footer}</div>}
        </div>
      </div>
      {/* OpenCode "Jump to latest": 32x28 raised button 32px above the bottom (44px on touch screens). */}
      {!pinned && (
        <button
          type="button"
          aria-label="Jump to latest"
          title="Jump to latest"
          data-testid="scroll-to-bottom"
          className="absolute bottom-8 left-1/2 z-10 flex h-7 w-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-lg bg-background/90 text-foreground shadow-raised outline-none backdrop-blur-[2px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info pointer-coarse:size-11"
          onClick={() => v.scrollToEnd({ behavior: matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
        >
          <ArrowDownIcon aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}
