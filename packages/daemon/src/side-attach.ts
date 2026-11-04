// `claude-ui side --attach` (ADR 0007): a thin bridge between ssh stdio and the Side Daemon's Unix socket. The launching ssh and every
// later reattach run it; it never speaks the protocol.
import { connect as netConnect, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Readable, Writable } from "node:stream";

/** Where the Side Daemon listens: next to the installs (the install sweep never touches a dot name), so a newer build finds an older Daemon. */
export function sideSocketPath(env: NodeJS.ProcessEnv, home: string, uid: number = process.getuid?.() ?? 0, platform: string = process.platform) {
  if (env.CLAUDE_UI_SIDE_SOCK) return env.CLAUDE_UI_SIDE_SOCK;
  // sun_path holds 104 bytes on macOS, 108 on Linux, with the NUL.
  const max = platform === "darwin" ? 103 : 107;
  const long = join(home, ".local", "share", "claude-ui", "side", ".side.sock");
  if (Buffer.byteLength(long) <= max) return long;
  const run = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "claude-ui-side.sock") : "";
  return run && Buffer.byteLength(run) <= max ? run : join("/tmp", `claude-ui-${uid}`, "side.sock");
}

let outer: number | undefined;
/** Listens on a Unix socket created with mode 0600. The umask is process-wide and children inherit it (the Claude CLI, terminals, git), so it is restored once listening. */
export function listenPrivate(server: Server, path: string) {
  const prev = process.umask(0o177);
  outer ??= prev;
  // Also on an error (EADDRINUSE of a lost race): the mask must not stay 0177.
  const restore = () => outer !== undefined && (process.umask(outer), (outer = undefined));
  server.once("listening", restore);
  server.once("error", restore);
  server.listen(path);
}

/**
 * Where a running Side Daemon records its install folder (`<root>/.live`, read by the install sweep so an update never deletes the build a
 * Daemon still runs on): from the cli path `<root>/<key>/node_modules/claude-code-ui/dist/cli.js`; undefined for any other layout (a source checkout).
 */
export function liveInstall(cli: string): { file: string; dir: string } | undefined {
  const tail = ["node_modules", "claude-code-ui", "dist", "cli.js"];
  const parts = cli.split(sep);
  if (tail.some((t, i) => parts.at(i - 4) !== t)) return undefined;
  const dir = parts.slice(0, -4).join(sep);
  return { file: join(dirname(dir), ".live"), dir };
}

/** Makes the socket's folder (mode 0700); a folder another user owns, or a symlink in its place, is refused (a shared /tmp). */
export function prepareSockDir(dir: string, uid: number | undefined = process.getuid?.()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a folder`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is owned by another user`);
  if (uid !== undefined) chmodSync(dir, 0o700);
}

/**
 * Listens on `path`. EADDRINUSE: a live Daemon owns it (`onLive`, a second start that lost the race leaves); else the file is stale
 * (a dead Daemon's) and is removed only if it is still the file seen at EADDRINUSE, so two starts never remove each other's new socket.
 * shortcut: the stat -> rm gap stays (no atomic compare-and-remove on a path), upgrade when a lock file is needed.
 */
export function claimSocket(server: Server, path: string, o: { onLive: () => void; onError: (e: Error) => void; connect?: (p: string) => Socket }) {
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE") return o.onError(e);
    const seen = statSync(path, { throwIfNoEntry: false })?.ino;
    const probe = (o.connect ?? ((p: string) => netConnect(p)))(path);
    probe.once("connect", () => (probe.destroy(), o.onLive()));
    probe.once("error", () => {
      probe.destroy();
      if (statSync(path, { throwIfNoEntry: false })?.ino === seen) rmSync(path, { force: true });
      listenPrivate(server, path);
    });
  });
  listenPrivate(server, path);
}

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
