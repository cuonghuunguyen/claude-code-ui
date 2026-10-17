import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * The content width of `ref`'s element, kept current with a ResizeObserver. Undefined until measured, without ResizeObserver
 * and while the element is hidden (0 wide): callers treat that as wide, like `useNarrow` without matchMedia.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth) setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries.at(-1)?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
