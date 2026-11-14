import { describe, expect, it, vi } from "vitest";
import { createStallLog, type StallSeams } from "./stall-log.ts";

/** Fake clock, interval and PerformanceObserver: `tick(ms)` advances the clock and runs the sampler once. */
function rig(over: Partial<StallSeams> & { longtask?: boolean } = {}) {
  let t = 1_000_000;
  let tickFn: (() => void) | undefined;
  let visible = true;
  const warn = vi.fn();
  const entries: { cb?: (list: { getEntries: () => { duration: number }[] }) => void; observed?: unknown } = {};
  class FakeObserver {
    static supportedEntryTypes = over.longtask === false ? ["paint"] : ["longtask"];
    constructor(cb: (list: { getEntries: () => { duration: number }[] }) => void) {
      entries.cb = cb;
    }
    observe(o: unknown) {
      entries.observed = o;
    }
    disconnect() {}
  }
  const log = createStallLog({
    now: () => t,
    setInterval: (f) => ((tickFn = f), 1 as never),
    clearInterval: () => (tickFn = undefined),
    visible: () => visible,
    PerformanceObserver: FakeObserver as never,
    warn,
    ...over,
  });
  return {
    log,
    warn,
    entries,
    hide: (v: boolean) => (visible = !v),
    /** The timer fires `ms` after the previous tick. */
    tick: (ms: number) => ((t += ms), tickFn?.()),
    longtask: (...d: number[]) => entries.cb?.({ getEntries: () => d.map((duration) => ({ duration })) }),
    running: () => tickFn !== undefined,
  };
}

describe("stall log", () => {
  it("lag is the delay beyond the 250 ms tick", () => {
    const r = rig();
    r.log.start();
    r.tick(250);
    r.tick(1_250); // 1 s late
    r.tick(750); // 0.5 s late
    expect(r.log.lag30()).toEqual({ max: 1000, total: 1500 });
  });

  it("does not sample while hidden: the wait of a throttled timer is not lag", () => {
    const r = rig();
    r.log.start();
    r.hide(true);
    r.tick(5_000);
    r.hide(false);
    r.tick(250);
    expect(r.log.lag30()).toEqual({ max: 0, total: 0 });
  });

  it("warns once per 10 s window, and only when the total lag is at least 500 ms", () => {
    const r = rig({ longtask: false });
    r.log.start();
    r.log.message(1000, 5);
    for (let i = 0; i < 40; i++) r.tick(250); // 10 s, no lag
    expect(r.warn).not.toHaveBeenCalled();
    r.log.message(2_000_000, 300);
    r.log.message(400_000, 10);
    r.tick(1_250); // 1 s lag
    r.tick(1_750); // 1.5 s lag
    for (let i = 0; i < 36; i++) r.tick(250);
    expect(r.warn).toHaveBeenCalledTimes(1);
    expect(r.warn.mock.calls[0][0]).toBe("claude-ui: main thread busy 10s: lag max 1.5s total 2.5s, msgs 2 (2.3MB) parse 310ms");
    for (let i = 0; i < 40; i++) r.tick(250);
    expect(r.warn).toHaveBeenCalledTimes(1);
  });

  it("counts long tasks when the browser reports them, and leaves them out when it does not", () => {
    const r = rig();
    r.log.start();
    expect(r.entries.observed).toEqual({ type: "longtask", buffered: false });
    r.longtask(120, 1800);
    r.tick(1_250);
    for (let i = 0; i < 40; i++) r.tick(250);
    expect(r.warn.mock.calls[0][0]).toContain("long tasks 2 (max 1.8s)");

    const n = rig({ longtask: false });
    n.log.start();
    expect(n.entries.observed).toBeUndefined();
    n.tick(1_250);
    for (let i = 0; i < 40; i++) n.tick(250);
    expect(n.warn.mock.calls[0][0]).not.toContain("long tasks");
  });

  it("lag30 covers the last three windows, then forgets", () => {
    const r = rig();
    r.log.start();
    r.tick(1_250);
    expect(r.log.lag30().total).toBe(1000);
    for (let i = 0; i < 40 * 4; i++) r.tick(250);
    expect(r.log.lag30()).toEqual({ max: 0, total: 0 });
  });

  it("stop ends the sampler", () => {
    const r = rig();
    r.log.start();
    expect(r.running()).toBe(true);
    r.log.stop();
    expect(r.running()).toBe(false);
  });
});
