// @vitest-environment jsdom
import type { PerfReport } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PerformanceSection } from "./perf-settings.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const report = (): PerfReport => ({
  daemon: {
    pid: 1,
    version: "1.2.3",
    since: Date.UTC(2026, 9, 1),
    monitor: true,
    eld: { excessP95: 1.5, excessMax: 42, idleP50: 62.5, resolutionMs: 50 },
    elu: 0.034,
    handlers: { "session.subscribe": { n: 3, p50: 120, max: 480 }, "git.log": { n: 40, p50: 8, p95: 30, max: 55 } },
    spans: { "session.open": { n: 2, p50: 300, max: 900 } },
    children: { "git log": { n: 40, p50: 6, p95: 20, max: 33 }, claude: { n: 1, p50: 25, max: 25 } },
    memory: [
      { at: 1, rss: 100e6, heapUsed: 40e6 },
      { at: 2, rss: 120e6, heapUsed: 50e6 },
    ],
    worst: [
      { kind: "stall", at: 5, ms: 650, spans: [{ name: "session.open", id: 3 }] },
      { kind: "child", at: 6, cmd: "git", sub: "log", ms: 250, thread: "worker", request: "git.log", exit: 0 },
    ],
    cost: { ownMs: 1.5, wallMs: 60_000 },
  },
});

let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const mount = async (request: (m: { type: string }) => Promise<unknown>) => {
  await act(async () => root.render(<PerformanceSection request={request as never} />));
  await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
};
const text = () => host.textContent ?? "";

it("shows excess delay, ELU, slowest requests and spans, processes, stalls, memory and cost", async () => {
  await mount(async () => report());
  expect(text()).toContain("1.5 ms");
  expect(text()).toContain("3.4 %");
  expect(host.querySelector('[data-testid="perf-slowest"]')?.textContent).toContain("session.subscribe");
  expect(host.querySelector('[data-testid="perf-slowest"]')?.textContent).toContain("session.open");
  expect(host.querySelector('[data-testid="perf-processes"]')?.textContent).toContain("git log");
  const events = host.querySelector('[data-testid="perf-events"]')?.textContent ?? "";
  expect(events).toContain("session.open");
  expect(events).toContain("git.log");
  expect(host.querySelector('[data-testid="perf-memory"] svg')).toBeTruthy();
  expect(text()).toContain("120 MB");
  expect(text()).toMatch(/Monitor cost.*1\.5 ms/);
});

it("p95 shows — when n < 30", async () => {
  await mount(async () => report());
  const row = (name: string) => [...host.querySelectorAll('[data-testid="perf-slowest"] [data-row]')].find((r) => r.textContent?.includes(name))!;
  expect(row("session.subscribe").textContent).toContain("—");
  expect(row("git.log").textContent).toContain("30 ms");
});

it("the tables are real tables with column and row headers, named by their title", async () => {
  await mount(async () => report());
  const t = host.querySelector('[data-testid="perf-slowest"] table')!;
  expect(t.getAttribute("aria-labelledby")).toBe("perf-slowest-title");
  expect([...t.querySelectorAll("thead th[scope=col]")].map((h) => h.textContent)).toEqual(["Name", "n", "p50", "p95", "Worst"]);
  expect(t.querySelector("tbody th[scope=row]")?.textContent).toBeTruthy();
});

it("the cost hint does not state one platform's number", async () => {
  await mount(async () => report());
  expect(text()).not.toMatch(/11 ms/);
});

it("says so when the monitor is off", async () => {
  const r = report();
  r.daemon.monitor = false;
  await mount(async () => r);
  expect(text()).toContain("The monitor is off");
});

it("Clear sends perf.clear and reloads", async () => {
  const sent: string[] = [];
  await mount(async (m) => (sent.push(m.type), m.type === "perf.clear" ? {} : report()));
  sent.length = 0;
  await act(async () => (host.querySelector('[data-testid="perf-clear"]') as HTMLElement).click());
  await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  expect(sent).toEqual(["perf.clear", "perf.report"]);
});

it("Export JSON has no titles, prompts or paths", async () => {
  const r = report();
  const blobs: Blob[] = [];
  URL.createObjectURL = ((b: Blob) => (blobs.push(b), "blob:x")) as never;
  URL.revokeObjectURL = (() => {}) as never;
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await mount(async () => r);
  await act(async () => (host.querySelector('[data-testid="perf-export"]') as HTMLElement).click());
  expect(click).toHaveBeenCalled();
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  expect(revoke).not.toHaveBeenCalled();
  await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
  expect(revoke).toHaveBeenCalledWith("blob:x");
  const json = await blobs[0]!.text();
  const out = JSON.parse(json) as { app: { web: string }; report: PerfReport };
  expect(out.report).toEqual(r);
  expect(json).not.toMatch(/\/home\/|[A-Za-z]:\\|secret/);
});

it("polls every 5 s while mounted and stops on unmount", async () => {
  const request = vi.fn(async () => report());
  await mount(request as never);
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
  expect(request).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
  await vi.advanceTimersByTimeAsync(20_000);
  expect(request).toHaveBeenCalledTimes(2);
  root = createRoot(host);
});
