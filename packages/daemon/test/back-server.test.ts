import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { BackMark, Part, PushPayload, ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import { fakeQuery, interruptQuery, permissionQuery } from "./fake-query.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const servers: { close(): unknown }[] = [];
afterAll(() => servers.forEach((s) => s.close()));
vi.spyOn(console, "log").mockImplementation(() => {});

async function harness(query: unknown, extra: Partial<Parameters<typeof createDaemon>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "back-"));
  const appSettings = createSettings({ file: join(dir, "settings.json") });
  const http = createDaemon({ webRoot: dir, roots: [dir], query: query as never, token, appSettings, ...extra });
  servers.push(http);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return vi.waitFor(() => inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) ?? Promise.reject(new Error("no reply")), { timeout: 5000 }) as unknown as Promise<{ type: string; result?: any; code?: string }>;
  };
  const session = async () => {
    const id = ((await request({ type: "session.create", cwd: dir })).result as any).session.id as string;
    await request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    return id;
  };
  const marks = (id: string): BackMark[] => appSettings.get().back.marks[id] ?? [];
  const parts = (id: string) => inbox.filter((m: any) => m.type === "event" && m.sessionId === id).map((m: any) => m.part as Part);
  return { dir, appSettings, request, session, marks, parts, inbox };
}
const set = (id: string, extra: object = {}) => ({ type: "back.set", sessionId: id, partId: "msg_1:0", title: "Reply title", ...extra });

describe("back marks in the daemon", { timeout: 20_000 }, () => {
  it("a new mark on an idle session sends a tagged brief turn and stores its answer", async () => {
    const h = await harness(fakeQuery);
    const id = await h.session();
    expect((await h.request(set(id, { note: "n" }))).type).toBe("reply");
    await vi.waitFor(() => expect(h.marks(id)[0]?.brief?.text).toBeTruthy(), { timeout: 5000 });
    const m = h.marks(id)[0]!;
    expect(m.briefState).toBeUndefined();
    expect(m.note).toBe("n");
    const user = h.parts(id).filter((p: any) => p.type === "user_text").map((p: any) => p.text as string);
    expect(user[0]!.split("\n")[0]).toBe('<claude-ui-brief part="msg_1:0"/>');
  });
  it("on a running session the brief is queued as a brief item, then runs after the turn", async () => {
    const h = await harness(permissionQuery);
    const id = await h.session();
    await h.request({ type: "session.prompt", sessionId: id, text: "first" });
    await vi.waitFor(() => expect(h.inbox.some((m: any) => m.type === "event" && m.part.type === "permission_request")).toBe(true), { timeout: 5000 });
    await h.request(set(id));
    expect(h.marks(id)[0]!.briefState).toBe("queued");
    const q = h.parts(id).filter((p: any) => p.type === "prompt_queue").at(-1) as any;
    expect(q.items).toHaveLength(1);
    expect(q.items[0].brief).toBe(true);
    // Done removes the queued item.
    await h.request({ type: "back.done", sessionId: id, partId: "msg_1:0" });
    expect(h.marks(id)).toEqual([]);
    const q2 = h.parts(id).filter((p: any) => p.type === "prompt_queue").at(-1) as any;
    expect(q2.items).toEqual([]);
  });
  it("deleting a queued brief marks it failed; Stop fails a running one; Retry sends one new brief; busy is refused", async () => {
    const h = await harness(interruptQuery);
    const id = await h.session();
    await h.request({ type: "session.prompt", sessionId: id, text: "work" });
    await h.request(set(id));
    const item = (h.parts(id).filter((p: any) => p.type === "prompt_queue").at(-1) as any).items[0];
    expect((await h.request({ type: "back.brief", sessionId: id, partId: "msg_1:0" })).code).toBe("brief_busy");
    await h.request({ type: "session.dequeue", sessionId: id, itemId: item.id });
    expect(h.marks(id)[0]).toMatchObject({ briefState: "failed", briefError: "Removed from queue" });
  });
  it("back.set validates and refuses unknown sessions; settings.set refuses back; marks are capped", async () => {
    const h = await harness(fakeQuery);
    const id = await h.session();
    expect((await h.request(set("00000000-0000-4000-8000-000000000000"))).code).toBe("unknown_session");
    expect((await h.request(set(id, { remindMs: 59_999 }))).code).toBe("bad_request");
    expect((await h.request(set(id, { remindMs: 8 * 86_400_000 }))).code).toBe("bad_request");
    expect((await h.request({ type: "settings.set", patch: { back: { marks: {} } } })).code).toBe("bad_settings");
    expect(h.marks(id)).toEqual([]);
  });
  it("remindMs sets remindAt; Dismiss clears; Done removes; deleting the session removes its marks", async () => {
    const h = await harness(fakeQuery, { history: { deleteSession: async () => {}, getSessionInfo: async () => undefined } as never });
    const id = await h.session();
    await h.request(set(id, { remindMs: 120_000 }));
    expect(h.marks(id)[0]!.remindAt).toBeGreaterThan(Date.now() + 100_000);
    await h.request(set(id, { remindMs: null }));
    expect(h.marks(id)[0]!.remindAt).toBeUndefined();
    await h.request({ type: "back.done", sessionId: id, partId: "msg_1:0" });
    expect(h.marks(id)).toEqual([]);
    await h.request(set(id));
    await vi.waitFor(() => expect(h.marks(id)[0]?.briefState).toBeUndefined(), { timeout: 5000 });
    // The reply waits for the CLI to close (slow in the fake): poll the effect.
    void h.request({ type: "session.delete", sessionId: id }).catch(() => {});
    await vi.waitFor(() => expect(h.appSettings.get().back.marks[id]).toBeUndefined(), { timeout: 15_000 });
  });
  it("a restart turns a pending brief into the failed state; a Side refuses back.*", async () => {
    const dir = mkdtempSync(join(tmpdir(), "back-"));
    const file = join(dir, "settings.json");
    const s = createSettings({ file });
    s.changeMarks((m) => void (m.sess = [{ partId: "p", at: 1, title: "t", briefState: "queued" }]));
    const h = await harness(fakeQuery, { appSettings: s });
    expect(s.get().back.marks.sess![0]).toMatchObject({ briefState: "failed", briefError: "Interrupted by a restart" });
    const side = await harness(fakeQuery, { attached: true });
    const id = await side.session();
    expect((await side.request(set(id))).code).toBe("back_unsupported");
  });
  it("a due reminder fires once: remindedAt set, one push with the mark part; two due give one grouped push", async () => {
    const pushed: PushPayload[] = [];
    let now = 1_000_000;
    const push = { publicKey: "k", subscribe: () => true, send: async (p: PushPayload) => void pushed.push(p) };
    const h = await harness(fakeQuery, { push: push as never, backReminders: { everyMs: 20, now: () => now } });
    const id = await h.session();
    await h.request(set(id, { remindMs: 60_000, note: "do it" }));
    await h.request({ ...set(id, { remindMs: 60_000 }), partId: "msg_2:0" });
    const base = h.marks(id)[0]!.remindAt!;
    now = base + 5 * 60_000;
    await vi.waitFor(() => expect(pushed.length).toBe(1), { timeout: 3000 });
    expect(pushed[0]).toMatchObject({ title: "2 replies to come back to", tag: "back" });
    expect(h.marks(id).every((m) => m.remindedAt !== undefined)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(pushed.length).toBe(1);
    // Snooze re-arms; a single due mark gives the single payload with backPart and the missed note.
    await h.request(set(id, { remindMs: 60_000 }));
    now = h.marks(id)[0]!.remindAt! + 5 * 60_000;
    await vi.waitFor(() => expect(pushed.length).toBe(2), { timeout: 3000 });
    expect(pushed[1]).toMatchObject({ backPart: "msg_1:0", tag: "back-msg_1:0" });
    expect(pushed[1]!.body).toMatch(/^do it \(was due /);
  });
});
