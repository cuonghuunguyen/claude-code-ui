// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PlanUsage } from "@claude-ui/protocol";
import { PlanMeter, planLevel, resetText } from "./plan-meter.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now();
const usage: PlanUsage = {
  plan: "team",
  status: "allowed",
  windows: [
    { kind: "session", label: "Current session", percent: 55, resetsAt: now + (2 * 60 + 5) * 60_000 + 30_000, severity: "normal", active: true },
    { kind: "weekly_all", label: "Current week (all models)", percent: 44, resetsAt: now + (2 * 24 + 3) * 3_600_000 + 30_000, severity: "normal", active: false },
    { kind: "weekly_scoped", label: "Current week (Fable)", percent: 2, resetsAt: null, severity: "normal", active: false },
  ],
};

let unmount = () => {};
afterEach(() => unmount());

async function render(u: PlanUsage) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<PlanMeter usage={u} />));
  unmount = () => (root.unmount(), el.remove());
  return el;
}
const meter = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="plan-meter"]')!;

it("shows the server's headline window as percent, the label names window and reset", async () => {
  const el = await render(usage);
  expect(meter(el).textContent).toBe("55%");
  expect(meter(el).dataset.level).toBe("ok");
  expect(meter(el).getAttribute("aria-label")).toMatch(/^Plan usage: Current session 55%, resets .* \(in 2h 5m\), show details$/);
});

it("click opens each window with percent and reset time", async () => {
  const el = await render(usage);
  await act(async () => meter(el).click());
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="plan-window"]')];
  expect(rows.map((r) => r.querySelector("span")!.textContent)).toEqual(["Current session", "Current week (all models)", "Current week (Fable)"]);
  expect(rows.map((r) => r.querySelectorAll("span")[1]!.textContent)).toEqual(["55%", "44%", "2%"]);
  expect(rows[0]!.textContent).toContain("(in 2h 5m)");
  expect(rows[1]!.textContent).toContain("(in 2d 3h)");
  expect(document.querySelector('[data-testid="plan-usage"]')!.textContent).toContain("Team plan");
});

it("warns past the threshold or on the server's grade, with an icon (not color only)", async () => {
  expect(planLevel({ ...usage, windows: [{ ...usage.windows[0]!, percent: 80 }] })).toBe("warning");
  expect(planLevel({ ...usage, windows: [{ ...usage.windows[0]!, severity: "warning" }] })).toBe("warning");
  expect(planLevel({ ...usage, status: "allowed_warning" })).toBe("warning");
  const el = await render({ ...usage, windows: [{ ...usage.windows[0]!, percent: 91 }, usage.windows[1]!] });
  expect(meter(el).dataset.level).toBe("warning");
  expect(meter(el).querySelector('[data-testid="plan-warning-icon"]')).not.toBeNull();
});

it("warning caused by another window: the trigger shows that window and its label names the warning", async () => {
  const el = await render({ ...usage, windows: [{ ...usage.windows[0]!, percent: 72 }, { ...usage.windows[1]!, percent: 86 }] });
  expect(meter(el).dataset.level).toBe("warning");
  expect(meter(el).textContent).toBe("86%");
  expect(meter(el).getAttribute("aria-label")).toMatch(/^Plan usage warning: Current week \(all models\) 86%, resets .*, show details$/);
  expect(meter(el).title).toMatch(/^Plan usage warning: Current week \(all models\) 86%/);
});

it("limit hit: a window at 100% or a rejected rate_limit_event, shown with its reset time", async () => {
  expect(planLevel({ ...usage, windows: [{ ...usage.windows[1]!, percent: 100 }] })).toBe("limit");
  const el = await render({ ...usage, status: "rejected", statusResetsAt: now + 65 * 60_000 + 30_000 });
  expect(meter(el).dataset.level).toBe("limit");
  expect(meter(el).getAttribute("aria-label")).toMatch(/^Plan usage: limit reached, resets .* \(in 1h 5m\), show details$/);
  await act(async () => meter(el).click());
  expect(document.querySelector('[data-testid="plan-limit"]')!.textContent).toMatch(/^Limit reached\. Resets .* \(in 1h 5m\)$/);
});

it("a rejected limit names its window when the event did; the popover's relative reset time counts down while open", async () => {
  vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    const el = await render({ ...usage, status: "rejected", statusLimit: "Current week (Opus)", statusResetsAt: now + 65 * 60_000 + 30_000 });
    expect(meter(el).getAttribute("aria-label")).toMatch(/^Plan usage: limit reached: Current week \(Opus\), resets /);
    await act(async () => meter(el).click());
    const limit = () => document.querySelector('[data-testid="plan-limit"]')!.textContent;
    expect(limit()).toMatch(/^Limit reached: Current week \(Opus\)\. Resets .* \(in 1h 5m\)$/);
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(limit()).toMatch(/\(in 1h 4m\)$/);
  } finally {
    vi.useRealTimers();
  }
});

it("reset text: time today, weekday otherwise, relative part", () => {
  const base = new Date(2026, 9, 1, 9, 0).getTime();
  expect(resetText(base + 30 * 60_000, base)).toMatch(/^Resets \d{1,2}:30.* \(in 30m\)$/);
  expect(resetText(base + 26 * 3_600_000, base)).toMatch(/^Resets Fri.* \(in 1d 2h\)$/);
  expect(resetText(base - 1, base)).toBe("Resets now");
});
