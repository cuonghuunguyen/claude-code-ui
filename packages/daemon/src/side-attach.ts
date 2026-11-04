// `claude-ui side --attach` (ADR 0007): a thin bridge between ssh stdio and the Side Daemon's Unix socket. The launching ssh and every
// later reattach run it; it never speaks the protocol.
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** Where the Side Daemon listens: next to the installs (the install sweep never touches a dot name), so a newer build finds an older Daemon. */
export const sideSocketPath = (env: NodeJS.ProcessEnv, home: string) => env.CLAUDE_UI_SIDE_SOCK || join(home, ".local", "share", "claude-ui", "side", ".side.sock");

const tryConnect = (path: string, connect: (p: string) => Socket) =>
  new Promise<Socket | undefined>((resolve) => {
    const s = connect(path);
    s.once("connect", () => (s.removeAllListeners("error"), resolve(s)));
    s.once("error", () => (s.destroy(), resolve(undefined)));
  });

/**
 * Bridges `stdin`/`stdout` to the socket until either ends. No Daemon: with `start` it is started (`start()` returns at once) and the
 * socket awaited up to `waitMs`; else `CLAUDE_UI_SETUP no_daemon` is printed and the exit code is 3 (the hub's setup-error contract).
 */
export async function runAttach(o: { sock: string; stdin: Readable; stdout: Writable; start?: () => void; waitMs?: number; connect?: (p: string) => Socket }): Promise<number> {
  const connect = o.connect ?? ((p: string) => netConnect(p));
  let s = await tryConnect(o.sock, connect);
  if (!s && o.start) {
    o.start();
    for (let t = 0; !s && t < (o.waitMs ?? 15_000); t += 100) {
      await new Promise((r) => setTimeout(r, 100));
      s = await tryConnect(o.sock, connect);
    }
  }
  if (!s) return (o.stdout.write("CLAUDE_UI_SETUP no_daemon\n"), 3);
  const sock = s;
  return new Promise((resolve) => {
    o.stdin.pipe(sock);
    sock.pipe(o.stdout, { end: false });
    sock.on("error", () => {});
    sock.on("close", () => resolve(0));
    o.stdin.on("end", () => sock.end());
    o.stdin.on("error", () => sock.destroy());
  });
}
