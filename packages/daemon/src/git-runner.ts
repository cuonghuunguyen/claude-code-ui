// The one place git processes of `git.ts` start (docs/spec.md "Layout", Graph tab): in a worker thread, so the spawn cost
// does not land on the main event loop. `setGitRunner` swaps the runner (tests; `wsl-git.ts` routes WSL projects).
import { execFile, spawn, spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { perf } from "./perf.ts";

export type GitRunOptions = { cwd: string; args: string[]; env: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number; input?: string; file?: string; /** May run twice: the call only reads. A WSL side lost after the call was sent re-runs it through wsl.exe only then. */ idempotent?: boolean;
  /** The process and everything it starts (ssh, per-remote fetches) run in their own group, which a timeout kills as a whole; the call settles after the group's pipes closed.
   * An `idempotent` call settles when the kill starts (timeout, abort, maxBuffer), with the output so far, and its group ends in the background: on Windows the
   * kill is a `taskkill /T` process of 0.5-5 s, which a read (a search past its deadline) does not wait for. */
  killTree?: boolean;
  /** Kills the process group and rejects (the rejection has the partial stdout). Honoured only together with `killTree`: only then the main thread knows the pid; without it the run ends at its timeout. An already aborted signal rejects without starting. */
  signal?: AbortSignal };
export type GitRunOutput = { stdout: Buffer; stderr: string };
/** Rejection: Error & { stderr: string; stdout: Buffer; killed: boolean; code?: string | number; signal?: string } */
export type GitRunner = (o: GitRunOptions) => Promise<GitRunOutput>;

/** ssh without any prompt; set as GIT_SSH_COMMAND by remote operations when the user has no ssh command (`git-remote.ts`, `wsl-git.ts`). */
export const BATCH_SSH = "ssh -o BatchMode=yes";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BUFFER = 64 << 20;

const GIT_RUN_THREAD = `
const { parentPort } = require("node:worker_threads");
const { execFile, spawn } = require("node:child_process");
// A kill command (Windows: taskkill /T) is not awaited: it takes 0.5-5 s, and this thread serves every other git call meanwhile.
const killTree = (pid, cmd) => {
  try {
    if (cmd) spawn(cmd.file, cmd.args.map((a) => (a === "{pid}" ? String(pid) : a)), { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    else process.kill(-pid, "SIGKILL");
  } catch {}
};
// execFile cannot start a process group (it drops detached): killTree runs are spawned here, with execFile's error shape.
// early (an idempotent call): it settles when the kill starts, with the output so far, not when the group's pipes close.
const spawnTree = (file, args, o, cb) => {
  const child = spawn(file, args, { cwd: o.cwd, env: o.env, windowsHide: true, detached: process.platform !== "win32" });
  const out = []; const err = []; let size = 0; let timedOut = false; let over = false; let done = false;
  const failure = (code, signal) => Object.assign(new Error("Command failed: " + file + " " + args.join(" ")), { code: over ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : code, killed: timedOut, signal });
  const kill = () => { killTree(child.pid, o.killCommand); if (o.early) finish(failure(null, null)); };
  const take = (arr) => (b) => { if (done) return; arr.push(b); size += b.length; if (size > o.maxBuffer && !over) { over = true; kill(); } };
  child.stdout.on("data", take(out)); child.stderr.on("data", take(err));
  const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeout);
  const finish = (e) => { if (done) return; done = true; clearTimeout(timer); cb(e, Buffer.concat(out), Buffer.concat(err)); };
  child.on("error", (e) => finish(e));
  child.on("close", (code, signal) => finish(code === 0 && !signal && !over ? undefined : failure(code, signal)));
  return child;
};
parentPort.on("message", ({ id, file, cwd, args, env, timeout, maxBuffer, input, tree, early, killCommand }) => {
  try {
  const cb = (err, stdout, stderr) => {
    const out = Buffer.from(stdout ?? []);
    const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    parentPort.postMessage({ id, stdout: ab, stderr: String(stderr ?? ""), error: err ? { message: err.message, code: err.code, killed: !!err.killed, signal: err.signal } : undefined }, [ab]);
  };
  const child = tree ? spawnTree(file || "git", args, { cwd, env, timeout, maxBuffer, early, killCommand }, cb) : execFile(file || "git", args, { cwd, env, timeout, maxBuffer, encoding: "buffer", windowsHide: true }, cb);
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  if (tree && child.pid) parentPort.postMessage({ id, pid: child.pid });
  } catch (e) {
    parentPort.postMessage({ id, stdout: new ArrayBuffer(0), stderr: "", error: { message: String((e && e.message) || e), killed: false } });
  }
});`;

let thread: Worker | undefined;
let threadBroken = false;
let started = false;
let nextCall = 0;
/** settled: an idempotent call that already failed with its abort; the thread's later result is dropped. */
type Call = { ok: (o: GitRunOutput) => void; fail: (e: Error) => void; timer: NodeJS.Timeout; w: Worker; pid?: number; aborted?: boolean; settled?: boolean };
const calls = new Map<number, Call>();

type KillCommand = { file: string; args: string[] };
const TASKKILL: KillCommand = { file: "taskkill", args: ["/pid", "{pid}", "/T", "/F"] };
/** Test seams: the thread's script; `killCommand` replaces the tree kill (taskkill on Windows, a group SIGKILL elsewhere), `{pid}` stands for the root's pid. `reset()` drops the thread and the broken mark. */
export const gitRunnerConfig = {
  script: GIT_RUN_THREAD,
  killCommand: undefined as KillCommand | undefined,
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
      // The lock of a remote operation is released with this failure: nothing may still run.
      if (c.pid !== undefined) (trees.delete(c.pid), killProcessTree(c.pid, true));
      if (!c.settled) c.fail(new Error(why));
    }
}

function runThread(): Worker | undefined {
  if (thread || threadBroken) return thread;
  try {
    const w = new Worker(gitRunnerConfig.script, { eval: true });
    w.on("message", ({ id, pid, stdout, stderr, error }: { id: number; pid?: number; stdout: ArrayBuffer; stderr: string; error?: { message: string; code?: string | number; killed: boolean; signal?: string } }) => {
      const c = calls.get(id);
      if (!c) return;
      if (pid !== undefined) {
        c.pid = pid;
        noteTree(pid);
        if (c.aborted) killProcessTree(pid);
        return;
      }
      if (c.pid !== undefined) trees.delete(c.pid);
      calls.delete(id);
      clearTimeout(c.timer);
      if (c.settled) return;
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

const killCommand = () => gitRunnerConfig.killCommand ?? (process.platform === "win32" ? TASKKILL : undefined);
/**
 * Kills a process and its whole group (`killTree` runs); the platform equivalent of `kill(-pid)` is `taskkill /T`, a process of 0.5-5 s:
 * not awaited (it would block the event loop) unless `sync` (daemon exit; a failure that releases a remote operation's lock).
 */
export function killProcessTree(pid: number, sync = false): void {
  const cmd = killCommand();
  try {
    if (!cmd) process.kill(-pid, "SIGKILL");
    else {
      const args = cmd.args.map((a) => (a === "{pid}" ? String(pid) : a));
      if (sync) spawnSync(cmd.file, args, { windowsHide: true });
      else spawn(cmd.file, args, { windowsHide: true, stdio: "ignore" }).on("error", () => {}).unref();
    }
  } catch {
    // Already gone.
  }
}
/** Process groups of running `killTree` calls (both runners): a detached group does not die with the daemon, so they end with it. */
const trees = new Set<number>();
let exitHook = false;
/** Kills every running `killTree` group (daemon exit and signals; tests). */
export function endProcessTrees(): void {
  for (const p of trees) killProcessTree(p, true);
  trees.clear();
}
function noteTree(pid: number | undefined): void {
  if (pid === undefined) return;
  trees.add(pid);
  if (exitHook) return;
  exitHook = true;
  process.on("exit", endProcessTrees);
  // Default signal handling would skip "exit": end the groups, then die of the same signal.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.once(sig, () => {
      endProcessTrees();
      process.kill(process.pid, sig);
    });
}

const abortedError = () => Object.assign(new Error("aborted"), { stderr: "", stdout: Buffer.alloc(0), killed: false, code: "ABORT_ERR" });

const direct: GitRunner = (o) =>
  new Promise((ok, fail) => {
    const timeout = o.timeout ?? DEFAULT_TIMEOUT;
    const maxBuffer = o.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const done = (err: (Error & { code?: string | number; killed?: boolean; signal?: string }) | null, stdout: Buffer, stderr: string) => {
      if (!err) return ok({ stdout, stderr });
      fail(Object.assign(new Error(err.message), { stderr, stdout, killed: !!err.killed, code: err.code, signal: err.signal }));
    };
    if (o.signal?.aborted && o.killTree) return fail(abortedError());
    if (!o.killTree) {
      const child = execFile(o.file ?? "git", o.args, { cwd: o.cwd, env: o.env, timeout, maxBuffer, encoding: "buffer", windowsHide: true }, (err, stdout, stderr) => done(err, Buffer.from(stdout ?? []), String(stderr ?? "")));
      child.stdin?.on("error", () => {});
      child.stdin?.end(o.input ?? "");
      return;
    }
    // execFile cannot start a process group: spawned here, so a timeout (or the daemon ending) kills the whole group.
    const child = spawn(o.file ?? "git", o.args, { cwd: o.cwd, env: o.env, windowsHide: true, detached: process.platform !== "win32" });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let over = false;
    let settled = false;
    const pid = child.pid;
    if (pid) noteTree(pid);
    const failure = (code: number | null, signal: NodeJS.Signals | null) =>
      Object.assign(new Error(`Command failed: ${o.file ?? "git"} ${o.args.join(" ")}`), { code: over ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : (code ?? undefined), killed: timedOut, signal: signal ?? undefined });
    // An idempotent call settles when the kill starts (see `killTree`).
    const kill = (early: () => Error) => {
      if (pid) killProcessTree(pid);
      if (o.idempotent) finish(early());
    };
    const onAbort = () => kill(abortedError);
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const take = (arr: Buffer[]) => (b: Buffer) => {
      if (settled) return;
      arr.push(b);
      size += b.length;
      if (size > maxBuffer && !over && pid) ((over = true), kill(() => failure(null, null)));
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    const timer = setTimeout(() => {
      timedOut = true;
      kill(() => failure(null, null));
    }, timeout);
    const finish = (e: (Error & { code?: string | number; killed?: boolean; signal?: string }) | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (pid) trees.delete(pid);
      done(e, Buffer.concat(out), Buffer.concat(err).toString("utf8"));
    };
    child.on("error", finish);
    child.on("close", (code, signal) => finish(code === 0 && !signal && !over ? null : failure(code, signal)));
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
  });

/** Git in a worker thread; a thread that cannot start falls back to child processes of this thread. */
export const threadRunner: GitRunner = (o) =>
  new Promise((ok, fail) => {
    if (o.signal?.aborted && o.killTree) return fail(abortedError());
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
    // Before the thread sent the pid, the kill waits for it. An idempotent call settles now (see `killTree`).
    const onAbort = () => {
      const c = calls.get(id);
      if (!c || c.aborted) return;
      c.aborted = true;
      if (c.pid !== undefined) killProcessTree(c.pid);
      if (o.idempotent) ((c.settled = true), c.fail(abortedError()));
    };
    if (o.killTree) o.signal?.addEventListener("abort", onAbort, { once: true });
    const settle = () => o.signal?.removeEventListener("abort", onAbort);
    calls.set(id, { ok: (r) => (settle(), done(0), ok(r)), fail: (e) => (settle(), done("error"), fail(e)), timer, w });
    w.postMessage({ id, file: o.file, cwd: o.cwd, args: o.args, env: o.env, timeout: o.timeout ?? DEFAULT_TIMEOUT, maxBuffer: o.maxBuffer ?? DEFAULT_MAX_BUFFER, input: o.input, tree: o.killTree, early: !!(o.killTree && o.idempotent), killCommand: killCommand() });
  });

let runner: GitRunner = threadRunner;
export const runGit: GitRunner = (o) => runner(o);
/** `undefined` restores the thread runner. */
export function setGitRunner(r: GitRunner | undefined): void {
  runner = r ?? threadRunner;
}
