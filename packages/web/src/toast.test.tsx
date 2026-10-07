// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toast } from "./toast.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const reduced = (on: boolean) => (window.matchMedia = ((q: string) => ({ matches: on && q.includes("reduce"), media: q })) as never);
const el = document.createElement("div");
const onClose = vi.fn();
const toast = () => el.querySelector<HTMLElement>('[data-testid="toast"]')!;
beforeEach(() => {
  vi.useFakeTimers();
  reduced(false);
  onClose.mockClear();
  document.body.append(el);
});
afterEach(() => {
  vi.useRealTimers();
  el.remove();
});
async function mount() {
  const root = createRoot(el);
  await act(async () => root.render(<Toast message="hi" onClose={onClose} />));
  return root;
}

// OpenCode toast-v2: 320px from 600px up (right 32 / bottom 48), full width with 16px offsets at 600px and below.
it("is full width at phone widths and 320px from 600px up", async () => {
  await mount();
  const c = toast().className;
  expect(c).toContain("w-[calc(100vw-2rem)]");
  expect(c).toContain("min-[601px]:w-80");
  expect(c).toContain("min-[601px]:right-8");
  expect(c).toContain("min-[601px]:bottom-12");
});

it("slides and fades in, and out before it closes (280ms transform, 160ms opacity; none under reduced motion)", async () => {
  await mount();
  expect(toast().className).toContain("motion-reduce:transition-none");
  expect(toast().dataset.state).toBe("closed");
  await act(async () => vi.advanceTimersByTime(20));
  expect(toast().dataset.state).toBe("open");
  await act(async () => el.querySelector<HTMLElement>("button")!.click());
  expect(toast().dataset.state).toBe("closed");
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(280));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("closes at once under prefers-reduced-motion", async () => {
  reduced(true);
  await mount();
  await act(async () => el.querySelector<HTMLElement>("button")!.click());
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("closes itself after 5 s", async () => {
  await mount();
  await act(async () => vi.advanceTimersByTime(5000 + 280));
  expect(onClose).toHaveBeenCalledTimes(1);
});
