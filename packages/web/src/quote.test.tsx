// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuoteButton } from "./quote-button.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getBoundingClientRect = () => new DOMRect(100, 200, 80, 20);

const onQuote = vi.fn();
let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="app"></div><div class="timeline"><div data-testid="assistant-text"><p>Alpha beta</p><pre><code>x = 1</code></pre></div><div data-testid="user-message">Gamma</div></div><textarea>draft</textarea><div data-testid="assistant-text">outside</div>`;
  const root = createRoot(document.getElementById("app")!);
  act(() => root.render(<QuoteButton onQuote={onQuote} />));
  unmount = () => act(() => root.unmount());
});
afterEach(() => {
  unmount();
  onQuote.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.getSelection()?.removeAllRanges();
});

const q = <T extends Element = HTMLElement>(s: string) =>
  document.querySelector<T>(s);
const button = () => q('[data-testid="quote-button"]');
const select = (node: Node, ms = 150) => {
  document.getSelection()!.selectAllChildren(node);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
    vi.advanceTimersByTime(ms);
  });
};
const pre = () => q("pre")!;
const quoteOf = () => (
  act(() => button()!.click()),
  onQuote.mock.lastCall![0] as string
);

it("the code fence does not depend on the drag direction", () => {
  const tn = (n: Node) => n.firstChild!;
  for (const [a, ao, f, fo] of [
    [tn(para()), 0, tn(q("code")!), 5],
    [tn(q("code")!), 5, tn(para()), 0],
  ] as const) {
    document.getSelection()!.setBaseAndExtent(a, ao, f, fo);
    act(
      () => (
        document.dispatchEvent(new Event("selectionchange")),
        void vi.advanceTimersByTime(150)
      ),
    );
    expect(quoteOf()).not.toContain("```");
  }
  select(pre());
  expect(quoteOf()).toContain("```");
});

it("Esc is not prevented while the focus is in a dialog or the prompt box, and a focus move outside the timeline hides the button", () => {
  select(para());
  const t = q("textarea")!;
  t.focus();
  const esc = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  act(() => void t.dispatchEvent(esc));
  expect(esc.defaultPrevented).toBe(false);
  select(para());
  act(() => void t.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(button()).toBeNull();
});

const para = () => q("p")!;

it("a selection inside one message shows the Quote button after 150 ms, not before", () => {
  select(para(), 149);
  expect(button()).toBeNull();
  act(() => void vi.advanceTimersByTime(1));
  expect(button()).not.toBeNull();
});

it("no Quote button for a selection in the prompt box, outside the timeline, or across two messages", () => {
  select(q("textarea")!);
  expect(button()).toBeNull();
  select(document.querySelectorAll('[data-testid="assistant-text"]')[1]!);
  expect(button()).toBeNull();
  document
    .getSelection()!
    .setBaseAndExtent(
      para().firstChild!,
      0,
      q('[data-testid="user-message"]')!.firstChild!,
      3,
    );
  act(
    () => (
      document.dispatchEvent(new Event("selectionchange")),
      void vi.advanceTimersByTime(150)
    ),
  );
  expect(button()).toBeNull();
});

it("the Quote button hides on an empty selection, a scroll, a click elsewhere and Esc; Esc is defaultPrevented", () => {
  select(para());
  act(
    () => (
      document.getSelection()!.removeAllRanges(),
      void document.dispatchEvent(new Event("selectionchange"))
    ),
  );
  expect(button()).toBeNull();
  select(para());
  act(() => void document.dispatchEvent(new Event("scroll")));
  expect(button()).toBeNull();
  select(para());
  act(
    () =>
      void q("textarea")!.dispatchEvent(
        new Event("pointerdown", { bubbles: true }),
      ),
  );
  expect(button()).toBeNull();
  select(para());
  const esc = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  act(() => void window.dispatchEvent(esc));
  expect(esc.defaultPrevented).toBe(true);
  expect(button()).toBeNull();
});

it("clicking Quote passes the quote (fenced for a selection inside <pre>) and hides the button", () => {
  select(para());
  act(() => button()!.click());
  expect(onQuote).toHaveBeenLastCalledWith("> Alpha beta\n\n");
  expect(button()).toBeNull();
  select(q("code")!);
  act(() => button()!.click());
  expect(onQuote).toHaveBeenLastCalledWith("> ```\n> x = 1\n> ```\n\n");
});

it("touch: the Quote button is 44 px (min-h-11) and sits below the selection", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)",
  }));
  select(para());
  expect(button()!.className).toContain("min-h-11");
  expect(button()!.style.top).toBe("228px");
});
