// GH-767: incremental resync on a real daemon: session.list versions, the send feed with backpressure, the background gap snapshot.
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Event, ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { FEED_HIGH } from "../src/feed.ts";
import { createDaemon, REPLAY_MAX_EVENTS } from "../src/server.ts";

expect(REPLAY_MAX_EVENTS).toBe(500);
/** The test daemon's limit: a few turns pass it. */
const GAP = 12;
import { fakeQuery } from "./fake-query.ts";

const webRoot = realpathSync(mkdtempSync(join(tmpdir(), "resync-")));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const daemon = createDaemon({ webRoot, roots: [webRoot], query: fakeQuery as never, token, replayMaxEvents: GAP, modelListWaitMs: 0, opencode: { listWaitMs: 200 }, history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never }, uploadDir: join(mkdtempSync(join(tmpdir(), "resync-up-")), "uploads") });
await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
const { port } = daemon.address() as AddressInfo;
afterAll(() => void daemon.close());

async function client() {
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

/** A connection without HTTP (a side's virtual one): its `bufferedAmount` is the test's. */
function virtual() {
  const sent: any[] = [];
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (x: string) => void sent.push(JSON.parse(x)), close() {}, ping() {}, terminate() {} });
  daemon.accept(ws as never);
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.emit("message", Buffer.from(JSON.stringify({ ...msg, reqId })));
    return (await vi.waitFor(() => sent.find((m) => m.reqId === reqId && (m.type === "reply" || m.type === "error")) ?? Promise.reject(new Error("no reply")), { timeout: 5000 })) as { type: string; result?: any; code?: string };
  };
  return { ws, sent, request, events: (id: string) => sent.filter((m) => m.type === "event" && m.sessionId === id) as Event[] };
}

const idle = (events: () => Event[], n = 1) => vi.waitFor(() => expect(events().filter((e) => e.part.type === "session_state" && (e.part as { state?: string }).state === "idle").length).toBeGreaterThanOrEqual(n), { timeout: 10_000 });

describe("session.list versions", () => {
  it("answers a delta against the version the page names: only the changed row, every id in order", async () => {
    const c = await client();
    const a = (await c.request({ type: "session.create", cwd: webRoot })).result.session.id as string;
    const first = await c.request({ type: "session.list", since: "" });
    expect(first.result.version).toBeTypeOf("string");
    expect(first.result.delta).toBeUndefined();
    const all = first.result.sessions.map((s: { id: string }) => s.id);
    expect(all).toContain(a);
    // Nothing changed: a delta without rows.
    const same = await c.request({ type: "session.list", since: first.result.version });
    expect(same.result).toMatchObject({ delta: true, version: first.result.version, ids: all, sessions: [] });
    // A rename changes one row.
    await c.request({ type: "session.subscribe", sessionId: a, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: a, text: "hello" });
    await vi.waitFor(async () => expect((await c.request({ type: "session.list", since: "" })).result.sessions.find((s: { id: string }) => s.id === a).state).toBe("idle"));
    const base = await c.request({ type: "session.list", since: "" });
    const b = (await c.request({ type: "session.create", cwd: webRoot })).result.session.id as string;
    const next = await c.request({ type: "session.list", since: base.result.version });
    expect(next.result.delta).toBe(true);
    expect(next.result.version).not.toBe(base.result.version);
    expect(next.result.sessions.map((s: { id: string }) => s.id)).toEqual([b]);
    expect(next.result.ids).toContain(a);
    expect(next.result.ids).toContain(b);
    expect(next.result.projects).toBeDefined();
    c.ws.close();
  });

  it("answers the whole list for an unknown version and the plain list without since", async () => {
    const c = await client();
    const unknown = await c.request({ type: "session.list", since: "other-epoch:1" });
    expect(unknown.result.delta).toBeUndefined();
    expect(unknown.result.sessions.length).toBeGreaterThan(0);
    expect(unknown.result.version).toBeTypeOf("string");
    const plain = await c.request({ type: "session.list" });
    expect(plain.result.version).toBeUndefined();
    expect(plain.result.delta).toBeUndefined();
    c.ws.close();
  });
});

describe("send feed", () => {
  it("holds a session's events while the socket buffer is above the high mark and sends them in seq order after it drained", async () => {
    const c = await client();
    const id = (await c.request({ type: "session.create", cwd: webRoot })).result.session.id as string;
    const v = virtual();
    await v.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    // The events a subscribe itself causes (commands) arrive first; the count from here on is what the buffer holds back.
    await new Promise((r) => setTimeout(r, 150));
    const base = v.events(id).length;
    v.ws.bufferedAmount = FEED_HIGH + 1;
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "hold" });
    await vi.waitFor(async () => expect(((await c.request({ type: "session.list", since: "" })).result.sessions.find((s: { id: string }) => s.id === id)).state).toBe("idle"), { timeout: 10_000 });
    expect(v.events(id)).toHaveLength(base);
    v.ws.bufferedAmount = 0;
    await idle(() => v.events(id));
    const seqs = v.events(id).map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(2);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    // The replies were not held behind the events: a request answered while the buffer was high.
    v.ws.bufferedAmount = FEED_HIGH + 1;
    expect((await v.request({ type: "session.list", since: "" })).type).toBe("reply");
    c.ws.close();
  });

  it("stops a paused feed when the session is unsubscribed: nothing arrives after the buffer drained", async () => {
    const c = await client();
    const id = (await c.request({ type: "session.create", cwd: webRoot })).result.session.id as string;
    const v = virtual();
    await v.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await new Promise((r) => setTimeout(r, 150));
    const base = v.events(id).length;
    v.ws.bufferedAmount = FEED_HIGH + 1;
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "x" });
    await v.request({ type: "session.unsubscribe", sessionId: id });
    v.ws.bufferedAmount = 0;
    await new Promise((r) => setTimeout(r, 300));
    expect(v.events(id)).toHaveLength(base);
    c.ws.close();
  });
});

describe("background resubscribe with a large gap", () => {
  /** A session with more than GAP logged events, and the client that drove it. */
  async function longSession() {
    const c = await client();
    const id = (await c.request({ type: "session.create", cwd: webRoot })).result.session.id as string;
    const sub = await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    const epoch = sub.result.logEpoch as string;
    const events = () => c.inbox.filter((m) => m.type === "event" && (m as Event).sessionId === id) as Event[];
    // The log holds fewer events than were sent (a streamed part keeps its first and latest): ask the daemon whether the gap from seq 1 passed the limit.
    const probe = virtual();
    const longGap = async () => {
      const r = await probe.request({ type: "session.subscribe", sessionId: id, sinceSeq: 1, logEpoch: epoch, paged: true, background: true });
      await probe.request({ type: "session.unsubscribe", sessionId: id });
      return !!r.result.snapshot;
    };
    for (let n = 1; !(events().length > GAP && (await longGap())); n++) {
      await c.request({ type: "session.prompt", sessionId: id, text: `turn ${n}` });
      await idle(events, n);
    }
    return { c, id, epoch, last: events().at(-1)!.seq };
  }

  it("a background resubscribe more than the limit behind gets the snapshot and no replay; a shown one or a short gap keeps the replay", async () => {
    const { c, id, epoch, last } = await longSession();
    const v = virtual();
    const sub = (extra: object, since = 1) => v.request({ type: "session.subscribe", sessionId: id, sinceSeq: since, logEpoch: epoch, paged: true, ...extra });
    const bg = await sub({ background: true });
    expect(bg.result.snapshot).toBeDefined();
    expect(bg.result.seq).toBe(last);
    await new Promise((r) => setTimeout(r, 100));
    expect(v.events(id)).toHaveLength(0);
    await v.request({ type: "session.unsubscribe", sessionId: id });
    const shown = await sub({});
    expect(shown.result.snapshot).toBeUndefined();
    await vi.waitFor(() => expect(v.events(id).length).toBeGreaterThan(GAP));
    expect(v.events(id)[0]!.seq).toBeGreaterThan(1);
    await v.request({ type: "session.unsubscribe", sessionId: id });
    v.sent.length = 0;
    const near = await sub({ background: true }, last - 5);
    expect(near.result.snapshot).toBeUndefined();
    // At most 5 (a replaced streamed event leaves a gap in the seqs), all after the cursor.
    await vi.waitFor(() => expect(v.events(id).length).toBeGreaterThan(0));
    expect(v.events(id).length).toBeLessThanOrEqual(5);
    expect(v.events(id).every((e) => e.seq > last - 5)).toBe(true);
    c.ws.close();
  });
});
