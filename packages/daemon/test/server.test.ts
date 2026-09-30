import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";

const webRoot = mkdtempSync(join(tmpdir(), "web-"));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const http = createDaemon({ webRoot, query: fakeQuery as never });
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const { address, port } = http.address() as AddressInfo;
afterAll(() => void http.close());

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
  return new Promise<{ request: typeof request; waitFor: typeof waitFor; inbox: ServerMessage[] }>((r) =>
    ws.on("open", () => r({ request, waitFor, inbox })),
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
});
