// `claude-ui side --attach`: the bridge between ssh stdio and the Side Daemon's Unix socket (ADR 0007).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { chmodSync, statSync } from "node:fs";
import { claimSocket, liveInstall, prepareSockDir, runAttach, sideSocketPath } from "../src/side-attach.ts";

let dir: string;
let server: Server | undefined;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "side-attach-"))));
afterEach(() => (server?.close(), rmSync(dir, { recursive: true, force: true })));

const listen = (sock: string) =>
  new Promise<void>((ok) => {
    server = createServer((c) => c.on("data", (d) => c.write(`echo:${d}`))).listen(sock, ok);
  });

it("no Daemon and no --start: prints the setup error and exits 3", async () => {
  const stdout = new PassThrough();
  expect(await runAttach({ sock: join(dir, "none.sock"), stdin: new PassThrough(), stdout })).toBe(3);
  expect(String(stdout.read())).toBe("CLAUDE_UI_SETUP no_daemon\n");
});

it("bridges stdin to the socket and back; ends when stdin ends", async () => {
  const sock = join(dir, "d.sock");
  await listen(sock);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = runAttach({ sock, stdin, stdout });
  stdin.write("hello");
  await new Promise((r) => stdout.once("data", r));
  expect(String(stdout.read() ?? "echo:hello")).toContain("echo:hello");
  stdin.end();
  expect(await done).toBe(0);
});

it("--start: starts the Daemon when none listens, then bridges", async () => {
  const sock = join(dir, "s.sock");
  let started = 0;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = runAttach({ sock, stdin, stdout, start: () => (started++, void listen(sock)) });
  stdin.write("x");
  await new Promise((r) => stdout.once("data", r));
  stdin.end();
  expect(await done).toBe(0);
  expect(started).toBe(1);
});

it("the socket path is the install root's dot file, or CLAUDE_UI_SIDE_SOCK", () => {
  expect(sideSocketPath({}, "/home/u")).toBe("/home/u/.local/share/claude-ui/side/.side.sock");
  expect(sideSocketPath({ CLAUDE_UI_SIDE_SOCK: "/x/y.sock" }, "/home/u")).toBe("/x/y.sock");
});

it("a too long path falls back to XDG_RUNTIME_DIR, else /tmp/claude-ui-<uid>", () => {
  const home = "/h/" + "x".repeat(100);
  expect(sideSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, home, 1000, "linux")).toBe("/run/user/1000/claude-ui-side.sock");
  expect(sideSocketPath({}, home, 1000, "linux")).toBe("/tmp/claude-ui-1000/side.sock");
  expect(sideSocketPath({ XDG_RUNTIME_DIR: "/r/" + "y".repeat(100) }, home, 7, "darwin")).toBe("/tmp/claude-ui-7/side.sock");
  // The limit is 103 bytes on macOS, 107 on Linux.
  const at = (n: number) => "/" + "h".repeat(n - "/.local/share/claude-ui/side/.side.sock".length - 1);
  expect(sideSocketPath({}, at(103), 1, "darwin")).toContain(".local/share");
  expect(sideSocketPath({}, at(104), 1, "darwin")).toBe("/tmp/claude-ui-1/side.sock");
  expect(sideSocketPath({}, at(107), 1, "linux")).toContain(".local/share");
  expect(sideSocketPath({}, at(108), 1, "linux")).toBe("/tmp/claude-ui-1/side.sock");
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
