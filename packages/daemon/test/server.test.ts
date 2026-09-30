import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { calls, fakeQuery, history } from "./fake-query.ts";

const webRoot = mkdtempSync(join(tmpdir(), "web-"));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const http = createDaemon({ webRoot, query: fakeQuery as never });
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const { address, port } = http.address() as AddressInfo;
afterAll(() => void http.close());

function client(p = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`);
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  const waitFor = (pred: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve) => {
      const t = setInterval(() => {
        const m = inbox.find(pred);
        if (m) clearInterval(t), resolve(m);
      }, 5);
    });
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return waitFor((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId);
  };
  return new Promise<{ ws: WebSocket; request: typeof request; waitFor: typeof waitFor; inbox: ServerMessage[] }>((r) =>
    ws.on("open", () => r({ ws, request, waitFor, inbox })),
  );
}

describe("daemon", () => {
  it("binds to 127.0.0.1 and serves the web app", async () => {
    expect(address).toBe("127.0.0.1");
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("<h1>app</h1>");
    expect((await fetch(`http://127.0.0.1:${port}/some/route`)).status).toBe(200);
  });

  it("creates a session, streams a prompt's reply as seq'd events over WebSocket", async () => {
    const c = await client();
    const created = await c.request({ type: "session.create", cwd: webRoot });
    const session = (created as { result: { session: { id: string } } }).result.session;
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);

    await c.request({ type: "session.subscribe", sessionId: session.id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: session.id, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    const events = c.inbox.filter((m) => m.type === "event");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it("rejects a cwd that is not a directory", async () => {
    const c = await client();
    expect(await c.request({ type: "session.create", cwd: "/nonexistent" })).toMatchObject({ type: "error", code: "bad_cwd" });
  });

  it("answers a malformed URL path with 400 and keeps running", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/100%`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  });

  it("answers a non-object WebSocket frame with a protocol error and keeps running", async () => {
    const c = await client();
    for (const frame of ["null", "42", '"x"', "[]"]) c.ws.send(frame);
    await c.waitFor(() => c.inbox.filter((m) => m.type === "error" && m.code === "bad_message").length === 4);
    expect(await c.request({ type: "session.create", cwd: "/nonexistent" })).toMatchObject({ code: "bad_cwd" });
  });

  it("replays events after sinceSeq to a reconnecting client of the same epoch, then streams live", async () => {
    const a = await client();
    const { result } = (await a.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
    const sessionId = result.session.id;
    const sub = (await a.request({ type: "session.subscribe", sessionId, sinceSeq: 0 })) as { result: { logEpoch: string } };
    await a.request({ type: "session.prompt", sessionId, text: "hi" });
    await a.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    a.ws.close();
    const seen = a.inbox.filter((m) => m.type === "event").length;

    const b = await client();
    const again = await b.request({ type: "session.subscribe", sessionId, sinceSeq: 5, logEpoch: sub.result.logEpoch });
    expect(again).toMatchObject({ result: { logEpoch: sub.result.logEpoch, session: { id: sessionId, cwd: webRoot } } });
    await b.waitFor(() => b.inbox.filter((m) => m.type === "event").length === seen - 5);
    expect((b.inbox.find((m) => m.type === "event") as { seq: number }).seq).toBe(6);

    await b.request({ type: "session.prompt", sessionId, text: "again" });
    await b.waitFor((m) => m.type === "event" && m.part.type === "turn_result" && m.seq > seen);
  });

  it("after a restart rebuilds a session from its transcript, full replay on a new epoch, prompt resumes the same ID", async () => {
    const id = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
    let reads = 0;
    const restarted = createDaemon({
      webRoot,
      query: fakeQuery as never,
      history: {
        getSessionInfo: (async (sid: string) => (sid === id ? { sessionId: id, cwd: webRoot } : undefined)) as never,
        getSessionMessages: (async () => (reads++, history)) as never,
      },
    });
    await new Promise<void>((r) => restarted.listen(0, "127.0.0.1", r));
    try {
      const c = await client((restarted.address() as AddressInfo).port);
      // Two tabs at once still restore one session.
      const [sub] = await Promise.all([
        c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 40, logEpoch: "old-epoch" }),
        c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 }),
      ]);
      expect(sub).toMatchObject({ result: { session: { id, cwd: webRoot, state: "idle" } } });
      expect(reads).toBe(1);
      expect((sub as { result: { logEpoch: string } }).result.logEpoch).not.toBe("old-epoch");
      await c.waitFor((m) => m.type === "event" && m.part.type === "session_state");
      const first = c.inbox.find((m) => m.type === "event") as { seq: number };
      expect(first.seq).toBe(1);

      await c.request({ type: "session.prompt", sessionId: id, text: "third" });
      expect(calls.filter((o) => o.resume === id)).toHaveLength(1);
      await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");

      expect(await c.request({ type: "session.subscribe", sessionId: "../../etc/passwd", sinceSeq: 0 })).toMatchObject({ code: "unknown_session" });
    } finally {
      restarted.close();
    }
  });
});
