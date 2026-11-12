// A request to an OpenCode server that died before the daemon saw its exit: the server restarts once and the request is answered.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenCodeServer } from "../src/opencode-server.ts";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

// On Windows the pid is gone before the sockets of the dead server close, so a pooled keep-alive connection still looks open: the request
// was written into it and met a reset after the connect (`fetch failed`, read ECONNRESET), which request() must not take for a delivered request.
it("a server that died with its connections still open is restarted by the next request, which is answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-"));
  const log = join(dir, "log.jsonl");
  const server = createOpenCodeServer({ path: () => "", command: [process.execPath, BIN], env: () => ({ FAKE_OPENCODE_LOG: log }) });
  try {
    const first = await server.ensure();
    await server.request("/session");
    // `connection: close`: the test's own connection must not stay in the shared pool.
    await fetch(`${first.url}/__zombie`, { method: "POST", headers: { connection: "close" } });
    expect(await server.request("/session")).toEqual([]);
    const starts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "start");
    expect(starts).toHaveLength(2);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// Windows, seen in a full suite: the pid of the killed server is gone and its exit not seen yet, and its listening socket still completes the
// handshake and then resets (read or write ECONNRESET after the connect, never a refused connect). The fake's /__dying holds that window open.
describe("a dead server whose listening socket still accepts and resets", () => {
  const boot = async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    const log = join(dir, "log.jsonl");
    const server = createOpenCodeServer({ path: () => "", command: [process.execPath, BIN], env: () => ({ FAKE_OPENCODE_LOG: log }) });
    cleanups.push(async () => (await server.stop(), rmSync(dir, { recursive: true, force: true })));
    const first = await server.ensure();
    await fetch(`${first.url}/__dying`, { method: "POST", headers: { connection: "close" } });
    const starts = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "start");
    return { server, starts };
  };

  it("a GET is sent to a new server and answered", async () => {
    const { server, starts } = await boot();
    expect(await server.request("/session")).toEqual([]);
    expect(starts()).toHaveLength(2);
  }, 30_000);

  it("a create (POST /session, safe to send again) is sent to a new server and answered", async () => {
    const { server, starts } = await boot();
    const row = await server.request<{ id: string }>("/session", { method: "POST", body: {}, resend: true });
    expect(row.id).toMatch(/^ses_/);
    expect(starts()).toHaveLength(2);
  }, 30_000);

  it("a POST that is not safe to send again fails; the dead server is dropped and the next request starts a new one", async () => {
    const { server, starts } = await boot();
    await expect(server.request("/session/ses_x/prompt_async", { method: "POST", body: {} })).rejects.toThrow("fetch failed");
    expect(server.running()).toBe(false);
    expect(await server.request("/session")).toEqual([]);
    expect(starts()).toHaveLength(2);
  }, 30_000);
});
