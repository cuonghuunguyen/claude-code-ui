// The one place git processes of `git.ts` start (docs/spec.md "Layout", Graph tab): in a worker thread, so the spawn cost
// does not land on the main event loop. `setGitRunner` swaps the runner (tests; `wsl-git.ts` routes WSL projects).
import { execFile, spawn, spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

export type GitRunOptions = { cwd: string; args: string[]; env: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number; input?: string; file?: string;
  /** The process and everything it starts (ssh, per-remote fetches) run in their own group, which a timeout kills as a whole; the call settles after the group's pipes closed. */
  killTree?: boolean };
export type GitRunOutput = { stdout: Buffer; stderr: string };
/** Rejection: Error & { stderr: string; stdout: Buffer; killed: boolean; code?: string | number; signal?: string } */
export type GitRunner = (o: GitRunOptions) => Promise<GitRunOutput>;

/** ssh without any prompt; set as GIT_SSH_COMMAND by remote operations when the user has no ssh command (`git-remote.ts`, `wsl-git.ts`). */
export const BATCH_SSH = "ssh -o BatchMode=yes";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BUFFER = 64 << 20;

const GIT_RUN_THREAD = `
const { parentPort } = require("node:worker_threads");
const { execFile, spawn, spawnSync } = require("node:child_process");
const killTree = (pid) => {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {}
};
// execFile cannot start a process group (it drops detached): killTree runs are spawned here, with execFile's error shape.
const spawnTree = (file, args, o, cb) => {
  const child = spawn(file, args, { cwd: o.cwd, env: o.env, windowsHide: true, detached: process.platform !== "win32" });
  const out = []; const err = []; let size = 0; let timedOut = false; let over = false; let done = false;
  const take = (arr) => (b) => { arr.push(b); size += b.length; if (size > o.maxBuffer && !over) { over = true; killTree(child.pid); } };
  child.stdout.on("data", take(out)); child.stderr.on("data", take(err));
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, o.timeout);
  const finish = (e) => { if (done) return; done = true; clearTimeout(timer); cb(e, Buffer.concat(out), Buffer.concat(err)); };
  child.on("error", (e) => finish(e));
  child.on("close", (code, signal) => finish(code === 0 && !signal && !over ? undefined : Object.assign(new Error("Command failed: " + file + " " + args.join(" ")), { code: over ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : code, killed: timedOut, signal })));
  return child;
};
parentPort.on("message", ({ id, file, cwd, args, env, timeout, maxBuffer, input, tree }) => {
  try {
  const cb = (err, stdout, stderr) => {
    const out = Buffer.from(stdout ?? []);
    const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    parentPort.postMessage({ id, stdout: ab, stderr: String(stderr ?? ""), error: err ? { message: err.message, code: err.code, killed: !!err.killed, signal: err.signal } : undefined }, [ab]);
  };
  const child = tree ? spawnTree(file || "git", args, { cwd, env, timeout, maxBuffer }, cb) : execFile(file || "git", args, { cwd, env, timeout, maxBuffer, encoding: "buffer", windowsHide: true }, cb);
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
type Call = { ok: (o: GitRunOutput) => void; fail: (e: Error) => void; timer: NodeJS.Timeout; w: Worker; pid?: number };
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
      // The lock of a remote operation is released with this failure: nothing may still run.
      if (c.pid !== undefined) (trees.delete(c.pid), killProcessTree(c.pid));
      c.fail(new Error(why));
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
        return;
      }
      if (c.pid !== undefined) trees.delete(c.pid);
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

/** Kills a process and its whole group (`killTree` runs); the platform equivalent of `kill(-pid)` is `taskkill /T`. */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
/** Process groups of running `killTree` calls (both runners): a detached group does not die with the daemon, so they end with it. */
const trees = new Set<number>();
let exitHook = false;
/** Kills every running `killTree` group (daemon exit and signals; tests). */
export function endProcessTrees(): void {
  for (const p of trees) killProcessTree(p);
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

const direct: GitRunner = (o) =>
  new Promise((ok, fail) => {
    const timeout = o.timeout ?? DEFAULT_TIMEOUT;
    const maxBuffer = o.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const done = (err: (Error & { code?: string | number; killed?: boolean; signal?: string }) | null, stdout: Buffer, stderr: string) => {
      if (!err) return ok({ stdout, stderr });
      fail(Object.assign(new Error(err.message), { stderr, stdout, killed: !!err.killed, code: err.code, signal: err.signal }));
    };
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
    const take = (arr: Buffer[]) => (b: Buffer) => {
      arr.push(b);
      size += b.length;
      if (size > maxBuffer && !over && pid) ((over = true), killProcessTree(pid));
    };
    child.stdout.on("data", take(out));
    child.stderr.on("data", take(err));
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) killProcessTree(pid);
    }, timeout);
    const finish = (e: (Error & { code?: string | number; killed?: boolean; signal?: string }) | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pid) trees.delete(pid);
      done(e, Buffer.concat(out), Buffer.concat(err).toString("utf8"));
    };
    child.on("error", finish);
    child.on("close", (code, signal) => finish(code === 0 && !signal && !over ? null : Object.assign(new Error(`Command failed: ${o.file ?? "git"} ${o.args.join(" ")}`), { code: over ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : (code ?? undefined), killed: timedOut, signal: signal ?? undefined })));
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
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
    calls.set(id, { ok, fail, timer, w });
    w.postMessage({ id, file: o.file, cwd: o.cwd, args: o.args, env: o.env, timeout: o.timeout ?? DEFAULT_TIMEOUT, maxBuffer: o.maxBuffer ?? DEFAULT_MAX_BUFFER, input: o.input, tree: o.killTree });
  });

let runner: GitRunner = threadRunner;
export const runGit: GitRunner = (o) => runner(o);
/** `undefined` restores the thread runner. */
export function setGitRunner(r: GitRunner | undefined): void {
  runner = r ?? threadRunner;
}
