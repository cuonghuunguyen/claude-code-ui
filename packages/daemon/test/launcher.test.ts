import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { launch, newest } from "../src/launcher.ts";
import { FAILED_MARK, versionCli } from "../src/update.ts";

const install = (dir: string, v: string) => {
  mkdirSync(join(dir, v, "node_modules", "claude-code-ui", "dist"), { recursive: true });
  writeFileSync(versionCli(dir, v), "");
};
const own = { cli: "/own/dist/cli.js", version: "0.2.0" };

/** Fake daemon children that exit with the next code of `codes` (a code or a signal). */
function fakeSpawn(codes: (number | NodeJS.Signals)[], onSpawn?: () => void) {
  const runs: { cli: string; args: string[]; killed?: string }[] = [];
  const spawn = (cli: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { kill: (s: string) => ((run.killed = s), child.emit("exit", null, s)) });
    const run: (typeof runs)[number] = { cli, args };
    runs.push(run);
    const next = codes.shift();
    onSpawn?.();
    if (next !== undefined) setImmediate(() => (typeof next === "number" ? child.emit("exit", next, null) : child.emit("exit", null, next)));
    return child as unknown as ChildProcess;
  };
  return { spawn, runs };
}

describe("launcher", () => {
  it("runs the newest of the own package and the versions dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-launch-"));
    expect(newest(own, dir)).toEqual({ cli: own.cli });
    install(dir, "0.1.9");
    expect(newest(own, dir)).toEqual({ cli: own.cli });
    install(dir, "0.2.1");
    expect(newest(own, dir)).toEqual({ cli: versionCli(dir, "0.2.1"), version: "0.2.1" });
    expect(newest({ ...own, version: "0.3.0" }, dir)).toEqual({ cli: own.cli });
  });

  it("exit 75 starts the newest version again with the same arguments; another code ends the launcher with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-launch-"));
    const signals = new EventEmitter();
    let n = 0;
    const { spawn, runs } = fakeSpawn([75, 0], () => n++ === 0 && install(dir, "0.2.1"));
    expect(await launch({ args: ["--port", "5000"], own, dir, spawn, signals: signals as never })).toBe(0);
    expect(runs.map((r) => r.cli)).toEqual([own.cli, versionCli(dir, "0.2.1")]);
    expect(runs[1]!.args).toEqual(["--port", "5000"]);
    expect(await launch({ args: [], own, dir: mkdtempSync(join(tmpdir(), "cu-launch-")), spawn: fakeSpawn([1]).spawn, signals: signals as never })).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("a version that fails at start is marked and the previous one runs; a newer one is tried again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-launch-"));
    install(dir, "0.2.1");
    install(dir, "0.2.2");
    const signals = new EventEmitter();
    const log: string[] = [];
    const { spawn, runs } = fakeSpawn([1, 1, 0]);
    expect(await launch({ args: [], own, dir, spawn, signals: signals as never, log: (l) => log.push(l) })).toBe(0);
    expect(runs.map((r) => r.cli)).toEqual([versionCli(dir, "0.2.2"), versionCli(dir, "0.2.1"), own.cli]);
    expect(log[0]).toContain("0.2.2 failed to start (exit 1)");
    expect(newest(own, dir)).toEqual({ cli: own.cli });
    install(dir, "0.2.3");
    expect(newest(own, dir).version).toBe("0.2.3");
  });

  it("a version ending with 129, 130 or 143 (a signal it handled, or its parent gone) within 10 s is not marked failed; a native crash code is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-launch-"));
    install(dir, "0.2.1");
    const { spawn, runs } = fakeSpawn([143]);
    expect(await launch({ args: [], own, dir, spawn, signals: new EventEmitter() as never, log: () => {} })).toBe(143);
    expect(runs).toHaveLength(1);
    expect(existsSync(join(dir, "0.2.1", FAILED_MARK))).toBe(false);
    const crash = fakeSpawn([3221225477, 0]);
    await launch({ args: [], own, dir, spawn: crash.spawn, signals: new EventEmitter() as never, log: () => {} });
    expect(existsSync(join(dir, "0.2.1", FAILED_MARK))).toBe(true);
  });

  it("when the previous version fails at start too (e.g. port in use), the marks go and the launcher exits with the code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-launch-"));
    install(dir, "0.2.1");
    const signals = new EventEmitter();
    const { spawn, runs } = fakeSpawn([1, 1]);
    expect(await launch({ args: [], own, dir, spawn, signals: signals as never, log: () => {} })).toBe(1);
    expect(runs.map((r) => r.cli)).toEqual([versionCli(dir, "0.2.1"), own.cli]);
    expect(existsSync(join(dir, "0.2.1", FAILED_MARK))).toBe(false);
    expect(newest(own, dir).version).toBe("0.2.1");
  });

  it("Ctrl+C stops the daemon and the launcher, also when the daemon then exits 75", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-launch-"));
    const signals = new EventEmitter();
    const { spawn, runs } = fakeSpawn([]);
    const done = launch({ args: [], own, dir, spawn, signals: signals as never });
    signals.emit("SIGINT", "SIGINT");
    expect(await done).toBe(130);
    // SIGTERM: 128 + 15, as a shell reports it.
    const s3 = new EventEmitter();
    const t = launch({ args: [], own, dir, spawn: fakeSpawn([]).spawn, signals: s3 as never });
    s3.emit("SIGTERM", "SIGTERM");
    expect(await t).toBe(143);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.killed).toBe("SIGINT");

    const s2 = new EventEmitter();
    const f = fakeSpawn([]);
    const p = launch({ args: [], own, dir, spawn: (cli, args) => {
      const c = f.spawn(cli, args);
      (c as unknown as { kill: (s: string) => void }).kill = () => c.emit("exit", 75, null);
      return c;
    }, signals: s2 as never });
    s2.emit("SIGTERM", "SIGTERM");
    expect(await p).toBe(75);
    expect(f.runs).toHaveLength(1);
  });
});
