// `claude-ui side --attach`: the bridge between ssh stdio and the Side Daemon's Unix socket (ADR 0007).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runAttach, sideSocketPath } from "../src/side-attach.ts";

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
