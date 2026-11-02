import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import { permissionQuery } from "./fake-query.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const dir = mkdtempSync(join(tmpdir(), "sleep-"));
let clock = 1_000_000;
const mk = (watchSleep?: object) => createDaemon({ webRoot: dir, roots: [dir], query: permissionQuery as never, token, appSettings: createSettings({ file: join(dir, `s${Math.random()}.json`) }), ...(watchSleep && { watchSleep }) });
const http = mk({ everyMs: 1e9, now: () => clock });
const plain = mk();
let port = 0;
let plainPort = 0;
beforeAll(async () => {
  for (const h of [http, plain]) await new Promise<void>((r) => h.listen(0, "127.0.0.1", r));
  port = (http.address() as AddressInfo).port;
  plainPort = (plain.address() as AddressInfo).port;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => void (http.close(), plain.close()));

async function client(p = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${p}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return vi.waitFor(() => inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) ?? Promise.reject(new Error("no reply")), { timeout: 5000 }) as unknown as Promise<{ result?: any }>;
  };
  return { ws, inbox, request };
}
const slept = (c: { inbox: ServerMessage[] }) => c.inbox.filter((m) => m.type === "daemon_slept");
const settle = () => new Promise((r) => setTimeout(r, 100));

it("a sleep during a run goes to every connection once, and to each later connection once", { timeout: 20_000 }, async () => {
  const a = await client();
  const id = ((await a.request({ type: "session.create", cwd: dir })).result as any).session.id as string;
  await a.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
  await a.request({ type: "session.prompt", sessionId: id, text: "go" });
  await vi.waitFor(() => a.inbox.find((m: any) => m.type === "event" && m.part.type === "permission_request") ?? Promise.reject(new Error("no request")), { timeout: 5000 });
  const b = await client(); // a check while the session waits: it counts as running
  expect(slept(b)).toEqual([]);
  clock += 61_000;
  const c = await client(); // the connection finds the gap
  await settle();
  expect(slept(a)).toEqual([{ type: "daemon_slept", at: clock, gapMs: 61_000 }]);
  expect(slept(b)).toHaveLength(1);
  expect(slept(c)).toEqual(slept(a));
  const d = await client();
  await settle();
  expect(slept(d)).toEqual(slept(a));
  for (const x of [a, b, c, d]) x.ws.close();
});

it("a sleep older than 24 h is dropped, not sent to a new connection", { timeout: 20_000 }, async () => {
  let now2 = 5_000_000;
  const d2 = mk({ everyMs: 1e9, now: () => now2 });
  await new Promise<void>((r) => d2.listen(0, "127.0.0.1", r));
  const p2 = (d2.address() as AddressInfo).port;
  const a = await client(p2);
  const id = ((await a.request({ type: "session.create", cwd: dir })).result as any).session.id as string;
  await a.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
  await a.request({ type: "session.prompt", sessionId: id, text: "go" });
  const req = await vi.waitFor(() => a.inbox.find((m: any) => m.type === "event" && m.part.type === "permission_request") ?? Promise.reject(new Error("no request")), { timeout: 5000 });
  const b = await client(p2); // was = running
  now2 += 61_000;
  const c = await client(p2); // sleep found
  await settle();
  expect(slept(c)).toHaveLength(1);
  await a.request({ type: "permission.respond", requestId: (req as any).part.requestId, decision: "allow" });
  await vi.waitFor(() => a.inbox.find((m: any) => m.type === "event" && m.part.type === "session_state" && m.part.state === "idle") ?? Promise.reject(new Error("not idle")), { timeout: 5000 });
  const e = await client(p2); // still within 24 h: replayed; this check sees idle
  await settle();
  expect(slept(e)).toHaveLength(1);
  now2 += 24 * 3600_000 + 1;
  const f = await client(p2);
  await settle();
  expect(slept(f)).toEqual([]);
  for (const x of [a, b, c, e, f]) x.ws.close();
  d2.close();
});

it("a daemon without watchSleep never reports one", async () => {
  const c = await client(plainPort);
  await settle();
  expect(slept(c)).toEqual([]);
  c.ws.close();
});
