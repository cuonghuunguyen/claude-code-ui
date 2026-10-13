// GH-254: a CLI that starts in a session without one (e.g. worker_send on a worker restored after a restart) is announced: sessions.changed.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ServerMessage } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { fakeQuery, history } from "./fake-query.ts";

const webRoot = mkdtempSync(join(tmpdir(), "rv-web-"));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";

async function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  const request = async (msg: object) => {
    const reqId = randomUUID();
    ws.send(JSON.stringify({ ...msg, reqId }));
    for (;;) {
      const m = inbox.find((x) => (x.type === "reply" || x.type === "error") && (x as { reqId?: string }).reqId === reqId);
      if (m) return m as { type: string; result?: any };
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { ws, inbox, request };
}

describe("session.list live changes", () => {
  it("a session not loaded since a restart (listed closed, live false) whose CLI starts is announced with sessions.changed, so an unsubscribed client re-lists it", async () => {
    const id = "00000000-0000-4000-8000-000000000777";
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      settingsFile: join(mkdtempSync(join(tmpdir(), "rv-cfg-")), "sessions.json"),
      projectsDir: mkdtempSync(join(tmpdir(), "rv-proj-")),
      history: {
        listSessions: (async () => [{ sessionId: id, cwd: webRoot, summary: "t", lastModified: 1 }]) as never,
        getSessionInfo: (async (sid: string) => ({ sessionId: sid, cwd: webRoot })) as never,
        getSessionMessages: (async () => history) as never,
        deleteSession: (async () => {}) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const port = (d.address() as AddressInfo).port;
    // obs = a web app tab: it lists, and (App.tsx) does not subscribe a session whose list state is "closed".
    const obs = await client(port);
    const other = await client(port);
    try {
      // Adds the project (the list shows only added projects).
      await obs.request({ type: "session.create", cwd: webRoot });
      const item = async () => ((await obs.request({ type: "session.list" })).result.sessions as any[]).find((s) => s.id === id);
      expect(await item()).toMatchObject({ state: "closed", live: false });
      const seen = obs.inbox.length;
      // Stands in for worker_send of the coordinator: restores the session and starts its CLI (no client subscribed).
      const r = await other.request({ type: "session.prompt", sessionId: id, text: "hi" });
      expect(r.type).toBe("reply");
      for (let i = 0; i < 200 && (await item()).live === false; i++) await new Promise((res) => setTimeout(res, 10));
      const now = await item();
      expect(now.live).toBeUndefined();
      // obs does not follow the session (list state closed): only sessions.changed tells it to re-list.
      expect(obs.inbox.slice(seen).some((m) => m.type === "sessions.changed")).toBe(true);
    } finally {
      obs.ws.close();
      other.ws.close();
      d.close();
    }
  });
});
