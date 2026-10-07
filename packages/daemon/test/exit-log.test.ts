import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "exit-log-"));
const src = (f: string) => new URL(`../src/${f}`, import.meta.url).pathname;
const run = (body: string) => {
  const f = join(dir, `${Math.random()}.ts`);
  writeFileSync(f, `import { logExit } from ${JSON.stringify(src("exit-log.ts"))};\nlogExit(process, console.error);\n${body}`);
  return spawnSync(process.execPath, [f], { encoding: "utf8" });
};

describe("logExit", () => {
  it("logs an uncaught exception with its stack, then exits 1", () => {
    const r = run('setTimeout(() => { throw new Error("boom"); }, 1);');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uncaughtException: Error: boom\n\s+at /);
    expect(r.stderr).toContain("exit, code 1");
  });
  it("logs an unhandled rejection, then exits 1 as Node does", () => {
    const r = run('Promise.reject(new Error("nope"));');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unhandledRejection: Error: nope/);
  });
  it("logs a normal exit code", () => {
    const r = run("process.exitCode = 3;");
    expect(r.stderr).toContain("exit, code 3");
  });
});

describe("exitOnSignal", () => {
  it.each([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const)("%s runs cleanup, logs the exit line and exits %i", async (sig, code) => {
    const f = join(dir, `${Math.random()}.ts`);
    writeFileSync(f, `import { exitOnSignal, logExit } from ${JSON.stringify(src("exit-log.ts"))};\nlogExit(process, console.error);\nexitOnSignal(process, () => console.error("cleanup"));\nsetInterval(() => {}, 1000);\nconsole.error("ready");`);
    const child = spawn(process.execPath, [f], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => ((err += d), err.includes("ready") && !child.killed && child.kill(sig)));
    const status = await new Promise((r) => child.on("exit", r));
    expect(status).toBe(code);
    expect(err).toMatch(new RegExp(`cleanup\\n.*exit, code ${code}`));
  });
});

describe("runCli stdin", () => {
  it("a child that exits before reading a large stdin rejects/resolves, not crashes", async () => {
    const old = process.env.CLAUDE_UI_CLAUDE_BIN;
    process.env.CLAUDE_UI_CLAUDE_BIN = execFileSync("which", ["true"], { encoding: "utf8" }).trim();
    try {
      const r = await runCli([], dir, "x".repeat(1 << 22));
      expect(r.code).toBe(0);
    } finally {
      if (old === undefined) delete process.env.CLAUDE_UI_CLAUDE_BIN;
      else process.env.CLAUDE_UI_CLAUDE_BIN = old;
    }
  });
});
