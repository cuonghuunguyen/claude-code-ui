// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AsidePopup } from "./aside-popup.tsx";
import type { Rect } from "./aside.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));
const phoneQuery = (phone: boolean) => (window.matchMedia = ((q: string) => ({ matches: phone && q.includes("40rem"), addEventListener() {}, removeEventListener() {} })) as never);

const h: { rect?: Rect; calls: string[] } = { calls: [] };
function Host({ initialMin = false }: { initialMin?: boolean }) {
  const [rect, setRect] = useState<Rect>({ x: 100, y: 100, w: 400, h: 300 });
  const [min, setMin] = useState(initialMin);
  h.rect = rect;
  return (
    <AsidePopup id="a1" index={0} title="why?" readOnly minimized={min} rect={rect} onRect={setRect} onMinimize={() => setMin(true)} onRestore={() => setMin(false)} onClose={() => h.calls.push("close")} onKeep={() => h.calls.push("keep")} onFocus={() => h.calls.push("focus")}>
      <p>body</p>
    </AsidePopup>
  );
}
const ptr = (target: Element, type: string, x: number, y: number) => act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })));

it("renders a non-modal dialog with the title, Read-only badge and body", async () => {
  phoneQuery(false);
  await act(async () => root.render(<Host />));
  const d = el.querySelector("[role=dialog]")!;
  expect(d.getAttribute("aria-modal")).toBe("false");
  expect(d.getAttribute("aria-label")).toBe("Aside: why?");
  expect(d.textContent).toContain("Read-only");
  expect(d.textContent).toContain("body");
  expect((d as HTMLElement).style.left).toBe("100px");
});

it("dragging the header moves the popup", async () => {
  phoneQuery(false);
  await act(async () => root.render(<Host />));
  const handle = el.querySelector("[data-aside-handle]")!;
  ptr(handle, "pointerdown", 300, 120);
  ptr(handle, "pointermove", 100, 220);
  ptr(handle, "pointerup", 100, 220);
  expect(h.rect).toMatchObject({ x: -100, y: 200 });
  expect((el.querySelector("[role=dialog]") as HTMLElement).style.left).toBe("-100px");
});

it("Minimize shows a chip and the chip restores the popup", async () => {
  phoneQuery(false);
  await act(async () => root.render(<Host />));
  await act(async () => void (el.querySelector("[aria-label='Minimize aside']") as HTMLElement).click());
  expect(el.querySelector("[role=dialog]")).toBeNull();
  const chip = el.querySelector("[data-aside-chip]") as HTMLElement;
  expect(chip.textContent).toContain("Aside: why?");
  await act(async () => void chip.click());
  expect(el.querySelector("[role=dialog]")).not.toBeNull();
});

it("Keep as session and Close call their handlers; pointer down raises", async () => {
  phoneQuery(false);
  h.calls = [];
  await act(async () => root.render(<Host />));
  await act(async () => void [...el.querySelectorAll("button")].find((b) => b.textContent === "Keep as session")!.click());
  await act(async () => void (el.querySelector("[aria-label='Close aside']") as HTMLElement).click());
  ptr(el.querySelector("[role=dialog]")!, "pointerdown", 1, 1);
  expect(h.calls).toEqual(expect.arrayContaining(["keep", "close", "focus"]));
});

it("on a phone it fills the viewport and cannot be dragged", async () => {
  phoneQuery(true);
  await act(async () => root.render(<Host />));
  const d = el.querySelector("[role=dialog]") as HTMLElement;
  expect(d.className).toContain("inset-0");
  expect(d.style.left).toBe("");
  const before = h.rect;
  ptr(el.querySelector("[data-aside-handle]")!, "pointerdown", 10, 10);
  ptr(el.querySelector("[data-aside-handle]")!, "pointermove", 50, 50);
  expect(h.rect).toBe(before);
});
