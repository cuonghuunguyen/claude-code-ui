// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContinueDock } from "./continue-dock.tsx";
import { clockText } from "./plan-meter.tsx";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function render(onCancel = vi.fn()) {
  const at = Date.now() + 60_000;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(<ContinueDock at={at} onCancel={onCancel} />));
  return { at, onCancel };
}

it("shows Continuing at <time> with a Cancel button (a 44px target below md) that calls onCancel", () => {
  const { at, onCancel } = render();
  expect(document.querySelector("[data-testid=auto-continue]")?.textContent).toContain(`Continuing at ${clockText(at)} after the usage limit resets`);
  expect(document.querySelector("[data-testid=auto-continue-cancel]")?.className).toContain("max-md:min-h-11");
  act(() => document.querySelector<HTMLElement>("[data-testid=auto-continue-cancel]")!.click());
  expect(onCancel).toHaveBeenCalledTimes(1);
});
