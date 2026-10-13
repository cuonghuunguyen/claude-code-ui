// The one place git processes of `git.ts` start (docs/spec.md "Layout", Graph tab): in a worker thread, so the spawn cost
// does not land on the main event loop. `setGitRunner` swaps the runner (tests; `wsl-git.ts` routes WSL projects).
import { execFile } from "node:child_process";
import { Worker } from "node:worker_threads";
import { perf } from "./perf.ts";

export type GitRunOptions = { cwd: string; args: string[]; env: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number; input?: string; file?: string };
export type GitRunOutput = { stdout: Buffer; stderr: string };
/** Rejection: Error & { stderr: string; stdout: Buffer; killed: boolean; code?: string | number; signal?: string } */
export type GitRunner = (o: GitRunOptions) => Promise<GitRunOutput>;

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BUFFER = 64 << 20;

const GIT_RUN_THREAD = `
const { parentPort } = require("node:worker_threads");
const { execFile } = require("node:child_process");
parentPort.on("message", ({ id, file, cwd, args, env, timeout, maxBuffer, input }) => {
  try {
  const child = execFile(file || "git", args, { cwd, env, timeout, maxBuffer, encoding: "buffer", windowsHide: true }, (err, stdout, stderr) => {
    const out = Buffer.from(stdout ?? []);
    const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    parentPort.postMessage({ id, stdout: ab, stderr: String(stderr ?? ""), error: err ? { message: err.message, code: err.code, killed: !!err.killed, signal: err.signal } : undefined }, [ab]);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  } catch (e) {
    parentPort.postMessage({ id, stdout: new ArrayBuffer(0), stderr: "", error: { message: String((e && e.message) || e), killed: false } });
  }
});`;

let thread: Worker | undefined;
let threadBroken = false;
let started = false;
let nextCall = 0;
type Call = { ok: (o: GitRunOutput) => void; fail: (e: Error) => void; timer: NodeJS.Timeout; w: Worker };
const calls = new Map<number, Call>();

/** Test seam: the thread's script. `reset()` drops the thread and the broken mark. */
export const gitRunnerConfig = {
  script: GIT_RUN_THREAD,
  reset() {
    const w = thread;
    thread = undefined;
    threadBroken = false;
    started = false;
    if (w) void w.terminate();
  },
  get broken() {
    return threadBroken;
  },
  get started() {
    return started;
  },
};

function failCalls(w: Worker, why: string) {
  for (const [id, c] of calls)
    if (c.w === w) {
      calls.delete(id);
      clearTimeout(c.timer);
      c.fail(new Error(why));
    }
}

function runThread(): Worker | undefined {
  if (thread || threadBroken) return thread;
  try {
    const w = new Worker(gitRunnerConfig.script, { eval: true });
    w.on("message", ({ id, stdout, stderr, error }: { id: number; stdout: ArrayBuffer; stderr: string; error?: { message: string; code?: string | number; killed: boolean; signal?: string } }) => {
      const c = calls.get(id);
      if (!c) return;
      calls.delete(id);
      clearTimeout(c.timer);
      const out = Buffer.from(stdout);
      if (!error) c.ok({ stdout: out, stderr });
      else c.fail(Object.assign(new Error(error.message), { stderr, stdout: out, killed: error.killed, code: error.code, signal: error.signal }));
    });
    w.on("error", (e) => {
      console.warn(`git-runner: git thread failed, using child processes from now on: ${String(e)}`);
      if (thread === w) {
        thread = undefined;
        threadBroken = true;
      }
      failCalls(w, `git thread failed: ${String(e)}`);
    });
    w.on("exit", (code) => {
      if (thread === w) thread = undefined;
      failCalls(w, `git thread exited (${code})`);
    });
    // After the listeners: a listener added later refs the port again, and the thread would keep the daemon from exiting.
    w.unref();
    thread = w;
    started = true;
  } catch (e) {
    console.warn(`git-runner: git thread did not start, using child processes: ${String(e)}`);
    threadBroken = true;
  }
  return thread;
}

const direct: GitRunner = (o) =>
  new Promise((ok, fail) => {
    const child = execFile(o.file ?? "git", o.args, { cwd: o.cwd, env: o.env, timeout: o.timeout ?? DEFAULT_TIMEOUT, maxBuffer: o.maxBuffer ?? DEFAULT_MAX_BUFFER, encoding: "buffer", windowsHide: true }, (err, stdout, stderr) => {
      const out = Buffer.from(stdout ?? []);
      if (!err) return ok({ stdout: out, stderr: String(stderr ?? "") });
      const e = err as Error & { code?: string | number; killed?: boolean; signal?: string };
      fail(Object.assign(new Error(e.message), { stderr: String(stderr ?? ""), stdout: out, killed: !!e.killed, code: e.code, signal: e.signal }));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.input ?? "");
  });

/** Git in a worker thread; a thread that cannot start falls back to child processes of this thread. */
export const threadRunner: GitRunner = (o) =>
  new Promise((ok, fail) => {
    const w = runThread();
    if (!w) return void direct(o).then(ok, fail);
    const id = ++nextCall;
    const timer = setTimeout(() => {
      console.warn("git-runner: git thread did not answer in time; starting a new one");
      if (thread === w) thread = undefined;
      failCalls(w, "git timed out");
      void w.terminate();
    }, (o.timeout ?? DEFAULT_TIMEOUT) + 10_000);
    timer.unref();
    // The thread runs git: the diagnostics channel does not see it, so the call is timed here (thread time, not main-loop time).
    const done = perf.child({ cmd: "git", args: o.args, cwd: o.cwd, thread: "worker" });
    calls.set(id, { ok: (r) => (done(0), ok(r)), fail: (e) => (done("error"), fail(e)), timer, w });
    w.postMessage({ id, file: o.file, cwd: o.cwd, args: o.args, env: o.env, timeout: o.timeout ?? DEFAULT_TIMEOUT, maxBuffer: o.maxBuffer ?? DEFAULT_MAX_BUFFER, input: o.input });
  });

let runner: GitRunner = threadRunner;
export const runGit: GitRunner = (o) => runner(o);
/** `undefined` restores the thread runner. */
export function setGitRunner(r: GitRunner | undefined): void {
  runner = r ?? threadRunner;
}
