// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocalePref } from "./i18n.ts";
import { StaleToast } from "./stale-toast.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const el = document.createElement("div");
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

it("shows the daemon's note, stays until Dismiss, and Dismiss calls back", async () => {
  const onDismiss = vi.fn();
  await act(async () => root.render(<StaleToast note="claude-ui 0.4.2 is installed but this daemon still runs 0.4.1; it runs after a restart." onDismiss={onDismiss} />));
  const toast = el.querySelector('[data-testid="stale-toast"]')!;
  expect(toast.getAttribute("role")).toBe("status");
  expect(toast.textContent).toContain("The daemon runs older code");
  expect(toast.textContent).toContain("claude-ui 0.4.2 is installed but this daemon still runs 0.4.1");
  await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Dismiss")!.click());
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("renders in Vietnamese when the language is vi, and follows a switch back", async () => {
  await act(async () => root.render(<StaleToast note="n" onDismiss={() => {}} />));
  try {
    await act(async () => setLocalePref("vi"));
    expect(el.textContent).toContain("Daemon đang chạy mã cũ hơn");
    expect(el.querySelector("button")!.textContent).toBe("Bỏ qua");
  } finally {
    await act(async () => setLocalePref("system"));
  }
  expect(el.textContent).toContain("The daemon runs older code");
});
