import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { backoffMs, connect, type ConnectionStatus } from "./client.ts";

const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.on("listening", r));
const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
afterAll(() => void wss.close());

const until = (pred: () => boolean) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => pred() && (clearInterval(t), resolve()), 5);
  });

describe("connect", () => {
  it("backs off exponentially up to a cap", () => {
    expect([0, 1, 2, 3].map(backoffMs)).toEqual([500, 1000, 2000, 4000]);
    expect(backoffMs(20)).toBe(10_000);
  });

  it("reconnects after the socket drops, reports status, runs onOpen again, rejects in-flight requests", async () => {
    const statuses: ConnectionStatus[] = [];
    let opens = 0;
    const offered: (string | undefined)[] = [];
    wss.on("connection", (_s, req) => offered.push(req.headers["sec-websocket-protocol"]));
    const c = connect({ url, token: "t0k", onEvent: () => {}, onOpen: () => opens++, onStatus: (s) => statuses.push(s) });
    await until(() => opens === 1);
    const inflight = c.request({ type: "session.subscribe", sessionId: "s", sinceSeq: 0 });
    await until(() => wss.clients.size === 1);
    for (const s of wss.clients) s.terminate();
    await expect(inflight).rejects.toThrow("disconnected");
    await until(() => opens === 2);
    expect(statuses).toEqual(["connected", "reconnecting", "connected"]);
    // Every dial, including the reconnect, offers the pairing token.
    expect(offered).toEqual(["claude-ui, token.t0k", "claude-ui, token.t0k"]);

    // A request sent after reconnecting gets its reply.
    for (const s of wss.clients) s.on("message", (d) => s.send(JSON.stringify({ type: "reply", reqId: JSON.parse(String(d)).reqId, result: 7 })));
    expect(await c.request({ type: "session.subscribe", sessionId: "s", sinceSeq: 0 })).toBe(7);

    // An error reply rejects with the daemon's code, so the app can tell a gone session from other failures.
    for (const s of wss.clients) {
      s.removeAllListeners("message");
      s.on("message", (d) => s.send(JSON.stringify({ type: "error", reqId: JSON.parse(String(d)).reqId, code: "unknown_session", message: "no session s" })));
    }
    await expect(c.request({ type: "session.subscribe", sessionId: "s", sinceSeq: 0 })).rejects.toMatchObject({ code: "unknown_session", message: "no session s" });
    c.close();
  });

  it("a request with timeoutMs rejects when no reply comes in time, connected or not", async () => {
    let opens = 0;
    const c = connect({ url, token: "t", onEvent: () => {}, onOpen: () => opens++ });
    await until(() => opens === 1);
    await expect(c.request({ type: "fs.search", cwd: "/", query: "" }, { timeoutMs: 20 })).rejects.toThrow("timed out");
    c.close();
    const down = connect({ url: "ws://127.0.0.1:1", token: "t", onEvent: () => {} });
    await expect(down.request({ type: "fs.search", cwd: "/", query: "" }, { timeoutMs: 20 })).rejects.toThrow("timed out");
    down.close();
  });

  it("stops redialing and reports unauthorized when the daemon rejects the token; a down daemon stays reconnecting", async () => {
    // The daemon's answers: every upgrade 401, the /auth probe 401 unless the token is "good".
    const http = createServer((req, res) => res.writeHead(req.headers.authorization === "Bearer good" ? 204 : 401).end());
    let upgrades = 0;
    http.on("upgrade", (_req, socket) => (upgrades++, socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as AddressInfo).port;
    const statuses: ConnectionStatus[] = [];
    const c = connect({ url: `ws://127.0.0.1:${port}/ws`, token: "bad", onEvent: () => {}, onStatus: (s) => statuses.push(s) });
    await until(() => statuses.includes("unauthorized"));
    await new Promise((r) => setTimeout(r, 1500));
    expect(statuses).toEqual(["unauthorized"]);
    expect(upgrades).toBe(1);
    c.close();

    // Token accepted by the probe, upgrade still failing (e.g. daemon restarting): keep reconnecting.
    const statuses2: ConnectionStatus[] = [];
    const c2 = connect({ url: `ws://127.0.0.1:${port}/ws`, token: "good", onEvent: () => {}, onStatus: (s) => statuses2.push(s) });
    await until(() => statuses2.length > 0);
    expect(statuses2[0]).toBe("reconnecting");
    c2.close();
    http.close();
  });

  it("search streams sessions.search.result of its reqId to onResult and resolves on the reply; other reqIds are ignored", async () => {
    let opened = 0;
    const c = connect({ url, token: "t", onEvent: () => {}, onOpen: () => opened++ });
    await until(() => opened === 1);
    const handler = (s: import("ws").WebSocket) => (d: import("ws").RawData) => {
      const { reqId } = JSON.parse(String(d));
      const hit = (id: string, sessionId: string) => s.send(JSON.stringify({ type: "sessions.search.result", reqId: id, sessionId, cwd: "/p", title: "t", hits: [] }));
      hit("other", "ignored");
      hit(reqId, "s1");
      s.send(JSON.stringify({ type: "reply", reqId, result: { scannedFiles: 1, scannedBytes: 1, ms: 1 } }));
    };
    const listeners = [...wss.clients].map((s) => [s, handler(s)] as const);
    listeners.forEach(([s, h]) => s.on("message", h));
    const got: string[] = [];
    const done = await c.search({ type: "sessions.search", query: "zebra" }, (m) => got.push(m.sessionId));
    listeners.forEach(([s, h]) => s.off("message", h));
    expect(got).toEqual(["s1"]);
    expect(done.scannedFiles).toBe(1);
    c.close();
  });
});
