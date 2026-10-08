// git.status requests for one folder that arrive while its read runs share that read (one set of git processes, not one per request).
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";

let release: () => void = () => {};
const gitStatus = vi.fn(() => new Promise((r) => (release = () => r({ branch: "main", added: 1, removed: 0 }))));
vi.mock("../src/git.ts", async (orig) => ({ ...(await orig<typeof import("../src/git.ts")>()), gitStatus }));
const { createDaemon } = await import("../src/server.ts");
const { fakeQuery } = await import("./fake-query.ts");

const webRoot = mkdtempSync(join(tmpdir(), "web-"));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const http = createDaemon({ webRoot, roots: [webRoot], query: fakeQuery as never, token, history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never } });
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const { port } = http.address() as AddressInfo;
afterAll(() => void http.close());

it("git.status requests for one folder while its read runs share it; a request after it ends reads again", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const replies = new Map<string, unknown>();
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.reqId) replies.set(m.reqId, m);
  });
  await new Promise((r) => ws.once("open", r));
  const ask = (reqId: string) => ws.send(JSON.stringify({ type: "git.status", cwd: webRoot, reqId }));
  const reply = (reqId: string) => vi.waitFor(() => replies.get(reqId) ?? Promise.reject(new Error("no reply")));
  ["a", "b", "c"].forEach(ask);
  await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 50));
  expect(gitStatus).toHaveBeenCalledTimes(1);
  release();
  for (const id of ["a", "b", "c"]) expect(await reply(id)).toMatchObject({ type: "reply", result: { status: { branch: "main", added: 1 } } });
  ask("d");
  await vi.waitFor(() => expect(gitStatus).toHaveBeenCalledTimes(2));
  release();
  expect(await reply("d")).toMatchObject({ type: "reply" });
  ws.close();
});
