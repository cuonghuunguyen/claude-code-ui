import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdLabel, createPerf, gitSub, KNOWN_TYPES, type PerfMonitor } from "../src/perf.ts";

let clock = 0;
let perfs: PerfMonitor[] = [];
const fakeEld = (o: { p50?: number; p95?: number; max?: number } = {}) => ({
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
  percentile: (p: number) => (p <= 50 ? (o.p50 ?? 15.6) : (o.p95 ?? 15.9)),
  max: o.max ?? 16,
});
const make = (o: Partial<Parameters<typeof createPerf>[0]> = {}) => {
  const eld = fakeEld();
  const p = createPerf({ now: () => clock, eld: () => eld, memory: () => ({ rss: 100e6, heapUsed: 50e6 }), elu: () => ({ utilization: 0.0001 }), ...o });
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
  it("excess delay is the delay over the idle p50 (Windows floor), ELU about 0", () => {
    const { p } = make();
    p.setEnabled(true);
    for (let i = 0; i < 6; i++) tick(10_000);
    const r = p.report();
    expect(r.eld.excessP95).toBeLessThanOrEqual(0.5);
    expect(r.eld.idleP50).toBeCloseTo(15.6);
    expect(r.elu).toBeLessThan(0.01);
    expect(r.memory).toHaveLength(6);
  });
  it("a slow window shows as excess over the idle floor", () => {
    const e = fakeEld();
    const p = createPerf({ now: () => clock, eld: () => e, memory: () => ({ rss: 1, heapUsed: 1 }), elu: () => ({ utilization: 0 }) });
    perfs.push(p);
    p.setEnabled(true);
    tick(10_000);
    e.percentile = (q) => (q <= 50 ? 15.6 : 215.6);
    Object.defineProperty(e, "max", { value: 400 });
    tick(10_000);
    const r = p.report();
    expect(r.eld.excessP95).toBeGreaterThan(150);
    expect(r.eld.excessMax).toBeGreaterThan(350);
  });
  it("memory keeps the last 60 samples", () => {
    const { p } = make();
    p.setEnabled(true);
    for (let i = 0; i < 70; i++) tick(10_000);
    expect(p.report().memory).toHaveLength(60);
  });
});

describe("spans", () => {
  it("span nesting: children carry the parent id", () => {
    const { p } = make();
    p.setEnabled(true);
    const top = p.span("side.start");
    const a = p.span("side.install", top);
    clock += 150;
    a.end();
    const b = p.span("side.spawn", top);
    clock += 200;
    b.end();
    top.end();
    const r = p.report();
    expect(Object.keys(r.spans).sort()).toEqual(["side.install", "side.spawn", "side.start"]);
    const kids = r.worst.filter((w) => w.kind === "span" && w.parent === top.id);
    expect(kids.map((k) => (k.kind === "span" ? k.name : ""))).toEqual(["side.spawn", "side.install"]);
  });
  it("a block during a span is a stall linked to it", () => {
    const { p } = make();
    p.setEnabled(true);
    const s = p.span("session.open");
    tick(300);
    const stall = p.report().worst.find((w) => w.kind === "stall");
    expect(stall).toMatchObject({ kind: "stall", spans: [{ name: "session.open", id: s.id }] });
    expect(stall && stall.kind === "stall" && stall.ms).toBeGreaterThanOrEqual(250);
    s.end();
  });
  it("a block that ends together with the span is still a stall", () => {
    const { p } = make();
    p.setEnabled(true);
    const s = p.span("session.open");
    clock += 300; // synchronous work: the watchdog timer never ran
    s.end();
    expect(p.report().worst.some((w) => w.kind === "stall" && w.spans[0]?.name === "session.open")).toBe(true);
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

describe("requests and processes", () => {
  it("git process recorded with subcommand, duration and request", () => {
    const { p } = make();
    p.setEnabled(true);
    const end = p.request("git.log", "/x");
    const done = p.child({ cmd: "git", args: ["-c", "core.fsmonitor=false", "log", "--oneline"], cwd: "/x", thread: "worker" });
    clock += 40;
    done(0);
    end();
    const r = p.report();
    expect(r.children["git log"]?.n).toBe(1);
    expect(r.handlers["git.log"]?.n).toBe(1);
    clock += 0;
    const e2 = p.request("git.status", "/x");
    const slow = p.child({ cmd: "git", args: ["status"], cwd: "/x", thread: "worker" });
    clock += 250;
    slow(0);
    e2();
    const w = p.report().worst.find((x) => x.kind === "child");
    expect(w).toMatchObject({ cmd: "git", sub: "status", thread: "worker", request: "git.status", exit: 0 });
  });
  it("a process is attributed to the in-flight request with the same cwd, else the newest, else background", () => {
    const { p } = make();
    p.setEnabled(true);
    const e1 = p.request("git.log", "/a");
    const e2 = p.request("session.subscribe");
    const d1 = p.child({ cmd: "git", args: ["log"], cwd: "/a", thread: "worker" });
    const d2 = p.child({ cmd: "git", args: ["diff"], thread: "main" });
    clock += 300;
    d1(0);
    d2(0);
    e1();
    e2();
    const d3 = p.child({ cmd: "git", args: ["show"], thread: "main" });
    clock += 300;
    d3(0);
    const by = Object.fromEntries(p.report().worst.filter((w) => w.kind === "child").map((w) => [w.sub, w.kind === "child" ? w.request : ""]));
    expect(by).toEqual({ log: "git.log", diff: "session.subscribe", show: "background" });
  });
  it("sync child counts its time as held", () => {
    const { p } = make();
    p.setEnabled(true);
    const v = p.syncChild("git", ["ls-files"], () => ((clock += 30), 7));
    expect(v).toBe(7);
    expect(() => p.syncChild("git", ["status"], () => { throw new Error("x"); })).toThrow("x");
    expect(p.report().children["git ls-files"]?.n).toBe(1);
    expect(p.report().worst.find((w) => w.kind === "child" && w.sub === "ls-files")).toMatchObject({ heldMs: 30 });
  });
  it("unknown request type is 'other'", () => {
    const { p } = make();
    p.setEnabled(true);
    p.request("<script>")();
    expect(p.report().handlers.other?.n).toBe(1);
    expect(Object.keys(p.report().handlers)).toEqual(["other"]);
  });
  it("gitSub allowlist and cmdLabel", () => {
    expect(gitSub(["-c", "a=b", "worktree", "list"])).toBe("worktree");
    expect(gitSub(["--no-pager", "log"])).toBe("log");
    expect(gitSub(["frobnicate"])).toBe("other");
    expect(gitSub([])).toBe("other");
    expect(cmdLabel("C:\\x\\git.exe")).toBe("git");
    expect(cmdLabel("/usr/bin/node")).toBe("node");
    expect(cmdLabel("/home/u/secret-tool")).toBe("other");
  });
  it("KNOWN_TYPES holds every client message type of the wire", () => {
    const wire = readFileSync(new URL("../../protocol/src/wire.ts", import.meta.url), "utf8");
    const block = wire.slice(wire.indexOf("export type ClientMessage"), wire.indexOf("export type ServerMessage"));
    const types = [...block.matchAll(/\{ type: "([a-zA-Z_.]+)"/g)].map((m) => m[1]!);
    expect(types.length).toBeGreaterThan(50);
    expect(types.filter((t) => !KNOWN_TYPES.has(t)), "add the new message type to KNOWN_TYPES in perf.ts").toEqual([]);
  });
});

describe("real child process", () => {
  it("channel records a real main-thread spawn", async () => {
    vi.useRealTimers();
    const p = createPerf({});
    perfs.push(p);
    p.setEnabled(true);
    await new Promise<void>((ok) => execFile(process.execPath, ["-e", "0"], () => ok()));
    await new Promise((r) => setTimeout(r, 20));
    const r = p.report();
    expect(r.children.node?.n).toBe(1);
    p.setEnabled(false);
    await new Promise<void>((ok) => execFile(process.execPath, ["-e", "0"], () => ok()));
    expect(p.report().children.node?.n).toBe(1);
  });
});

describe("off", () => {
  it("off stops sampling, timers, the channel and the handles", () => {
    const { p, eld } = make();
    p.setEnabled(true);
    p.span("session.open");
    p.setEnabled(false);
    expect(eld.disable).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    p.request("git.log")();
    p.child({ cmd: "git", args: ["log"], thread: "worker" })(0);
    const s = p.span("session.open");
    s.end();
    const r = p.report();
    expect(r.monitor).toBe(false);
    expect(r.handlers).toEqual({});
    expect(r.children).toEqual({});
    expect(r.spans).toEqual({});
  });
  it("setEnabled is idempotent and on again restarts sampling", () => {
    const { p, eld } = make();
    p.setEnabled(true);
    p.setEnabled(true);
    expect(eld.enable).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    p.setEnabled(false);
    p.setEnabled(true);
    expect(eld.enable).toHaveBeenCalledTimes(2);
  });
  it("the tick follows the settings: off there stops the monitor", () => {
    let on = true;
    const { p } = make({ poll: () => on });
    p.setEnabled(true);
    on = false;
    tick(10_000);
    expect(p.report().monitor).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clear empties the store", () => {
    const { p } = make();
    p.setEnabled(true);
    p.request("git.log")();
    tick(10_000);
    p.clear();
    const r = p.report();
    expect(r.handlers).toEqual({});
    expect(r.memory).toEqual([]);
    expect(r.worst).toEqual([]);
    expect(r.cost.ownMs).toBe(0);
  });
});

describe("privacy and cost", () => {
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
    sp.end();
    end();
    const json = JSON.stringify(p.report());
    expect(json).not.toContain("secret");
    expect(json).not.toContain("/home/");
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(json).toContain("session.prompt");
  });
  it("own cost under 1 ms per 10 s idle", () => {
    let calls = 0;
    const { p } = make({ now: () => (calls++, clock + calls * 0.01) });
    p.setEnabled(true);
    for (let i = 0; i < 6; i++) tick(10_000);
    const r = p.report();
    expect(r.cost.ownMs / 6).toBeLessThan(1);
    expect(r.cost.ownMs).toBeGreaterThan(0);
  });
});
