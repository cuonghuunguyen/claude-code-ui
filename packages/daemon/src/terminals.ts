// Terminal panel PTYs (docs/spec.md "Side panel"). They belong to the daemon, not to a connection: a reconnect re-attaches.
import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { TerminalInfo } from "@claude-ui/protocol";

/** Scrollback replayed on attach, in UTF-16 units. */
// ponytail: the cut can split an escape sequence, so a replay may start with a few garbled chars; cut at a line break if it shows.
const BUFFER_CHARS = 256 * 1024;

type Listener = { output: (data: string) => void; exit: (exitCode: number) => void };
type Terminal = TerminalInfo & { cwd: string; pty: IPty; buffer: string; listeners: Set<Listener> };

export function createTerminals() {
  const terminals = new Map<string, Terminal>();

  function create(cwd: string, cols: number, rows: number): TerminalInfo {
    const used = new Set([...terminals.values()].filter((t) => t.cwd === cwd).map((t) => t.title));
    let n = 1;
    while (used.has(`Terminal ${n}`)) n++;
    // ponytail: $SHELL or bash; Windows (powershell) not handled, the daemon targets Linux and macOS.
    const pty = spawn(process.env.SHELL || "bash", [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    });
    const t: Terminal = { id: randomUUID(), title: `Terminal ${n}`, cwd, pty, buffer: "", listeners: new Set() };
    pty.onData((data) => {
      t.buffer = (t.buffer + data).slice(-BUFFER_CHARS);
      t.listeners.forEach((l) => l.output(data));
    });
    pty.onExit(({ exitCode }) => {
      terminals.delete(t.id);
      t.listeners.forEach((l) => l.exit(exitCode));
    });
    terminals.set(t.id, t);
    return { id: t.id, title: t.title };
  }

  return {
    create,
    get: (id: string) => terminals.get(id),
    list: (cwd: string): TerminalInfo[] => [...terminals.values()].filter((t) => t.cwd === cwd).map(({ id, title }) => ({ id, title })),
    /** Unlisted at once; attached connections get the exit when the shell is gone. */
    close(t: Terminal) {
      terminals.delete(t.id);
      t.pty.kill();
    },
    /** Returns the scrollback and the detach function. */
    attach(t: Terminal, l: Listener) {
      t.listeners.add(l);
      return { buffer: t.buffer, detach: () => void t.listeners.delete(l) };
    },
  };
}

export type Terminals = ReturnType<typeof createTerminals>;
