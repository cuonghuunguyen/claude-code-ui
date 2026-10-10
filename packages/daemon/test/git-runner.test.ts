import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { gitRunnerConfig, runGit } from "../src/git-runner.ts";

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gr-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x.test", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
};
const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

describe("git-runner", () => {
  afterEach(() => gitRunnerConfig.reset());

  it("runs git in a worker thread: stdout bytes, stdin input, exit code and stderr on failure", async () => {
    const dir = repo();
    gitRunnerConfig.reset();
    const v = await runGit({ cwd: dir, args: ["--version"], env: env() });
    expect(v.stdout.toString()).toMatch(/^git version/);
    expect(gitRunnerConfig.started).toBe(true);
    expect(gitRunnerConfig.broken).toBe(false);
    const b = await runGit({ cwd: dir, args: ["cat-file", "--batch"], env: env(), input: "HEAD\n" });
    expect(b.stdout.toString()).toMatch(/^[0-9a-f]{40} commit \d+\n/);
    await expect(runGit({ cwd: dir, args: ["no-such-cmd"], env: env() })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/\S/) });
  });

  it("rejects with the partial stdout when maxBuffer is exceeded", async () => {
    const dir = repo();
    const e = await runGit({ cwd: dir, args: ["cat-file", "--batch"], env: env(), input: "HEAD\n", maxBuffer: 50 }).then(
      () => undefined,
      (x) => x as { code: string; stdout: Buffer },
    );
    expect(e?.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(e?.stdout.length).toBe(50);
    expect(e?.stdout.toString().split("\n")[0]).toMatch(/^[0-9a-f]{40} commit \d+$/);
  });

  it("git exiting before reading stdin does not break the thread", async () => {
    const dir = repo();
    await runGit({ cwd: dir, args: ["--version"], env: env(), input: "x".repeat(1 << 20) }).catch(() => {});
    const v = await runGit({ cwd: dir, args: ["--version"], env: env() });
    expect(v.stdout.toString()).toMatch(/^git version/);
    expect(gitRunnerConfig.broken).toBe(false);
  });

  it("a thread that cannot start falls back to child processes", async () => {
    const dir = repo();
    const script = gitRunnerConfig.script;
    gitRunnerConfig.script = "throw new Error('x')";
    gitRunnerConfig.reset();
    try {
      const v = await runGit({ cwd: dir, args: ["--version"], env: env() }).catch(() => undefined);
      // The broken mark is set when the thread fails to start (async 'error' event) or at once; a later call is served by a child process.
      await new Promise((r) => setTimeout(r, 200));
      const v2 = await runGit({ cwd: dir, args: ["--version"], env: env() });
      expect(v2.stdout.toString()).toMatch(/^git version/);
      expect(gitRunnerConfig.broken).toBe(true);
      void v;
    } finally {
      gitRunnerConfig.script = script;
      gitRunnerConfig.reset();
    }
  });

  it.skipIf(process.platform === "win32")("uses PATH of each call's env", async () => {
    const dir = repo();
    const bin = mkdtempSync(join(tmpdir(), "grbin-"));
    writeFileSync(join(bin, "git"), "#!/bin/sh\necho wrapped\n");
    chmodSync(join(bin, "git"), 0o755);
    const r = await runGit({ cwd: dir, args: ["--version"], env: { ...env(), PATH: `${bin}:${process.env.PATH}` } });
    expect(r.stdout.toString().trim()).toBe("wrapped");
  });

  it("40 parallel git calls keep the main event loop delay under 50 ms", async () => {
    const dir = repo();
    await runGit({ cwd: dir, args: ["--version"], env: env() });
    const h = monitorEventLoopDelay({ resolution: 5 });
    h.enable();
    await Promise.all(Array.from({ length: 40 }, () => runGit({ cwd: dir, args: ["rev-parse", "HEAD"], env: env() })));
    h.disable();
    expect(h.max / 1e6).toBeLessThan(50);
  });
});
