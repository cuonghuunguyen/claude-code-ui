import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { cliCandidates, installHint, readServe, readStatus, startServe, tailscalePreflight, type Exec } from "../src/tailscale.ts";

const running = { BackendState: "Running", Self: { DNSName: "m.tn.ts.net." }, CertDomains: ["m.tn.ts.net"] };
const winServe = { TCP: { "443": { HTTPS: true } }, Web: { "m.tn.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4280" } } } } };

describe("cliCandidates / installHint", () => {
  it("per platform", () => {
    expect(cliCandidates("linux", {})).toEqual(["tailscale"]);
    expect(cliCandidates("darwin", {})).toEqual(["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
    expect(cliCandidates("win32", { ProgramFiles: "D:\\PF" })).toEqual(["D:\\PF\\Tailscale\\tailscale.exe", "tailscale"]);
  });
  it("install text", () => {
    expect(installHint("linux", {})).toContain("install.sh");
    expect(installHint("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toMatch(/WSL distro[\s\S]*Windows/);
    expect(installHint("darwin", {})).toContain("download/mac");
    expect(installHint("win32", {})).toContain("download/windows");
  });
});

describe("readStatus", () => {
  it("running: hostname without trailing dot", () => expect(readStatus(running)).toEqual({ hostname: "m.tn.ts.net" }));
  it("not running states name the next step", () => {
    expect(readStatus({ BackendState: "Stopped" })).toEqual({ error: expect.stringContaining("tailscale up") });
    expect(readStatus({ BackendState: "NeedsLogin" })).toEqual({ error: expect.stringContaining("tailscale up") });
    expect(readStatus({ BackendState: "NeedsMachineAuth" })).toEqual({ error: expect.stringContaining("admin console") });
  });
  it("no CertDomains", () => expect(readStatus({ ...running, CertDomains: null })).toEqual({ error: expect.stringContaining("login.tailscale.com/admin/dns") }));
});

describe("readServe", () => {
  it("free / ours / other", () => {
    expect(readServe({}, "m.tn.ts.net", 4280)).toBe("free");
    expect(readServe(winServe, "m.tn.ts.net", 4280)).toBe("ours");
    expect(readServe(winServe, "m.tn.ts.net", 5000)).toEqual({ error: expect.stringContaining("already serves something else") });
    const lh = { Web: { "m.tn.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:4280" } } } } };
    expect(readServe(lh, "m.tn.ts.net", 4280)).toBe("ours");
  });
  it("funnel is refused, also when ours", () => {
    expect(readServe({ ...winServe, AllowFunnel: { "m.tn.ts.net:443": true } }, "m.tn.ts.net", 4280)).toEqual({ error: expect.stringContaining("Funnel is on") });
  });
});

const ok = (stdout: string) => Promise.resolve({ stdout });
describe("readServe Foreground", () => {
  const fgWeb = { Foreground: { abc: { TCP: { "443": { HTTPS: true } }, Web: { "m.tn.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4280" } } } } } } };
  it("foreground funnel is refused", () => {
    expect(readServe({ Foreground: { abc: { AllowFunnel: { "m.tn.ts.net:443": true } } } }, "m.tn.ts.net", 4280)).toEqual({ error: expect.stringContaining("Funnel is on") });
  });
  it("foreground serve on 443 is refused, also for our port", () => {
    expect(readServe(fgWeb, "m.tn.ts.net", 4280)).toEqual({ error: expect.stringContaining("foreground") });
    expect(readServe(fgWeb, "m.tn.ts.net", 5000)).toEqual({ error: expect.stringContaining("foreground") });
  });
  it("empty Foreground is free", () => expect(readServe({ Foreground: {} }, "m.tn.ts.net", 4280)).toBe("free"));
});

describe("tailscalePreflight", () => {
  const base = { port: 4280, platform: "darwin" as const, env: {} };
  it("falls through ENOENT to the app path", async () => {
    const exec: Exec = (f, a) => (f === "tailscale" ? Promise.reject({ code: "ENOENT" }) : ok(a[0] === "status" ? JSON.stringify(running) : "{}"));
    expect(await tailscalePreflight({ ...base, exec })).toEqual({ cli: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", hostname: "m.tn.ts.net", serve: true });
  });
  it("all ENOENT: install hint", async () => {
    expect(await tailscalePreflight({ ...base, exec: () => Promise.reject({ code: "ENOENT" }) })).toEqual({ error: installHint("darwin", {}) });
  });
  it("status fails: stderr and start hint", async () => {
    const r = await tailscalePreflight({ ...base, platform: "linux", exec: () => Promise.reject({ stderr: "failed to connect to local tailscaled" }) });
    expect(r).toEqual({ error: expect.stringMatching(/failed to connect to local tailscaled[\s\S]*systemctl start tailscaled/) });
  });
  it("serve status fails", async () => {
    const exec: Exec = (_f, a) => (a[0] === "status" ? ok(JSON.stringify(running)) : Promise.reject({ stderr: "access denied" }));
    expect(await tailscalePreflight({ ...base, platform: "linux", exec })).toEqual({ error: expect.stringContaining("serve status failed: access denied") });
  });
  it("invalid status JSON", async () => {
    expect(await tailscalePreflight({ ...base, platform: "linux", exec: () => ok("not json") })).toEqual({ error: expect.stringContaining("could not read") });
  });
  it("ours: serve false", async () => {
    const exec: Exec = (_f, a) => ok(JSON.stringify(a[0] === "status" ? running : winServe));
    expect(await tailscalePreflight({ ...base, platform: "linux", exec })).toEqual({ cli: "tailscale", hostname: "m.tn.ts.net", serve: false });
  });
});

describe("startServe", () => {
  function fake() {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; } });
    const calls: unknown[][] = [];
    const spawn = ((...a: unknown[]) => (calls.push(a), child)) as never;
    return { child, calls, spawn };
  }
  const tick = () => new Promise((r) => setTimeout(r, 10));
  it("spawns serve, prefixes lines, explains an exit", async () => {
    const { child, calls, spawn } = fake();
    const logs: string[] = [];
    startServe({ cli: "tailscale", port: 4280, spawn, log: (l) => logs.push(l), platform: "linux" });
    expect(calls[0]![1]).toEqual(["serve", "--https=443", "http://127.0.0.1:4280"]);
    expect((calls[0]![2] as { env: Record<string, string> }).env.TAILSCALE_BE_CLI).toBe("1");
    child.stdout.write("Available within your tailnet\n");
    child.stderr.write("access denied\n");
    await tick();
    child.emit("exit", 1);
    expect(logs[0]).toBe("tailscale serve: Available within your tailnet");
    expect(logs.at(-1)).toMatch(/code 1[\s\S]*access denied[\s\S]*--operator=\$USER/);
  });
  it("a spawn error is logged", () => {
    const { child, spawn } = fake();
    const logs: string[] = [];
    startServe({ cli: "tailscale", port: 1, spawn, log: (l) => logs.push(l), platform: "linux" });
    child.emit("error", new Error("EACCES"));
    expect(logs[0]).toContain("failed to start: EACCES");
  });
  it("stop kills; the later exit is not logged", async () => {
    const { child, spawn } = fake();
    const logs: string[] = [];
    startServe({ cli: "tailscale", port: 1, spawn, log: (l) => logs.push(l), platform: "linux" }).stop();
    child.emit("exit", null);
    expect(child.killed).toBe(true);
    expect(logs).toEqual([]);
  });
});
