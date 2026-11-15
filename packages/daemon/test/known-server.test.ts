// GH-771: daemon_hello on connect, session.subscribe `known` -> snapshot refs, the same-epoch seq guard, on a real daemon.
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { partHash, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type Part, type ServerMessage, type SnapshotWire } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";

const webRoot = realpathSync(mkdtempSync(join(tmpdir(), "known-")));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const sessionId = "7d4e5f60-8192-4ca3-9db4-c5d6e7f8091a";

// Turns 1 and 2 are long, turn 3 short: the bytes of a resume are the changed turn, not the cached ones.
const long = (n: number) => (n < 2 ? `${"lorem ipsum dolor sit amet ".repeat(400)}#${n}` : `#${n}`);
const msgs = Array.from({ length: 3 }, (_, i) => [
  { type: "user", uuid: `u${i}`, session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: `prompt ${i} ${long(i)}` } },
  { type: "assistant", uuid: `a${i}`, session_id: sessionId, parent_tool_use_id: null, message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: `answer ${i} ${long(i)}` }], stop_reason: "end_turn" } },
]).flat();

const history = { listSessions: (async () => []) as never, getSessionInfo: (async (sid: string) => (sid === sessionId ? { sessionId, cwd: webRoot, summary: "Known" } : undefined)) as never, getSessionMessages: (async () => msgs) as never };
const start = async (extra: object = {}) => {
  const d = createDaemon({ webRoot, roots: [webRoot], query: fakeQuery as never, token, modelListWaitMs: 0, opencode: { listWaitMs: 200 }, history, uploadDir: join(mkdtempSync(join(tmpdir(), "known-up-")), "uploads"), ...extra });
  await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
  return { d, port: (d.address() as AddressInfo).port };
};

async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return (await vi.waitFor(() => inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) ?? Promise.reject(new Error("no reply")), { timeout: 5000 })) as { type: string; result?: any; code?: string };
  };
  return { ws, inbox, request };
}

const daemons: { close: () => unknown }[] = [];
afterAll(() => daemons.forEach((d) => d.close()));

describe("daemon_hello", () => {
  it("is the first message on a connection, before plan_usage and the rest; carries the daemonId option and the epoch the subscribe reply names", async () => {
    const { d, port } = await start({ daemonId: "daemon-fixed-id" });
    daemons.push(d);
    const c = await client(port);
    await vi.waitFor(() => expect(c.inbox.length).toBeGreaterThan(0));
    expect(c.inbox[0]).toMatchObject({ type: "daemon_hello", daemonId: "daemon-fixed-id", logEpoch: expect.any(String) });
    const sub = await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true });
    expect((c.inbox[0] as { logEpoch: string }).logEpoch).toBe(sub.result.logEpoch);
    // A second connection of the same daemon: same hello.
    const c2 = await client(port);
    await vi.waitFor(() => expect(c2.inbox.length).toBeGreaterThan(0));
    expect(c2.inbox[0]).toEqual(c.inbox[0]);
    c.ws.close();
    c2.ws.close();
  });

  it("without the option a daemon makes its own id; a restart with the same daemonId has a new logEpoch", async () => {
    const a = await start({ daemonId: "same" });
    const b = await start({ daemonId: "same" });
    const own = await start();
    daemons.push(a.d, b.d, own.d);
    const [ca, cb, co] = await Promise.all([client(a.port), client(b.port), client(own.port)]);
    await vi.waitFor(() => expect([ca, cb, co].every((c) => c.inbox.length > 0)).toBe(true));
    const hello = (c: { inbox: ServerMessage[] }) => c.inbox[0] as { daemonId: string; logEpoch: string };
    expect(hello(ca).daemonId).toBe(hello(cb).daemonId);
    expect(hello(ca).logEpoch).not.toBe(hello(cb).logEpoch);
    expect(hello(co).daemonId).toBeTruthy();
    [ca, cb, co].forEach((c) => c.ws.close());
  });
});

describe("session.subscribe known", () => {
  it("after a restart: cached turns come as refs, a changed part and a new turn whole; the reply is under 20% of the one without known", async () => {
    // First run: what the page cached.
    const first = await start({ daemonId: "x" });
    daemons.push(first.d);
    const c1 = await client(first.port);
    const cached = (await c1.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true })).result.snapshot as SnapshotWire;
    const cachedParts = cached.page.parts as Part[];
    expect(cachedParts.length).toBe(6);
    c1.ws.close();
    // The page cached turns 1 and 2 (the first 4 parts) and an out-of-date copy of the third turn's answer.
    const known: [string, string][] = [...cachedParts.slice(0, 4).map((p): [string, string] => [p.id, partHash(p)]), [cachedParts[5]!.id, "stale"]];

    const second = await start({ daemonId: "x" });
    daemons.push(second.d);
    const c2 = await client(second.port);
    const plain = await c2.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true });
    const plainSize = JSON.stringify(plain).length;
    const c3 = await client(second.port);
    const withKnown = await c3.request({ type: "session.subscribe", sessionId, sinceSeq: 7, logEpoch: "older-epoch", paged: true, known });
    const snap = withKnown.result.snapshot as SnapshotWire;
    expect(snap.refs).toBe(true);
    expect(snap.page.parts.map((p) => ("ref" in p ? "ref" : "part"))).toEqual(["ref", "ref", "ref", "ref", "part", "part"]);
    expect((snap.page.parts[0] as { ref: string }).ref).toBe(cachedParts[0]!.id);
    expect(snap.page.parts[5]).toEqual(cachedParts[5]);
    expect(JSON.stringify(withKnown).length).toBeLessThan(plainSize * 0.2);
    // Everything known: reply size below 20% of the plain reply.
    const all = await c3.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true, known: cachedParts.map((p): [string, string] => [p.id, partHash(p)]) });
    expect(JSON.stringify(all).length).toBeLessThan(plainSize * 0.2);
    [c2, c3].forEach((c) => c.ws.close());
  });

  it("a malformed known is bad_request", async () => {
    const { d, port } = await start();
    daemons.push(d);
    const c = await client(port);
    const bad: unknown[] = ["x", [["a"]], [["a", 1]], [[1, "h"]], [["a".repeat(201), "h"]], [["a", "h".repeat(17)]], Array.from({ length: 5001 }, (_, i) => [`p${i}`, "h"]), [{ a: "b" }]];
    for (const known of bad) expect(await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true, known })).toMatchObject({ type: "error", code: "bad_request" });
    expect((await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true, known: [] })).result.snapshot).toBeDefined();
    c.ws.close();
  });

  it("known is ignored when the reply is a replay, not a snapshot (same epoch, since > 0, or not paged)", async () => {
    const { d, port } = await start();
    daemons.push(d);
    const c = await client(port);
    const first = await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true });
    const known: [string, string][] = (first.result.snapshot.page.parts as Part[]).map((p) => [p.id, partHash(p)]);
    const again = await c.request({ type: "session.subscribe", sessionId, sinceSeq: first.result.seq, logEpoch: first.result.logEpoch, paged: true, known });
    expect(again.result.snapshot).toBeUndefined();
    const unpaged = await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0, known });
    expect(unpaged.result.snapshot).toBeUndefined();
    c.ws.close();
  });

  it("same epoch with sinceSeq above the session's seq (dropped and restored in one run) answers a snapshot", async () => {
    const { d, port } = await start();
    daemons.push(d);
    const c = await client(port);
    const first = await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true });
    const r = await c.request({ type: "session.subscribe", sessionId, sinceSeq: first.result.seq + 1000, logEpoch: first.result.logEpoch, paged: true });
    expect(r.result.snapshot).toBeDefined();
    expect(r.result.snapshot.refs).toBeUndefined();
    c.ws.close();
  });
});
