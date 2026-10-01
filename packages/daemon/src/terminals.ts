// Terminal panel PTYs (docs/spec.md "Side panel"). They belong to the daemon, not to a connection: a reconnect re-attaches.
import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type { TerminalInfo } from "@claude-ui/protocol";

/** Scrollback replayed on attach, in UTF-16 units. */
// ponytail: the cut can split an escape sequence, so a replay may start with a few garbled chars; cut at a line break if it shows.
const BUFFER_CHARS = 256 * 1024;

/** Shells outlive their connection, so a client loop could otherwise pile them up until the daemon stops. */
export const MAX_TERMINALS = 32;
/** Running terminals created by one connection. */
export const MAX_TERMINALS_PER_CLIENT = 8;

type Listener = { output: (data: string) => void; exit: (exitCode: number) => void };
type Terminal = TerminalInfo & { cwd: string; owner: object; pty: IPty; buffer: string; listeners: Set<Listener> };

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
    const t: Terminal = { id: randomUUID(), title: `Terminal ${n}`, cwd, owner, pty, buffer: "", listeners: new Set() };
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
    /** Why `owner` may not open another terminal, or undefined. */
    limit(owner: object) {
      if (terminals.size >= MAX_TERMINALS) return `at most ${MAX_TERMINALS} terminals run at once; close one`;
      if ([...terminals.values()].filter((t) => t.owner === owner).length >= MAX_TERMINALS_PER_CLIENT)
        return `at most ${MAX_TERMINALS_PER_CLIENT} terminals per browser tab; close one`;
    },
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
