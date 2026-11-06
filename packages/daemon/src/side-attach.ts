// `claude-ui side --attach` (ADR 0009): a thin bridge between ssh/wsl/docker stdio and the attach socket of the Hub of this machine (named in
// its daemon.json). Every launch and reattach runs it; it never speaks the protocol.
import { connect as netConnect, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { readDaemonFile } from "./ctl/daemon-file.ts";
import { pidAlive } from "./ctl/connect.ts";
import type { SideSetup } from "@claude-ui/protocol";
import { parseHub, type Hub } from "./hub-probe.ts";
import { attachArgs, shq } from "./sides.ts";
import type { Readable, Writable } from "node:stream";

/** Where a Hub accepts attaching Hubs (ADR 0009): next to its `daemon.json`, else a shorter folder when the path does not fit `sun_path`. */
export function attachSocketPath(env: NodeJS.ProcessEnv, configDir: string, uid: number = process.getuid?.() ?? 0, platform: string = process.platform) {
  if (env.CLAUDE_UI_ATTACH_SOCK) return env.CLAUDE_UI_ATTACH_SOCK;
  // sun_path holds 104 bytes on macOS, 108 on Linux, with the NUL.
  const max = platform === "darwin" ? 103 : 107;
  const long = join(configDir, "attach.sock");
  if (Buffer.byteLength(long) <= max) return long;
  const run = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "claude-ui-attach.sock") : "";
  return run && Buffer.byteLength(run) <= max ? run : join("/tmp", `claude-ui-${uid}`, "attach.sock");
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
 * Where a running attach-started Hub records its install folder (`<root>/.live`, read by the install sweep so an update never deletes the build a
 * Hub still runs on): from the cli path `<root>/<key>/node_modules/claude-code-ui/dist/cli.js`; undefined for any other layout (a source checkout).
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
 * Listens on `path`. EADDRINUSE: a live Hub owns it (`onLive`); else the file is stale
 * (a dead Hub's) and is removed only if it is still the file seen at EADDRINUSE, so two starts never remove each other's new socket.
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
 * Bridges `stdin`/`stdout` to the attach socket of the Hub in `<dir>/daemon.json` until either ends. Prints `CLAUDE_UI_SETUP <code>` and returns 3 (the
 * attaching Hub's setup-error contract) when there is no Hub (`no_daemon`) or a live Hub without an attach socket (`hub_no_attach <version>`).
 * A live Hub whose socket refuses (it retires) is awaited up to `waitMs`, no Hub up to `gapMs` (a Hub that replaces it appears within seconds);
 * only then, with `start`, a Hub is started (`start()` returns at once) when no live pid is named, and awaited up to `waitMs`.
 */
export async function runAttach(o: { dir: string; stdin: Readable; stdout: Writable; start?: () => void; waitMs?: number; gapMs?: number; connect?: (p: string) => Socket; alive?: (pid: number) => boolean }): Promise<number> {
  const connect = o.connect ?? ((p: string) => netConnect(p));
  const alive = o.alive ?? pidAlive;
  const say = (code: string) => (o.stdout.write(`CLAUDE_UI_SETUP ${code}\n`), 3);
  const find = async (spawned: boolean) => {
    const t0 = Date.now();
    let live = spawned;
    for (;;) {
      const d = readDaemonFile(o.dir);
      if (d && alive(d.pid)) {
        live = true;
        if (!d.attach) return { noAttach: d.version };
        const s = await tryConnect(d.attach, connect);
        if (s) return { sock: s };
      }
      if (Date.now() - t0 >= (live ? (o.waitMs ?? 15_000) : (o.gapMs ?? 5_000))) return undefined;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  let r = await find(false);
  if (!r && o.start) {
    const d = readDaemonFile(o.dir);
    // A live pid that still refuses is a Hub on its way: never a second one.
    if (!(d && alive(d.pid))) (o.start(), (r = await find(true)));
  }
  if (!r) return say("no_daemon");
  if ("noAttach" in r) return say(`hub_no_attach ${r.noAttach}`);
  const sock = r.sock;
  return new Promise((resolve) => {
    o.stdin.pipe(sock);
    sock.pipe(o.stdout, { end: false });
    sock.on("error", () => {});
    sock.on("close", () => resolve(0));
    o.stdin.on("end", () => sock.end());
    o.stdin.on("error", () => sock.destroy());
  });
}

/** `[node, ...execArgv, cli.js]` of this process, for daemon.json `exec` (GH-619). Debugger flags are dropped: a bridge replaying `--inspect` would clash on its port. */
export const hubExec = () => [process.execPath, ...process.execArgv.filter((a) => !/^--(inspect|debug)/.test(a)), process.argv[1]!];

/** Runs the bridge of the Hub there: every word quoted. `--start`: when that Hub died since the probe, a Hub of the same build starts (nothing is installed: the cli is there). */
export const hubBridgeScript = (exec: string[]) => `exec ${exec.map(shq).join(" ")} side --attach --start`;

/**
 * The Hub that `run` (a probe through the Side's transport) finds. No probe for an update, Reinstall (`force`) or a pinned start: those must reach the install
 * even when the Hub there has a broken `exec` (its cli folder swept, its Node.js removed). A probe that fails to run counts as no Hub (the install path
 * reports the real error); `fatal` names an error that the install path would hit too (ssh unreachable): thrown at once, not after a second timeout. Not on a reattach: a throw there ends the retries, while the bridge's own failure keeps them.
 */
export async function findHub(o: { runArgs: string; setup: SideSetup; pinned?: boolean; run: () => Promise<{ code: number | null; stdout: string; stderr: string }>; fatal?: (r: { code: number | null; stderr: string }) => string | undefined }): Promise<Hub | undefined> {
  if (o.runArgs === "update" || o.setup === "force" || o.pinned) return undefined;
  let r;
  try {
    r = await o.run();
  } catch {
    return undefined;
  }
  const msg = o.runArgs === attachArgs(true) ? undefined : o.fatal?.(r);
  if (msg) throw new Error(msg);
  // The exit code is not read otherwise: the probe ends non-zero when no Hub runs.
  return parseHub(r.stdout);
}
