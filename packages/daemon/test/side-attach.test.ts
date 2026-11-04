// `claude-ui side --attach`: the bridge between ssh stdio and the Side Daemon's Unix socket (ADR 0007).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { chmodSync, statSync } from "node:fs";
import { prepareSockDir, runAttach, sideSocketPath } from "../src/side-attach.ts";

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

it("the socket folder is made mode 0700 and a folder of another user is refused", () => {
  const d = join(dir, "a", "b");
  prepareSockDir(d, process.getuid!());
  expect(statSync(d).mode & 0o777).toBe(0o700);
  chmodSync(d, 0o755);
  prepareSockDir(d, process.getuid!());
  expect(statSync(d).mode & 0o777).toBe(0o700);
  expect(() => prepareSockDir(d, process.getuid!() + 1)).toThrow("another user");
});
