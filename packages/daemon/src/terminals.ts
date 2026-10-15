// Terminal panel PTYs (docs/spec.md "Side panel"). They belong to the daemon, not to a connection: a reconnect re-attaches.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, lstatSync, readFileSync, statSync, writeSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, win32 } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { TerminalInfo } from "@claude-ui/protocol";

/** Scrollback replayed on attach, in UTF-16 units. */
const BUFFER_CHARS = 256 * 1024;
/** A connection with more unsent output than this pauses the shell (backpressure) until it is down to RESUME_BYTES. */
export const PAUSE_BYTES = 1024 * 1024;
const RESUME_BYTES = 128 * 1024;
const DRAIN_POLL_MS = 50;

/**
 * The last `max` chars of `buf`, cut where no escape sequence or surrogate pair can be split: after the first line
 * break of the kept part, else before its first ESC.
 */
export function trimScrollback(buf: string, max = BUFFER_CHARS) {
  if (buf.length <= max) return buf;
  const from = buf.length - max;
  const nl = buf.indexOf("\n", from);
  if (nl >= 0) return buf.slice(nl + 1);
  const esc = buf.indexOf("\x1b", from);
  return esc >= 0 ? buf.slice(esc) : buf.slice(from);
}

/** Shells outlive their connection, so a client loop could otherwise pile them up until the daemon stops. */
export const MAX_TERMINALS = 32;
/** Running terminals created by one connection. */
export const MAX_TERMINALS_PER_CLIENT = 8;
/** Input the shell has not read yet; more is refused until it reads. */
export const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const RETRY_MS = 10;

/** `backlog`: bytes the listener's connection has not sent yet (ws bufferedAmount). */
type Listener = { output: (data: string) => void; exit: (exitCode: number) => void; backlog?: () => number };
type Terminal = TerminalInfo & {
  cwd: string;
  owner: object;
  pty: IPty;
  buffer: string;
  listeners: Set<Listener>;
  paused?: NodeJS.Timeout;
  /** The PTY master's fd number. */
  fd: number;
  /** node-pty's read stream on `fd`: the only thing that closes it. Windows: the output socket. */
  socket: { destroyed: boolean; on?: (event: "error", listener: (err: NodeJS.ErrnoException) => void) => unknown };
  pending: Buffer[];
  retry?: NodeJS.Timeout;
  /** Windows: node-pty's ConPTY input pipe socket (a net.Socket): its 'error' event, its queued size, and destroy on exit. */
  input?: EventEmitter & { writableLength?: number; destroy?: () => void };
  /** Resolves once the shell process is gone (node-pty's onExit). */
  exited: Promise<void>;
  /** First output seen. Windows: node-pty defers input and kill() until then, and reports no exit before it. */
  ready: boolean;
  /** Windows: input bytes written before the first output; node-pty holds them in its own deferred list, outside `input.writableLength`. */
  early: number;
  /** Set once the exit was handled (node-pty's onExit, or fail() before the first output). */
  finished?: boolean;
  /** Windows: node-pty's conout worker connection; node-pty disposes it only in kill(). */
  conout?: { dispose: () => void };
  /** Windows: node-pty's agent, whose kill() is not deferred like IPty.kill(). */
  agent?: { kill: () => void };
  /** The exit path, once: unlist, tell the listeners, release node-pty's handles. */
  finish: (exitCode: number) => void;
};

/**
 * True while `t.fd` is still this PTY's master. node-pty closes the master only by destroying its read stream, and
 * `destroy()` sets `destroyed` in the same synchronous call that closes the fd (uv_close of a stream closes it at once),
 * on the main thread. So no other open can take the number between this check and a write in the same turn.
 * Not fstat: every PTY master has the inode of /dev/ptmx, so another terminal's master on the reused number passed.
 */
const open = (t: Terminal) => !t.socket.destroyed;

/**
 * Writes queued input until the kernel buffer is full, then retries later.
 * Not `pty.write`: node-pty 1.1.0 keeps retrying its queue on the fd number after the PTY closes it, so input reached
 * whatever reused that number (another client's socket). Here every write is synchronous and checked with `open`.
 */
/** False when the queue was dropped (master closed or a write error). */
function flush(t: Terminal) {
  t.retry = undefined;
  while (t.pending.length) {
    if (!open(t)) return !(t.pending.length = 0);
    const chunk = t.pending[0]!;
    let n: number;
    try {
      n = writeSync(t.fd, chunk);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") return !(t.pending.length = 0);
      t.retry = setTimeout(flush, RETRY_MS, t);
      return true;
    }
    if (n < chunk.length) t.pending[0] = chunk.subarray(n);
    else t.pending.shift();
  }
  return true;
}

function stop(t: Terminal) {
  clearTimeout(t.retry);
  t.pending.length = 0;
}

/** The daemon's own settings (PORT, CLAUDE_UI_*) stay out of the shell: `npm start` there must not bind the daemon's port. The rest is the user's env, like a VS Code terminal. */
export const shellEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "PORT" && !k.startsWith("CLAUDE_UI_"))) as Record<string, string>;

/** Not existsSync: a Microsoft Store pwsh is a 0-byte App Execution Alias on PATH; stat fails on it, lstat and CreateProcess do not. */
const onDisk = (path: string) => {
  try {
    return !!lstatSync(path);
  } catch {
    return false;
  }
};

/**
 * The terminal panel's shell: SHELL, else bash; on Windows without a usable SHELL, pwsh on PATH, else Windows PowerShell, else COMSPEC.
 * On Windows SHELL counts only as an existing file: Git Bash sets it to "/usr/bin/bash", which ConPTY cannot start.
 */
export function shell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists = onDisk) {
  if (platform !== "win32") return env.SHELL || "bash";
  if (env.SHELL && exists(env.SHELL)) return env.SHELL;
  // Plain objects (tests, a copied env) keep Windows' key case ("Path", "ComSpec"); process.env ignores it.
  const get = (key: string) => Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1];
  const dirs = (get("PATH") ?? "").split(";").filter(Boolean);
  for (const exe of ["pwsh.exe", "powershell.exe"]) {
    const hit = dirs.map((d) => win32.join(d, exe)).find((p) => exists(p));
    if (hit) return hit;
  }
  return get("COMSPEC") || "cmd.exe";
}

/**
 * node-pty 1.1.0 publishes its macOS `spawn-helper` without the executable bit, so every spawn there fails with
 * "posix_spawnp failed." (GH-84). Sets it on the helper(s) node-pty may load; returns the command that fixes one it
 * could not (`sudo` when another user, e.g. root for a global install, owns it).
 * ponytail: drop once a node-pty release ships the helper executable.
 */
export function fixSpawnHelper(root: string, platform = process.platform, arch = process.arch, chmod = chmodSync, stat: (path: string) => { mode: number; uid: number } = statSync) {
  if (platform !== "darwin") return;
  let broken: string | undefined;
  for (const dir of ["build/Release", "build/Debug", `prebuilds/${platform}-${arch}`]) {
    const helper = join(root, dir, "spawn-helper");
    let mode: number, uid: number;
    try {
      ({ mode, uid } = stat(helper));
    } catch {
      continue;
    }
    if ((mode & 0o111) === 0o111) continue;
    try {
      chmod(helper, mode | 0o111);
    } catch {
      broken = `${uid === process.getuid?.() ? "" : "sudo "}chmod +x "${helper}"`;
    }
  }
  return broken;
}

export const nodePtyRoot = () => dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));

/** GH-266: the "node-pty internals changed" warning is logged once per process. */
let warnedInternals = false;
let warnedVersion = false;

/** The node-pty version in `root`'s package.json, or undefined. */
function ptyVersion(root: string) {
  try {
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version;
  } catch {}
}

type Closable = { dispose: () => void };
type PtyAgent = { kill: () => void; _innerPid: number; _getConsoleProcessList: () => Promise<number[]> };

/**
 * node-pty 1.1.0 Windows internals the daemon guards (no public API). Recheck every name on a node-pty upgrade
 * (the test "node-pty still has the Windows internals the daemon guards" scans node-pty's lib for them):
 * - `_socket`: output socket (WindowsTerminal, = `_agent.outSocket`): 'error' listener before ready
 * - `_agent.inSocket`: ConPTY input pipe (GH-266)
 * - `_agent._conoutSocketWorker` (`dispose()`, `_worker`): conout worker thread
 * - `_agent._getConsoleProcessList`, `_agent._innerPid`: console-list child process
 * - `_agent.kill()`: kill without IPty.kill()'s defer until the first output
 * Each field is set only when its feature check passes; `missing` names the checks that failed.
 */
function windowsInternals(pty: IPty) {
  const p = pty as unknown as { _socket?: { on?: unknown }; _agent?: Record<string, any> };
  const agent = p._agent;
  const missing: string[] = [];
  const check = <T>(name: string, ok: boolean, value: T) => {
    if (ok) return value;
    missing.push(name);
  };
  const input = check("_agent.inSocket", typeof agent?.inSocket?.on === "function", agent?.inSocket as Terminal["input"]);
  const output = check("_socket", typeof p._socket?.on === "function", p._socket as Terminal["socket"]);
  const conoutObj = agent?._conoutSocketWorker;
  const conout = check("_agent._conoutSocketWorker", typeof conoutObj?.dispose === "function", conoutObj as Closable);
  const worker = typeof conoutObj?._worker?.on === "function" ? (conoutObj._worker as EventEmitter) : undefined;
  if (conout && !worker) missing.push("_agent._conoutSocketWorker._worker");
  const consoleList = check("_agent._getConsoleProcessList", typeof agent?._getConsoleProcessList === "function" && typeof agent?._innerPid === "number", agent as unknown as PtyAgent);
  const kill = check("_agent.kill", typeof agent?.kill === "function", agent as { kill: () => void });
  return { input, output, conout, worker, consoleList, kill, missing };
}

/** Parameters after `root`: test seams. */
export function createTerminals(root = nodePtyRoot(), platform = process.platform, spawnPty = spawn, chmod = chmodSync, forkChild: typeof fork = fork) {
  const terminals = new Map<string, Terminal>();
  fixSpawnHelper(root, platform, process.arch, chmod);

  /** `owner`: the creating connection, for MAX_TERMINALS_PER_CLIENT. */
  function create(cwd: string, cols: number, rows: number, owner: object): TerminalInfo {
    const used = new Set([...terminals.values()].filter((t) => t.cwd === cwd).map((t) => t.title));
    let n = 1;
    while (used.has(`Terminal ${n}`)) n++;
    const start = () =>
      spawnPty(shell(), [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: { ...shellEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
      });
    let pty: IPty;
    try {
      pty = start();
    } catch (err) {
      if (platform !== "darwin") throw err;
      // node-pty reinstalled since startup ships the helper 0644 again: fix it now and retry once.
      // Always retry: the unfixable helper may be one node-pty does not load.
      const fix = fixSpawnHelper(root, platform, process.arch, chmod);
      try {
        pty = start();
      } catch (retryErr) {
        if (!fix) throw retryErr;
        throw new Error(`${(retryErr as Error).message} node-pty's spawn-helper is not executable; run: ${fix}`);
      }
    }
    // node-pty 1.1.0 internals (`fd`, `_socket`); recheck both on an upgrade. The Windows ones: windowsInternals().
    const { fd, _socket: socket } = pty as unknown as { fd: number; _socket: Terminal["socket"] };
    let exited!: () => void;
    const t: Terminal = {
      id: randomUUID(),
      title: `Terminal ${n}`,
      cwd,
      owner,
      pty,
      buffer: "",
      listeners: new Set(),
      fd,
      socket,
      pending: [],
      exited: new Promise((r) => (exited = r)),
      ready: false,
      early: 0,
      finish(exitCode) {
        if (t.finished) return;
        t.finished = true;
        clearInterval(t.paused);
        stop(t);
        terminals.delete(t.id);
        t.listeners.forEach((l) => l.exit(exitCode));
        exited();
        // node-pty never closes the ConPTY input pipe, nor stops its conout worker thread when the shell exits by itself
        // (only kill() does): either keeps `t` (scrollback, pty, connections) reachable for as long as the daemon runs.
        // A late 'error' on the input pipe is still swallowed.
        for (const [what, close] of [
          ["input pipe", () => t.input?.destroy?.()],
          ["conout worker", () => t.conout?.dispose()],
        ] as const)
          try {
            close();
          } catch (err) {
            console.warn(`terminal ${t.id}: closing the ${what} failed: ${String(err)}`);
          }
      },
    };
    const backlog = () => Math.max(0, ...[...t.listeners].map((l) => l.backlog?.() ?? 0));
    pty.onData((data) => {
      // node-pty flushes its deferred input into the input socket in this same 'data' emit, right after this listener,
      // so from now on `input.writableLength` counts it. Recheck on a node-pty upgrade (`_defer` in windowsTerminal.js).
      if (!t.ready) {
        t.ready = true;
        t.early = 0;
      }
      t.buffer = trimScrollback(t.buffer + data);
      t.listeners.forEach((l) => l.output(data));
      // A slow connection: stop reading the shell's output (it blocks on a full PTY) until the socket drained.
      if (t.paused || backlog() <= PAUSE_BYTES) return;
      pty.pause();
      t.paused = setInterval(() => {
        if (backlog() > RESUME_BYTES) return;
        clearInterval(t.paused);
        t.paused = undefined;
        pty.resume();
      }, DRAIN_POLL_MS);
    });
    pty.onExit(({ exitCode }) => t.finish(exitCode));
    if (platform === "win32") guardWindows(t);
    terminals.set(t.id, t);
    return { id: t.id, title: t.title };
  }

  /**
   * GH-266, GH-268: node-pty's Windows pipes and helpers raise 'error' events nobody listens to, which ended the daemon:
   * - ConPTY input is a net.Socket on a named pipe. A write that lands while ConPTY closes it (input still queued when the
   *   terminal is closed or the shell ends) fails later: EAGAIN (libuv's name for ERROR_NO_DATA, "the pipe is being
   *   closed") or EOF. Node has destroyed the socket by then, so no retry.
   * - The output socket gets node-pty's own 'error' listener only after its first output, and that one rethrows unless
   *   another listener exists; the conout worker thread and the console-list child have none at all.
   * Each ends this terminal only. Without a node-pty internal, that part stays unguarded, with one warning.
   */
  function guardWindows(t: Terminal) {
    const w = windowsInternals(t.pty);
    if (w.missing.length && !warnedInternals) {
      warnedInternals = true;
      console.warn(`node-pty internals changed (missing: ${w.missing.join(", ")}); Windows terminals are not fully guarded against pipe errors and leaks`);
    }
    t.input = w.input;
    t.conout = w.conout;
    t.agent = w.kill;
    w.input?.on("error", (err) => fail(t, "input", err));
    // EIO is node-pty's normal "shell gone" signal; node-pty handles it.
    w.output?.on?.("error", (err) => {
      if (!/EIO|errno 5/.test(String(err.code))) fail(t, "output", err);
    });
    w.worker?.on("error", (err) => fail(t, "output", err));
    // The copy below is of node-pty 1.1.x only: 1.2.x reshaped kill() and starts _innerPid at 0. Elsewhere node-pty's own stays.
    const version = ptyVersion(root);
    const agent = version?.startsWith("1.1.") ? w.consoleList : undefined;
    if (w.consoleList && !agent && !warnedVersion) {
      warnedVersion = true;
      console.warn(`node-pty ${version ?? "(unknown version)"}: its console-list helper is not guarded against a failed fork; the daemon's guard covers node-pty 1.1.x only`);
    }
    if (agent) {
      // node-pty 1.1.0 WindowsPtyAgent._getConsoleProcessList (MIT, Microsoft; see THIRD_PARTY_NOTICES.md) forks this
      // helper with no 'error' listener: a failed fork (EAGAIN, EMFILE) ended the daemon. Same behaviour, plus the
      // listener. Recheck on a node-pty upgrade.
      agent._getConsoleProcessList = () =>
        new Promise<number[]>((resolve) => {
          const pid = agent._innerPid;
          // As upstream: no inner PID yet (0): listing would make kill() signal PID 0, the daemon's own process group.
          if (!(pid > 0)) return resolve([]);
          let timer: NodeJS.Timeout | undefined;
          const done = (list: number[]) => {
            clearTimeout(timer);
            resolve(list);
          };
          const failed = (err: unknown) => {
            console.warn(`terminal ${t.id}: listing the console processes failed: ${err instanceof Error ? err.message : String(err)}`);
            done([pid]);
          };
          let child: ChildProcess;
          try {
            child = forkChild(join(root, "lib", "conpty_console_list_agent"), [String(pid)]);
          } catch (err) {
            return failed(err);
          }
          child.on("message", (m) => done((m as { consoleProcessList?: number[] }).consoleProcessList ?? [pid]));
          child.on("error", failed);
          timer = setTimeout(() => {
            try {
              child.kill();
            } catch {}
            done([pid]);
          }, 5000);
        });
    }
  }

  /** A node-pty pipe or worker error: ends only this terminal, with a notice line. Later errors of a closed terminal are swallowed. */
  function fail(t: Terminal, what: "input" | "output", err: Error) {
    if (terminals.get(t.id) !== t) return; // already closed: the queued input was meant for a shell that is gone
    console.warn(`terminal ${t.id}: ${what} pipe failed (${err.message}); closing the terminal`);
    t.listeners.forEach((l) => l.output(`\r\n[claude-ui: terminal ${what} failed (${err.message}); the terminal is closed]\r\n`));
    if (t.ready) return closeTerminal(t); // node-pty reports the exit (onExit)
    // Before the first output node-pty defers IPty.kill() and never emits 'exit' (both wait for the output pipe):
    // kill through the agent and end the terminal here.
    stop(t);
    terminals.delete(t.id);
    try {
      if (t.agent) t.agent.kill();
      else t.pty.kill();
    } catch (e) {
      console.warn(`terminal ${t.id}: kill failed: ${String(e)}`);
    }
    t.finish(-1);
  }

  /** Unlisted at once; attached connections get the exit when the shell is gone. */
  function closeTerminal(t: Terminal) {
    stop(t);
    terminals.delete(t.id);
    try {
      t.pty.kill();
    } catch (err) {
      console.warn(`terminal ${t.id}: kill failed: ${String(err)}`);
    }
  }

  return {
    create,
    /** Why `owner` may not open another terminal, or undefined. */
    limit(owner: object) {
      if (terminals.size >= MAX_TERMINALS) return `at most ${MAX_TERMINALS} terminals run at once; close one`;
      if ([...terminals.values()].filter((t) => t.owner === owner).length >= MAX_TERMINALS_PER_CLIENT)
        return `at most ${MAX_TERMINALS_PER_CLIENT} terminals per browser tab; close one`;
    },
    /** Undefined once the master closed, also while the shell process lives on (onExit has not fired). */
    get: (id: string) => {
      const t = terminals.get(id);
      return t && open(t) ? t : undefined;
    },
    list: (cwd: string): TerminalInfo[] => [...terminals.values()].filter((t) => t.cwd === cwd && open(t)).map(({ id, title }) => ({ id, title })),
    close: closeTerminal,
    /** A running terminal started in a cwd `inside` accepts. */
    any: (inside: (cwd: string) => boolean) => [...terminals.values()].some((t) => open(t) && inside(t.cwd)),
    /**
     * Closes every terminal started in a cwd `inside` accepts and waits (at most `timeoutMs`) for the shells to exit.
     * Removing a worktree needs it: on Windows a shell whose working directory is the worktree keeps the folder from being deleted.
     * ponytail: only the start cwd counts; a shell that `cd`ed into the folder later still holds it.
     */
    async closeIn(inside: (cwd: string) => boolean, timeoutMs = 5000) {
      const doomed = [...terminals.values()].filter((t) => inside(t.cwd));
      for (const t of doomed) this.close(t);
      if (!doomed.length) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(doomed.map((t) => t.exited)), new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
      clearTimeout(timer);
    },
    /** The error code when `data` is not written now or queued; undefined when it is. */
    write(t: Terminal, data: string): "unknown_terminal" | "input_backlog" | "write_failed" | undefined {
      if (!open(t)) return "unknown_terminal";
      const chunk = Buffer.from(data);
      // ConPTY: input goes through node-pty's pipe socket, which has no fd reuse to guard against. Its queue is capped
      // like the POSIX one (a flood buffered 600 MB, then failed with ENOBUFS). Its async errors: guardWindows().
      // A Buffer, not the string: a net.Socket counts a string chunk in UTF-16 units, so the cap would not be bytes.
      // Without `writableLength` (node-pty changed) that part of the cap cannot apply. node-pty 1.1.0 defers writes until
      // the shell's first output (`_defer`) in a list of its own, outside `writableLength`: `early` counts those bytes.
      if (platform === "win32") {
        const queued = (typeof t.input?.writableLength === "number" ? t.input.writableLength : 0) + t.early;
        if (queued + chunk.length > MAX_PENDING_INPUT_BYTES) return "input_backlog";
        try {
          t.pty.write(chunk);
        } catch {
          return "write_failed";
        }
        if (!t.ready) t.early += chunk.length;
        return;
      }
      if (t.pending.reduce((sum, b) => sum + b.length, chunk.length) > MAX_PENDING_INPUT_BYTES) return "input_backlog";
      t.pending.push(chunk);
      if (t.pending.length === 1 && !flush(t)) return "write_failed";
    },
    /** Skipped once the fd is no longer this PTY: the ioctl would resize whatever reused the number. */
    resize(t: Terminal, cols: number, rows: number) {
      if (open(t)) t.pty.resize(cols, rows);
    },
    /** Running terminals, of every cwd. */
    count: () => terminals.size,
    /** Returns the scrollback and the detach function. */
    attach(t: Terminal, l: Listener) {
      t.listeners.add(l);
      return { buffer: t.buffer, detach: () => void t.listeners.delete(l) };
    },
  };
}

export type Terminals = ReturnType<typeof createTerminals>;
