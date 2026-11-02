// True while an element is within `margin` of the viewport (GH-516: addon blocks mount their frame only then). One shared observer per margin.
import { useEffect, useState, type RefObject } from "react";

const shared = new Map<string, { io: IntersectionObserver; subs: Map<Element, (near: boolean) => void> }>();

function observe(el: Element, margin: string, cb: (near: boolean) => void) {
  let s = shared.get(margin);
  if (!s) {
    const subs = new Map<Element, (near: boolean) => void>();
    s = { io: new IntersectionObserver((entries) => entries.forEach((e) => subs.get(e.target)?.(e.isIntersecting)), { rootMargin: margin }), subs };
    shared.set(margin, s);
  }
  const mine = s;
  mine.subs.set(el, cb);
  mine.io.observe(el);
  return () => {
    mine.subs.delete(el);
    mine.io.unobserve(el);
    if (!mine.subs.size) (mine.io.disconnect(), shared.delete(margin));
  };
}

/** False until the observer says so, and always where there is no IntersectionObserver (a test DOM). */
export function useNear(ref: RefObject<Element | null>, margin = "800px"): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    return observe(el, margin, setNear);
  }, [ref, margin]);
  return near;
}
