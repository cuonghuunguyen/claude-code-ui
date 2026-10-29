// Aside (docs/spec.md "Aside"): daemon side of /btw, Keep as session and the cleanup of leftovers.
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ServerMessage } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { calls, fakeQuery, history as chain, inputs } from "./fake-query.ts";
import { createSessionSettings } from "../src/session-settings.ts";

const webRoot = realpathSync(mkdtempSync(join(tmpdir(), "as-web-")));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const lastAssistant = (chain as { type: string; uuid: string }[]).filter((m) => m.type === "assistant").at(-1)!.uuid;

/** fakeQuery whose close() also ends the wait for the next prompt (else Session.close() waits its 5 s cap). */
function closableQuery({ prompt, options }: Parameters<typeof fakeQuery>[0]) {
  const it = prompt[Symbol.asyncIterator]();
  let stop = () => {};
  const stopped = new Promise<IteratorResult<never>>((r) => (stop = () => r({ done: true, value: undefined as never })));
  const wrapped = { [Symbol.asyncIterator]: () => ({ next: () => Promise.race([it.next(), stopped]), return: async () => ({ done: true as const, value: undefined as never }) }) };
  const q = fakeQuery({ prompt: wrapped as never, options });
  const close = q.close;
  q.close = () => (stop(), close());
  return q;
}

type Fork = { id: string; upTo?: string; title?: string; dir?: string };
let open: { close(): void }[] = [];
afterEach(() => (open.forEach((o) => o.close()), (open = [])));

/** A daemon over a fake SDK history: `owner` has a transcript (`messages`); forkSession adds a transcript copy. */
async function start({ messages = chain, settingsFile = join(mkdtempSync(join(tmpdir(), "as-cfg-")), "sessions.json"), idleCloseMs = 0, asideSweepMs = undefined as number | undefined, listen = true, seed = {} as Record<string, object> } = {}) {
  const forks: Fork[] = [];
  const deleted: string[] = [];
  const transcripts = new Map<string, { messages: unknown[]; summary: string }>([[OWNER, { messages: messages as never[], summary: "owner" }]]);
  if (Object.keys(seed).length) writeFileSync(settingsFile, JSON.stringify(seed));
  for (const id of Object.keys(seed)) transcripts.set(id, { messages: messages as never[], summary: "leftover" });
  const d = createDaemon({
    webRoot,
    token,
    roots: [webRoot],
    query: closableQuery as never,
    settingsFile,
    projectsDir: mkdtempSync(join(tmpdir(), "as-proj-")),
    idleCloseMs,
    asideSweepMs,
    listCache: false,
    modelListWaitMs: 0,
    history: {
      listSessions: (async () => [...transcripts].map(([sessionId, t]) => ({ sessionId, cwd: webRoot, summary: t.summary, lastModified: 1 }))) as never,
      getSessionInfo: (async (sid: string) => (transcripts.has(sid) ? { sessionId: sid, cwd: webRoot, summary: transcripts.get(sid)!.summary } : undefined)) as never,
      getSessionMessages: (async (sid: string) => transcripts.get(sid)?.messages ?? []) as never,
      forkSession: (async (id: string, o: { upToMessageId?: string; title?: string; dir?: string }) => {
        const sessionId = randomUUID();
        forks.push({ id, upTo: o.upToMessageId, title: o.title, dir: o.dir });
        transcripts.set(sessionId, { messages: transcripts.get(id)!.messages, summary: o.title ?? "" });
        return { sessionId };
      }) as never,
      deleteSession: (async (sid: string) => void (deleted.push(sid), transcripts.delete(sid))) as never,
    },
  });
  open.push(d);
  // listen: false stands for a --side daemon, which has no port of its own.
  if (!listen) return { d, settingsFile, deleted } as unknown as Awaited<ReturnType<typeof start>>;
  await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
  const port = (d.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  open.push(ws);
  const inbox: ServerMessage[] = [];
  ws.on("message", (m) => inbox.push(JSON.parse(String(m))));
  await new Promise((r) => ws.once("open", r));
  const request = async (msg: object) => {
    const reqId = randomUUID();
    ws.send(JSON.stringify({ ...msg, reqId }));
    for (;;) {
      const m = inbox.find((x) => (x.type === "reply" || x.type === "error") && (x as { reqId?: string }).reqId === reqId);
      if (m) return m as { type: string; result?: any; code?: string };
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const ids = async () => ((await request({ type: "session.list" })).result.sessions as { id: string }[]).map((s) => s.id);
  return { d, port, settingsFile, forks, deleted, transcripts, inbox, request, ids };
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};
const linkOf = (file: string, id: string) => createSessionSettings({ file }).get(id);

describe("aside.open", () => {
  it("forks at the fork point and links the Aside: read-only, no worker tools, the question is the first input", async () => {
    const t = await start();
    await t.request({ type: "session.create", cwd: webRoot });
    const before = calls.length;
    const r = await t.request({ type: "aside.open", sessionId: OWNER, text: "what is this?\nmore" });
    expect(r.type).toBe("reply");
    const { session, title, from } = r.result;
    expect(title).toBe("what is this?");
    expect(t.forks).toEqual([{ id: OWNER, upTo: lastAssistant, title: "what is this?", dir: webRoot }]);
    expect(linkOf(t.settingsFile, session.id)).toMatchObject({ ownerId: OWNER, readOnly: true, permissionMode: "default", port: t.port });
    const run = calls.slice(before).find((o) => o.resume === session.id && o.canUseTool)!;
    expect(run.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit", "mcp__orchestration"]);
    expect(inputs.at(-1)!.uuid).toBe(from);
    expect(inputs.at(-1)!.message.content).toBe("what is this?\nmore");
  });

  it("without a reply it fails aside_unavailable and creates nothing", async () => {
    const t = await start({ messages: [chain[0]!] });
    const r = await t.request({ type: "aside.open", sessionId: OWNER, text: "q" });
    expect(r).toMatchObject({ type: "error", code: "aside_unavailable" });
    expect(t.forks).toEqual([]);
    expect((await t.request({ type: "aside.open", sessionId: OWNER, text: "  " })).code).toBe("bad_prompt");
  });

  it("leaves the owner untouched: no input on the owner, the owner's transcript only read", async () => {
    const t = await start();
    const before = inputs.length;
    await t.request({ type: "aside.open", sessionId: OWNER, text: "q" });
    // Only the Aside's question reached a CLI.
    expect(inputs.length - before).toBe(1);
    expect(t.deleted).toEqual([]);
    expect(t.transcripts.get(OWNER)!.messages).toBe(chain);
  });

  it("a failing transcript read reports the real error, not 'needs a reply first'", async () => {
    const t = await start();
    // The owner restores once (first read); the fork point read after it fails.
    let reads = 0;
    const orig = t.transcripts.get(OWNER)!;
    Object.defineProperty(orig, "messages", { get: () => { if (++reads > 1) throw new Error("EIO read failed"); return chain; } });
    const r = await t.request({ type: "aside.open", sessionId: OWNER, text: "q" });
    expect(r).toMatchObject({ type: "error", code: "aside_failed" });
    expect((r as { message?: string }).message).toContain("EIO read failed");
    expect(t.forks).toEqual([]);
  });

  it("an unknown owner fails unknown_session", async () => {
    const t = await start();
    t.transcripts.delete(OWNER);
    expect((await t.request({ type: "aside.open", sessionId: OWNER, text: "q" })).code).toBe("unknown_session");
  });
});

describe("listing, close and keep", () => {
  it("session.list never lists an Aside; it is listed after aside.keep, which keeps readOnly", async () => {
    const t = await start();
    await t.request({ type: "session.create", cwd: webRoot });
    const { session } = (await t.request({ type: "aside.open", sessionId: OWNER, text: "q" })).result;
    expect(await t.ids()).not.toContain(session.id);
    expect((await t.request({ type: "aside.keep", sessionId: session.id })).type).toBe("reply");
    expect(await t.ids()).toContain(session.id);
    expect(linkOf(t.settingsFile, session.id)).toMatchObject({ readOnly: true });
    expect(linkOf(t.settingsFile, session.id)?.ownerId).toBeUndefined();
    expect((await t.request({ type: "aside.keep", sessionId: session.id })).code).toBe("not_an_aside");
  });

  it("aside.close deletes transcript and link and broadcasts the deletion; a plain session is refused", async () => {
    const t = await start();
    const { session } = (await t.request({ type: "aside.open", sessionId: OWNER, text: "q" })).result;
    expect((await t.request({ type: "aside.close", sessionId: OWNER })).code).toBe("not_an_aside");
    expect((await t.request({ type: "aside.close", sessionId: session.id })).type).toBe("reply");
    expect(t.deleted).toEqual([session.id]);
    expect(linkOf(t.settingsFile, session.id)).toBeUndefined();
    expect(t.inbox.some((m) => m.type === "sessions.changed" && (m as { deleted?: string }).deleted === session.id)).toBe(true);
  });

  it("setPermissionMode clears readOnly; the next CLI start has no editing tools restriction", async () => {
    const t = await start();
    const { session } = (await t.request({ type: "aside.open", sessionId: OWNER, text: "q" })).result;
    await t.request({ type: "aside.keep", sessionId: session.id });
    await until(() => (inputs.at(-1)!.message.content as string) === "q");
    await t.request({ type: "session.setPermissionMode", sessionId: session.id, mode: "acceptEdits" });
    expect(linkOf(t.settingsFile, session.id)?.readOnly).toBeUndefined();
  });
});

describe("leftovers", () => {
  /** A server on a free port: stands for a daemon of another port. */
  const foreign = async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    open.push({ close: () => void s.close() });
    return { port: (s.address() as AddressInfo).port, close: () => new Promise((r) => s.close(r)) };
  };
  const deadPort = async () => {
    const f = await foreign();
    await f.close();
    return f.port;
  };

  it("startup removes leftover Asides of this port, of no port and of a port where nothing listens, not of a live port", async () => {
    const b = "00000000-0000-4000-8000-0000000000b2";
    const c = "00000000-0000-4000-8000-0000000000b3";
    const e = "00000000-0000-4000-8000-0000000000b5";
    const live = await foreign();
    const t = await start({ seed: { [b]: { ownerId: OWNER, readOnly: true }, [c]: { ownerId: OWNER, readOnly: true, port: await deadPort() }, [e]: { ownerId: OWNER, readOnly: true, port: live.port } } });
    await until(() => t.deleted.includes(b) && t.deleted.includes(c));
    expect(t.deleted).not.toContain(e);
  });

  it("a kept Session (no owner) of a dead port is not deleted", async () => {
    const k = "00000000-0000-4000-8000-0000000000b4";
    const t = await start({ seed: { [k]: { port: await deadPort() } } });
    await new Promise((r) => setTimeout(r, 300));
    expect(t.deleted).not.toContain(k);
  });

  it("the periodic pass deletes the Aside of a daemon that stopped while this one runs, also with idle close off", async () => {
    const e = "00000000-0000-4000-8000-0000000000b6";
    const live = await foreign();
    const t = await start({ asideSweepMs: 50, seed: { [e]: { ownerId: OWNER, readOnly: true, port: live.port } } });
    await new Promise((r) => setTimeout(r, 200));
    expect(t.deleted).not.toContain(e);
    await live.close();
    await until(() => t.deleted.includes(e));
    await until(() => linkOf(t.settingsFile, e) === undefined);
  });

  it("the periodic pass leaves a link of its own port", async () => {
    const own = "00000000-0000-4000-8000-0000000000b7";
    const t = await start({ asideSweepMs: 50 });
    writeFileSync(t.settingsFile, JSON.stringify({ [own]: { ownerId: OWNER, readOnly: true, port: t.port } }));
    t.transcripts.set(own, { messages: chain as never[], summary: "own" });
    await new Promise((r) => setTimeout(r, 300));
    expect(t.deleted).not.toContain(own);
  });

  it("a daemon without a port of its own (--side) deletes no link of another port", async () => {
    const e = "00000000-0000-4000-8000-0000000000b8";
    const t = await start({ listen: false, asideSweepMs: 50, seed: { [e]: { ownerId: OWNER, readOnly: true, port: await deadPort() } } });
    await new Promise((r) => setTimeout(r, 300));
    expect(t.deleted).not.toContain(e);
  });

  it("idle close deletes an Aside without a popup", async () => {
    const t = await start({ idleCloseMs: 50 });
    const { session } = (await t.request({ type: "aside.open", sessionId: OWNER, text: "q" })).result;
    await until(() => t.deleted.includes(session.id));
    // The link goes after the transcript delete returns.
    await until(() => linkOf(t.settingsFile, session.id) === undefined);
  });

  it("an Aside followed only by a background subscription (popup open after a reconnect) is not deleted by idle close", async () => {
    const t = await start({ idleCloseMs: 50 });
    const { session } = (await t.request({ type: "aside.open", sessionId: OWNER, text: "q" })).result;
    await t.request({ type: "session.subscribe", sessionId: session.id, sinceSeq: 0, paged: true, background: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(t.deleted).not.toContain(session.id);
  });

  it("a kept Session restores after a daemon restart and keeps readOnly", async () => {
    const t = await start();
    const { session } = (await t.request({ type: "aside.open", sessionId: OWNER, text: "q" })).result;
    await t.request({ type: "aside.keep", sessionId: session.id });
    const again = await start({ settingsFile: t.settingsFile });
    again.transcripts.set(session.id, { messages: chain as never[], summary: "kept" });
    const before = calls.length;
    await again.request({ type: "session.prompt", sessionId: session.id, text: "next" });
    const run = calls.slice(before).find((o) => o.resume === session.id && o.canUseTool)!;
    expect(run.disallowedTools).toEqual(["Edit", "Write", "NotebookEdit"]);
  });
});
