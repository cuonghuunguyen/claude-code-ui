// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Thinking } from "./tool-card.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());

it.each([
  ["after", false],
  ["while", true],
])("a thinking block that streamed in this page stays open when the user opens it %s it streams", (_, openWhileStreaming) => {
  vi.useFakeTimers();
  const el = document.createElement("div");
  const root = createRoot(el);
  const render = (streaming: boolean) => act(() => root.render(<Thinking part={{ type: "thinking", id: "k", text: "plan", streaming }} />));
  render(true);
  const trigger = el.querySelector("button")!;
  if (openWhileStreaming) act(() => trigger.click());
  render(false);
  if (!openWhileStreaming) act(() => trigger.click());
  act(() => void vi.advanceTimersByTime(3000));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  root.unmount();
});
