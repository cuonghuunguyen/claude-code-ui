// Terminal panel PTYs (docs/spec.md "Side panel"). They belong to the daemon, not to a connection: a reconnect re-attaches.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, lstatSync, statSync, writeSync } from "node:fs";
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
  /** node-pty's read stream on `fd`: the only thing that closes it. */
  socket: { destroyed: boolean };
  pending: Buffer[];
  retry?: NodeJS.Timeout;
  /** Windows: node-pty's ConPTY input pipe socket, for its 'error' event and its queued bytes. */
  input?: { writableLength: number };
  /** Resolves once the shell process is gone (node-pty's onExit). */
  exited: Promise<void>;
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

/** Parameters after `root`: test seams. */
export function createTerminals(root = nodePtyRoot(), platform = process.platform, spawnPty = spawn, chmod = chmodSync) {
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
    // node-pty 1.1.0 internals (`fd`, `_socket`); recheck both on an upgrade.
    const { fd, _socket: socket } = pty as unknown as { fd: number; _socket: Terminal["socket"] };
    let exited!: () => void;
    const t: Terminal = { id: randomUUID(), title: `Terminal ${n}`, cwd, owner, pty, buffer: "", listeners: new Set(), fd, socket, pending: [], exited: new Promise((r) => (exited = r)) };
    const backlog = () => Math.max(0, ...[...t.listeners].map((l) => l.backlog?.() ?? 0));
    pty.onData((data) => {
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
    pty.onExit(({ exitCode }) => {
      clearInterval(t.paused);
      stop(t);
      terminals.delete(t.id);
      t.listeners.forEach((l) => l.exit(exitCode));
      exited();
    });
    // GH-266: ConPTY input goes through a net.Socket on a named pipe, and node-pty 1.1.0 listens for 'error' only on the
    // output socket. A write that lands while ConPTY closes the pipe (input still queued when the terminal is closed or
    // the shell ends) fails later: EAGAIN (libuv's name for ERROR_NO_DATA, "the pipe is being closed") or EOF. Unhandled,
    // that 'error' event ended the daemon. Node has destroyed the socket by then, so no retry: end this terminal only.
    // node-pty internal (`_agent.inSocket`, no public API); recheck on an upgrade. Without it, input stays unguarded.
    const input = platform === "win32" ? (pty as unknown as { _agent?: { inSocket?: unknown } })._agent?.inSocket : undefined;
    if (input instanceof EventEmitter && typeof (input as { writableLength?: unknown }).writableLength === "number") {
      t.input = input as unknown as Terminal["input"];
      input.on("error", (err: NodeJS.ErrnoException) => {
        if (terminals.get(t.id) !== t) return; // already closed: the queued input was meant for a shell that is gone
        console.warn(`terminal ${t.id}: input pipe failed (${err.message}); closing the terminal`);
        t.listeners.forEach((l) => l.output(`\r\n[claude-ui: terminal input failed (${err.message}); the terminal is closed]\r\n`));
        closeTerminal(t);
      });
    }
    terminals.set(t.id, t);
    return { id: t.id, title: t.title };
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
      // ConPTY: input goes through node-pty's pipe socket, which has no fd reuse to guard against. Its queue is capped
      // like the POSIX one (a flood buffered 600 MB, then failed with ENOBUFS). Its async errors: the listener in create().
      // ponytail: input sent before the shell's first output waits in node-pty's own deferred list, uncounted.
      if (platform === "win32") {
        if ((t.input?.writableLength ?? 0) + Buffer.byteLength(data) > MAX_PENDING_INPUT_BYTES) return "input_backlog";
        try {
          t.pty.write(data);
        } catch {
          return "write_failed";
        }
        return;
      }
      const chunk = Buffer.from(data);
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
