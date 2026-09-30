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
    c.close();
  });
});
