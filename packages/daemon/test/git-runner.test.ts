import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { gitRunnerConfig, runGit } from "../src/git-runner.ts";
import type { GitRunOptions } from "../src/git-runner.ts";
import { slowKill } from "./slow-kill.ts";

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gr-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@x.test", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
};
const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

describe("git-runner", () => {
  afterEach(() => gitRunnerConfig.reset());

  it("runs another program when file is set, in the thread and in the child-process fallback", async () => {
    const dir = repo();
    const o = { cwd: dir, file: process.execPath, args: ["-e", "process.stdout.write('ok')"], env: env() };
    expect((await runGit(o)).stdout.toString()).toBe("ok");
    expect(gitRunnerConfig.started).toBe(true);
    gitRunnerConfig.reset();
    const script = gitRunnerConfig.script;
    gitRunnerConfig.script = "throw new Error('x')";
    try {
      await runGit(o).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      expect(gitRunnerConfig.broken).toBe(true);
      expect((await runGit(o)).stdout.toString()).toBe("ok");
    } finally {
      gitRunnerConfig.script = script;
    }
  });

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

  describe("signal", () => {
    const sleeper = (signal: AbortSignal) => ({ cwd: tmpdir(), file: process.execPath, args: ["-e", "setTimeout(()=>{}, 10000)"], env: env(), killTree: true, signal });
    const abortLater = async (name: string) => {
      const ctl = new AbortController();
      const t0 = Date.now();
      const p = runGit(sleeper(ctl.signal)).then(() => undefined, (e) => e as Error);
      setTimeout(() => ctl.abort(), 300);
      expect(await p, name).toBeInstanceOf(Error);
      // The point: the abort ends the run, which sleeps 10 s. On Windows the kill is a taskkill process (2.4-2.9 s measured alone, 3.2 s in a full suite); elsewhere the kill is a signal and 3 s stays.
      expect(Date.now() - t0).toBeLessThan(process.platform === "win32" ? 8000 : 3000);
    };

    it("kills a killTree run in the thread runner", () => abortLater("thread"));

    it("kills a killTree run in the child-process fallback", async () => {
      const script = gitRunnerConfig.script;
      gitRunnerConfig.script = "throw new Error('x')";
      try {
        await runGit({ cwd: tmpdir(), args: ["--version"], env: env() }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 200));
        expect(gitRunnerConfig.broken).toBe(true);
        await abortLater("direct");
      } finally {
        gitRunnerConfig.script = script;
      }
    });

    it("rejects an already aborted signal without starting", async () => {
      const t0 = Date.now();
      await expect(runGit(sleeper(AbortSignal.abort()))).rejects.toMatchObject({ code: "ABORT_ERR" });
      expect(Date.now() - t0).toBeLessThan(500);
    });
  });

  // On Windows the tree kill is a taskkill process of 0.5-5 s (more under load): a search past its deadline waited for it (GH-685).
  describe("a slow tree kill", () => {
    const sleeper = (o: Partial<GitRunOptions> = {}): GitRunOptions => ({ cwd: tmpdir(), file: process.execPath, args: ["-e", "setTimeout(()=>{}, 30000)"], env: env(), killTree: true, timeout: 100, ...o });
    const withSlowKill = async (fn: (k: ReturnType<typeof slowKill>) => Promise<void>) => {
      const k = slowKill();
      gitRunnerConfig.killCommand = k.command;
      try {
        await fn(k);
      } finally {
        await k.finish();
        gitRunnerConfig.killCommand = undefined;
      }
    };
    const direct = async (fn: () => Promise<void>) => {
      const script = gitRunnerConfig.script;
      gitRunnerConfig.script = "throw new Error('x')";
      try {
        await runGit({ cwd: tmpdir(), args: ["--version"], env: env() }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 200));
        expect(gitRunnerConfig.broken).toBe(true);
        await fn();
      } finally {
        gitRunnerConfig.script = script;
      }
    };
    const cases = (name: string, wrap: (fn: () => Promise<void>) => Promise<void>) => {
      it(`${name}: a read past its timeout settles when the kill starts, before the kill ran`, () =>
        wrap(() =>
          withSlowKill(async (k) => {
            const e = await runGit(sleeper({ idempotent: true })).then(() => undefined, (x: Error) => x);
            expect(e).toMatchObject({ killed: true });
            expect(k.killed()).toBe(false);
          }),
        ));
      it(`${name}: an aborted read settles at the abort, before the kill ran`, () =>
        wrap(() =>
          withSlowKill(async (k) => {
            const ctl = new AbortController();
            const p = runGit(sleeper({ idempotent: true, timeout: 30_000, signal: ctl.signal })).then(() => undefined, (x: Error) => x);
            setTimeout(() => ctl.abort(), 300);
            expect(await p).toMatchObject({ code: "ABORT_ERR" });
            expect(k.killed()).toBe(false);
          }),
        ));
      it(`${name}: a call that is not a read settles only after its group was killed`, () =>
        wrap(() =>
          withSlowKill(async (k) => {
            setTimeout(k.release, 500);
            const e = await runGit(sleeper()).then(() => undefined, (x: Error) => x);
            expect(e).toMatchObject({ killed: true });
            expect(k.killed()).toBe(true);
          }),
        ));
    };
    cases("thread", (fn) => fn());
    cases("child-process fallback", direct);

    it("the git thread answers other calls while a kill runs", () =>
      withSlowKill(async (k) => {
        const p = runGit(sleeper()).then(() => undefined, (x: Error) => x);
        await new Promise((r) => setTimeout(r, 300));
        await runGit({ cwd: tmpdir(), file: process.execPath, args: ["-e", ""], env: env() });
        expect(k.killed()).toBe(false);
        k.release();
        expect(await p).toMatchObject({ killed: true });
      }));
  });
});
