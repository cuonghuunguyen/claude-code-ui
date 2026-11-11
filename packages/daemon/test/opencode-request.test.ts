// OpenCode keeps a request cut off during a folder's MCP load as the folder's state (GH-682): a request's timeout stops the caller waiting, it never aborts the request.
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createOpenCodeServer } from "../src/opencode-server.ts";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

it("a request that times out is left running: the caller gets a TimeoutError, the folder is not broken, a later read gets its answer", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocr-")));
  const logFile = join(root, "fake.log");
  const server = createOpenCodeServer({ path: () => "", command: [process.execPath, BIN], env: () => ({ FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_MCP_LOAD_MS: "1500" }) });
  cleanups.push(() => server.close());
  const cut = await server.request("/command", { directory: root, timeoutMs: 300 }).catch((err: Error) => err);
  expect(cut).toMatchObject({ name: "TimeoutError", message: expect.stringMatching(/GET \/command did not answer in 300 ms/) });
  // The fake breaks a folder whose waiting request is cut off (like OpenCode 1.19.5): this one is still waiting, so the read works.
  expect(await server.request<{ name: string }[]>("/command", { directory: root })).toEqual(expect.arrayContaining([expect.objectContaining({ name: "init" })]));
  expect(await server.request("/mcp", { directory: root })).toEqual({});
  const paths = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "request").map((l) => l.path);
  expect(paths.filter((p: string) => p === "/command")).toHaveLength(2);
}, 20_000);

it("two concurrent requests to a server that died restart it once; the one that times out still runs to its answer on the new server (GH-682 merged with GH-685)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocr-")));
  const logFile = join(root, "fake.log");
  const server = createOpenCodeServer({ path: () => "", command: [process.execPath, BIN], env: () => ({ FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_MCP_LOAD_MS: "1500" }) });
  cleanups.push(() => server.close());
  const log = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  const srv = await server.ensure();
  // The server stops answering and its process stays (no exit event): both requests meet it, each probes it, only the first drops it, both are sent
  // again to the one new server.
  await fetch(`${srv.url}/__deaf`, { method: "POST", body: "{}" });
  await new Promise((r) => setTimeout(r, 200));
  const [cut, status] = await Promise.all([server.request("/command", { directory: root, timeoutMs: 300 }).catch((err: Error) => err), server.request("/session/status", { directory: root })]);
  expect(cut).toMatchObject({ name: "TimeoutError" });
  expect(status).toEqual({});
  const starts = log().filter((l) => l.type === "start");
  expect(starts).toHaveLength(2);
  // The timed-out GET /command was not cut off: it waits for the load on the new server, so the folder is not broken there.
  await new Promise((r) => setTimeout(r, 2000));
  expect(await server.request("/mcp", { directory: root })).toEqual({});
  expect(log().filter((l) => l.type === "start")).toHaveLength(2);
  expect(server.running()).toBe(true);
}, 30_000);

it("E2E harness: with CLAUDE_UI_E2E_OPENCODE_INFO the daemon writes the url and auth of its OpenCode server there; without it nothing is written", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocr-")));
  const info = join(root, "opencode-server.json");
  const make = () => createOpenCodeServer({ path: () => "", command: [process.execPath, BIN] });
  const none = make();
  cleanups.push(() => none.close());
  await none.ensure();
  expect(existsSync(info)).toBe(false);
  process.env.CLAUDE_UI_E2E_OPENCODE_INFO = info;
  cleanups.push(() => delete process.env.CLAUDE_UI_E2E_OPENCODE_INFO);
  const server = make();
  cleanups.push(() => server.close());
  await server.ensure();
  const written = JSON.parse(readFileSync(info, "utf8")) as { url: string; auth: string };
  expect(written.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect((await fetch(`${written.url}/global/health`, { headers: { authorization: written.auth } })).ok).toBe(true);
}, 20_000);
