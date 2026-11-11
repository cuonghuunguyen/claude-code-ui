// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useNear } from "./use-near.ts";

const created: { cb: (e: { target: Element; isIntersecting: boolean }[]) => void; opts: IntersectionObserverInit; observed: Set<Element>; disconnected: boolean }[] = [];
class FakeObserver {
  rec: (typeof created)[number];
  constructor(cb: never, opts: IntersectionObserverInit) {
    this.rec = { cb, opts, observed: new Set(), disconnected: false };
    created.push(this.rec);
  }
  observe(el: Element) { this.rec.observed.add(el); }
  unobserve(el: Element) { this.rec.observed.delete(el); }
  disconnect() { this.rec.disconnected = true; }
}
afterEach(() => (created.length = 0, vi.unstubAllGlobals(), (document.body.innerHTML = "")));

function Probe({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNear(ref);
  return <div ref={ref} id={id} data-near={String(near)} />;
}

it("near flips true when the observer reports intersection and false after; one observer serves two elements", async () => {
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<><Probe id="a" /><Probe id="b" /></>));
  expect(created).toHaveLength(1);
  expect(created[0]!.opts.rootMargin).toBe("800px");
  const [a, b] = [el.querySelector("#a")!, el.querySelector("#b")!];
  expect(a.getAttribute("data-near")).toBe("false");
  await act(async () => created[0]!.cb([{ target: a, isIntersecting: true }]));
  expect(a.getAttribute("data-near")).toBe("true");
  expect(b.getAttribute("data-near")).toBe("false");
  await act(async () => created[0]!.cb([{ target: a, isIntersecting: false }]));
  expect(a.getAttribute("data-near")).toBe("false");
  await act(async () => root.unmount());
  expect(created[0]!.disconnected).toBe(true);
});

it("is false where there is no IntersectionObserver", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<Probe id="a" />));
  expect(el.querySelector("#a")!.getAttribute("data-near")).toBe("false");
  await act(async () => root.unmount());
});
