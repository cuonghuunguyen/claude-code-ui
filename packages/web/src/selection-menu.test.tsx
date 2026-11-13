// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectionMenu } from "./selection-menu.tsx";

const onAdd = vi.fn();
const onQuote = vi.fn();
const onDismiss = vi.fn();
let anchor: DOMRect | undefined;
let unmount = () => {};
const q = (s: string) => document.querySelector<HTMLElement>(s);
const mount = (props: { onScroll?: "hide" | "follow" } = {}) => {
  const root = createRoot(document.getElementById("app")!);
  act(() =>
    root.render(
      <SelectionMenu
        anchor={() => anchor}
        source={() => q("#src")}
        onDismiss={onDismiss}
        actions={[
          { id: "add", label: "Add to chat", icon: null, onSelect: onAdd },
          { id: "quote", label: "Quote", icon: null, onSelect: onQuote },
        ]}
        {...props}
      />,
    ),
  );
  unmount = () => act(() => root.unmount());
};
beforeEach(() => {
  document.body.innerHTML = `<div id="app"></div><div id="src"><input id="in"></div><textarea id="out"></textarea>`;
  anchor = new DOMRect(100, 200, 80, 20);
});
afterEach(() => {
  unmount();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("renders a toolbar with one button per action", () => {
  mount();
  expect(q('[data-testid="selection-menu"]')!.getAttribute("role")).toBe("toolbar");
  expect(q('[data-testid="selection-menu-add"]')!.textContent).toBe("Add to chat");
  expect(q('[data-testid="selection-menu-quote"]')!.textContent).toBe("Quote");
});
it("an action runs, then dismisses", () => {
  mount();
  act(() => q('[data-testid="selection-menu-quote"]')!.click());
  expect(onQuote).toHaveBeenCalledOnce();
  expect(onAdd).not.toHaveBeenCalled();
  expect(onDismiss).toHaveBeenCalledOnce();
});
it("pointerdown on a button is default-prevented (the source keeps focus)", () => {
  mount();
  const e = new Event("pointerdown", { bubbles: true, cancelable: true });
  act(() => void q('[data-testid="selection-menu-add"]')!.dispatchEvent(e));
  expect(e.defaultPrevented).toBe(true);
  expect(onDismiss).not.toHaveBeenCalled();
});
it("Escape dismisses; it is default-prevented only from the body or the source", () => {
  mount();
  const esc = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  const a = esc();
  q("#out")!.focus();
  onDismiss.mockClear();
  act(() => void window.dispatchEvent(a));
  expect(a.defaultPrevented).toBe(false);
  expect(onDismiss).toHaveBeenCalledOnce();
  const b = esc();
  q("#in")!.focus();
  onDismiss.mockClear();
  act(() => void window.dispatchEvent(b));
  expect(b.defaultPrevented).toBe(true);
  expect(onDismiss).toHaveBeenCalledOnce();
});
it("pointerdown outside dismisses; on the menu it does not", () => {
  mount();
  act(() => void q('[data-testid="selection-menu"]')!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(onDismiss).not.toHaveBeenCalled();
  act(() => void q("#out")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(onDismiss).toHaveBeenCalledOnce();
});
it("focus moving outside the source dismisses; inside the source it does not", () => {
  mount();
  act(() => q("#in")!.focus());
  expect(onDismiss).not.toHaveBeenCalled();
  act(() => q("#out")!.focus());
  expect(onDismiss).toHaveBeenCalledOnce();
});
it("no anchor: nothing is drawn", () => {
  anchor = undefined;
  mount();
  expect(q('[data-testid="selection-menu"]')).toBeNull();
});
it('scroll: "hide" dismisses', () => {
  mount({ onScroll: "hide" });
  act(() => void document.dispatchEvent(new Event("scroll")));
  expect(onDismiss).toHaveBeenCalledOnce();
});
it('scroll: "follow" keeps the menu and re-reads the anchor', async () => {
  vi.useFakeTimers();
  mount();
  anchor = new DOMRect(100, 400, 80, 20);
  await act(async () => {
    document.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(20);
  });
  vi.useRealTimers();
  expect(onDismiss).not.toHaveBeenCalled();
  expect(q('[data-testid="selection-menu"]')!.style.top).toBe("392px");
});
it("touch: buttons are 44px high (min-h-11) and the menu sits below the anchor", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" }));
  mount();
  expect(q('[data-testid="selection-menu-add"]')!.className).toContain("min-h-11");
  expect(q('[data-testid="selection-menu"]')!.style.top).toBe("228px");
});
