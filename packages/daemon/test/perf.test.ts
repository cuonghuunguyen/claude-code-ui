import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPerf, type PerfMonitor } from "../src/perf.ts";

let clock = 0;
let perfs: PerfMonitor[] = [];
const fakeEld = () => ({ enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), percentile: (p: number) => (p <= 50 ? 15.6 : 15.9), max: 16 });
const make = () => {
  const eld = fakeEld();
  const p = createPerf({ now: () => clock, eld: () => eld, memory: () => ({ rss: 100e6, heapUsed: 50e6 }), elu: () => ({ utilization: 0.0001 }) });
  perfs.push(p);
  return { p, eld };
};
const tick = (ms: number) => {
  clock += ms;
  vi.advanceTimersByTime(ms);
};

beforeEach(() => {
  clock = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  perfs.forEach((p) => p.close());
  perfs = [];
  vi.useRealTimers();
});

describe("event loop", () => {
  it("memory keeps the last 60 samples", () => {
    const { p } = make();
    p.setEnabled(true);
    for (let i = 0; i < 70; i++) tick(10_000);
    expect(p.report().memory).toHaveLength(60);
  });
});

describe("spans", () => {
  it("a session.start span that never ends closes as a timeout after 60 s, with no stall label afterwards", () => {
    const { p } = make();
    p.setEnabled(true);
    const s = p.span("session.start");
    tick(61_000);
    const r = p.report();
    expect(r.spans["session.start"]).toBeUndefined();
    expect(r.spans["session.start.timeout"]?.n).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    s.end();
    expect(p.report().spans["session.start"]).toBeUndefined();
    const q = p.span("session.open");
    tick(300);
    const stall = p.report().worst.filter((w) => w.kind === "stall").at(-1);
    expect(stall && stall.kind === "stall" && stall.spans.map((x) => x.name)).toEqual(["session.open"]);
    q.end();
  });
  it("no watchdog timer without an open span", () => {
    const { p } = make();
    p.setEnabled(true);
    expect(vi.getTimerCount()).toBe(1);
    const s = p.span("session.open");
    expect(vi.getTimerCount()).toBe(2);
    s.end();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("privacy", () => {
  it("report holds no path, title or id", () => {
    const { p } = make();
    p.setEnabled(true);
    const end = p.request("session.prompt", "/home/u/secret-project");
    const sp = p.span("session.open");
    const done = p.child({ cmd: "/home/u/secret-project/secret-tool", args: ["log", "secret.txt", "feature/secret-branch", "0a1b2c3d-1111-2222-3333-444455556666"], cwd: "/home/u/secret-project", thread: "main" });
    clock += 400;
    done(0);
    const g = p.child({ cmd: "git", args: ["log", "secret.txt", "secret-branch"], cwd: "/home/u/secret-project", thread: "worker" });
    clock += 400;
    g(0);
    // A git subcommand outside the allowlist is "other", never its name.
    const h = p.child({ cmd: "git", args: ["secret-subcommand", "secret.txt"], cwd: "/home/u/secret-project", thread: "worker" });
    clock += 400;
    h(0);
    sp.end();
    end();
    const json = JSON.stringify(p.report());
    expect(json).not.toContain("secret");
    expect(json).not.toContain("/home/");
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(json).toContain("session.prompt");
  });
});

describe("queue and client marks", () => {
  it("request records the time from the stamp to the handler start, per type; no stamp records nothing", () => {
    const { p } = make();
    p.setEnabled(true);
    clock = 100;
    const at = p.stamp();
    clock = 130;
    p.request("session.create", undefined, at)();
    p.request("session.create", undefined, 0)();
    const q = p.report().queue!;
    expect(q["session.create"]).toMatchObject({ n: 1 });
    expect(q["session.create"]!.max).toBeGreaterThanOrEqual(30);
    p.setEnabled(false);
    expect(p.stamp()).toBe(0);
  });
  it("client keeps the known marks with valid values only; off records nothing", () => {
    const { p } = make();
    p.client({ "firstSend.sent": 5 });
    expect(p.report().client).toEqual({});
    p.setEnabled(true);
    p.client({ "firstSend.sent": 5, "firstSend.info": 70, "firstSend.taken": -1, "firstSend.tab": Number.NaN, "my.secret": 1, "firstSend.nope": 2 });
    p.client({ "firstSend.sent": 600_001, "firstSend.info": "9" });
    const c = p.report().client!;
    expect(Object.keys(c).sort()).toEqual(["firstSend.info", "firstSend.sent"]);
    expect(c["firstSend.sent"]!.n).toBe(1);
    expect(c["firstSend.info"]!.n).toBe(1);
  });
});
