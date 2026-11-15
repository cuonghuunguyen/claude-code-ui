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

beforeEach(() => {
  clock = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  perfs.forEach((p) => p.close());
  perfs = [];
  vi.useRealTimers();
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
