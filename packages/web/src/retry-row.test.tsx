// @vitest-environment jsdom
// The retry line (GH-683): the reason, a countdown to the next try, a quiet announcement for screen readers.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryRow, retryCountdown, retryTime } from "./retry-row.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const NOW = 1_700_000_000_000;
const show = (retry: { attempt: number; message: string; next?: number }) => act(() => root.render(<RetryRow retry={retry} />));
const countdown = () => el.querySelector('[data-testid="retry-countdown"]')!.textContent;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  vi.useRealTimers();
});

describe("RetryRow", () => {
  it("shows the reason and counts down to the next try each second", () => {
    show({ attempt: 2, message: "Rate limit reached for m1", next: NOW + 4000 });
    expect(el.querySelector('[data-testid="retry-reason"]')!.textContent).toBe("Rate limit reached for m1");
    expect(el.querySelector('[data-testid="retry-reason"]')!.getAttribute("title")).toBe("Rate limit reached for m1");
    expect(countdown()).toBe("Retrying in 4s · attempt 2");
    act(() => void vi.advanceTimersByTime(1000));
    expect(countdown()).toBe("Retrying in 3s · attempt 2");
    act(() => void vi.advanceTimersByTime(3000));
    expect(countdown()).toBe("Retrying now · attempt 2");
  });

  it("at or past next it says retrying now; without next too", () => {
    show({ attempt: 1, message: "x", next: NOW - 5000 });
    expect(countdown()).toBe("Retrying now · attempt 1");
    show({ attempt: 3, message: "x" });
    expect(countdown()).toBe("Retrying now · attempt 3");
    expect(retryCountdown(NOW + 1, NOW)).toEqual({ seconds: 1 });
  });

  it("minutes and hours format", () => {
    expect(retryTime(4)).toBe("4s");
    expect(retryTime(65)).toBe("1m 05s");
    expect(retryTime(3720)).toBe("1h 02m");
    show({ attempt: 1, message: "x", next: NOW + 65_000 });
    expect(countdown()).toBe("Retrying in 1m 05s · attempt 1");
  });

  it("the status text for screen readers names the attempt and reason once; the countdown is aria-hidden", () => {
    show({ attempt: 2, message: "Rate limit reached for m1", next: NOW + 4000 });
    const status = el.querySelector('[role="status"]')!;
    expect(status.querySelector(".sr-only")!.textContent).toBe("Retrying, attempt 2: Rate limit reached for m1");
    expect(el.querySelector('[data-testid="retry-countdown"]')!.getAttribute("aria-hidden")).toBe("true");
    expect(status.querySelector('[data-testid="retry-reason"]')!.closest("[aria-hidden]")!.getAttribute("aria-hidden")).toBe("true");
    act(() => void vi.advanceTimersByTime(2000));
    expect(status.querySelector(".sr-only")!.textContent).toBe("Retrying, attempt 2: Rate limit reached for m1");
  });
});
