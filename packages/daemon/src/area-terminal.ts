// Area: the terminal panel (`terminal.*`).
// Per-connection state: the attached terminals; `close` detaches them.
import { statSync } from "node:fs";
import type { TerminalTypes } from "./areas.ts";
import type { DaemonContext } from "./daemon-context.ts";
import type { Area, Connection, Handlers, Msg, Respond } from "./dispatch.ts";
import { claudeBin } from "./claude-bin.ts";
import { MAX_TERMINAL_INPUT_BYTES } from "@claude-ui/protocol";

export type TerminalAreaContext = Pick<DaemonContext, "allowed" | "isRemoving" | "terminals" | "claudeLoginChanged"> & { opts: Pick<DaemonContext["opts"], "claudeBin"> };

const isSize = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000;

export function createTerminalArea(ctx: TerminalAreaContext, conn: Connection): Area<TerminalTypes> {
  const { allowed, isRemoving, terminals, claudeLoginChanged, opts } = ctx;
  // Attached terminals: ID → detach.
  const attached = new Map<string, () => void>();

  const create = async (msg: Msg<"terminal.create">, r: Respond) => {
    const cwd = allowed(msg.cwd);
    if (!cwd || !statSync(cwd).isDirectory()) return r.fail("cwd_not_allowed", `not a directory inside the allowlisted roots: ${msg.cwd}`);
    if (isRemoving(cwd)) return r.fail("worktree_removing", "This worktree is being removed");
    if (!isSize(msg.cols) || !isSize(msg.rows)) return r.fail("bad_size", "cols and rows must be integers from 1 to 1000");
    if (msg.login !== undefined && msg.login !== true) return r.fail("bad_request", "login must be true");
    const full = terminals.limit(conn.ws);
    if (full) return r.fail("too_many_terminals", full);
    try {
      const login = msg.login && { file: opts.claudeBin ?? claudeBin(), args: ["auth", "login"], title: "Claude login", onExit: (code: number) => code === 0 && claudeLoginChanged() };
      return r.reply({ terminal: terminals.create(cwd, msg.cols, msg.rows, conn.ws, login || undefined) });
    } catch (err) {
      return r.fail("spawn_failed", String(err));
    }
  };

  const list = async (msg: Msg<"terminal.list">, r: Respond) => {
    const cwd = allowed(msg.cwd);
    return r.reply({ terminals: cwd ? terminals.list(cwd) : [] });
  };

  const detach = async (msg: Msg<"terminal.detach">, r: Respond) => {
    attached.get(msg.terminalId)?.();
    attached.delete(msg.terminalId);
    return r.reply({});
  };

  const attachInputResizeClose = async (msg: Msg<"terminal.attach" | "terminal.input" | "terminal.resize" | "terminal.close">, r: Respond) => {
    const t = terminals.get(msg.terminalId);
    if (!t) return r.fail("unknown_terminal", `no terminal ${msg.terminalId}`);
    if (msg.type === "terminal.attach") {
      const { buffer, detach } = terminals.attach(t, {
        output: (data) => conn.send({ type: "terminal.output", terminalId: t.id, data }),
        backlog: () => conn.ws.bufferedAmount,
        exit: (exitCode) => (attached.delete(t.id), conn.send({ type: "terminal.exit", terminalId: t.id, exitCode })),
      });
      attached.get(t.id)?.();
      attached.set(t.id, detach);
      return r.reply({ buffer });
    }
    if (msg.type === "terminal.input") {
      if (typeof msg.data !== "string") return r.fail("bad_input", "data must be a string");
      if (Buffer.byteLength(msg.data) > MAX_TERMINAL_INPUT_BYTES) return r.fail("too_large", `terminal input larger than ${MAX_TERMINAL_INPUT_BYTES} bytes`);
      const err = terminals.write(t, msg.data);
      if (err) return r.fail(err, { input_backlog: "the shell has not read the earlier input yet; send again later", unknown_terminal: "the terminal is closed", write_failed: "writing to the terminal failed" }[err]);
    } else if (msg.type === "terminal.resize") {
      if (!isSize(msg.cols) || !isSize(msg.rows)) return r.fail("bad_size", "cols and rows must be integers from 1 to 1000");
      terminals.resize(t, msg.cols, msg.rows);
    } else terminals.close(t);
    return r.reply({});
  };

  const handlers: Handlers<TerminalTypes> = {
    "terminal.create": create,
    "terminal.list": list,
    "terminal.detach": detach,
    "terminal.attach": attachInputResizeClose,
    "terminal.input": attachInputResizeClose,
    "terminal.resize": attachInputResizeClose,
    "terminal.close": attachInputResizeClose,
  };
  return {
    handlers,
    close() {
      attached.forEach((d) => d());
    },
  };
}
