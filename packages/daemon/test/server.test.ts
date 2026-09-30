import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { calls, fakeQuery, history, interruptQuery, models, permissionQuery, questionQuery, setModelCalls } from "./fake-query.ts";

const webRoot = mkdtempSync(join(tmpdir(), "web-"));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const http = createDaemon({ webRoot, roots: [webRoot], query: fakeQuery as never, token });
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const { address, port } = http.address() as AddressInfo;
afterAll(() => void http.close());

const origin = () => `http://127.0.0.1:${port}`;
const protocols = (t = token) => [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${t}`];

/** Sends raw request bytes (any request target, even one no WebSocket client can send); resolves with the response head. */
function raw(requestLine: string, headers: Record<string, string> = {}) {
  const head = Object.entries({ host: `127.0.0.1:${port}`, upgrade: "websocket", connection: "Upgrade", ...headers })
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  return new Promise<string>((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(`${requestLine}\r\n${head}\r\n`));
    let out = "";
    s.on("data", (d) => {
      out += d;
      if (out.includes("\r\n\r\n")) (resolve(out.split("\r\n\r\n")[0]), s.destroy());
    });
    s.on("error", reject);
  });
}

/** Resolves with the HTTP status of a rejected upgrade and its body, or "open". */
function attempt(opts: { protocols?: string[]; headers?: Record<string, string> }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, opts.protocols ?? [], { headers: opts.headers });
  return new Promise<{ status: number | "open"; body: string; protocol?: string }>((resolve) => {
    ws.on("open", () => (resolve({ status: "open", body: "", protocol: ws.protocol }), ws.close()));
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    ws.on("error", () => {});
  });
}

function client(p = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, protocols(), { origin: `http://127.0.0.1:${p}` });
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
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      history: {
        listSessions: (async () => []) as never,
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

  it("lists models from supportedModels() and caches them", async () => {
    const c = await client();
    const before = calls.length;
    expect(await c.request({ type: "models.list" })).toMatchObject({ type: "reply", result: { models } });
    expect(await c.request({ type: "models.list" })).toMatchObject({ result: { models } });
    expect(calls.length).toBe(before + 1);
  });

  it("creates a session with a model and switches it with session.setModel", async () => {
    const c = await client();
    const created = await c.request({ type: "session.create", cwd: webRoot, model: "haiku" });
    const session = (created as { result: { session: { id: string; model: string } } }).result.session;
    expect(session.model).toBe("haiku");
    const r = await c.request({ type: "session.setModel", sessionId: session.id, model: "default" });
    expect(r).toMatchObject({ type: "reply", result: { session: { id: session.id, model: "default" } } });
    expect(setModelCalls.at(-1)).toBe("default");
  });

  it("rejects an empty or non-string model", async () => {
    const c = await client();
    expect(await c.request({ type: "session.create", cwd: webRoot, model: 5 })).toMatchObject({ code: "bad_model" });
    const created = await c.request({ type: "session.create", cwd: webRoot });
    const id = (created as { result: { session: { id: string } } }).result.session.id;
    expect(await c.request({ type: "session.setModel", sessionId: id, model: "" })).toMatchObject({ code: "bad_model" });
  });

  it("accepts an image-only prompt and rejects invalid images", async () => {
    const c = await client();
    const created = await c.request({ type: "session.create", cwd: webRoot });
    const sessionId = (created as { result: { session: { id: string } } }).result.session.id;
    const prompt = (images: unknown) => c.request({ type: "session.prompt", sessionId, text: "", images });
    for (const bad of ["data:image/png;base64,x", ["data:text/html;base64,PGI+"], [42]])
      expect(await prompt(bad)).toMatchObject({ type: "error", code: "bad_images" });
    expect(await prompt([])).toMatchObject({ type: "error", code: "bad_prompt" });
    expect(await prompt(["data:image/png;base64,iVBORw0KGgo="])).toMatchObject({ type: "reply" });
  });

  it("rejects a cwd outside the allowlisted roots", async () => {
    const c = await client();
    expect(await c.request({ type: "session.create", cwd: tmpdir() })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
    expect(await c.request({ type: "session.create", cwd: join(webRoot, "..", "..") })).toMatchObject({ code: "cwd_not_allowed" });
  });

  it("runs several sessions at the same time, each with its own event log", async () => {
    const c = await client();
    const ids = await Promise.all(
      [0, 1].map(async () => ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id),
    );
    await Promise.all(ids.map((sessionId) => c.request({ type: "session.subscribe", sessionId, sinceSeq: 0 })));
    await Promise.all(ids.map((sessionId) => c.request({ type: "session.prompt", sessionId, text: "hi" })));
    for (const id of ids) {
      await c.waitFor((m) => m.type === "event" && m.sessionId === id && m.part.type === "turn_result");
      const seqs = c.inbox.filter((m) => m.type === "event" && m.sessionId === id).map((m) => (m as { seq: number }).seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    }
  });

  it("lists allowlisted directories for the directory picker", async () => {
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    const c = await client();
    expect(await c.request({ type: "fs.list" })).toMatchObject({ result: { entries: [{ path: webRoot, isDir: true }] } });
    const sub = (await c.request({ type: "fs.list", path: webRoot })) as { result: { entries: { name: string; isDir: boolean }[] } };
    expect(sub.result.entries).toContainEqual({ name: "proj", path: join(webRoot, "proj"), isDir: true });
    expect(sub.result.entries).toContainEqual({ name: "index.html", path: join(webRoot, "index.html"), isDir: false });
    expect(await c.request({ type: "fs.list", path: join(webRoot, "..") })).toMatchObject({ code: "cwd_not_allowed" });
  });

  it("searches files under a cwd inside the allowlisted roots for @-mentions", async () => {
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    writeFileSync(join(webRoot, "proj", "notes.md"), "");
    const c = await client();
    expect(await c.request({ type: "fs.search", cwd: webRoot, query: "prnot" })).toMatchObject({ result: { paths: ["proj/notes.md"] } });
    expect(await c.request({ type: "fs.search", cwd: join(webRoot, ".."), query: "" })).toMatchObject({ code: "cwd_not_allowed" });
    expect(await c.request({ type: "fs.search", cwd: webRoot, query: 42 })).toMatchObject({ code: "bad_query" });
  });

  it("lists transcripts inside the roots merged with live sessions; opening one resumes it with the same ID", async () => {
    const inside = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
    const outside = "2b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
    const cwd = join(webRoot, "proj");
    mkdirSync(cwd, { recursive: true });
    const transcripts = [
      { sessionId: inside, summary: "fix the bug", lastModified: 1000, cwd },
      { sessionId: outside, summary: "elsewhere", lastModified: 2000, cwd: "/etc" },
      { sessionId: "3b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", summary: "no cwd", lastModified: 3000 },
    ];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      history: {
        listSessions: (async () => transcripts) as never,
        getSessionInfo: (async (sid: string) => transcripts.find((t) => t.sessionId === sid)) as never,
        getSessionMessages: (async () => history) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const created = (await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
      const list = (await c.request({ type: "session.list" })) as { result: { sessions: { id: string }[] } };
      expect(list.result.sessions).toEqual([
        { id: created.result.session.id, cwd: webRoot, state: "idle", model: "default", title: "New session", lastActivity: expect.any(Number) },
        { id: inside, cwd, state: "closed", model: "default", title: "fix the bug", lastActivity: 1000 },
      ]);

      expect(await c.request({ type: "session.subscribe", sessionId: outside, sinceSeq: 0 })).toMatchObject({ code: "unknown_session" });
      await c.request({ type: "session.subscribe", sessionId: inside, sinceSeq: 0 });
      await c.request({ type: "session.prompt", sessionId: inside, text: "go on" });
      expect(calls.filter((o) => o.resume === inside)).toHaveLength(1);
      const again = (await c.request({ type: "session.list" })) as { result: { sessions: { id: string; state: string }[] } };
      // State now comes from the live session, not "closed".
      expect(["running", "idle"]).toContain(again.result.sessions.find((s) => s.id === inside)?.state);
    } finally {
      d.close();
    }
  });

  it("previews and runs a rewind over WebSocket; bad mode and unknown message are errors", async () => {
    const c = await client();
    const { result } = (await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
    const sessionId = result.session.id;
    await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "session_state" && m.part.state === "idle" && m.seq > 2);
    const userMessageId = (c.inbox.find((m) => m.type === "event" && m.part.type === "user_text") as { part: { id: string } }).part.id;

    expect(await c.request({ type: "session.rewindPreview", sessionId, userMessageId })).toMatchObject({
      type: "reply",
      result: { filesChanged: ["/repo/a.ts"], conversation: false },
    });
    expect(await c.request({ type: "session.rewind", sessionId, userMessageId, mode: "code" })).toMatchObject({ type: "reply" });
    expect(await c.request({ type: "session.rewind", sessionId, userMessageId, mode: "conversation" })).toMatchObject({
      code: "rewind_failed",
      message: expect.stringMatching(/first prompt/),
    });
    expect(await c.request({ type: "session.rewind", sessionId, userMessageId, mode: "all" })).toMatchObject({ code: "bad_mode" });
    expect(await c.request({ type: "session.rewindPreview", sessionId, userMessageId: "nope" })).toMatchObject({ code: "rewind_failed" });
  });

  it("permission.respond: the first answer from any tab settles the request for all tabs; later ones are ignored", async () => {
    const d = createDaemon({ webRoot, roots: [webRoot], query: permissionQuery as never, token });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const p = (d.address() as AddressInfo).port;
    try {
      const [a, b] = await Promise.all([client(p), client(p)]);
      const { result } = (await a.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
      const sessionId = result.session.id;
      await a.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await b.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await a.request({ type: "session.prompt", sessionId, text: "run tests" });
      const isRequest = (m: ServerMessage) => m.type === "event" && m.part.type === "permission_request";
      const req = (await b.waitFor(isRequest)) as Extract<ServerMessage, { type: "event" }>;
      const requestId = (req.part as { requestId: string }).requestId;

      expect(await b.request({ type: "permission.respond", requestId, decision: "allow" })).toMatchObject({ result: { settled: true } });
      expect(await a.request({ type: "permission.respond", requestId, decision: "deny" })).toMatchObject({ result: { settled: false } });
      const settled = (m: ServerMessage) => isRequest(m) && m.type === "event" && (m.part as { settled: boolean }).settled;
      for (const c of [a, b]) expect(((await c.waitFor(settled)) as { part: object }).part).toMatchObject({ decision: "allow" });
      expect(await a.request({ type: "permission.respond", requestId, decision: "maybe" })).toMatchObject({ type: "error", code: "bad_request" });
    } finally {
      d.close();
    }
  });
  it("question.respond: the first answer from any tab settles the question for all tabs", async () => {
    const d = createDaemon({ webRoot, roots: [webRoot], query: questionQuery as never, token });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const p = (d.address() as AddressInfo).port;
    try {
      const [a, b] = await Promise.all([client(p), client(p)]);
      const { result } = (await a.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
      const sessionId = result.session.id;
      await a.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await b.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await a.request({ type: "session.prompt", sessionId, text: "set up" });
      const isQuestion = (m: ServerMessage) => m.type === "event" && m.part.type === "question";
      const requestId = ((await b.waitFor(isQuestion)) as { part: { requestId: string } }).part.requestId;

      expect(await a.request({ type: "question.respond", requestId, answers: { q: 1 } })).toMatchObject({ type: "error", code: "bad_request" });
      expect(await a.request({ type: "question.respond", requestId })).toMatchObject({ type: "error", code: "bad_request" });
      const answers = { "Which package manager?": "pnpm" };
      expect(await b.request({ type: "question.respond", requestId, answers })).toMatchObject({ result: { settled: true } });
      expect(await a.request({ type: "question.respond", requestId, answers: {} })).toMatchObject({ result: { settled: false } });
      const settled = (m: ServerMessage) => isQuestion(m) && (m as { part: { settled: boolean } }).part.settled;
      for (const c of [a, b]) expect(((await c.waitFor(settled)) as { part: object }).part).toMatchObject({ answers });
    } finally {
      d.close();
    }
  });

  it("session.prompt steers a running turn; session.interrupt stops it and the session takes the next prompt", async () => {
    const d = createDaemon({ webRoot, roots: [webRoot], query: interruptQuery as never, token });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const { result } = (await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
      const sessionId = result.session.id;
      await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await c.request({ type: "session.prompt", sessionId, text: "run" });
      await c.waitFor((m) => m.type === "event" && m.part.type === "tool_call");
      expect(await c.request({ type: "session.prompt", sessionId, text: "steer" })).toMatchObject({ type: "reply" });
      expect(await c.request({ type: "session.interrupt", sessionId })).toMatchObject({ type: "reply" });
      await c.waitFor((m) => m.type === "event" && m.part.type === "turn_interrupted");
      await c.request({ type: "session.prompt", sessionId, text: "hi" });
      await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
      expect(await c.request({ type: "session.interrupt", sessionId: "nope" })).toMatchObject({ type: "error", code: "unknown_session" });
    } finally {
      d.close();
    }
  });
});

describe("WebSocket auth and origin check", () => {
  it("accepts the paired token from the daemon's own origin and selects the claude-ui subprotocol", async () => {
    expect(await attempt({ protocols: protocols(), headers: { origin: origin() } })).toMatchObject({ status: "open", protocol: WS_PROTOCOL });
    const localhost = `http://localhost:${port}`;
    expect((await attempt({ protocols: protocols(), headers: { origin: localhost, host: `localhost:${port}` } })).status).toBe("open");
  });

  it("rejects a connection without a token or with a wrong token (401), without echoing the token", async () => {
    expect((await attempt({ headers: { origin: origin() } })).status).toBe(401);
    expect((await attempt({ protocols: [WS_PROTOCOL], headers: { origin: origin() } })).status).toBe(401);
    const wrong = await attempt({ protocols: protocols("wrong-token"), headers: { origin: origin() } });
    expect(wrong.status).toBe(401);
    expect(wrong.body).not.toContain("wrong-token");
  });

  it("rejects a cross-site, missing or DNS-rebinding Origin (403), even with the valid token", async () => {
    const bad: Record<string, string>[] = [
      { origin: "http://evil.example" },
      { origin: `http://localhost:${port + 1}` },
      {},
      { origin: `http://evil.example:${port}`, host: `evil.example:${port}` },
      { origin: "null" },
    ];
    for (const headers of bad) {
      const r = await attempt({ protocols: protocols(), headers });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain(token);
    }
  });

  it("rejects upgrades on paths other than /ws", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`, protocols(), { origin: origin() });
    const status = await new Promise((r) => (ws.on("unexpected-response", (_q, res) => r(res.statusCode)), ws.on("error", () => {})));
    expect(status).toBe(404);
  });

  it("answers a malformed upgrade request target with 4xx and keeps serving", async () => {
    for (const target of ["http://[", "http://[::1", "//[/ws"]) {
      expect(await raw(`GET ${target} HTTP/1.1`, { origin: origin(), "sec-websocket-protocol": protocols().join(", ") })).toMatch(/^HTTP\/1\.1 4\d\d /);
    }
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  });

  it("selects the claude-ui subprotocol only when the client offered it", async () => {
    const res = await raw("GET /ws HTTP/1.1", {
      origin: origin(),
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": `${TOKEN_PROTOCOL_PREFIX}${token}`,
    });
    expect(res).toMatch(/^HTTP\/1\.1 101 /);
    expect(res.toLowerCase()).not.toContain("sec-websocket-protocol");
  });
});
