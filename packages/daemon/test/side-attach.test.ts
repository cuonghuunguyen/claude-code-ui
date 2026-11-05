// `claude-ui side --attach`: the bridge between ssh stdio and the attach socket of the Hub of the machine (ADR 0009).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeDaemonFile } from "../src/ctl/daemon-file.ts";
import { chmodSync, statSync } from "node:fs";
import { claimSocket, liveInstall, prepareSockDir, runAttach, attachSocketPath } from "../src/side-attach.ts";

let dir: string;
let server: Server | undefined;
const servers: Server[] = [];
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "side-attach-"))));
afterEach(() => (servers.forEach((x) => x.close()), servers.length = 0, rmSync(dir, { recursive: true, force: true })));

const listen = (sock: string) =>
  new Promise<void>((ok) => {
    servers.push((server = createServer((c) => c.on("data", (d) => c.write(`echo:${d}`))).listen(sock, ok)));
  });

const info = (attach?: string, pid = process.pid) => ({ port: 1, pid, version: "1.1.0", startedAt: "2026-01-01T00:00:00Z", ...(attach && { attach }) });
const alive = (pid: number) => pid === process.pid;
const run = (o: Partial<Parameters<typeof runAttach>[0]> = {}) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return { stdin, stdout, done: runAttach({ dir, stdin, stdout, alive, waitMs: 3000, gapMs: 150, ...o }) };
};
/** Writes a line and waits for the echo; then ends stdin. */
const bridged = async (r: ReturnType<typeof run>) => {
  r.stdin.write("hello");
  await new Promise((ok) => r.stdout.once("data", ok));
  r.stdin.end();
  expect(await r.done).toBe(0);
};

it("a live Hub with an attach socket: bridges stdin to the socket and back; ends when stdin ends", async () => {
  const sock = join(dir, "d.sock");
  await listen(sock);
  writeDaemonFile(dir, info(sock));
  const r = run();
  const got: string[] = [];
  r.stdout.on("data", (b) => got.push(String(b)));
  await bridged(r);
  expect(got.join("")).toBe("echo:hello");
});

it("a live Hub without an attach socket: prints hub_no_attach with its version and exits 3", async () => {
  writeDaemonFile(dir, info());
  const r = run();
  expect(await r.done).toBe(3);
  expect(String(r.stdout.read())).toBe("CLAUDE_UI_SETUP hub_no_attach 1.1.0\n");
});

it("a dead pid and --start: starts a Hub, then connects once its daemon.json appears", async () => {
  const sock = join(dir, "s.sock");
  writeDaemonFile(dir, info(sock, 999999));
  let started = 0;
  const r = run({ start: () => (started++, void listen(sock).then(() => writeDaemonFile(dir, info(sock)))) });
  await bridged(r);
  expect(started).toBe(1);
});

it("no Hub and no --start: no_daemon, exit 3", async () => {
  const r = run();
  expect(await r.done).toBe(3);
  expect(String(r.stdout.read())).toBe("CLAUDE_UI_SETUP no_daemon\n");
});

it("a live Hub whose socket refuses, then a new daemon.json with a listening socket: bridges, never starts a second Hub", async () => {
  const gone = join(dir, "gone.sock");
  const fresh = join(dir, "fresh.sock");
  writeDaemonFile(dir, info(gone));
  setTimeout(() => void listen(fresh).then(() => writeDaemonFile(dir, info(fresh))), 250);
  const start = vi.fn();
  await bridged(run({ start }));
  expect(start).not.toHaveBeenCalled();
});

it("nothing appears within waitMs: --start ran once, then no_daemon", async () => {
  const start = vi.fn();
  const r = run({ start, waitMs: 300 });
  expect(await r.done).toBe(3);
  expect(start).toHaveBeenCalledTimes(1);
  expect(String(r.stdout.read())).toBe("CLAUDE_UI_SETUP no_daemon\n");
});

it("the attach socket path is CLAUDE_UI_ATTACH_SOCK, else next to daemon.json", () => {
  expect(attachSocketPath({}, "/home/u/.config/claude-ui", 1, "linux")).toBe("/home/u/.config/claude-ui/attach.sock");
  expect(attachSocketPath({ CLAUDE_UI_ATTACH_SOCK: "/x/y.sock" }, "/home/u/.config/claude-ui")).toBe("/x/y.sock");
});

it("a too long path falls back to XDG_RUNTIME_DIR, else /tmp/claude-ui-<uid>", () => {
  const cfg = "/h/" + "x".repeat(100);
  expect(attachSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, cfg, 1000, "linux")).toBe("/run/user/1000/claude-ui-attach.sock");
  expect(attachSocketPath({}, cfg, 1000, "linux")).toBe("/tmp/claude-ui-1000/attach.sock");
  expect(attachSocketPath({ XDG_RUNTIME_DIR: "/r/" + "y".repeat(100) }, cfg, 7, "darwin")).toBe("/tmp/claude-ui-7/attach.sock");
  // The limit is 103 bytes on macOS, 107 on Linux.
  const at = (n: number) => "/" + "h".repeat(n - "/attach.sock".length - 1);
  expect(attachSocketPath({}, at(103), 1, "darwin")).toContain("/attach.sock");
  expect(attachSocketPath({}, at(104), 1, "darwin")).toBe("/tmp/claude-ui-1/attach.sock");
  expect(attachSocketPath({}, at(107), 1, "linux")).toContain("hhh");
  expect(attachSocketPath({}, at(108), 1, "linux")).toBe("/tmp/claude-ui-1/attach.sock");
});

it("a Daemon records its install folder next to the installs, for the sweep", () => {
  expect(liveInstall("/h/.local/share/claude-ui/side/1.2-3/node_modules/claude-code-ui/dist/cli.js")).toEqual({ file: "/h/.local/share/claude-ui/side/.live", dir: "/h/.local/share/claude-ui/side/1.2-3" });
  expect(liveInstall("/src/packages/daemon/src/main.ts")).toBeUndefined();
});

it("the socket folder is made mode 0700 and a folder of another user is refused", () => {
  const d = join(dir, "a", "b");
  prepareSockDir(d, process.getuid!());
  expect(statSync(d).mode & 0o777).toBe(0o700);
  chmodSync(d, 0o755);
  prepareSockDir(d, process.getuid!());
  expect(statSync(d).mode & 0o777).toBe(0o700);
  expect(() => prepareSockDir(d, process.getuid!() + 1)).toThrow("another user");
});

it("listenPrivate: the socket is 0600 and the process umask is restored (children must not inherit 0177)", async () => {
  const before = process.umask();
  const { listenPrivate } = await import("../src/side-attach.ts");
  const { statSync } = await import("node:fs");
  const sock = join(dir, "p.sock");
  server = createServer();
  await new Promise<void>((ok) => (listenPrivate(server!, sock), server!.once("listening", ok)));
  expect(statSync(sock).mode & 0o777).toBe(0o600);
  expect(process.umask()).toBe(before);
});

it("prepareSockDir refuses a symlink in place of the folder", () => {
  const real = join(dir, "real");
  mkdirSync(real);
  const link = join(dir, "link");
  symlinkSync(real, link);
  expect(() => prepareSockDir(link, process.getuid!())).toThrow("not a folder");
  writeFileSync(join(dir, "file"), "");
  expect(() => prepareSockDir(join(dir, "file"), process.getuid!())).toThrow();
});

it("claimSocket: two Daemons that meet a stale socket file: exactly one owns the socket, the other leaves", async () => {
  const sock = join(dir, "c.sock");
  writeFileSync(sock, ""); // stale: a regular file of a dead Daemon
  const a = createServer();
  const b = createServer();
  const live: string[] = [];
  const errors: Error[] = [];
  const listening = (s: Server) => new Promise<void>((ok) => s.once("listening", ok));
  const first = listening(a);
  claimSocket(a, sock, { onLive: () => live.push("a"), onError: (e) => errors.push(e) });
  claimSocket(b, sock, { onLive: () => live.push("b"), onError: (e) => errors.push(e) });
  await Promise.race([first, new Promise((r) => setTimeout(r, 2000))]);
  await new Promise((r) => setTimeout(r, 200));
  expect([a.listening, b.listening].filter(Boolean).length).toBe(1);
  expect(live.length + [a.listening, b.listening].filter(Boolean).length).toBe(2);
  expect(errors).toEqual([]);
  a.close();
  b.close();
});

it("claimSocket: a live Daemon owns the socket: the second start leaves it alone", async () => {
  const sock = join(dir, "l.sock");
  await listen(sock);
  const second = createServer();
  const live = await new Promise<boolean>((ok) => claimSocket(second, sock, { onLive: () => ok(true), onError: () => ok(false) }));
  expect(live).toBe(true);
  expect(second.listening).toBe(false);
  expect(statSync(sock).isSocket()).toBe(true); // not removed
});
