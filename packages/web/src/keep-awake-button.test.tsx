// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { KeepAwakeButton, keepAwakeTitle } from "./keep-awake-button.tsx";
import type { KeepAwakeStatus } from "./keep-awake.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => (act(() => root?.unmount()), (document.body.innerHTML = "")));

function show(status: KeepAwakeStatus, error?: string) {
  const onToggle = vi.fn();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(<KeepAwakeButton status={status} error={error} onToggle={onToggle} testId="k" />));
  return { b: el.querySelector<HTMLButtonElement>('[data-testid="k"]')!, onToggle };
}

it("keeps a fixed name; aria-pressed and the tooltip carry the state", () => {
  const rows: [KeepAwakeStatus, string | null, string][] = [
    ["off", "false", "Screen may sleep"],
    ["held", "true", "Keep screen awake"],
    ["idle", "true", "Keep screen awake (waits for a running session)"],
    ["pending", "true", "Keep screen awake"],
    ["hidden", "true", "Keep screen awake (resumes when the page is visible)"],
  ];
  for (const [status, pressed, title] of rows) {
    const { b } = show(status);
    expect(b.getAttribute("aria-label")).toBe("Keep screen awake");
    expect(b.getAttribute("aria-pressed")).toBe(pressed);
    expect(b.title).toBe(title);
    act(() => root!.unmount());
  }
});

it("refused: pressed, warning icon, reason with the error name", () => {
  const { b } = show("refused", "NotAllowedError");
  expect(b.getAttribute("aria-pressed")).toBe("true");
  expect(b.title).toContain("NotAllowedError");
  expect(b.querySelector("svg")!.getAttribute("class")).toContain("text-warning");
  expect(keepAwakeTitle("refused")).toContain("(error)");
});

it("unsupported: aria-disabled, focusable, a click does not toggle", () => {
  const { b, onToggle } = show("unsupported");
  expect(b.getAttribute("aria-disabled")).toBe("true");
  expect(b.disabled).toBe(false);
  expect(b.getAttribute("aria-pressed")).toBe("false");
  expect(b.title).toContain("HTTPS or localhost");
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  try {
    expect(keepAwakeTitle("unsupported")).toContain("not supported by this browser");
    expect(keepAwakeTitle("unsupported")).not.toContain("HTTPS");
  } finally {
    Object.defineProperty(window, "isSecureContext", { value: undefined, configurable: true });
  }
  act(() => b.click());
  expect(onToggle).not.toHaveBeenCalled();
});

it("a click on a supported button toggles", () => {
  const { b, onToggle } = show("off");
  act(() => b.click());
  expect(onToggle).toHaveBeenCalledOnce();
});
