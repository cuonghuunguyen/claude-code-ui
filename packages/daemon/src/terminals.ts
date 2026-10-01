// Terminal panel PTYs (docs/spec.md "Side panel"). They belong to the daemon, not to a connection: a reconnect re-attaches.
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
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
const shellEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "PORT" && !k.startsWith("CLAUDE_UI_"))) as Record<string, string>;

export function createTerminals() {
  const terminals = new Map<string, Terminal>();

  /** `owner`: the creating connection, for MAX_TERMINALS_PER_CLIENT. */
  function create(cwd: string, cols: number, rows: number, owner: object): TerminalInfo {
    const used = new Set([...terminals.values()].filter((t) => t.cwd === cwd).map((t) => t.title));
    let n = 1;
    while (used.has(`Terminal ${n}`)) n++;
    // ponytail: $SHELL or bash; Windows (powershell) not handled, the daemon targets Linux and macOS.
    const pty = spawn(process.env.SHELL || "bash", [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...shellEnv(), TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    });
    // node-pty 1.1.0 internals (`fd`, `_socket`); recheck both on an upgrade.
    const { fd, _socket: socket } = pty as unknown as { fd: number; _socket: Terminal["socket"] };
    const t: Terminal = { id: randomUUID(), title: `Terminal ${n}`, cwd, owner, pty, buffer: "", listeners: new Set(), fd, socket, pending: [] };
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
    });
    terminals.set(t.id, t);
    return { id: t.id, title: t.title };
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
    /** Unlisted at once; attached connections get the exit when the shell is gone. */
    close(t: Terminal) {
      stop(t);
      terminals.delete(t.id);
      t.pty.kill();
    },
    /** The error code when `data` is not written now or queued; undefined when it is. */
    write(t: Terminal, data: string): "unknown_terminal" | "input_backlog" | "write_failed" | undefined {
      if (!open(t)) return "unknown_terminal";
      const chunk = Buffer.from(data);
      if (t.pending.reduce((sum, b) => sum + b.length, chunk.length) > MAX_PENDING_INPUT_BYTES) return "input_backlog";
      t.pending.push(chunk);
      if (t.pending.length === 1 && !flush(t)) return "write_failed";
    },
    /** Skipped once the fd is no longer this PTY: the ioctl would resize whatever reused the number. */
    resize(t: Terminal, cols: number, rows: number) {
      if (open(t)) t.pty.resize(cols, rows);
    },
    /** Returns the scrollback and the detach function. */
    attach(t: Terminal, l: Listener) {
      t.listeners.add(l);
      return { buffer: t.buffer, detach: () => void t.listeners.delete(l) };
    },
  };
}

export type Terminals = ReturnType<typeof createTerminals>;
