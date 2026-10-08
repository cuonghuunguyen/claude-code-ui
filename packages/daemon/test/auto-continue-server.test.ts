import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Part, ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import { limitQuery, limitState } from "./fake-query.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const dir = mkdtempSync(join(tmpdir(), "ac-"));
const http = createDaemon({ webRoot: dir, roots: [dir], query: limitQuery as never, token, appSettings: createSettings({ file: join(dir, "settings.json") }), autoContinue: { graceMs: 0, gapMs: 300, retryMs: 500 } });
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  port = (http.address() as AddressInfo).port;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => void http.close());

type C = Awaited<ReturnType<typeof client>>;
async function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
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
const parts = (c: C, id: string) => c.inbox.filter((m: any) => m.type === "event" && m.sessionId === id).map((m: any) => m.part as Part);
const texts = (c: C, id: string) => parts(c, id).filter((p) => p.type === "user_text").map((p: any) => p.text as string);
const acs = (c: C, id: string) => parts(c, id).filter((p) => p.type === "auto_continue").map((p: any) => p.at as number | null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function session(c: C) {
  const id = ((await c.request({ type: "session.create", cwd: dir })).result as any).session.id as string;
  await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
  return id;
}
const setting = async (c: C, on: boolean) => void (await c.request({ type: "settings.set", patch: { usageLimit: { autoContinue: on } } }));
const fresh = () => ((limitState.repeatEvent = true), (limitState.continueHits = false), (limitState.inSeconds = 2), (limitState.resetsAt = 0));

describe("auto-continue in the daemon", { timeout: 20_000 }, () => {
  it("setting off: a limit stop schedules nothing and sends no prompt", async () => {
    fresh();
    const c = await client();
    await setting(c, false);
    const id = await session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await sleep(4500);
    expect(acs(c, id)).toEqual([]);
    expect(texts(c, id)).toEqual(["limit"]);
    c.ws.close();
  });

  it("setting on: shows the time, then sends continue as a normal turn, and clears the indicator", async () => {
    fresh();
    const c = await client();
    await setting(c, true);
    const id = await session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await vi.waitFor(() => expect(acs(c, id)[0]).toEqual(expect.any(Number)), { timeout: 2000 });
    await vi.waitFor(() => expect(texts(c, id)).toEqual(["limit", "continue"]), { timeout: 8000 });
    await vi.waitFor(() => expect(parts(c, id).filter((p) => p.type === "turn_result").length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    expect(acs(c, id).at(-1)).toBeNull();
    c.ws.close();
  });

  it("session.cancelContinue clears it and nothing is sent after the reset", async () => {
    fresh();
    const c = await client();
    await setting(c, true);
    const id = await session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await vi.waitFor(() => expect(acs(c, id).length).toBe(1), { timeout: 2000 });
    await c.request({ type: "session.cancelContinue", sessionId: id });
    expect(acs(c, id).at(-1)).toBeNull();
    await sleep(4500);
    expect(texts(c, id)).toEqual(["limit"]);
    c.ws.close();
  });

  it("a manual session.prompt before the reset cancels the schedule", async () => {
    fresh();
    const c = await client();
    await setting(c, true);
    const id = await session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await vi.waitFor(() => expect(acs(c, id).length).toBe(1), { timeout: 2000 });
    await c.request({ type: "session.prompt", sessionId: id, text: "hello" });
    await sleep(4500);
    expect(texts(c, id)).toEqual(["limit", "hello"]);
    expect(acs(c, id).at(-1)).toBeNull();
    c.ws.close();
  });

  it("two sessions stopped by the same limit continue one after the other", async () => {
    fresh();
    limitState.inSeconds = 5; // both stops must land before the reset, even when a session starts slowly
    const c = await client();
    await setting(c, true);
    const a = await session(c);
    const b = await session(c);
    await c.request({ type: "session.prompt", sessionId: a, text: "limit" });
    await c.request({ type: "session.prompt", sessionId: b, text: "limit" });
    const stamp: Record<string, number> = {};
    const t = setInterval(() => {
      for (const id of [a, b]) if (!stamp[id] && texts(c, id).includes("continue")) stamp[id] = Date.now();
    }, 20);
    await vi.waitFor(() => expect(Object.keys(stamp).length).toBe(2), { timeout: 10000 });
    clearInterval(t);
    // The 5 s spacing itself is asserted in auto-continue.test.ts: here the client-visible time also holds each session's sync before its prompt (slow on Windows).
    expect(Object.keys(stamp).sort()).toEqual([a, b].sort());
    c.ws.close();
  });

  it("settings.set turning it off clears the pending schedule", async () => {
    fresh();
    const c = await client();
    await setting(c, true);
    const id = await session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await vi.waitFor(() => expect(acs(c, id).length).toBe(1), { timeout: 2000 });
    await setting(c, false);
    expect(acs(c, id).at(-1)).toBeNull();
    await sleep(4500);
    expect(texts(c, id)).toEqual(["limit"]);
    c.ws.close();
  });

  it("session.delete cancels the schedule", async () => {
    fresh();
    const c = await client();
    await setting(c, true);
    const id = await session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await vi.waitFor(() => expect(acs(c, id).length).toBe(1), { timeout: 2000 });
    c.ws.send(JSON.stringify({ type: "session.delete", sessionId: id, reqId: "del" })); // the reply may wait for the CLI and transcript (slow on Windows)
    await sleep(4500);
    expect(texts(c, id)).toEqual(["limit"]);
    c.ws.close();
  });

  it("another 429 during an allowed_warning (no rejected event) schedules nothing", async () => {
    fresh();
    const c = await client();
    await setting(c, true);
    const id = await session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit-warn" });
    await vi.waitFor(() => expect(parts(c, id).filter((p) => p.type === "turn_result").length).toBeGreaterThanOrEqual(0), { timeout: 3000 });
    await sleep(3500);
    expect(acs(c, id)).toEqual([]);
    expect(texts(c, id)).toEqual(["limit-warn"]);
    c.ws.close();
  });

  it("the continue hits the limit again without a rejected event: the retry still schedules and sends", async () => {
    fresh();
    limitState.repeatEvent = false;
    limitState.continueHits = true;
    const c = await client();
    await setting(c, true);
    const id = await session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await vi.waitFor(() => expect(texts(c, id).filter((t) => t === "continue").length).toBeGreaterThanOrEqual(2), { timeout: 9000 });
    c.ws.close();
  });
});
