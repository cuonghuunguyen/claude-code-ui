// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
