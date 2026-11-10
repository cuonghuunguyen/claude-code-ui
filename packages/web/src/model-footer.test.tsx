// @vitest-environment jsdom
// The model picker's footer (GH-679): after the items, not an option, closes the popup through close().
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Chooser, ModelFooter } from "./toolbar.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => (act(() => root.unmount()), el.remove(), (document.body.innerHTML = "")));
const mount = async (node: React.ReactNode) => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(node));
};
const items = ["a", "b", "c", "d", "e"].map((v) => ({ value: v, label: v.toUpperCase(), group: "G" }));

it("a Chooser footer sits after the items, is not an option and closes the popup through close()", async () => {
  const onConnect = vi.fn();
  await mount(<Chooser label="Model" testId="m" value="a" onChange={() => {}} items={items} footer={(close) => <ModelFooter onRetry={() => {}} onConnect={onConnect} close={close} />} />);
  const trigger = el.querySelector<HTMLElement>('[data-testid="m"]')!;
  await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(5);
  const connect = document.querySelector<HTMLElement>('[data-testid="models-connect"]')!;
  expect(connect.closest('[role="option"]')).toBeNull();
  await act(async () => connect.click());
  expect(onConnect).toHaveBeenCalledTimes(1);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("ModelFooter: the error line with role=alert and Retry only when an error is set", async () => {
  const onRetry = vi.fn();
  await mount(<ModelFooter onRetry={onRetry} onConnect={() => {}} close={() => {}} />);
  expect(el.querySelector('[role="alert"]')).toBeNull();
  expect(el.querySelector('[data-testid="models-retry"]')).toBeNull();
  await act(async () => root.render(<ModelFooter error="499" onRetry={onRetry} onConnect={() => {}} close={() => {}} />));
  expect(el.querySelector('[role="alert"]')!.textContent).toBe("Models could not be loaded: 499");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="models-retry"]')!.click());
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it("the footer is pinned outside the scrolling list: a sibling after it inside the popup, sticky at the bottom, with 40 models (GH-679)", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ value: `m${i}`, label: `Model ${i}`, group: i < 20 ? "A" : "B" }));
  await mount(<Chooser label="Model" testId="m" value="m0" onChange={() => {}} items={many} footer={(close) => <ModelFooter onRetry={() => {}} onConnect={() => {}} close={close} />} />);
  await act(async () => el.querySelector<HTMLElement>('[data-testid="m"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const footer = document.querySelector<HTMLElement>('[data-slot="select-footer"]')!;
  const popup = document.querySelector<HTMLElement>('[data-slot="select-content"]')!;
  expect(footer.parentElement).toBe(popup);
  expect(footer.className).toContain("sticky");
  expect(footer.className).toContain("bottom-0");
  expect(footer.querySelector('[data-testid="models-connect"]')).not.toBeNull();
  expect(popup.querySelector('[role="listbox"]')!.contains(footer)).toBe(false);
});

it("a footer with an error shows the alert and Retry and both stay in the pinned footer (GH-679)", async () => {
  const onRetry = vi.fn();
  await mount(<Chooser label="Model" testId="m" value="a" onChange={() => {}} items={items} footer={(close) => <ModelFooter error="499" onRetry={onRetry} onConnect={() => {}} close={close} />} />);
  await act(async () => el.querySelector<HTMLElement>('[data-testid="m"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const footer = document.querySelector<HTMLElement>('[data-slot="select-footer"]')!;
  expect(footer.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => footer.querySelector<HTMLElement>('[data-testid="models-retry"]')!.click());
  expect(onRetry).toHaveBeenCalledTimes(1);
});
