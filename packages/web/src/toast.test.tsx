// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StaleToast } from "./stale-toast.tsx";
import { Toast, ToastRegion } from "./toast.tsx";

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
it("sits in the toast region: full width at phone widths and 320px from 600px up", async () => {
  const root = createRoot(el);
  await act(async () => root.render(<ToastRegion><Toast message="hi" onClose={onClose} /></ToastRegion>));
  const c = el.querySelector('[data-testid="toast-region"]')!.className;
  expect(c).toContain("w-[calc(100vw-2rem)]");
  expect(c).toContain("min-[601px]:w-80");
  expect(c).toContain("min-[601px]:right-8");
  expect(c).toContain("min-[601px]:bottom-12");
  // The card itself is not positioned: the region places it.
  expect(toast().className).not.toContain("fixed");
});

it("two toasts at once stack in one region instead of covering each other (GH-158)", async () => {
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <ToastRegion>
        <Toast message="first" onClose={onClose} />
        <StaleToast note="n" onDismiss={() => {}} />
      </ToastRegion>,
    ),
  );
  const region = el.querySelector('[data-testid="toast-region"]')!;
  expect(region.className).toContain("flex-col-reverse");
  expect(region.className).toContain("gap-2");
  expect(region.querySelectorAll('[data-testid="toast"], [data-testid="stale-toast"]')).toHaveLength(2);
  expect(region.className).toContain("pointer-events-none");
  expect(toast().className).toContain("pointer-events-auto");
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

it("an action button (Undo) runs its callback and closes the toast, at once under reduced motion", async () => {
  reduced(true);
  const run = vi.fn();
  const root = createRoot(el);
  await act(async () => root.render(<Toast message="Closed Fix login" action={{ label: "Undo", onClick: run }} onClose={onClose} />));
  const undo = [...toast().querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
  await act(async () => undo.click());
  expect(run).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

it("a toast replaced while it leaves does not close the next one", async () => {
  const first = vi.fn();
  const root = createRoot(el);
  await act(async () => root.render(<Toast key="1" message="a" action={{ label: "Undo", onClick: () => {} }} onClose={first} />));
  await act(async () => void toast().querySelector<HTMLElement>('[aria-label="Dismiss"]')!.click());
  await act(async () => root.render(<Toast key="2" message="b" onClose={onClose} />));
  await act(async () => void vi.advanceTimersByTime(300));
  expect(first).not.toHaveBeenCalled();
});

it("the 5 s timer waits while the toast has the pointer or the focus (the Undo button), then runs again", async () => {
  const root = createRoot(el);
  await act(async () => root.render(<Toast message="Closed x" action={{ label: "Undo", onClick: () => {} }} onClose={onClose} />));
  const undo = [...toast().querySelectorAll("button")].find((b) => b.textContent === "Undo")!;
  await act(async () => void undo.focus());
  await act(async () => void vi.advanceTimersByTime(8000));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => void undo.blur());
  await act(async () => void vi.advanceTimersByTime(4000));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => void vi.advanceTimersByTime(2000));
  expect(onClose).toHaveBeenCalled();
  onClose.mockClear();
  await act(async () => root.render(<Toast key="2" message="again" onClose={onClose} />));
  await act(async () => void toast().dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
  await act(async () => void vi.advanceTimersByTime(8000));
  expect(onClose).not.toHaveBeenCalled();
});

it("a toast that is closing stays closing when the pointer leaves during its exit", async () => {
  const root = createRoot(el);
  await act(async () => root.render(<Toast message="x" onClose={onClose} />));
  await act(async () => void vi.advanceTimersByTime(20));
  await act(async () => void toast().dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
  await act(async () => void toast().querySelector<HTMLElement>('[aria-label="Dismiss"]')!.click());
  expect(toast().dataset.state).toBe("closed");
  await act(async () => void toast().dispatchEvent(new PointerEvent("pointerout", { bubbles: true })));
  await act(async () => void vi.advanceTimersByTime(20));
  expect(toast().dataset.state).toBe("closed");
});
