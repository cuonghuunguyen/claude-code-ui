import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Part, ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import { clearQuery, clearState, closedQueries, fakeQuery, interruptQuery, limitQuery, limitState, permissionQuery } from "./fake-query.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const servers: { close(): unknown }[] = [];
afterAll(() => servers.forEach((s) => s.close()));
vi.spyOn(console, "log").mockImplementation(() => {});

async function harness(query: unknown, extra: Partial<Parameters<typeof createDaemon>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pq-"));
  const http = createDaemon({ webRoot: dir, roots: [dir], query: query as never, token, appSettings: createSettings({ file: join(dir, "settings.json") }), ...extra });
  servers.push(http);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  async function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
    const inbox: ServerMessage[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    const request = async (msg: object) => {
      const reqId = Math.random().toString(36);
      ws.send(JSON.stringify({ ...msg, reqId }));
      return vi.waitFor(() => inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) ?? Promise.reject(new Error("no reply")), { timeout: 5000 }) as unknown as Promise<{ type: string; result?: any; code?: string }>;
    };
    return { ws, inbox, request };
  }
  type C = Awaited<ReturnType<typeof client>>;
  const parts = (c: C, id: string) => c.inbox.filter((m: any) => m.type === "event" && m.sessionId === id).map((m: any) => m.part as Part);
  const texts = (c: C, id: string) => parts(c, id).filter((p) => p.type === "user_text").map((p: any) => p.text as string);
  const queue = (c: C, id: string) => parts(c, id).filter((p) => p.type === "prompt_queue").map((p: any) => p as { items: { id: string; text: string; imageCount: number; bash?: true }[]; held?: { reason: string; until?: number } });
  const lastQueue = (c: C, id: string) => queue(c, id).at(-1);
  async function session(c: C, dir2 = dir) {
    const id = ((await c.request({ type: "session.create", cwd: dir2 })).result as any).session.id as string;
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    return id;
  }
  return { dir, client, parts, texts, queue, lastQueue, session };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("queued messages in the daemon", { timeout: 20_000 }, () => {
  it("enqueue during a turn waiting for permission: nothing until the turn ends, then the item is sent", async () => {
    const h = await harness(permissionQuery);
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "first" });
    const req = await vi.waitFor(() => c.inbox.find((m: any) => m.type === "event" && m.part.type === "permission_request") ?? Promise.reject(new Error("no request")), { timeout: 5000 });
    const r = await c.request({ type: "session.enqueue", sessionId: id, text: "second" });
    expect(r.result.itemId).toEqual(expect.any(String));
    await sleep(300);
    expect(h.texts(c, id)).toEqual(["first"]);
    expect(h.lastQueue(c, id)!.items.map((i) => i.text)).toEqual(["second"]);
    await c.request({ type: "permission.respond", requestId: (req as any).part.requestId, decision: "allow" });
    await vi.waitFor(() => expect(h.texts(c, id)).toEqual(["first", "second"]), { timeout: 5000 });
    expect(h.lastQueue(c, id)!.items).toEqual([]);
    c.ws.close();
  });

  it("enqueue on an idle session is sent at once", async () => {
    const h = await harness(fakeQuery);
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.enqueue", sessionId: id, text: "now" });
    await vi.waitFor(() => expect(h.texts(c, id)).toEqual(["now"]), { timeout: 5000 });
    c.ws.close();
  });

  it("Stop: the next queued item is sent after the interrupt", async () => {
    const h = await harness(interruptQuery);
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "work" });
    await vi.waitFor(() => expect(h.parts(c, id).some((p) => p.type === "session_state" && p.state === "running")).toBe(true));
    await c.request({ type: "session.enqueue", sessionId: id, text: "after stop" });
    await sleep(200);
    expect(h.texts(c, id)).toEqual(["work"]);
    await c.request({ type: "session.interrupt", sessionId: id });
    await vi.waitFor(() => expect(h.texts(c, id)).toEqual(["work", "after stop"]), { timeout: 5000 });
    c.ws.close();
  });

  it("two clients both get prompt_queue; the subscribe snapshot heads hold it", async () => {
    const h = await harness(interruptQuery);
    const a = await h.client();
    const b = await h.client();
    const id = await h.session(a);
    await b.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await a.request({ type: "session.prompt", sessionId: id, text: "work" });
    await a.request({ type: "session.enqueue", sessionId: id, text: "q1", images: [PNG] });
    await vi.waitFor(() => expect(h.lastQueue(b, id)?.items.map((i) => [i.text, i.imageCount])).toEqual([["q1", 1]]));
    expect(h.lastQueue(a, id)!.items).toHaveLength(1);
    const late = await h.client();
    const sub = await late.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0, paged: true });
    expect(sub.result.snapshot.heads.some((e: any) => e.part.type === "prompt_queue" && e.part.items.length === 1)).toBe(true);
    a.ws.close(); b.ws.close(); late.ws.close();
  });

  it("dequeue returns text and images once; sendQueued steers a running turn", async () => {
    const h = await harness(interruptQuery);
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "work" });
    await c.request({ type: "session.enqueue", sessionId: id, text: "back", images: [PNG] });
    await c.request({ type: "session.enqueue", sessionId: id, text: "steer" });
    const [back, steer] = h.lastQueue(c, id)!.items;
    const d = await c.request({ type: "session.dequeue", sessionId: id, itemId: back!.id });
    expect(d.result).toEqual({ text: "back", images: [PNG] });
    expect((await c.request({ type: "session.dequeue", sessionId: id, itemId: back!.id })).code).toBe("unknown_item");
    await c.request({ type: "session.sendQueued", sessionId: id, itemId: steer!.id });
    await vi.waitFor(() => expect(h.texts(c, id)).toEqual(["work", "steer"]));
    expect(h.lastQueue(c, id)!.items).toEqual([]);
    expect((await c.request({ type: "session.sendQueued", sessionId: id, itemId: steer!.id })).code).toBe("unknown_item");
    c.ws.close();
  });

  it("a message queued during /clear goes to the new session", async () => {
    clearState.delayMs = 400;
    const h = await harness(clearQuery);
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "/clear" });
    await c.request({ type: "session.enqueue", sessionId: id, text: "after clear" });
    const heir = await vi.waitFor(() => (h.parts(c, id).find((p) => p.type === "session_cleared") as any)?.sessionId ?? Promise.reject(new Error("no heir")), { timeout: 5000 });
    await c.request({ type: "session.subscribe", sessionId: heir, sinceSeq: 0 });
    await vi.waitFor(() => expect(h.texts(c, heir)).toContain("after clear"), { timeout: 5000 });
    expect(h.texts(c, id)).not.toContain("after clear");
    clearState.delayMs = 0;
    c.ws.close();
  });

  it("a usage limit stop holds the queue until the reset", async () => {
    limitState.repeatEvent = true;
    limitState.continueHits = false;
    limitState.inSeconds = 60;
    limitState.resetsAt = 0;
    const h = await harness(limitQuery);
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await c.request({ type: "session.enqueue", sessionId: id, text: "later" });
    await vi.waitFor(() => expect(h.lastQueue(c, id)?.held).toMatchObject({ reason: "usage_limit", until: expect.any(Number) }), { timeout: 5000 });
    await sleep(500);
    expect(h.texts(c, id)).toEqual(["limit"]);
    // A user message releases the hold.
    await c.request({ type: "session.prompt", sessionId: id, text: "hello" });
    await vi.waitFor(() => expect(h.texts(c, id)).toEqual(["limit", "hello", "later"]), { timeout: 5000 });
    c.ws.close();
  });

  it("a paused queue survives the idle close of its session: shown paused on reopen, nothing sent until resumed", async () => {
    limitState.repeatEvent = true;
    limitState.continueHits = false;
    limitState.inSeconds = 60;
    limitState.resetsAt = 0;
    const h = await harness(limitQuery, { idleCloseMs: 150 });
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await c.request({ type: "session.enqueue", sessionId: id, text: "later" });
    await vi.waitFor(() => expect(h.lastQueue(c, id)?.held).toMatchObject({ reason: "usage_limit" }), { timeout: 5000 });
    const closes = () => closedQueries.filter((o) => o.sessionId === id || o.resume === id).length;
    const before = closes();
    await c.request({ type: "session.unsubscribe", sessionId: id });
    await vi.waitFor(() => expect(closes()).toBeGreaterThan(before), { timeout: 3000 });
    await sleep(400);
    const c2 = await h.client();
    const sub = await c2.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0, paged: true });
    const head = sub.result.snapshot.heads.find((e: any) => e.part.type === "prompt_queue");
    expect(head.part.items.map((i: any) => i.text)).toEqual(["later"]);
    expect(head.part.held).toMatchObject({ reason: "usage_limit" });
    expect(h.texts(c, id)).toEqual(["limit"]);
    // A user message resumes the CLI and releases the queue.
    await c2.request({ type: "session.prompt", sessionId: id, text: "hello" });
    await vi.waitFor(() => expect(h.texts(c2, id)).toEqual(["hello", "later"]), { timeout: 5000 });
    c.ws.close(); c2.ws.close();
  });

  it("Send now of an unknown item does not cancel a scheduled auto-continue", async () => {
    limitState.repeatEvent = true; limitState.continueHits = false; limitState.inSeconds = 30; limitState.resetsAt = 0;
    const h = await harness(limitQuery, { autoContinue: { graceMs: 0, gapMs: 300, retryMs: 500 } });
    const c = await h.client();
    await c.request({ type: "settings.set", patch: { usageLimit: { autoContinue: true } } });
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    const at = () => h.parts(c, id).filter((p) => p.type === "auto_continue").map((p: any) => p.at).at(-1);
    await vi.waitFor(() => expect(at()).toEqual(expect.any(Number)), { timeout: 5000 });
    const r = await c.request({ type: "session.sendQueued", sessionId: id, itemId: "nope" });
    expect(r.code).toBe("unknown_item");
    await sleep(200);
    expect(at()).toEqual(expect.any(Number));
    c.ws.close();
  });

  it("a refused prompt does not end the usage-limit pause", async () => {
    limitState.repeatEvent = true; limitState.continueHits = false; limitState.inSeconds = 60; limitState.resetsAt = 0;
    const h = await harness(limitQuery);
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await c.request({ type: "session.enqueue", sessionId: id, text: "later" });
    await vi.waitFor(() => expect(h.lastQueue(c, id)?.held).toMatchObject({ reason: "usage_limit" }), { timeout: 5000 });
    expect((await c.request({ type: "session.prompt", sessionId: id, text: "  " })).code).toBe("bad_prompt");
    await sleep(300);
    expect(h.lastQueue(c, id)?.held).toMatchObject({ reason: "usage_limit" });
    expect(h.texts(c, id)).toEqual(["limit"]);
    c.ws.close();
  });

  it("dequeue and Send now on a session that is not in memory do not load it from disk", async () => {
    const h = await harness(fakeQuery);
    const c = await h.client();
    const id = "11111111-2222-3333-4444-555555555555";
    expect((await c.request({ type: "session.dequeue", sessionId: id, itemId: "x" })).code).toBe("unknown_item");
    expect((await c.request({ type: "session.sendQueued", sessionId: id, itemId: "x" })).code).toBe("unknown_item");
    c.ws.close();
  });

  it("the CLI crashes while a message is queued: the queue shows Paused (not_live)", async () => {
    const crashQuery = (args: any) => {
      const base = fakeQuery(args) as any;
      const it = (async function* () {
        for await (const _m of args.prompt) {
          await sleep(400);
          throw new Error("crash");
        }
      })();
      for (const k of Object.keys(base)) if (!["next", "return", "throw"].includes(k)) (it as any)[k] = base[k];
      (it as any).close = () => void it.return(undefined);
      return it;
    };
    const h = await harness(crashQuery);
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "work" });
    await c.request({ type: "session.enqueue", sessionId: id, text: "later" });
    await vi.waitFor(() => expect(h.parts(c, id).some((p) => p.type === "session_state" && p.state === "error")).toBe(true), { timeout: 5000 });
    await vi.waitFor(() => expect(h.lastQueue(c, id)?.held).toMatchObject({ reason: "not_live" }), { timeout: 2000 });
    expect(h.lastQueue(c, id)?.items.map((i) => i.text)).toEqual(["later"]);
    c.ws.close();
  });

  it("dequeue and Send now do not load a session that exists only on disk", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const getSessionInfo = vi.fn(async (sid: string) => (sid === id ? { sessionId: id, cwd: "", summary: "on disk" } : undefined));
    const h = await harness(fakeQuery, { history: { getSessionInfo } as never });
    // The cwd must be an allowed root for a restore to succeed.
    getSessionInfo.mockImplementation(async (sid: string) => (sid === id ? { sessionId: id, cwd: h.dir, summary: "on disk" } : undefined));
    const c = await h.client();
    expect((await c.request({ type: "session.dequeue", sessionId: id, itemId: "x" })).code).toBe("unknown_item");
    expect((await c.request({ type: "session.sendQueued", sessionId: id, itemId: "x" })).code).toBe("unknown_item");
    expect(getSessionInfo.mock.calls.filter((a) => a[0] === id)).toEqual([]);
    c.ws.close();
  });

  it("Send now refused because the session is not live does not cancel a scheduled auto-continue", async () => {
    limitState.repeatEvent = true; limitState.continueHits = false; limitState.inSeconds = 30; limitState.resetsAt = 0;
    const crashAfterLimit = (args: any) => {
      const base = limitQuery(args) as any;
      const it = (async function* () {
        for await (const m of base) {
          yield m;
          if (m.type === "result") {
            await sleep(300);
            throw new Error("crash");
          }
        }
      })();
      for (const k of Object.keys(base)) if (!["next", "return", "throw"].includes(k)) (it as any)[k] = base[k];
      (it as any).close = () => void it.return(undefined);
      return it;
    };
    const h = await harness(crashAfterLimit, { autoContinue: { graceMs: 0, gapMs: 300, retryMs: 500 } });
    const c = await h.client();
    await c.request({ type: "settings.set", patch: { usageLimit: { autoContinue: true } } });
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await c.request({ type: "session.enqueue", sessionId: id, text: "later" });
    const at = () => h.parts(c, id).filter((p) => p.type === "auto_continue").map((p: any) => p.at).at(-1);
    await vi.waitFor(() => expect(at()).toEqual(expect.any(Number)), { timeout: 5000 });
    await vi.waitFor(() => expect(h.parts(c, id).some((p) => p.type === "session_state" && p.state === "error")).toBe(true), { timeout: 5000 });
    const item = h.lastQueue(c, id)!.items[0]!;
    const r = await c.request({ type: "session.sendQueued", sessionId: id, itemId: item.id });
    expect(r.code).toBe("session_not_live");
    await sleep(200);
    expect(at()).toEqual(expect.any(Number));
    expect(h.lastQueue(c, id)?.items.map((i) => i.text)).toEqual(["later"]);
    c.ws.close();
  });
});

describe.skipIf(process.platform === "win32")("queued bash commands", { timeout: 20_000 }, () => {
  const bashParts = (h: Awaited<ReturnType<typeof harness>>, c: any, id: string) => h.parts(c, id).filter((p) => p.type === "bash") as any[];
  async function busy(h: Awaited<ReturnType<typeof harness>>, c: any, id: string) {
    await c.request({ type: "session.prompt", sessionId: id, text: "first" });
    const req = await vi.waitFor(() => c.inbox.find((m: any) => m.type === "event" && m.part.type === "permission_request") ?? Promise.reject(new Error("no request")), { timeout: 5000 });
    return () => c.request({ type: "permission.respond", requestId: (req as any).part.requestId, decision: "allow" });
  }

  it("session.bash during a turn is queued (itemId, bash chip), runs when the turn ends, output as a bash part, chip gone", async () => {
    const h = await harness(permissionQuery);
    const c = await h.client();
    const id = await h.session(c);
    const allow = await busy(h, c, id);
    const r = await c.request({ type: "session.bash", sessionId: id, command: "echo queued-out" });
    expect(r.type).toBe("reply");
    expect(r.result.itemId).toEqual(expect.any(String));
    expect(h.lastQueue(c, id)!.items.map(({ text, imageCount, bash }) => ({ text, imageCount, bash }))).toEqual([{ text: "echo queued-out", imageCount: 0, bash: true }]);
    await sleep(300);
    expect(bashParts(h, c, id)).toEqual([]);
    await allow();
    await vi.waitFor(() => expect(bashParts(h, c, id).some((p) => p.status === "done" && p.stdout === "queued-out\n")).toBe(true), { timeout: 5000 });
    expect(h.lastQueue(c, id)!.items).toEqual([]);
    c.ws.close();
  });

  it("mixed queue prompt, bash, prompt runs in submit order", async () => {
    const h = await harness(permissionQuery);
    const c = await h.client();
    const id = await h.session(c);
    await busy(h, c, id);
    await c.request({ type: "session.enqueue", sessionId: id, text: "p1" });
    await c.request({ type: "session.bash", sessionId: id, command: "echo b1" });
    await c.request({ type: "session.enqueue", sessionId: id, text: "p2" });
    // permissionQuery asks again on every prompt: allow each request.
    const answered = new Set<string>();
    await vi.waitFor(async () => {
      for (const m of c.inbox as any[]) {
        if (m.type === "event" && m.part.type === "permission_request" && !answered.has(m.part.requestId)) {
          answered.add(m.part.requestId);
          await c.request({ type: "permission.respond", requestId: m.part.requestId, decision: "allow" });
        }
      }
      expect(h.texts(c, id)).toEqual(["first", "p1", "p2"]);
      expect(bashParts(h, c, id).some((p) => p.status === "done")).toBe(true);
    }, { timeout: 8000 });
    const kinds = h.parts(c, id).flatMap((p: any) => (p.type === "user_text" ? [`t:${p.text}`] : p.type === "bash" && p.status === "running" ? ["b:start"] : p.type === "bash" && p.status === "done" ? ["b:done"] : []));
    expect(kinds.indexOf("t:p1")).toBeLessThan(kinds.indexOf("b:start"));
    expect(kinds.indexOf("b:done")).toBeLessThan(kinds.indexOf("t:p2"));
    c.ws.close();
  });

  it("dequeue of a bash item returns bash: true", async () => {
    const h = await harness(permissionQuery);
    const c = await h.client();
    const id = await h.session(c);
    await busy(h, c, id);
    await c.request({ type: "session.bash", sessionId: id, command: "ls" });
    const item = h.lastQueue(c, id)!.items[0]!;
    expect((await c.request({ type: "session.dequeue", sessionId: id, itemId: item.id })).result).toEqual({ text: "ls", images: [], bash: true });
    expect(h.lastQueue(c, id)!.items).toEqual([]);
    c.ws.close();
  });

  it("Send now of a bash item during a turn: session_busy, item stays", async () => {
    const h = await harness(permissionQuery);
    const c = await h.client();
    const id = await h.session(c);
    await busy(h, c, id);
    await c.request({ type: "session.bash", sessionId: id, command: "echo x" });
    const item = h.lastQueue(c, id)!.items[0]!;
    expect(await c.request({ type: "session.sendQueued", sessionId: id, itemId: item.id })).toMatchObject({ type: "error", code: "session_busy" });
    expect(h.lastQueue(c, id)!.items.map((i) => i.text)).toEqual(["echo x"]);
    expect(bashParts(h, c, id)).toEqual([]);
    c.ws.close();
  });

  it("Send now of a bash item on an idle session (a held queue) runs it at once and does not release a usage-limit pause", async () => {
    limitState.repeatEvent = true;
    limitState.continueHits = false;
    limitState.inSeconds = 60;
    limitState.resetsAt = 0;
    const h = await harness(limitQuery);
    const c = await h.client();
    const id = await h.session(c);
    await c.request({ type: "session.prompt", sessionId: id, text: "limit" });
    await c.request({ type: "session.enqueue", sessionId: id, text: "later" });
    await vi.waitFor(() => expect(h.lastQueue(c, id)?.held).toMatchObject({ reason: "usage_limit" }), { timeout: 5000 });
    // A running command makes the next one queue (the hold keeps it queued after the first ends).
    await c.request({ type: "session.bash", sessionId: id, command: "sleep 1" });
    expect((await c.request({ type: "session.bash", sessionId: id, command: "echo held-out" })).result.itemId).toEqual(expect.any(String));
    await vi.waitFor(() => expect(bashParts(h, c, id).some((p) => p.command === "sleep 1" && p.status === "done")).toBe(true), { timeout: 5000 });
    await sleep(200);
    expect(bashParts(h, c, id).some((p) => p.command === "echo held-out")).toBe(false);
    const item = h.lastQueue(c, id)!.items.find((i) => i.bash)!;
    expect(item).toBeDefined();
    expect((await c.request({ type: "session.sendQueued", sessionId: id, itemId: item.id })).type).toBe("reply");
    await vi.waitFor(() => expect(bashParts(h, c, id).some((p) => p.status === "done" && p.stdout === "held-out\n")).toBe(true), { timeout: 5000 });
    expect(h.lastQueue(c, id)!.held).toMatchObject({ reason: "usage_limit" });
    expect(h.lastQueue(c, id)!.items.map((i) => i.text)).toEqual(["later"]);
    await sleep(300);
    expect(h.texts(c, id)).toEqual(["limit"]);
    c.ws.close();
  });

  it("session.bash failures other than busy still fail: empty => bad_command; folder outside roots => cwd_not_allowed; nothing queued", async () => {
    const h = await harness(permissionQuery);
    const c = await h.client();
    const gone = join(h.dir, "gone");
    mkdirSync(gone);
    const id = await h.session(c, gone);
    await busy(h, c, id);
    expect(await c.request({ type: "session.bash", sessionId: id, command: "  " })).toMatchObject({ type: "error", code: "bad_command" });
    rmSync(gone, { recursive: true });
    expect(await c.request({ type: "session.bash", sessionId: id, command: "echo hi" })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
    expect(h.lastQueue(c, id)?.items ?? []).toEqual([]);
    c.ws.close();
  });
});
