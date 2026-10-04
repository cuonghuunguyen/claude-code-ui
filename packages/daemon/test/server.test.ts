import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { PushPayload, ServerMessage } from "@claude-ui/protocol";
import { MAX_TERMINAL_INPUT_BYTES, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createDaemon, MAX_FRAME_BYTES, MAX_SETTINGS } from "../src/server.ts";
import { MAX_TERMINALS, MAX_TERMINALS_PER_CLIENT } from "../src/terminals.ts";
import { calls, closedQueries, controlCalls, fakeQuery, firstTurnLastAssistant, planCalls, history, interruptQuery, models, permissionQuery, permissionResults, questionQuery, setModelCalls, stopped, subagentQuery, yielded } from "./fake-query.ts";

/** A projects store with these cwds added. */
const added = (...cwds: string[]) => {
  const p = createProjects();
  cwds.forEach((c) => p.open(c));
  return p;
};

const webRoot = mkdtempSync(join(tmpdir(), "web-"));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const http = createDaemon({ webRoot, roots: [webRoot], query: fakeQuery as never, token, uploadDir: join(mkdtempSync(join(tmpdir(), "up-")), "claude-ui-uploads") });
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
  // A rejected upgrade (ws "error": Unexpected server response) or no answer fails the caller instead of hanging it.
  return new Promise<{ ws: WebSocket; request: typeof request; waitFor: typeof waitFor; inbox: ServerMessage[] }>((resolve, reject) => {
    const t = setTimeout(() => (ws.terminate(), reject(new Error("WebSocket open timed out"))), 5_000);
    ws.once("error", (e) => (clearTimeout(t), reject(e)));
    ws.once("open", () => (clearTimeout(t), resolve({ ws, request, waitFor, inbox })));
  });
}

describe("daemon", () => {
  it("sends plan usage to every connection: read on connect, cached for the next one, again after each turn", async () => {
    const a = await client();
    const first = (await a.waitFor((m) => m.type === "plan_usage")) as Extract<ServerMessage, { type: "plan_usage" }>;
    expect(first.usage).toMatchObject({ plan: "team", status: "allowed", windows: [{ kind: "session", percent: 55 }, { kind: "weekly_all" }, { label: "Current week (Fable)" }] });
    const before = planCalls.length;
    const b = await client();
    await b.waitFor((m) => m.type === "plan_usage");
    expect(planCalls.length).toBe(before);
    const created = (await a.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
    const id = created.result.session.id;
    await a.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await a.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await b.waitFor(() => b.inbox.filter((m) => m.type === "plan_usage").length >= 2);
    expect(planCalls.at(-1)).toMatchObject({ sessionId: id });
    a.ws.close();
    b.ws.close();
  });

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
      // An idle restored session spawns no prompt query until it is prompted (only the throwaway usage query, serialized daemon-wide).
      expect(calls.filter((o) => o.resume === id && o.canUseTool)).toHaveLength(0);

      await c.request({ type: "session.prompt", sessionId: id, text: "third" });
      expect(calls.filter((o) => o.resume === id && o.canUseTool)).toHaveLength(1);
      await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");

      expect(await c.request({ type: "session.subscribe", sessionId: "../../etc/passwd", sinceSeq: 0 })).toMatchObject({ code: "unknown_session" });
    } finally {
      restarted.close();
    }
  });

  it("a restored session keeps the model its transcript last ran on or switched to: header and resumed query agree", async () => {
    const id = "9b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
    const onHaiku = history.map((m: { type: string; message: object }) =>
      m.type === "assistant" ? { ...m, message: { ...m.message, model: "claude-haiku-4-5-20251001" } } : m,
    );
    const switched = [...history, { type: "user", uuid: "u3", session_id: "x", message: { role: "user", content: "<local-command-stdout>Set model to `haiku (claude-haiku-4-5-20251001)`</local-command-stdout>" }, parent_tool_use_id: null }];
    const restart = async (transcript: unknown[]) => {
      const d = createDaemon({
        webRoot,
        token,
        roots: [webRoot],
        query: fakeQuery as never,
        history: {
          listSessions: (async () => []) as never,
          getSessionInfo: (async () => ({ sessionId: id, cwd: webRoot })) as never,
          getSessionMessages: (async () => transcript) as never,
        },
      });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      const c = await client((d.address() as AddressInfo).port);
      const sub = (await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 })) as { result: { session: { model: string } } };
      await c.request({ type: "session.prompt", sessionId: id, text: "go" });
      d.close();
      return { model: sub.result.session.model, resumedWith: calls.at(-1)!.model };
    };
    expect(await restart(onHaiku)).toEqual({ model: "haiku", resumedWith: "haiku" });
    // A switch after the last reply, before any prompt on the new model.
    expect(await restart(switched)).toEqual({ model: "haiku", resumedWith: "haiku" });
    // The default model's reply maps to "default", not to an alias row with the same resolved model.
    expect(await restart(history)).toEqual({ model: "default", resumedWith: undefined });
  });

  it("a restored session keeps its model, effort and permission mode across a restart: header and resumed query agree", async () => {
    const settingsFile = join(mkdtempSync(join(tmpdir(), "cfg-")), "sessions.json");
    const start = async (allowBypass = false) => {
      const d = createDaemon({
        webRoot,
        token,
        roots: [webRoot],
        query: fakeQuery as never,
        settingsFile,
        allowBypass,
        history: {
          listSessions: (async () => []) as never,
          getSessionInfo: (async (sid: string) => ({ sessionId: sid, cwd: webRoot })) as never,
          getSessionMessages: (async () => history) as never,
        },
      });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      return { d, c: await client((d.address() as AddressInfo).port) };
    };
    const first = await start(true);
    const id = ((await first.c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
    await first.c.request({ type: "session.setModel", sessionId: id, model: "haiku" });
    await first.c.request({ type: "session.setEffort", sessionId: id, effort: "high" });
    await first.c.request({ type: "session.setPermissionMode", sessionId: id, mode: "acceptEdits" });
    first.d.close();

    const second = await start();
    const sub = (await second.c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 })) as { result: { seq: number; session: object } };
    expect(sub.result.session).toMatchObject({ model: "haiku", effort: "high", permissionMode: "acceptEdits" });
    expect(sub.result.seq).toBeGreaterThan(0);
    await second.c.request({ type: "session.prompt", sessionId: id, text: "go" });
    expect(calls.at(-1)).toMatchObject({ resume: id, model: "haiku", effort: "high", permissionMode: "acceptEdits" });
    // A mode the daemon no longer enables is not restored.
    await second.c.request({ type: "session.setPermissionMode", sessionId: id, mode: "plan" });
    second.d.close();
    const saved = JSON.parse(readFileSync(settingsFile, "utf8"));
    writeFileSync(settingsFile, JSON.stringify({ ...saved, [id]: { ...saved[id], permissionMode: "bypassPermissions" } }));
    const third = await start();
    const again = (await third.c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 })) as { result: { session: object } };
    expect(again.result.session).toMatchObject({ model: "haiku", effort: "high", permissionMode: "default" });
    third.d.close();
  });

  describe("sessions.json", () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const daemon = async (settingsFile: string, transcripts: { sessionId: string; cwd: string }[] = [], projectsDir?: string) => {
      const d = createDaemon({
        webRoot,
        token,
        roots: [webRoot],
        query: fakeQuery as never,
        settingsFile,
        projectsDir,
        history: {
          listSessions: (async () => transcripts.map((t) => ({ ...t, summary: "t", lastModified: 1 }))) as never,
          getSessionInfo: (async (sid: string) => ({ sessionId: sid, cwd: webRoot })) as never,
          getSessionMessages: (async () => history) as never,
          deleteSession: (async () => {}) as never,
        },
      });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      return { d, c: await client((d.address() as AddressInfo).port) };
    };
    const file = () => join(mkdtempSync(join(tmpdir(), "cfg-")), "sessions.json");
    const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;

    it("is replaced atomically (a new file renamed over the old one), no temp file left", async () => {
      const f = file();
      const { d, c } = await daemon(f);
      const id = ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      await c.request({ type: "session.setEffort", sessionId: id, effort: "high" });
      const inode = statSync(f).ino;
      await c.request({ type: "session.setEffort", sessionId: id, effort: "low" });
      expect(statSync(f).ino).not.toBe(inode);
      expect(read(f)[id]).toMatchObject({ effort: "low" });
      expect(readdirSync(dirname(f))).toEqual(["sessions.json"]);
      d.close();
    });

    it("session.delete removes the entry; a list drops entries whose session has no transcript and is not live", async () => {
      const f = file();
      const [kept, gone, deleted] = [uuid(1), uuid(2), uuid(3)];
      const entry = { model: "haiku", permissionMode: "default", effort: "high" };
      writeFileSync(f, JSON.stringify({ [kept]: entry, [gone]: entry, [deleted]: entry }));
      const { d, c } = await daemon(f, [{ sessionId: kept, cwd: webRoot }, { sessionId: deleted, cwd: webRoot }]);
      expect(await c.request({ type: "session.delete", sessionId: deleted })).toMatchObject({ type: "reply" });
      expect(Object.keys(read(f))).toEqual([kept, gone]);
      await c.request({ type: "session.list" });
      expect(Object.keys(read(f))).toEqual([kept]);
      d.close();
    });

    it(`keeps at most ${MAX_SETTINGS} entries: the least recently changed go first`, async () => {
      const f = file();
      const entry = { model: "haiku", permissionMode: "default", effort: "high" };
      writeFileSync(f, JSON.stringify(Object.fromEntries(Array.from({ length: MAX_SETTINGS }, (_, i) => [uuid(i), entry]))));
      const { d, c } = await daemon(f);
      // Re-saving an existing entry moves it to the end; a new one pushes out the oldest.
      await c.request({ type: "session.subscribe", sessionId: uuid(0), sinceSeq: 0 });
      await c.request({ type: "session.setEffort", sessionId: uuid(0), effort: "low" });
      const id = ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      await c.request({ type: "session.setEffort", sessionId: id, effort: "max" });
      const keys = Object.keys(read(f));
      expect(keys).toHaveLength(MAX_SETTINGS);
      expect(keys.slice(0, 1)).toEqual([uuid(2)]);
      expect(keys.slice(-2)).toEqual([uuid(0), id]);
      d.close();
    });

    it("without an entry a restored session takes mode and effort from its raw transcript", async () => {
      const id = uuid(7);
      const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
      const dir = join(projectsDir, webRoot.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir);
      const line = (o: object) => JSON.stringify(o) + "\n";
      writeFileSync(
        join(dir, `${id}.jsonl`),
        line({ type: "user", permissionMode: "plan" }) + line({ type: "assistant", effort: "low" }) + line({ type: "user", permissionMode: "acceptEdits" }) +
          line({ type: "assistant", effort: "high" }) + line({ type: "assistant", isSidechain: true, effort: "max" }),
      );
      const { d, c } = await daemon(file(), [], projectsDir);
      const sub = (await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 })) as { result: { session: object } };
      expect(sub.result.session).toMatchObject({ permissionMode: "acceptEdits", effort: "high" });
      d.close();
    });

    it("a prompted web session with default settings restores with effort Default, not the effective effort its transcript records", async () => {
      const f = file();
      const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
      const dir = join(projectsDir, webRoot.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir);
      const first = await daemon(f, [], projectsDir);
      const id = ((await first.c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      await first.c.request({ type: "session.prompt", sessionId: id, text: "hi" });
      // The CLI records the effort it ran with (the model's default) on every reply.
      writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: "assistant", effort: "medium" }) + "\n");
      first.d.close();
      const second = await daemon(f, [], projectsDir);
      const sub = (await second.c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 })) as { result: { session: object } };
      expect(sub.result.session).toMatchObject({ effort: "default", permissionMode: "default", model: "default" });
      second.d.close();
    });
  });

  it("session.list names the modes a new session may start in: bypassPermissions only when the daemon enables it", async () => {
    for (const allowBypass of [false, true]) {
      const d = createDaemon({ webRoot, token, roots: [webRoot], query: fakeQuery as never, allowBypass, history: { listSessions: (async () => []) as never } as never });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      const c = await client((d.address() as AddressInfo).port);
      const modes = allowBypass ? ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"] : ["default", "acceptEdits", "plan", "dontAsk"];
      expect(await c.request({ type: "session.list" })).toMatchObject({ result: { permissionModes: modes } });
      d.close();
    }
  });

  it("lists models from supportedModels() and caches them", async () => {
    // Own daemon: session.create of other tests loads the list of the shared one.
    const d = createDaemon({ webRoot, token, roots: [webRoot], query: fakeQuery as never, history: { listSessions: (async () => []) as never } as never });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const c = await client((d.address() as AddressInfo).port);
    const before = calls.length;
    expect(await c.request({ type: "models.list" })).toMatchObject({ type: "reply", result: { models } });
    expect(await c.request({ type: "models.list" })).toMatchObject({ result: { models } });
    expect(calls.length).toBe(before + 1);
    d.close();
  });

  it("creates a session with a model and switches it with session.setModel; its CLI starts on the first prompt", async () => {
    const c = await client();
    const created = await c.request({ type: "session.create", cwd: webRoot, model: "haiku" });
    const session = (created as { result: { session: { id: string; model: string } } }).result.session;
    expect(session.model).toBe("haiku");
    const r = await c.request({ type: "session.setModel", sessionId: session.id, model: "default" });
    expect(r).toMatchObject({ type: "reply", result: { session: { id: session.id, model: "default" } } });
    expect(calls.some((o) => o.sessionId === session.id)).toBe(false);
    await c.request({ type: "session.prompt", sessionId: session.id, text: "hi" });
    expect(calls.find((o) => o.sessionId === session.id)).toMatchObject({ model: undefined });
    await c.request({ type: "session.setModel", sessionId: session.id, model: "haiku" });
    expect(setModelCalls.at(-1)).toBe("haiku");
  });

  it("switches permission mode and effort; rejects unknown values and bypass when not enabled", async () => {
    const c = await client();
    const created = await c.request({ type: "session.create", cwd: webRoot });
    const id = (created as { result: { session: { id: string } } }).result.session.id;
    expect(await c.request({ type: "session.setPermissionMode", sessionId: id, mode: "plan" })).toMatchObject({ result: { session: { permissionMode: "plan" } } });
    expect(await c.request({ type: "session.setEffort", sessionId: id, effort: "max" })).toMatchObject({ result: { session: { effort: "max" } } });
    expect(await c.request({ type: "session.setPermissionMode", sessionId: id, mode: "yolo" })).toMatchObject({ code: "bad_mode" });
    expect(await c.request({ type: "session.setEffort", sessionId: id, effort: "huge" })).toMatchObject({ code: "bad_effort" });
    expect(await c.request({ type: "session.setPermissionMode", sessionId: id, mode: "bypassPermissions" })).toMatchObject({ code: "set_failed" });
    const sub = await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    expect(sub).toMatchObject({ result: { session: { permissionMode: "plan", effort: "max", permissionModes: ["default", "acceptEdits", "plan", "dontAsk"] } } });
  });

  it("offers auto mode only for a model with supportsAutoMode; dontAsk always; both reach the SDK", async () => {
    const c = await client();
    const create = async (model?: string) =>
      ((await c.request({ type: "session.create", cwd: webRoot, model })) as { result: { session: { id: string; permissionModes: string[] } } }).result.session;
    const sonnet = await create("sonnet");
    expect(sonnet.permissionModes).toEqual(["default", "acceptEdits", "plan", "auto", "dontAsk"]);
    const haiku = await create("haiku");
    expect(haiku.permissionModes).toEqual(["default", "acceptEdits", "plan", "dontAsk"]);
    expect(await c.request({ type: "session.setPermissionMode", sessionId: haiku.id, mode: "auto" })).toMatchObject({ code: "set_failed" });
    expect(await c.request({ type: "session.setPermissionMode", sessionId: haiku.id, mode: "dontAsk" })).toMatchObject({ result: { session: { permissionMode: "dontAsk" } } });
    // Before the CLI runs the mode is its start option; afterwards setPermissionMode().
    expect(await c.request({ type: "session.setPermissionMode", sessionId: sonnet.id, mode: "auto" })).toMatchObject({ result: { session: { permissionMode: "auto" } } });
    await c.request({ type: "session.prompt", sessionId: sonnet.id, text: "hi" });
    expect(calls.find((o) => o.sessionId === sonnet.id)).toMatchObject({ permissionMode: "auto" });
    await c.request({ type: "session.setPermissionMode", sessionId: sonnet.id, mode: "dontAsk" });
    expect(controlCalls.at(-1)).toEqual({ setPermissionMode: "dontAsk" });
    await c.request({ type: "session.setPermissionMode", sessionId: sonnet.id, mode: "auto" });
    expect(controlCalls.at(-1)).toEqual({ setPermissionMode: "auto" });
  });

  it("a session in auto mode drops to default when its model changes to one without auto support", async () => {
    const c = await client();
    const id = ((await c.request({ type: "session.create", cwd: webRoot, model: "sonnet" })) as { result: { session: { id: string } } }).result.session.id;
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await c.request({ type: "session.setPermissionMode", sessionId: id, mode: "auto" });
    const r = await c.request({ type: "session.setModel", sessionId: id, model: "haiku" });
    expect(r).toMatchObject({ result: { session: { model: "haiku", permissionMode: "default", permissionModes: ["default", "acceptEdits", "plan", "dontAsk"] } } });
    expect(controlCalls.at(-1)).toEqual({ setPermissionMode: "default" });
    const sub = await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    expect(sub).toMatchObject({ result: { session: { permissionMode: "default" } } });
    // Other modes stay as they are.
    await c.request({ type: "session.setModel", sessionId: id, model: "sonnet" });
    await c.request({ type: "session.setPermissionMode", sessionId: id, mode: "dontAsk" });
    expect(await c.request({ type: "session.setModel", sessionId: id, model: "haiku" })).toMatchObject({ result: { session: { permissionMode: "dontAsk" } } });
  });

  it("session.list offers auto to a new session only when the default model supports it", async () => {
    const c = await client();
    expect(await c.request({ type: "session.list" })).toMatchObject({ result: { permissionModes: ["default", "acceptEdits", "plan", "dontAsk"] } });
    models[0]!.supportsAutoMode = true;
    try {
      const d = createDaemon({ webRoot, token, roots: [webRoot], query: fakeQuery as never, history: { listSessions: (async () => []) as never } as never });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      const c2 = await client((d.address() as AddressInfo).port);
      expect(await c2.request({ type: "session.list" })).toMatchObject({ result: { permissionModes: ["default", "acceptEdits", "plan", "auto", "dontAsk"] } });
      d.close();
    } finally {
      delete models[0]!.supportsAutoMode;
    }
  });

  it("session.list does not wait long for a model list that is not available yet; new sessions then offer no auto", async () => {
    const hung = (a: Parameters<typeof fakeQuery>[0]) => ({ ...fakeQuery(a), supportedModels: () => new Promise<never>(() => {}) });
    // A short wait: a wall-clock bound near the 2 s default failed under a loaded parallel suite. The model list never answers.
    const d = createDaemon({ webRoot, token, roots: [webRoot], query: hung as never, modelListWaitMs: 100, history: { listSessions: (async () => []) as never } as never });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const c = await client((d.address() as AddressInfo).port);
    const t = Date.now();
    expect(await c.request({ type: "session.list" })).toMatchObject({ result: { permissionModes: ["default", "acceptEdits", "plan", "dontAsk"] } });
    expect(Date.now() - t).toBeLessThan(5000);
    d.close();
  });

  it("restores a saved auto or dontAsk mode; auto on a model without support restores as default", async () => {
    const settingsFile = join(mkdtempSync(join(tmpdir(), "cfg-")), "sessions.json");
    const restored = async (model: string, permissionMode: string) => {
      const id = randomUUID();
      writeFileSync(settingsFile, JSON.stringify({ [id]: { model, permissionMode, effort: "default" } }));
      const d = createDaemon({
        webRoot,
        token,
        roots: [webRoot],
        query: fakeQuery as never,
        settingsFile,
        history: {
          listSessions: (async () => []) as never,
          getSessionInfo: (async (sid: string) => ({ sessionId: sid, cwd: webRoot })) as never,
          getSessionMessages: (async () => history) as never,
        },
      });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      const c = await client((d.address() as AddressInfo).port);
      const sub = (await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 })) as { result: { session: { permissionMode: string } } };
      d.close();
      return sub.result.session.permissionMode;
    };
    expect(await restored("sonnet", "auto")).toBe("auto");
    expect(await restored("haiku", "dontAsk")).toBe("dontAsk");
    expect(await restored("haiku", "auto")).toBe("default");
  });

  it("stores an uploaded file under its own name in a fresh folder and replies the path", async () => {
    const c = await client();
    const r = (await c.request({ type: "fs.upload", name: "../notes.txt", data: Buffer.from("hi").toString("base64") })) as { result: { path: string } };
    expect(r.result.path).toMatch(/claude-ui-uploads\/u-[^/]+\/notes\.txt$/);
    expect(readFileSync(r.result.path, "utf8")).toBe("hi");
    expect(await c.request({ type: "fs.upload", name: "x", data: 5 })).toMatchObject({ code: "bad_upload" });
  });

  it("sessions get the upload folder as an additional directory, so Claude reads an attachment without a permission request", async () => {
    // A prompt with an image is a block array; the CLI does not expand @path there and Claude calls Read on the upload.
    const c = await client();
    const created = (await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
    const up = (await c.request({ type: "fs.upload", name: "notes.txt", data: Buffer.from("hi").toString("base64") })) as { result: { path: string } };
    await c.request({ type: "session.prompt", sessionId: created.result.session.id, text: "read it" });
    const dirs = calls.find((o) => o.sessionId === created.result.session.id)!.additionalDirectories!;
    expect(dirs).toHaveLength(1);
    expect(up.result.path.startsWith(`${dirs[0]}/`)).toBe(true);
  });

  it("survives a frame above ws maxPayload: that socket closes with 1009, the daemon keeps answering", async () => {
    const c = await client();
    const closed = new Promise<number>((r) => c.ws.on("close", r));
    // Raw masked binary frame header claiming 256 MiB (> the 100 MiB default maxPayload); ws rejects it on the header.
    (c.ws as unknown as { _socket: import("node:net").Socket })._socket.write(Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0x10, 0, 0, 0, 1, 2, 3, 4]));
    expect(await closed).toBe(1009);
    expect(await (await client()).request({ type: "fs.upload", name: "x", data: 5 })).toMatchObject({ code: "bad_upload" });
  });

  it("sets ws maxPayload to MAX_FRAME_BYTES, below the 100 MiB default", async () => {
    const c = await client();
    const closed = new Promise<number>((r) => c.ws.on("close", r));
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(MAX_FRAME_BYTES + 1));
    (c.ws as unknown as { _socket: import("node:net").Socket })._socket.write(Buffer.concat([Buffer.from([0x82, 0xff]), len, Buffer.from([1, 2, 3, 4])]));
    expect(await closed).toBe(1009);
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

  // Spawning a PTY and waiting for shell output takes seconds on a loaded machine.
  describe("terminals", { timeout: 30_000 }, () => {
    process.env.SHELL = "/bin/sh";
    const output = (inbox: ServerMessage[], terminalId: string) =>
      inbox.map((m) => (m.type === "terminal.output" && m.terminalId === terminalId ? m.data : "")).join("");
    const opened: { c: Awaited<ReturnType<typeof client>>; id: string }[] = [];
    const create = async (c: Awaited<ReturnType<typeof client>>, cwd = webRoot) => {
      const t = ((await c.request({ type: "terminal.create", cwd, cols: 80, rows: 24 })) as { result: { terminal: { id: string; title: string } } }).result.terminal;
      opened.push({ c, id: t.id });
      return t;
    };
    // Shells outlive their connection: one left by a failed test counts against MAX_TERMINALS and takes the next test's "Terminal 1".
    // Closes over a connection the test opened: no new socket here, see the 64 KiB test.
    afterEach(async () => {
      const left = opened.splice(0);
      if (!left.length) return;
      const live = left.find(({ c }) => c.ws.readyState === WebSocket.OPEN)?.c;
      const c = live ?? (await client());
      for (const { id } of left) await c.request({ type: "terminal.close", terminalId: id });
      if (!live) c.ws.close();
    });

    it("opens a shell in a cwd inside the roots only", async () => {
      const c = await client();
      expect(await c.request({ type: "terminal.create", cwd: tmpdir(), cols: 80, rows: 24 })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
      expect(await c.request({ type: "terminal.create", cwd: "relative", cols: 80, rows: 24 })).toMatchObject({ code: "cwd_not_allowed" });
      expect(await c.request({ type: "terminal.create", cwd: webRoot, cols: 0, rows: 24 })).toMatchObject({ code: "bad_size" });
      const t = await create(c);
      await c.request({ type: "terminal.attach", terminalId: t.id });
      await c.request({ type: "terminal.input", terminalId: t.id, data: "pwd\r" });
      await c.waitFor(() => output(c.inbox, t.id).includes(`\n${realpathSync(webRoot)}`));
      await c.request({ type: "terminal.close", terminalId: t.id });
    });

    it("numbers terminals per cwd, lists them, resizes, and drops one whose shell exits", async () => {
      const c = await client();
      const a = await create(c);
      const b = await create(c);
      expect([a.title, b.title]).toEqual(["Terminal 1", "Terminal 2"]);
      expect(await c.request({ type: "terminal.list", cwd: webRoot })).toMatchObject({ result: { terminals: [a, b] } });
      await c.request({ type: "terminal.attach", terminalId: b.id });
      expect(await c.request({ type: "terminal.resize", terminalId: b.id, cols: 100, rows: 30 })).toMatchObject({ type: "reply" });
      await c.request({ type: "terminal.input", terminalId: b.id, data: "stty size\r" });
      await c.waitFor(() => output(c.inbox, b.id).includes("30 100"));
      await c.request({ type: "terminal.input", terminalId: b.id, data: "exit\r" });
      await c.waitFor((m) => m.type === "terminal.exit" && m.terminalId === b.id);
      await c.request({ type: "terminal.close", terminalId: a.id });
      expect(await c.request({ type: "terminal.list", cwd: webRoot })).toMatchObject({ result: { terminals: [] } });
      expect(await c.request({ type: "terminal.input", terminalId: a.id, data: "x" })).toMatchObject({ code: "unknown_terminal" });
    });

    it("keeps running after the connection drops; a new connection gets the scrollback, then live output", async () => {
      const a = await client();
      const t = await create(a);
      await a.request({ type: "terminal.attach", terminalId: t.id });
      await a.request({ type: "terminal.input", terminalId: t.id, data: "echo before-$((40+2))\r" });
      await a.waitFor(() => output(a.inbox, t.id).includes("before-42"));
      a.ws.close();
      const b = await client();
      const r = (await b.request({ type: "terminal.attach", terminalId: t.id })) as { result: { buffer: string } };
      expect(r.result.buffer).toContain("before-42");
      await b.request({ type: "terminal.input", terminalId: t.id, data: "echo after-$((40+3))\r" });
      await b.waitFor(() => output(b.inbox, t.id).includes("after-43"));
      // Attached once: a second attach on the same connection does not double the output.
      await b.request({ type: "terminal.attach", terminalId: t.id });
      await b.request({ type: "terminal.input", terminalId: t.id, data: "echo once-$((40+4))\r" });
      await b.waitFor(() => output(b.inbox, t.id).includes("once-44"));
      await new Promise((r) => setTimeout(r, 100));
      expect(output(b.inbox, t.id).split("once-44").length).toBe(2);
      // Detached: the shell keeps running, its output no longer comes here.
      await b.request({ type: "terminal.detach", terminalId: t.id });
      await b.request({ type: "terminal.input", terminalId: t.id, data: "echo gone-$((40+5))\r" });
      await new Promise((r) => setTimeout(r, 200));
      expect(output(b.inbox, t.id)).not.toContain("gone-45");
      expect(((await b.request({ type: "terminal.attach", terminalId: t.id })) as { result: { buffer: string } }).result.buffer).toContain("gone-45");
      await b.request({ type: "terminal.close", terminalId: t.id });
    });

    it("caps terminals per connection and per daemon: too_many_terminals", async () => {
      const cs = await Promise.all([client(), client(), client(), client(), client()]);
      const ids: string[] = [];
      for (const c of cs.slice(0, 4)) for (let i = 0; i < MAX_TERMINALS_PER_CLIENT; i++) ids.push((await create(c)).id);
      expect(ids).toHaveLength(MAX_TERMINALS);
      expect(await cs[0]!.request({ type: "terminal.create", cwd: webRoot, cols: 80, rows: 24 })).toMatchObject({ code: "too_many_terminals" });
      expect(await cs[4]!.request({ type: "terminal.create", cwd: webRoot, cols: 80, rows: 24 })).toMatchObject({ code: "too_many_terminals" });
      // A closed terminal frees its slot.
      await cs[0]!.request({ type: "terminal.close", terminalId: ids.shift()! });
      ids.push((await create(cs[0]!)).id);
      for (const id of ids) await cs[0]!.request({ type: "terminal.close", terminalId: id });
    });

    it("rejects terminal.input above 64 KiB and a size above 1000", async () => {
      const c = await client();
      const t = await create(c);
      expect(await c.request({ type: "terminal.input", terminalId: t.id, data: "x".repeat(MAX_TERMINAL_INPUT_BYTES + 1) })).toMatchObject({ code: "too_large" });
      expect(await c.request({ type: "terminal.input", terminalId: t.id, data: "é".repeat(MAX_TERMINAL_INPUT_BYTES / 2 + 1) })).toMatchObject({ code: "too_large" });
      // Input the shell consumes (comment lines), drained before close: node-pty 1.1.0 retries a write that got EAGAIN on its fd
      // even after the PTY closed, so input still queued then lands on whichever socket reuses that fd number (seen as a 400 upgrade).
      const line = `#${"x".repeat(1022)}\r`;
      await c.request({ type: "terminal.attach", terminalId: t.id });
      expect(await c.request({ type: "terminal.input", terminalId: t.id, data: line.repeat(MAX_TERMINAL_INPUT_BYTES / line.length) })).toMatchObject({ type: "reply" });
      await c.request({ type: "terminal.input", terminalId: t.id, data: "echo drained-$((40+6))\r" });
      await c.waitFor(() => output(c.inbox, t.id).includes("drained-46"));
      expect(await c.request({ type: "terminal.resize", terminalId: t.id, cols: 1001, rows: 24 })).toMatchObject({ code: "bad_size" });
      expect(await c.request({ type: "terminal.create", cwd: webRoot, cols: 80, rows: 1001 })).toMatchObject({ code: "bad_size" });
      await c.request({ type: "terminal.close", terminalId: t.id });
    });

    it("the shell env has no CLAUDE_UI_* and no daemon PORT, the rest of the user's env stays", async () => {
      Object.assign(process.env, { CLAUDE_UI_ROOTS: "/secret-roots", PORT: "5999", GH33_KEEP: "kept-value" });
      try {
        const c = await client();
        const t = await create(c);
        await c.request({ type: "terminal.attach", terminalId: t.id });
        await c.request({ type: "terminal.input", terminalId: t.id, data: "env | grep -E '^(CLAUDE_UI_|PORT=|GH33_)'; echo env-done\r" });
        await c.waitFor(() => /\nenv-done/.test(output(c.inbox, t.id)));
        const env = output(c.inbox, t.id);
        expect(env).toContain("GH33_KEEP=kept-value");
        expect(env).not.toMatch(/\n(CLAUDE_UI_\w*|PORT)=/);
        await c.request({ type: "terminal.close", terminalId: t.id });
      } finally {
        for (const k of ["CLAUDE_UI_ROOTS", "PORT", "GH33_KEEP"]) delete process.env[k];
      }
    });
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

  it("answers git.status for a cwd inside the roots only", async () => {
    const c = await client();
    expect(await c.request({ type: "git.status", cwd: webRoot })).toMatchObject({ result: { status: null } });
    expect(await c.request({ type: "git.status", cwd: join(webRoot, "..") })).toMatchObject({ code: "cwd_not_allowed" });
  });

  it("does not offer a symlink whose real path is outside the roots as an @-mention", async () => {
    symlinkSync(mkdtempSync(join(tmpdir(), "outside-")), join(webRoot, "linkedout"));
    symlinkSync(join(webRoot, "proj"), join(webRoot, "linkedin"));
    const c = await client();
    expect(await c.request({ type: "fs.search", cwd: webRoot, query: "linked" })).toMatchObject({ result: { paths: ["linkedin"] } });
  });

  it("reads and writes files inside the roots only, refusing a write over a newer disk version", async () => {
    const file = join(webRoot, "proj", "a.txt");
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    writeFileSync(file, "one");
    const c = await client();
    const read = (await c.request({ type: "fs.read", path: file })) as { result: { content: string; mtime: number } };
    expect(read.result.content).toBe("one");
    const wrote = (await c.request({ type: "fs.write", path: file, content: "two", baseMtime: read.result.mtime })) as {
      result: { mtime: number };
    };
    expect(readFileSync(file, "utf8")).toBe("two");
    // Stale base: the file changed since the client read it.
    expect(
      await c.request({ type: "fs.write", path: file, content: "three", baseMtime: read.result.mtime - 1000 }),
    ).toMatchObject({
      code: "conflict",
    });
    expect(readFileSync(file, "utf8")).toBe("two");
    expect(await c.request({ type: "fs.read", path: file })).toMatchObject({
      result: { content: "two", mtime: wrote.result.mtime },
    });

    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "secret.txt");
    writeFileSync(outside, "secret");
    expect(await c.request({ type: "fs.read", path: outside })).toMatchObject({ code: "path_not_allowed" });
    expect(await c.request({ type: "fs.write", path: outside, content: "x" })).toMatchObject({ code: "path_not_allowed" });
    expect(readFileSync(outside, "utf8")).toBe("secret");
    // A symlink inside a root pointing outside it is outside.
    symlinkSync(outside, join(webRoot, "proj", "link.txt"));
    expect(await c.request({ type: "fs.read", path: join(webRoot, "proj", "link.txt") })).toMatchObject({
      code: "path_not_allowed",
    });
    expect(await c.request({ type: "fs.read", path: join(webRoot, "proj") })).toMatchObject({ code: "not_a_file" });
    writeFileSync(join(webRoot, "proj", "bin"), Buffer.from([1, 0, 2]));
    expect(await c.request({ type: "fs.read", path: join(webRoot, "proj", "bin") })).toMatchObject({ code: "binary" });
  });

  it("fs.read of a deleted file inside a root replies not_found, outside a root still path_not_allowed", async () => {
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    const file = join(webRoot, "proj", "gone.txt");
    writeFileSync(file, "x");
    rmSync(file);
    const c = await client();
    expect(await c.request({ type: "fs.read", path: file })).toMatchObject({ code: "not_found" });
    expect(await c.request({ type: "fs.read", path: join(webRoot, "proj", "no-dir", "f.txt") })).toMatchObject({ code: "not_found" });
    // ../ out of a root through a missing directory is still outside.
    expect(await c.request({ type: "fs.read", path: join(webRoot, "proj", "no-dir", "..", "..", "..", "f.txt") })).toMatchObject({ code: "path_not_allowed" });
    expect(await c.request({ type: "fs.read", path: join(mkdtempSync(join(tmpdir(), "outside-")), "f.txt") })).toMatchObject({ code: "path_not_allowed" });
  });

  it("fs.read of files under a deleted directory (rm -rf after Edits) replies not_found", async () => {
    const src = join(webRoot, "proj", "src");
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "math.js"), "x");
    writeFileSync(join(src, "sub", "notes.md"), "y");
    rmSync(src, { recursive: true });
    const c = await client();
    expect(await c.request({ type: "fs.read", path: join(src, "math.js") })).toMatchObject({ code: "not_found" });
    expect(await c.request({ type: "fs.read", path: join(src, "sub", "notes.md") })).toMatchObject({ code: "not_found" });
  });

  it("fs.read refuses non-UTF-8 text and keeps a BOM, CRLF and a missing final newline byte for byte", async () => {
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    const c = await client();
    const latin1 = join(webRoot, "proj", "latin1.txt");
    writeFileSync(latin1, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café\n" in Latin-1
    expect(await c.request({ type: "fs.read", path: latin1 })).toMatchObject({ code: "not_utf8" });

    const bytes = Buffer.from("\ufeffa\r\nb", "utf8");
    const file = join(webRoot, "proj", "bom.txt");
    writeFileSync(file, bytes);
    const read = (await c.request({ type: "fs.read", path: file })) as { result: { content: string; mtime: number } };
    expect(read.result.content).toBe("\ufeffa\r\nb");
    await c.request({ type: "fs.write", path: file, content: read.result.content, baseMtime: read.result.mtime });
    expect(readFileSync(file).equals(bytes)).toBe(true);

    const empty = join(webRoot, "proj", "empty.txt");
    writeFileSync(empty, "");
    expect(await c.request({ type: "fs.read", path: empty })).toMatchObject({ result: { content: "" } });
  });

  it("notifies watchers when a watched file changes on disk", { timeout: 10_000 }, async () => {
    const file = join(webRoot, "proj", "w.txt");
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    writeFileSync(file, "v1");
    const c = await client();
    expect(await c.request({ type: "fs.watch", paths: [file, join(webRoot, "..", "nope")] })).toMatchObject({ type: "reply" });
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(file, "v2 longer");
    const changed = await c.waitFor((m) => m.type === "fs.changed");
    expect(changed).toMatchObject({ type: "fs.changed", path: file, mtime: statSync(file).mtimeMs });
    // An empty set stops watching.
    await c.request({ type: "fs.watch", paths: [] });
    c.inbox.length = 0;
    writeFileSync(file, "v3");
    await new Promise((r) => setTimeout(r, 1500));
    expect(c.inbox.some((m) => m.type === "fs.changed")).toBe(false);
  });

  it("keeps reporting a change made just before the watched set changes", { timeout: 10_000 }, async () => {
    const a = join(webRoot, "proj", "a.txt");
    const b = join(webRoot, "proj", "b.txt");
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    writeFileSync(a, "v1");
    writeFileSync(b, "v1");
    const c = await client();
    await c.request({ type: "fs.watch", paths: [a] });
    await new Promise((r) => setTimeout(r, 1100)); // at least one poll with the old stat
    writeFileSync(a, "v2 by claude");
    // The user opens another tab before the next poll: a's watcher must keep its baseline.
    await c.request({ type: "fs.watch", paths: [a, b] });
    expect(await c.waitFor((m) => m.type === "fs.changed" && m.path === a)).toMatchObject({ path: a });
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
      // The created session adds its project; the transcript-only project is not listed.
      expect(list.result.sessions).toMatchObject([{ id: created.result.session.id, cwd: webRoot, state: "idle", model: "default", title: "New session", lastActivity: expect.any(Number), archived: false, transcript: false }]);

      expect(await c.request({ type: "session.subscribe", sessionId: outside, sinceSeq: 0 })).toMatchObject({ code: "unknown_session" });
      // A deep link to a session of a project that is not added opens it and adds the project.
      await c.request({ type: "session.subscribe", sessionId: inside, sinceSeq: 0, addProject: true });
      const linked = (await c.request({ type: "session.list" })) as { result: { sessions: { id: string }[]; projects: string[] } };
      expect(linked.result.projects).toEqual([cwd, webRoot]);
      expect(linked.result.sessions.map((s) => s.id)).toContain(inside);
      await c.request({ type: "session.prompt", sessionId: inside, text: "go on" });
      expect(calls.filter((o) => o.resume === inside && o.canUseTool)).toHaveLength(1);
      const again = (await c.request({ type: "session.list" })) as { result: { sessions: { id: string; state: string }[] } };
      // State now comes from the live session, not "closed".
      expect(["running", "idle"]).toContain(again.result.sessions.find((s) => s.id === inside)?.state);
    } finally {
      d.close();
    }
  });

  it("a burst of session.list requests runs one transcript scan at a time: one running, one queued for the rest", async () => {
    // A reload replays every subscribed session's state events and the web app re-lists on each (FIX-LEAK):
    // concurrent full scans of ~/.claude/projects took the daemon out of heap.
    let scans = 0;
    let running = 0;
    let maxRunning = 0;
    const release: (() => void)[] = [];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      projects: added(webRoot),
      history: {
        listSessions: (async () => {
          scans++;
          maxRunning = Math.max(maxRunning, ++running);
          await new Promise<void>((r) => release.push(r));
          running--;
          return [{ sessionId: "4b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", summary: `scan ${scans}`, lastModified: 1, cwd: webRoot }];
        }) as never,
        getSessionInfo: (async () => undefined) as never,
        getSessionMessages: (async () => []) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const first = c.request({ type: "session.list" });
      await vi.waitFor(() => expect(scans).toBe(1));
      const burst = Array.from({ length: 10 }, () => c.request({ type: "session.list" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(scans).toBe(1);
      release.shift()!();
      await vi.waitFor(() => expect(scans).toBe(2));
      release.shift()!();
      const titles = (r: unknown) => (r as { result: { sessions: { title: string }[] } }).result.sessions.map((s) => s.title);
      expect(titles(await first)).toEqual(["scan 1"]);
      // Requests that arrived during scan 1 get scan 2: no reply is older than its request.
      for (const r of await Promise.all(burst)) expect(titles(r)).toEqual(["scan 2"]);
      expect({ scans, maxRunning }).toEqual({ scans: 2, maxRunning: 1 });
    } finally {
      d.close();
    }
  });

  it("reuses the last transcript scan while no transcript file changed (listSessions() leaks RSS per call)", async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
    const dir = join(projectsDir, "-p");
    mkdirSync(dir);
    const file = join(dir, "4b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b.jsonl");
    writeFileSync(file, "{}\n");
    let scans = 0;
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      projectsDir,
      listCache: true,
      history: { listSessions: (async () => (scans++, [])) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "session.list" });
      await c.request({ type: "session.list" });
      expect(scans).toBe(1);
      writeFileSync(file, "{}\n{}\n");
      await c.request({ type: "session.list" });
      expect(scans).toBe(2);
      writeFileSync(join(dir, "5b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b.jsonl"), "{}\n");
      await c.request({ type: "session.list" });
      expect(scans).toBe(3);
    } finally {
      d.close();
    }
  });

  it("lists by the last message time in the transcript, not the file mtime that metadata appended on CLI exit bumps", async () => {
    const [older, newer, noFile] = ["4b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", "5b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", "6b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b"];
    const cwd = join(webRoot, "my proj");
    mkdirSync(cwd, { recursive: true });
    const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
    const dir = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir);
    const line = (o: object) => JSON.stringify(o) + "\n";
    const exitLines = line({ type: "last-prompt", lastPrompt: "hi" }) + line({ type: "cost-state", totalCostUSD: 0 });
    writeFileSync(join(dir, `${older}.jsonl`), line({ type: "user", timestamp: "2026-10-01T10:00:00.000Z" }) + line({ type: "assistant", timestamp: "2026-10-01T10:00:05.000Z" }) + exitLines);
    writeFileSync(join(dir, `${newer}.jsonl`), line({ type: "user", timestamp: "2026-10-01T11:00:00.000Z" }) + line({ type: "attachment", timestamp: "2026-10-01T11:30:00.000Z" }) + exitLines);
    // All rewritten at the same daemon restart; mtime order is the reverse of the real one.
    const transcripts = [
      { sessionId: older, summary: "older", lastModified: 9_000, cwd },
      { sessionId: newer, summary: "newer", lastModified: 8_000, cwd },
      { sessionId: noFile, summary: "no file", lastModified: 7_000, cwd },
    ];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      projectsDir,
      projects: added(cwd),
      history: { listSessions: (async () => transcripts) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const list = (await c.request({ type: "session.list" })) as { result: { sessions: { id: string; lastActivity: number }[] } };
      expect(list.result.sessions.map((s) => [s.id, s.lastActivity])).toEqual([
        [newer, Date.parse("2026-10-01T11:00:00.000Z")],
        [older, Date.parse("2026-10-01T10:00:05.000Z")],
        [noFile, 7_000],
      ]);
    } finally {
      d.close();
    }
  });

  it("a projects.json write that fails is an fs_error reply; the daemon keeps running", async () => {
    // The config dir is gone after the start: the write fails (as EACCES, ENOSPC, EROFS would).
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const projects = createProjects({ file: join(dir, "projects.json") });
    rmSync(dir, { recursive: true });
    const d = createDaemon({ webRoot, token, roots: [webRoot], query: fakeQuery as never, projects, history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      expect(await c.request({ type: "project.open", cwd: webRoot })).toMatchObject({ code: "fs_error" });
      expect(await c.request({ type: "project.remove", cwd: webRoot })).toMatchObject({ code: "fs_error" });
      expect(await c.request({ type: "session.list" })).toMatchObject({ result: { sessions: [] } });
    } finally {
      d.close();
    }
  });

  describe("added projects", () => {
    const cwdOf = (n: string) => mkdtempSync(join(webRoot, `${n}-`));
    const sid = (n: number) => `0b2c3d4e-5f60-4718-8a9b-${String(n).padStart(12, "0")}`;
    const start = async (transcripts: { sessionId: string; summary: string; lastModified: number; cwd: string }[], projects: ReturnType<typeof createProjects>, settingsFile?: string) => {
      const d = createDaemon({
        webRoot,
        token,
        roots: [webRoot],
        query: fakeQuery as never,
        projects,
        settingsFile,
        history: { listSessions: (async () => transcripts) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
      });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      return { d, c: await client((d.address() as AddressInfo).port) };
    };
    type Listed = { projects: string[]; recentProjects: { cwd: string; sessionCount: number; lastActivity: number }[]; sessions: { id: string }[] };
    const list = async (c: Awaited<ReturnType<typeof client>>) => ((await c.request({ type: "session.list" })) as { result: Listed }).result;

    it("a fresh state lists no project and no session while transcripts exist; they are the recent projects, newest first", async () => {
      const [a, b] = [cwdOf("a"), cwdOf("b")];
      const x = await start(
        [
          { sessionId: sid(1), summary: "a1", lastModified: 10, cwd: a },
          { sessionId: sid(2), summary: "b1", lastModified: 30, cwd: b },
          { sessionId: sid(3), summary: "a2", lastModified: 20, cwd: a },
          { sessionId: sid(4), summary: "outside", lastModified: 40, cwd: "/etc" },
        ],
        createProjects(),
      );
      try {
        expect(await list(x.c)).toMatchObject({
          projects: [],
          sessions: [],
          recentProjects: [
            { cwd: b, sessionCount: 1, lastActivity: 30 },
            { cwd: a, sessionCount: 2, lastActivity: 20 },
          ],
        });
      } finally {
        x.d.close();
      }
    });

    it("project.open keeps a project across a restart and moves it from recent to the list with its sessions; project.remove hides it again", async () => {
      const cwd = cwdOf("proj");
      const empty = cwdOf("empty");
      const file = join(mkdtempSync(join(tmpdir(), "cfg-")), "projects.json");
      const transcripts = [{ sessionId: sid(1), summary: "old", lastModified: 1000, cwd }];
      const a = await start(transcripts, createProjects({ file }));
      try {
        // Another connected client hears of the change and refreshes its list.
        const other = await client((a.d.address() as AddressInfo).port);
        expect(await a.c.request({ type: "project.open", cwd: empty })).toMatchObject({ result: { cwd: empty } });
        await other.waitFor((m) => m.type === "sessions.changed");
        expect(await a.c.request({ type: "project.open", cwd: "/etc" })).toMatchObject({ code: "cwd_not_allowed" });
        expect(await a.c.request({ type: "project.open", cwd: join(webRoot, "index.html") })).toMatchObject({ code: "cwd_not_allowed" });
        expect(await list(a.c)).toMatchObject({ projects: [empty], sessions: [], recentProjects: [{ cwd }] });
        await a.c.request({ type: "project.open", cwd });
        expect(await list(a.c)).toMatchObject({ projects: [cwd, empty], sessions: [{ id: sid(1) }], recentProjects: [] });
      } finally {
        a.d.close();
      }
      const b = await start(transcripts, createProjects({ file }));
      try {
        expect((await list(b.c)).projects).toEqual([cwd, empty]);
        const other = await client((b.d.address() as AddressInfo).port);
        await b.c.request({ type: "project.remove", cwd });
        await other.waitFor((m) => m.type === "sessions.changed");
        expect(await list(b.c)).toMatchObject({ projects: [empty], sessions: [], recentProjects: [{ cwd, sessionCount: 1 }] });
        expect(await b.c.request({ type: "project.remove", cwd: 7 })).toMatchObject({ code: "bad_cwd" });
        // Files stay.
        expect(statSync(cwd).isDirectory()).toBe(true);
      } finally {
        b.d.close();
      }
    });

    it("session.create adds its project, so it stays listed after a restart", async () => {
      const cwd = cwdOf("created");
      const file = join(mkdtempSync(join(tmpdir(), "cfg-")), "projects.json");
      const a = await start([], createProjects({ file }));
      try {
        await a.c.request({ type: "session.create", cwd });
        expect((await list(a.c)).projects).toEqual([cwd]);
      } finally {
        a.d.close();
      }
      const b = await start([], createProjects({ file }));
      try {
        expect((await list(b.c)).projects).toEqual([cwd]);
      } finally {
        b.d.close();
      }
    });

    it("a resubscribe after project.remove does not add the project again; only a subscribe with addProject does", async () => {
      const cwd = cwdOf("resub");
      const a = await start([], createProjects());
      try {
        const created = (await a.c.request({ type: "session.create", cwd })) as { result: { session: { id: string } } };
        const sessionId = created.result.session.id;
        expect((await list(a.c)).projects).toEqual([cwd]);
        await a.c.request({ type: "project.remove", cwd });
        // The web app resubscribes every view it holds on a reconnect.
        await a.c.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
        expect((await list(a.c)).projects).toEqual([]);
        await a.c.request({ type: "session.subscribe", sessionId, sinceSeq: 0, addProject: true });
        expect((await list(a.c)).projects).toEqual([cwd]);
      } finally {
        a.d.close();
      }
    });

    it("upgrade: the first start with the new rule adds opened projects and cwds of sessions with saved claude-ui settings; transcript-only cwds stay recent", async () => {
      const [saved, opened, cliOnly, removed] = [cwdOf("saved"), cwdOf("opened"), cwdOf("cli"), cwdOf("removed")];
      const dir = mkdtempSync(join(tmpdir(), "cfg-"));
      const file = join(dir, "projects.json");
      // sid(2) has no saved settings (default model, mode, effort never changed): not seeded, a documented gap (docs/spec.md "Projects").
      // projects.json of the old version: no "seeded" mark.
      writeFileSync(file, JSON.stringify({ opened: { [opened]: 5 }, removed: { [removed]: 5000 } }));
      const settingsFile = join(dir, "sessions.json");
      writeFileSync(settingsFile, JSON.stringify({ [sid(1)]: { permissionMode: "default" }, [sid(4)]: { permissionMode: "default" } }));
      const transcripts = [
        { sessionId: sid(1), summary: "saved", lastModified: 100, cwd: saved },
        { sessionId: sid(2), summary: "cli", lastModified: 200, cwd: cliOnly },
        // Removed after its last activity (old rule): not seeded back.
        { sessionId: sid(4), summary: "removed", lastModified: 300, cwd: removed },
      ];
      const a = await start(transcripts, createProjects({ file }), settingsFile);
      try {
        expect(await list(a.c)).toMatchObject({ projects: [saved, opened], recentProjects: [{ cwd: removed }, { cwd: cliOnly }] });
      } finally {
        a.d.close();
      }
      // Seeded once: a later removal and a new transcript-only cwd do not come back through a second seed.
      const b = await start(transcripts, createProjects({ file }), settingsFile);
      try {
        await b.c.request({ type: "project.remove", cwd: saved });
        expect((await list(b.c)).projects).toEqual([opened]);
      } finally {
        b.d.close();
      }
    });
  });

  it("session.list drops an opened project whose directory is gone or outside the roots", async () => {
    const gone = mkdtempSync(join(webRoot, "gone-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const projects = createProjects();
    projects.open(gone);
    projects.open(outside);
    rmSync(gone, { recursive: true });
    const d = createDaemon({ webRoot, token, roots: [webRoot], query: fakeQuery as never, projects, history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      expect(await c.request({ type: "session.list" })).toMatchObject({ result: { projects: [], sessions: [] } });
    } finally {
      d.close();
    }
  });

  it("rename, archive and delete change the SDK transcript and tell every connected client; a running session cannot be deleted", async () => {
    const id = "4b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
    const cwd = join(webRoot, "proj");
    mkdirSync(cwd, { recursive: true });
    let transcripts: { sessionId: string; summary: string; lastModified: number; cwd: string; tag?: string }[] = [
      { sessionId: id, summary: "fix the bug", lastModified: 1000, cwd },
    ];
    const mutations: unknown[][] = [];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: permissionQuery as never,
      projects: added(cwd),
      history: {
        listSessions: (async () => transcripts) as never,
        getSessionInfo: (async (sid: string) => transcripts.find((t) => t.sessionId === sid)) as never,
        getSessionMessages: (async () => history) as never,
        renameSession: (async (sid: string, title: string, o: object) => {
          mutations.push(["rename", sid, title, o]);
          const t = transcripts.find((t) => t.sessionId === sid);
          if (!t) throw new Error(`Session ${sid} not found`);
          t.summary = title;
        }) as never,
        tagSession: (async (sid: string, tag: string | null) => {
          mutations.push(["tag", sid, tag]);
          transcripts.find((t) => t.sessionId === sid)!.tag = tag ?? undefined;
        }) as never,
        deleteSession: (async (sid: string, o: object) => {
          mutations.push(["delete", sid, o]);
          transcripts = transcripts.filter((t) => t.sessionId !== sid);
        }) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const p = (d.address() as AddressInfo).port;
    try {
      const [a, b] = await Promise.all([client(p), client(p)]);
      const changes = () => b.inbox.filter((m) => m.type === "sessions.changed");
      const listed = async () => ((await a.request({ type: "session.list" })) as { result: { sessions: { id: string; title: string; archived: boolean }[] } }).result.sessions;

      expect(await a.request({ type: "session.rename", sessionId: id, title: "  " })).toMatchObject({ code: "bad_title" });
      expect(await a.request({ type: "session.rename", sessionId: id, title: "x".repeat(201) })).toMatchObject({ code: "bad_title" });
      expect(await a.request({ type: "session.rename", sessionId: id, title: " Better name " })).toMatchObject({ type: "reply" });
      expect(mutations.at(-1)).toEqual(["rename", id, "Better name", { dir: cwd }]);
      await b.waitFor(() => changes().length === 1);
      expect((await listed())[0]).toMatchObject({ id, title: "Better name", archived: false });

      await a.request({ type: "session.archive", sessionId: id, archived: true });
      expect(mutations.at(-1)).toEqual(["tag", id, "archived"]);
      expect((await listed())[0]).toMatchObject({ archived: true });
      await a.request({ type: "session.archive", sessionId: id, archived: false });
      expect(mutations.at(-1)).toEqual(["tag", id, null]);
      expect((await listed())[0]).toMatchObject({ archived: false });
      await b.waitFor(() => changes().length === 3);

      // A live session with a pending permission request is not deleted.
      const created = (await a.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
      const live = created.result.session.id;
      await a.request({ type: "session.subscribe", sessionId: live, sinceSeq: 0 });
      await a.request({ type: "session.prompt", sessionId: live, text: "run tests" });
      await a.waitFor((m) => m.type === "event" && m.part.type === "permission_request");
      expect(await a.request({ type: "session.delete", sessionId: live })).toMatchObject({ code: "session_running" });
      // Never prompted into a transcript (fake history): it has nothing to rename.
      expect(await a.request({ type: "session.rename", sessionId: live, title: "x" })).toMatchObject({ code: "rename_failed" });

      expect(await a.request({ type: "session.delete", sessionId: id })).toMatchObject({ type: "reply" });
      expect(mutations.at(-1)).toEqual(["delete", id, { dir: cwd }]);
      await b.waitFor((m) => m.type === "sessions.changed" && m.deleted === id);
      expect((await listed()).map((s) => s.id)).toEqual([live]);
      expect(await a.request({ type: "session.delete", sessionId: id })).toMatchObject({ code: "unknown_session" });
    } finally {
      d.close();
    }
  });

  it("a subscribe while a delete is in progress does not restore the session from its not yet removed transcript", async () => {
    const id = "5c2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
    const cwd = join(webRoot, "proj");
    mkdirSync(cwd, { recursive: true });
    let transcripts = [{ sessionId: id, summary: "fix the bug", lastModified: 1000, cwd }];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: permissionQuery as never,
      history: {
        listSessions: (async () => transcripts) as never,
        getSessionInfo: (async (sid: string) => transcripts.find((t) => t.sessionId === sid)) as never,
        getSessionMessages: (async () => history) as never,
        deleteSession: (async () => {
          await gate;
          transcripts = [];
        }) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const p = (d.address() as AddressInfo).port;
    try {
      const [a, b] = await Promise.all([client(p), client(p)]);
      const deleted = a.request({ type: "session.delete", sessionId: id });
      await new Promise((r) => setTimeout(r, 20));
      expect(await b.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 })).toMatchObject({ code: "unknown_session" });
      release();
      expect(await deleted).toMatchObject({ type: "reply" });
      const list = (await b.request({ type: "session.list" })) as { result: { sessions: unknown[] } };
      expect(list.result.sessions).toEqual([]);
    } finally {
      d.close();
    }
  });

  it("a delete while a restore of the same session is in flight waits for it; the session does not come back", async () => {
    const id = "6c2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
    const cwd = join(webRoot, "proj");
    mkdirSync(cwd, { recursive: true });
    let transcripts = [{ sessionId: id, summary: "fix the bug", lastModified: 1000, cwd }];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: permissionQuery as never,
      history: {
        listSessions: (async () => transcripts) as never,
        getSessionInfo: (async (sid: string) => transcripts.find((t) => t.sessionId === sid)) as never,
        getSessionMessages: (async () => {
          await gate;
          return history;
        }) as never,
        deleteSession: (async () => {
          transcripts = [];
        }) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const p = (d.address() as AddressInfo).port;
    try {
      const [a, b] = await Promise.all([client(p), client(p)]);
      const subscribed = b.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await new Promise((r) => setTimeout(r, 20));
      const deleted = a.request({ type: "session.delete", sessionId: id });
      await new Promise((r) => setTimeout(r, 20));
      release();
      expect(await deleted).toMatchObject({ type: "reply" });
      await subscribed;
      const list = (await b.request({ type: "session.list" })) as { result: { sessions: unknown[] } };
      expect(list.result.sessions).toEqual([]);
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
      for (const updatedInput of [null, [], "x"])
        expect(await a.request({ type: "permission.respond", requestId, decision: "allow", updatedInput } as never)).toMatchObject({ type: "error", code: "bad_request" });
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

  it("a restored session includes the subagent run timelines of its subagent transcripts, nested runs under their parent run", async () => {
    const id = "8b2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const msg = (type: string, parent: string | null, content: unknown, uuid = Math.random().toString(36)) =>
      ({ type, uuid, session_id: id, parent_tool_use_id: parent, parent_agent_id: null, timestamp: "2026-09-30T18:21:30.000Z", message: { id: `m${uuid}`, role: type, content } }) as never;
    const main = [
      msg("user", null, "inspect"),
      msg("assistant", null, [{ type: "tool_use", id: "toolu_outer", name: "Agent", input: { description: "Outer run" } }]),
      msg("user", null, [{ type: "tool_result", tool_use_id: "toolu_outer", content: "done" }]),
    ];
    const subagents: Record<string, never[]> = {
      // The SDK names each message's parent_tool_use_id: the Agent call that started the run.
      outer: [
        msg("user", "toolu_outer", "Read value.ts", "sub-prompt"),
        msg("assistant", "toolu_outer", [{ type: "tool_use", id: "toolu_inner", name: "Agent", input: { description: "Inner run" } }]),
        msg("user", "toolu_outer", [{ type: "tool_result", tool_use_id: "toolu_inner", content: "done" }]),
      ],
      inner: [
        msg("assistant", "toolu_inner", [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/x" } }]),
        msg("user", "toolu_inner", [{ type: "tool_result", tool_use_id: "toolu_read", content: "1" }]),
      ],
    };
    const listed: unknown[] = [];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (sid: string) => (sid === id ? { sessionId: id, cwd: webRoot } : undefined)) as never,
        getSessionMessages: (async () => main) as never,
        listSubagents: (async (sid: string, o: unknown) => (listed.push([sid, o]), ["inner", "outer"])) as never,
        getSubagentMessages: (async (_sid: string, agentId: string) => subagents[agentId]) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await c.waitFor((m) => m.type === "event" && m.part.type === "session_state");
      const parts = new Map(c.inbox.flatMap((m) => (m.type === "event" ? [[m.part.id, m.part] as const] : [])));
      expect(listed).toEqual([[id, { dir: webRoot }]]);
      expect(parts.get("toolu_outer")).toMatchObject({ type: "subagent", description: "Outer run", status: "done" });
      expect(parts.get("toolu_outer")?.parentId).toBeUndefined();
      expect(parts.get("toolu_inner")).toMatchObject({ type: "subagent", description: "Inner run", status: "done", parentId: "toolu_outer" });
      expect(parts.get("toolu_read")).toMatchObject({ type: "tool_call", tool: "Read", status: "done", parentId: "toolu_inner" });
      expect(parts.get("sub-prompt")).toMatchObject({ type: "user_text", text: "Read value.ts", parentId: "toolu_outer" });
      // A run's prompt is no checkpoint of the session.
      expect(await c.request({ type: "session.rewindPreview", sessionId: id, userMessageId: "sub-prompt" })).toMatchObject({ type: "error" });
    } finally {
      d.close();
    }
  });

  it("a restored subagent run keeps the results of its parallel tool calls that getSubagentMessages() drops", async () => {
    // Shapes of run "Second widgets feature sweep" in session 7a3df1cd (development-docs/GH-36/review-fix2.html, SDK 0.3.285): each
    // parallel tool_use is its own assistant line, each tool_result a child of it; the SDK keeps only the last parentUuid chain.
    const id = "7a3df1cd-2a8b-4f32-8270-c70ece8c957d";
    const at = "2026-10-01T10:00:00.000Z";
    const line = (type: string, uuid: string, parentUuid: string | null, content: unknown) =>
      ({ type, uuid, parentUuid, isSidechain: true, agentId: "a0bbcf768e4c2d321", sessionId: id, timestamp: at, message: { role: type, content } });
    const call = (n: number) => [{ type: "tool_use", id: `toolu_read${n}`, name: "Read", input: { file_path: `/x${n}` } }];
    const result = (n: number) => [{ type: "tool_result", tool_use_id: `toolu_read${n}`, content: `${n}` }];
    const raw = [
      line("user", "p", null, "Read both"),
      line("assistant", "a1", "p", call(1)),
      line("assistant", "a2", "a1", call(2)),
      line("user", "r1", "a1", result(1)),
      line("user", "r2", "a2", result(2)),
      line("assistant", "a3", "r2", [{ type: "text", text: "done" }]),
    ];
    const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
    const runs = join(projectsDir, webRoot.replace(/[^a-zA-Z0-9]/g, "-"), id, "subagents");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "agent-a0bbcf768e4c2d321.jsonl"), raw.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const sdk = (l: (typeof raw)[number]) => ({ type: l.type, uuid: l.uuid, session_id: id, message: l.message, parent_tool_use_id: "toolu_outer", parent_agent_id: null, timestamp: at });
    const main = [
      { type: "user", uuid: "u0", session_id: id, parent_tool_use_id: null, parent_agent_id: null, timestamp: at, message: { role: "user", content: "inspect" } },
      { type: "assistant", uuid: "u1", session_id: id, parent_tool_use_id: null, parent_agent_id: null, timestamp: at, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_outer", name: "Agent", input: { description: "Sweep" } }] } },
      { type: "user", uuid: "u2", session_id: id, parent_tool_use_id: null, parent_agent_id: null, timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_outer", content: "done" }] } },
    ];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      projectsDir,
      query: fakeQuery as never,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (sid: string) => (sid === id ? { sessionId: id, cwd: webRoot } : undefined)) as never,
        getSessionMessages: (async () => main) as never,
        listSubagents: (async () => ["a0bbcf768e4c2d321"]) as never,
        // The leaf chain a3 > r2 > a2 > a1 > p: r1 is on a side branch.
        getSubagentMessages: (async () => raw.filter((l) => l.uuid !== "r1").map(sdk)) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await c.waitFor((m) => m.type === "event" && m.part.type === "session_state");
      const parts = new Map(c.inbox.flatMap((m) => (m.type === "event" ? [[m.part.id, m.part] as const] : [])));
      for (const n of [1, 2]) {
        expect(parts.get(`toolu_read${n}`)).toMatchObject({ type: "tool_call", status: "done", parentId: "toolu_outer" });
        expect(parts.get(`toolu_read${n}:result`)).toMatchObject({ type: "tool_result", output: `${n}`, parentId: "toolu_outer" });
      }
    } finally {
      d.close();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("a restored subagent run keeps parallel tool calls whose tool_use lines getSubagentMessages() drops with their results", async () => {
    // Shapes of run "Mine base features" (a39f5d09) in session 7a3df1cd, API message …MtzhX8 (SDK 0.3.285): the parallel tool_use
    // lines of one API message chain off each other; the leaf chain goes through call 1's result, so calls 2 and 3 (and their
    // results) are on a side branch. Hook attachments sit between lines; the SDK does not return them.
    const id = "7a3df1cd-2a8b-4f32-8270-c70ece8c957e";
    const at = "2026-10-01T10:00:00.000Z";
    const line = (type: string, uuid: string, parentUuid: string | null, content: unknown) =>
      ({ type, uuid, parentUuid, isSidechain: true, agentId: "a39f5d0972c7cf0a8", sessionId: id, timestamp: at, message: type === "assistant" ? { id: "msg_MtzhX8", role: type, content } : { role: type, content } });
    const call = (n: number) => [{ type: "tool_use", id: `toolu_read${n}`, name: "Read", input: { file_path: `/x${n}` } }];
    const result = (n: number) => [{ type: "tool_result", tool_use_id: `toolu_read${n}`, content: `${n}` }];
    const hook = (uuid: string, parentUuid: string) => ({ type: "attachment", uuid, parentUuid, isSidechain: true, attachment: { type: "hook_success" } });
    const raw = [
      line("user", "p", null, "Read all"),
      line("assistant", "t", "p", [{ type: "thinking", thinking: "" }]),
      line("assistant", "a1", "t", call(1)),
      line("assistant", "a2", "a1", call(2)),
      line("assistant", "a3", "a2", call(3)),
      hook("h1", "a3"),
      line("user", "r1", "a1", result(1)),
      hook("h2", "r1"),
      line("assistant", "a4", "h2", call(4)),
      line("assistant", "a5", "a4", call(5)),
      line("user", "r2", "a2", result(2)),
      line("user", "r3", "a3", result(3)),
      line("user", "r4", "a4", result(4)),
      line("user", "r5", "a5", result(5)),
      { ...line("assistant", "a6", "r5", [{ type: "text", text: "done" }]), message: { id: "msg_next", role: "assistant", content: [{ type: "text", text: "done" }] } },
    ];
    const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
    const runs = join(projectsDir, webRoot.replace(/[^a-zA-Z0-9]/g, "-"), id, "subagents");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "agent-a39f5d0972c7cf0a8.jsonl"), raw.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const sdk = (l: { type: string; uuid: string; message?: unknown }) => ({ type: l.type, uuid: l.uuid, session_id: id, message: l.message, parent_tool_use_id: "toolu_outer", parent_agent_id: null, timestamp: at });
    const main = [
      { type: "user", uuid: "u0", session_id: id, parent_tool_use_id: null, parent_agent_id: null, timestamp: at, message: { role: "user", content: "inspect" } },
      { type: "assistant", uuid: "u1", session_id: id, parent_tool_use_id: null, parent_agent_id: null, timestamp: at, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_outer", name: "Agent", input: { description: "Mine" } }] } },
      { type: "user", uuid: "u2", session_id: id, parent_tool_use_id: null, parent_agent_id: null, timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_outer", content: "done" }] } },
    ];
    // The leaf chain a6 > r5 > a5 > a4 > h2 > r1 > a1 > t > p, without the attachment.
    const chain = ["p", "t", "a1", "r1", "a4", "a5", "r5", "a6"];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      projectsDir,
      query: fakeQuery as never,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (sid: string) => (sid === id ? { sessionId: id, cwd: webRoot } : undefined)) as never,
        getSessionMessages: (async () => main) as never,
        listSubagents: (async () => ["a39f5d0972c7cf0a8"]) as never,
        getSubagentMessages: (async () => chain.map((u) => sdk(raw.find((l) => l.uuid === u)!))) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await c.waitFor((m) => m.type === "event" && m.part.type === "session_state");
      const events = c.inbox.flatMap((m) => (m.type === "event" ? [m.part] : []));
      const parts = new Map(events.map((p) => [p.id, p] as const));
      for (const n of [1, 2, 3, 4, 5]) {
        expect(parts.get(`toolu_read${n}`)).toMatchObject({ type: "tool_call", status: "done", parentId: "toolu_outer" });
        expect(parts.get(`toolu_read${n}:result`)).toMatchObject({ type: "tool_result", output: `${n}`, parentId: "toolu_outer" });
      }
      // Calls keep the API message's order.
      const order = events.flatMap((p) => (p.type === "tool_call" && p.id.startsWith("toolu_read") && !p.id.includes(":") ? [p.id] : []));
      expect([...new Set(order)]).toEqual([1, 2, 3, 4, 5].map((n) => `toolu_read${n}`));
    } finally {
      d.close();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("a restored subagent run shows put-back parallel calls in the raw file's order, also when a lost call's subtree holds a later call", async () => {
    // GH-46 review round 2: call 5's line hangs off lost call 2's line but is written after kept calls 3 and 4.
    const id = "8b4ef2a1-2a8b-4f32-8270-c70ece8c957e";
    const at = "2026-10-01T10:00:00.000Z";
    const line = (uuid: string, parentUuid: string | null, content: unknown, msg = "msg_P") =>
      ({ type: uuid === "p" ? "user" : "assistant", uuid, parentUuid, isSidechain: true, sessionId: id, timestamp: at, message: { id: msg, role: uuid === "p" ? "user" : "assistant", content } });
    const call = (n: number) => [{ type: "tool_use", id: `toolu_call${n}`, name: "Read", input: { file_path: `/x${n}` } }];
    const raw = [line("p", null, "Read all"), line("a1", "p", call(1)), line("a2", "a1", call(2)), line("a3", "a1", call(3)), line("a4", "a3", call(4)), line("a6", "a2", call(5)), line("a7", "a4", [{ type: "text", text: "done" }], "msg_next")];
    const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
    const runs = join(projectsDir, webRoot.replace(/[^a-zA-Z0-9]/g, "-"), id, "subagents");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "agent-b1.jsonl"), raw.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const sdk = (l: (typeof raw)[number]) => ({ type: l.type, uuid: l.uuid, session_id: id, message: l.message, parent_tool_use_id: "toolu_outer", parent_agent_id: null, timestamp: at });
    const main = [
      { type: "user", uuid: "u0", session_id: id, parent_tool_use_id: null, parent_agent_id: null, timestamp: at, message: { role: "user", content: "inspect" } },
      { type: "assistant", uuid: "u1", session_id: id, parent_tool_use_id: null, parent_agent_id: null, timestamp: at, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_outer", name: "Agent", input: { description: "Mine" } }] } },
    ];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      projectsDir,
      query: fakeQuery as never,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (sid: string) => (sid === id ? { sessionId: id, cwd: webRoot } : undefined)) as never,
        getSessionMessages: (async () => main) as never,
        listSubagents: (async () => ["b1"]) as never,
        // The leaf chain a7 > a4 > a3 > a1 > p.
        getSubagentMessages: (async () => ["p", "a1", "a3", "a4", "a7"].map((u) => sdk(raw.find((l) => l.uuid === u)!))) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await c.waitFor((m) => m.type === "event" && m.part.type === "session_state");
      const order = c.inbox.flatMap((m) => (m.type === "event" && m.part.type === "tool_call" ? [m.part.id] : []));
      expect([...new Set(order)]).toEqual([1, 2, 3, 4, 5].map((n) => `toolu_call${n}`));
    } finally {
      d.close();
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  it("a restored background subagent run keeps its real status and duration from the transcript's task notifications", async () => {
    // Shapes of the "Sleeper" run in development-docs/GH-36 session 4c189532 (getSessionMessages, SDK 0.3.285).
    const id = "9c3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";
    const at = (s: number) => new Date(Date.UTC(2026, 9, 2, 9, 16, 5) + s * 1000).toISOString();
    const msg = (type: string, s: number, content: unknown) =>
      ({ type, uuid: `u${s}${type}`, session_id: id, parent_tool_use_id: null, parent_agent_id: null, timestamp: at(s), message: { id: `m${s}`, role: type, content } }) as never;
    const notice = (s: number, runId: string, agentId: string, status: string) =>
      msg("user", s, `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${runId}</tool-use-id>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`);
    const launched = (runId: string, agentId: string) => [
      { type: "tool_result", tool_use_id: runId, content: [{ type: "text", text: `Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${agentId} (internal ID - do not mention to user.)\nThe agent is working in the background.` }] },
    ];
    const main = [
      msg("user", 0, "sleep in the background"),
      msg("assistant", 0, [
        { type: "tool_use", id: "toolu_sleeper", name: "Agent", input: { description: "Sleeper", run_in_background: true } },
        { type: "tool_use", id: "toolu_stopped", name: "Agent", input: { description: "Stopped", run_in_background: true } },
      ]),
      msg("user", 1, [...launched("toolu_sleeper", "a6f05acc3b9960d0d"), ...launched("toolu_stopped", "a1b2c3d4e5f6a7b8c")]),
      notice(40, "toolu_stopped", "a1b2c3d4e5f6a7b8c", "stopped"),
      notice(145, "toolu_sleeper", "a6f05acc3b9960d0d", "completed"),
    ];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (sid: string) => (sid === id ? { sessionId: id, cwd: webRoot } : undefined)) as never,
        getSessionMessages: (async () => main) as never,
        listSubagents: (async () => []) as never,
        getSubagentMessages: (async () => []) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await c.waitFor((m) => m.type === "event" && m.part.type === "session_state");
      const parts = new Map(c.inbox.flatMap((m) => (m.type === "event" ? [[m.part.id, m.part] as const] : [])));
      expect(parts.get("toolu_sleeper")).toMatchObject({ type: "subagent", status: "done", startedAt: Date.parse(at(0)), endedAt: Date.parse(at(145)) });
      expect(parts.get("toolu_stopped")).toMatchObject({ type: "subagent", status: "stopped", endedAt: Date.parse(at(40)) });
    } finally {
      d.close();
    }
  });

  it("session.stopSubagent stops that run through stopTask with its task ID; a permission request inside the run is delivered and settled once; the turn goes on", async () => {
    const d = createDaemon({ webRoot, roots: [webRoot], query: subagentQuery as never, token });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const [a, b] = await Promise.all([client((d.address() as AddressInfo).port), client((d.address() as AddressInfo).port)]);
      const { result } = (await a.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
      const sessionId = result.session.id;
      await a.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await b.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await a.request({ type: "session.prompt", sessionId, text: "test" });
      const isRequest = (m: ServerMessage) => m.type === "event" && m.part.type === "permission_request";
      const req = (await b.waitFor(isRequest)) as Extract<ServerMessage, { type: "event" }>;
      const { requestId, toolUseId } = req.part as { requestId: string; toolUseId: string };
      const call = a.inbox.find((m) => m.type === "event" && m.part.id === toolUseId) as Extract<ServerMessage, { type: "event" }>;
      expect(call.part).toMatchObject({ type: "tool_call", parentId: "agent-1" });
      const answers = await Promise.all([a.request({ type: "permission.respond", requestId, decision: "allow" }), b.request({ type: "permission.respond", requestId, decision: "deny" })]);
      const settled = answers.map((r) => (r as { result: { settled: boolean } }).result.settled);
      expect(settled.filter(Boolean)).toHaveLength(1);
      // The SDK got the winning answer only.
      expect(permissionResults.at(-1)).toMatchObject({ behavior: settled[0] ? "allow" : "deny" });

      expect(await a.request({ type: "session.stopSubagent", sessionId, subagentId: "nope" })).toMatchObject({ type: "error", code: "unknown_subagent" });
      expect(await a.request({ type: "session.stopSubagent", sessionId, subagentId: "agent-1" })).toMatchObject({ type: "reply" });
      expect(stopped).toEqual(["task-1"]);
      // Stopped, not failed: the error tool_result that follows keeps it stopped.
      const ended = (m: ServerMessage) => m.type === "event" && m.part.type === "subagent" && m.part.status === "stopped";
      for (const c of [a, b]) expect(((await c.waitFor(ended)) as { part: object }).part).toMatchObject({ id: "agent-1", endedAt: expect.any(Number) });
      await a.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
      expect(a.inbox.filter((m) => m.type === "event" && m.part.id === "agent-1").at(-1)).toMatchObject({ part: { status: "stopped" } });
      // Ended: nothing left to stop.
      expect(await a.request({ type: "session.stopSubagent", sessionId, subagentId: "agent-1" })).toMatchObject({ type: "error", code: "unknown_subagent" });
      expect(await a.request({ type: "session.stopSubagent", sessionId: "nope", subagentId: "agent-1" })).toMatchObject({ type: "error", code: "unknown_session" });
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

describe("push", () => {
  const fakePush = () => {
    const sent: PushPayload[] = [];
    const subs: unknown[] = [];
    return { sent, subs, push: { publicKey: "BPUBLIC", subscribe: (s: unknown) => (subs.push(s), s !== null), send: async (p: PushPayload) => void sent.push(p) } };
  };
  async function daemon(push?: ReturnType<typeof fakePush>["push"]) {
    const d = createDaemon({ webRoot, roots: [webRoot], query: permissionQuery as never, token, push, history: { ...history, getSessionInfo: async () => undefined } as never });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    return { d, c: await client((d.address() as AddressInfo).port) };
  }

  it("push.key and push.subscribe hand the VAPID key out and store the subscription", async () => {
    const f = fakePush();
    const { d, c } = await daemon(f.push);
    try {
      expect(await c.request({ type: "push.key" })).toMatchObject({ result: { publicKey: "BPUBLIC" } });
      const sub = { endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } };
      expect(await c.request({ type: "push.subscribe", subscription: sub })).toMatchObject({ type: "reply" });
      expect(f.subs).toEqual([sub]);
      expect(await c.request({ type: "push.subscribe", subscription: null })).toMatchObject({ code: "bad_subscription" });
      expect(await c.request({ type: "push.focus", sessionId: 42 })).toMatchObject({ code: "bad_request" });
    } finally {
      d.close();
    }
    const none = await daemon();
    expect(await none.c.request({ type: "push.key" })).toMatchObject({ code: "push_unavailable" });
    none.d.close();
  });

  it("pushes needs input with the session title fallback and tool command; suppressed while a focused tab shows the session", async () => {
    const f = fakePush();
    const { d, c } = await daemon(f.push);
    try {
      const { result } = (await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
      const sessionId = result.session.id;
      await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await c.request({ type: "push.focus", sessionId });
      await c.request({ type: "session.prompt", sessionId, text: "run tests" });
      const req = (await c.waitFor((m) => m.type === "event" && m.part.type === "permission_request")) as { part: { requestId: string } };
      await new Promise((r) => setTimeout(r, 50));
      expect(f.sent).toEqual([]);

      await c.request({ type: "push.focus" });
      await c.request({ type: "permission.respond", requestId: req.part.requestId, decision: "allow" });
      await c.waitFor((m) => m.type === "event" && m.part.type === "session_state" && m.part.state === "idle");
      await c.request({ type: "session.prompt", sessionId, text: "again" });
      await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      expect(f.sent[0]).toEqual({ sessionId, title: basename(webRoot), body: "Needs input · Bash: npm test" });
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

  it("answers the /auth probe 204 for the paired token and 401 otherwise: the browser cannot see a rejected upgrade's status", async () => {
    const probe = (headers: Record<string, string> = {}) => fetch(`${origin()}/auth`, { headers }).then((r) => r.status);
    expect(await probe({ authorization: `Bearer ${token}` })).toBe(204);
    expect(await probe({ authorization: "Bearer wrong-token" })).toBe(401);
    expect(await probe()).toBe(401);
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

  it("accepts a configured hostname (tailscale serve) and only on the daemon that configured it", async () => {
    const name = "box.tail1234.ts.net";
    const headers = { origin: `https://${name}`, host: name };
    expect((await attempt({ protocols: protocols(), headers })).status).toBe(403);
    const d = createDaemon({ webRoot, roots: [webRoot], query: fakeQuery as never, token, hostnames: [name] });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${(d.address() as AddressInfo).port}/ws`, protocols(), { headers });
      expect(await new Promise((r) => (ws.on("open", () => (r("open"), ws.close())), ws.on("unexpected-response", (_q, res) => r(res.statusCode))))).toBe("open");
    } finally {
      d.close();
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

describe("transcript sync (terminal CLI turns)", () => {
  type Msg = { type: string; uuid: string; parent_tool_use_id: string | null };
  const msg = (type: "user" | "assistant", uuid: string, content: unknown, parent: string | null = null) =>
    ({ type, uuid, session_id: "x", parent_tool_use_id: parent, parent_agent_id: null, message: type === "user" ? { role: "user", content } : { id: `msg_${uuid}`, role: "assistant", content } }) as Msg;
  const at = history.findIndex((m: Msg) => m.uuid === "u2");
  /** What the CLI writes for the fake query's turns: prompt 1, the fixture's first turn, prompt 2, its second turn. */
  const own = (...prompts: string[]) => prompts.flatMap((p, i) => [msg("user", p, "x"), ...(i ? history.slice(at + 1) : history.slice(1, at))]) as Msg[];
  /** A finished terminal CLI turn: its reply ends the turn (stop_reason end_turn, as the CLI writes it). */
  const external = (n: string) => {
    const reply = msg("assistant", `cli-${n}-reply`, [{ type: "text", text: `terminal reply ${n}` }]) as Msg & { message: object };
    return [msg("user", `cli-${n}`, `from the terminal ${n}`), { ...reply, message: { ...reply.message, stop_reason: "end_turn" } } as Msg];
  };
  const quiet = () => new Promise((r) => setTimeout(r, 1500));
  type Event = Extract<ServerMessage, { type: "event" }>;
  const events = (c: { inbox: ServerMessage[] }) => c.inbox.filter((m): m is Event => m.type === "event");
  const isPart = (type: string, id?: string) => (m: ServerMessage) => m.type === "event" && m.part.type === type && (id === undefined || m.part.id === id);

  /** A daemon whose transcripts are `files` (getSessionMessages) with a file per session under its projectsDir that `touch` grows. */
  async function syncDaemon(query: unknown = fakeQuery, restored: Record<string, Msg[]> = {}) {
    const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
    const files: Record<string, Msg[] | "unreadable"> = { ...restored };
    // Transcript reads (getSessionMessages calls, getSubagentMessages agent IDs) and the subagent runs listSubagents names.
    const reads = { main: 0, runs: [] as string[] };
    const agents: string[] = [];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: query as never,
      projectsDir,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (sid: string) => (restored[sid] ? { sessionId: sid, cwd: webRoot } : undefined)) as never,
        getSessionMessages: (async (sid: string) => {
          reads.main++;
          if (files[sid] === "unreadable") throw new Error("EACCES");
          return files[sid] ?? [];
        }) as never,
        listSubagents: (async () => agents) as never,
        getSubagentMessages: (async (_sid: string, agent: string) => (reads.runs.push(agent), [])) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const c = await client((d.address() as AddressInfo).port);
    /** Grows the session's transcript file, or with `agent` that subagent run's file. */
    const touch = (sid: string, cwd: string, agent?: string) => {
      const dir = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"), ...(agent ? [sid, "subagents"] : []));
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, agent ? `agent-${agent}.jsonl` : `${sid}.jsonl`), "{}\n");
    };
    const create = async () => {
      const { result } = (await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string; cwd: string } } };
      await c.request({ type: "session.subscribe", sessionId: result.session.id, sinceSeq: 0 });
      return result.session;
    };
    const idle = (sid: string, after: number) => c.waitFor((m) => m.type === "event" && m.sessionId === sid && m.seq > after && m.part.type === "session_state" && m.part.state === "idle");
    const prompt = async (sid: string, text: string) => {
      const before = events(c).at(-1)?.seq ?? 0;
      await c.request({ type: "session.prompt", sessionId: sid, text });
      const user = (await c.waitFor((m) => m.type === "event" && m.sessionId === sid && m.part.type === "user_text" && m.part.text === text)) as Event;
      await idle(sid, user.seq);
      return user.part.id;
    };
    return { d, c, files, touch, create, prompt, reads, agents, port: (d.address() as AddressInfo).port };
  }

  it("a terminal CLI /compact shows the compaction divider once, like a restore: its summary lies before the preserved known messages", { timeout: 15_000 }, async () => {
    const { d, c, files, touch, create, prompt } = await syncDaemon();
    try {
      const s = await create();
      const p1 = await prompt(s.id, "hi");
      files[s.id] = own(p1);
      touch(s.id, s.cwd);
      await quiet();
      // Chain after `claude -p "/compact" --resume <id>` (GH-38 review session 717f91ad): summary, preserved tail, command record, its output.
      const summary = { ...msg("user", "sum", "This session is being continued from a previous conversation."), isCompactSummary: true } as Msg;
      const command = msg("user", "cmd", "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>");
      files[s.id] = [summary, ...own(p1), command, msg("user", "out", "<local-command-stdout>Compacted</local-command-stdout>")];
      touch(s.id, s.cwd);
      const divider = (await c.waitFor(isPart("compaction", "sum"))) as Event;
      expect(divider.part).toMatchObject({ summary: "This session is being continued from a previous conversation." });
      const slash = (await c.waitFor(isPart("user_text", "cmd"))) as Event;
      expect(slash.part).toMatchObject({ text: "/compact" });
      touch(s.id, s.cwd);
      await quiet();
      expect(events(c).filter((e) => e.part.id === "sum")).toHaveLength(1);
    } finally {
      d.close();
    }
  });

  it("while a terminal CLI turn runs (transcript grew, its last message opens a turn) the session reports it and refuses prompts; its end clears it", { timeout: 15_000 }, async () => {
    const { d, c, files, touch, create, prompt } = await syncDaemon();
    try {
      const s = await create();
      const p1 = await prompt(s.id, "hi");
      files[s.id] = own(p1);
      touch(s.id, s.cwd);
      await quiet();
      expect(events(c).some((e) => e.part.type === "external_turn")).toBe(false);
      const reply = (uuid: string, content: unknown[], stop_reason: string) => {
        const m = msg("assistant", uuid, content) as Msg & { message: object };
        return { ...m, message: { ...m.message, stop_reason } } as Msg;
      };
      const call = reply("cli-call", [{ type: "tool_use", id: "toolu_cli", name: "Bash", input: { command: "sleep 5" } }], "tool_use");
      files[s.id] = [...own(p1), msg("user", "cli-p", "from the terminal"), call];
      touch(s.id, s.cwd);
      await c.waitFor((m) => isPart("external_turn")(m) && (m as Event).part.type === "external_turn" && (m as { part: { running: boolean } }).part.running);
      expect(await c.request({ type: "session.prompt", sessionId: s.id, text: "too early" })).toMatchObject({ type: "error", code: "external_turn", message: "A terminal CLI turn is running in this session" });
      expect(events(c).some((e) => e.part.type === "user_text" && (e.part as { text: string }).text === "too early")).toBe(false);
      const result = msg("user", "cli-result", [{ type: "tool_result", tool_use_id: "toolu_cli", content: "" }]);
      files[s.id] = [...own(p1), msg("user", "cli-p", "from the terminal"), call, result, reply("cli-end", [{ type: "text", text: "done" }], "end_turn")];
      touch(s.id, s.cwd);
      await c.waitFor((m) => isPart("external_turn")(m) && !(m as { part: { running: boolean } }).part.running);
      await prompt(s.id, "now");
    } finally {
      d.close();
    }
  });

  it("a sync reads the transcript only when its file changed, from the last offset, and a subagent run file only when that file changed", { timeout: 15_000 }, async () => {
    const { d, c, files, touch, create, prompt, reads, agents } = await syncDaemon();
    try {
      const s = await create();
      const p1 = await prompt(s.id, "hi");
      files[s.id] = own(p1);
      agents.push("r1", "r2");
      touch(s.id, s.cwd);
      touch(s.id, s.cwd, "r1");
      touch(s.id, s.cwd, "r2");
      await quiet();
      expect(reads.runs.sort()).toEqual(["r1", "r2"]);
      // Nothing changed: the sync before this prompt reads no transcript.
      Object.assign(reads, { main: 0, runs: [] });
      const p2 = await prompt(s.id, "again");
      expect(reads).toEqual({ main: 0, runs: [] });
      files[s.id] = [...own(p1, p2), ...external("1")];
      touch(s.id, s.cwd, "r2");
      touch(s.id, s.cwd);
      await c.waitFor(isPart("user_text", "cli-1"));
      expect(reads.main).toBe(1);
      expect(reads.runs).toEqual(["r2"]);
    } finally {
      d.close();
    }
  });

  it("mirrors terminal CLI turns of a viewed session once, in order; the daemon's own turns do not come back; replay by sinceSeq", { timeout: 15_000 }, async () => {
    const { d, c, files, touch, create, prompt, port } = await syncDaemon();
    try {
      const s = await create();
      const p1 = await prompt(s.id, "hi");
      files[s.id] = own(p1);
      touch(s.id, s.cwd);
      await quiet();
      const before = events(c).length;
      const lastSeq = events(c).at(-1)!.seq;
      expect(before).toBeGreaterThan(0);
      expect(events(c).filter((e) => e.part.type === "user_text")).toHaveLength(1);

      files[s.id] = [...own(p1), ...external("1")];
      touch(s.id, s.cwd);
      const reply = await c.waitFor(isPart("assistant_text", "msg_cli-1-reply:0"));
      const user = events(c).find((e) => e.part.id === "cli-1")!;
      expect(user.part).toMatchObject({ type: "user_text", text: "from the terminal 1" });
      expect(user.seq).toBeGreaterThan(lastSeq);
      expect((reply as Event).seq).toBeGreaterThan(user.seq);
      // A sync that logged turns refreshes the context usage, as the end of a turn does.
      await c.waitFor((m) => isPart("context_usage")(m) && (m as Event).seq > user.seq);

      touch(s.id, s.cwd);
      await quiet();
      expect(events(c).filter((e) => e.part.id === "cli-1")).toHaveLength(1);

      const sub = (await c.request({ type: "session.subscribe", sessionId: s.id, sinceSeq: 0 })) as { result: { logEpoch: string } };
      const b = await client(port);
      await b.request({ type: "session.subscribe", sessionId: s.id, sinceSeq: lastSeq, logEpoch: sub.result.logEpoch });
      await b.waitFor(isPart("assistant_text", "msg_cli-1-reply:0"));
      expect(events(b)[0]).toMatchObject({ seq: lastSeq + 1 });
      expect(events(b).filter((e) => e.part.id === "cli-1")).toHaveLength(1);
      b.ws.close();
    } finally {
      d.close();
    }
  });

  it("a prompt after terminal CLI turns starts a fresh query resuming the transcript with the session's model, mode and effort; without them it reuses the live query", { timeout: 15_000 }, async () => {
    const { d, c, files, create, prompt } = await syncDaemon();
    try {
      const s = await create();
      const mine = () => calls.filter((o) => (o.sessionId === s.id || o.resume === s.id) && o.canUseTool);
      const p1 = await prompt(s.id, "hi");
      files[s.id] = own(p1);
      const p2 = await prompt(s.id, "again");
      expect(mine()).toHaveLength(1);
      expect(closedQueries).not.toContain(mine()[0]);
      // After the fixture turns: their system/init reports mode default.
      await c.request({ type: "session.setModel", sessionId: s.id, model: "sonnet" });
      await c.request({ type: "session.setPermissionMode", sessionId: s.id, mode: "acceptEdits" });
      await c.request({ type: "session.setEffort", sessionId: s.id, effort: "high" });

      // No file change: the prompt itself syncs first.
      files[s.id] = [...own(p1, p2), ...external("1")];
      await prompt(s.id, "third");
      expect(mine()).toHaveLength(2);
      expect(mine().at(-1)).toMatchObject({ resume: s.id, model: "sonnet", permissionMode: "acceptEdits", effort: "high", resumeSessionAt: undefined });
      expect(closedQueries).toContain(mine()[0]);
      const order = events(c).filter((e) => e.part.type === "user_text").map((e) => e.part.id);
      expect(order.slice(-2)).toEqual(["cli-1", expect.any(String)]);
      expect((events(c).find((e) => e.part.id === order.at(-1)) as Event).part).toMatchObject({ text: "third" });
    } finally {
      d.close();
    }
  });

  it("no sync while a permission request is pending; the terminal CLI turns arrive after the turn ends", { timeout: 15_000 }, async () => {
    const { d, c, files, touch, create } = await syncDaemon(permissionQuery);
    try {
      const s = await create();
      await c.request({ type: "session.prompt", sessionId: s.id, text: "run tests" });
      const req = (await c.waitFor(isPart("permission_request"))) as Event;
      const p1 = events(c).find((e) => e.part.type === "user_text")!.part.id;
      files[s.id] = [msg("user", p1, "run tests"), yielded.at(-1) as never as Msg, ...external("1")];
      touch(s.id, s.cwd);
      await quiet();
      expect(events(c).some((e) => e.part.id === "cli-1")).toBe(false);
      expect(c.inbox.some((m) => m.type === "event" && m.part.type === "permission_request" && (m.part as { settled: boolean }).settled)).toBe(false);

      await c.request({ type: "permission.respond", requestId: (req.part as { requestId: string }).requestId, decision: "allow" });
      const user = (await c.waitFor(isPart("user_text", "cli-1"))) as Event;
      const result = events(c).find((e) => e.part.type === "turn_result")!;
      expect(user.seq).toBeGreaterThan(result.seq);
    } finally {
      d.close();
    }
  });

  it("a fork in the transcript (terminal CLI rewind) rewinds the timeline to the common message, then shows the new branch; its prompt is a checkpoint", { timeout: 15_000 }, async () => {
    const id = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
    const { d, c, files, touch } = await syncDaemon(fakeQuery, { [id]: history as never });
    try {
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await c.waitFor(isPart("session_state"));
      files[id] = [...(history.slice(0, at) as Msg[]), ...external("fork")];
      touch(id, webRoot);
      const user = (await c.waitFor(isPart("user_text", "cli-fork"))) as Event;
      const rewind = events(c).find((e) => e.part.type === "rewind")!;
      expect(rewind.part).toMatchObject({ userMessageId: "u2" });
      expect(rewind.seq).toBeLessThan(user.seq);
      expect(await c.request({ type: "session.rewindPreview", sessionId: id, userMessageId: "cli-fork" })).toMatchObject({ result: { conversation: true } });
      await c.request({ type: "session.prompt", sessionId: id, text: "go on" });
      expect(calls.filter((o) => o.resume === id && o.canUseTool).at(-1)).toMatchObject({ resume: id, resumeSessionAt: undefined });
    } finally {
      d.close();
    }
  });

  it("an unreadable transcript logs no events and leaves the session usable", { timeout: 15_000 }, async () => {
    const { d, c, files, touch, create, prompt } = await syncDaemon();
    try {
      const s = await create();
      await prompt(s.id, "hi");
      files[s.id] = "unreadable";
      const before = events(c).length;
      touch(s.id, s.cwd);
      await quiet();
      expect(events(c)).toHaveLength(before);
      await prompt(s.id, "again");
      await c.waitFor((m) => isPart("turn_result")(m) && (m as Event).seq > before);
    } finally {
      d.close();
    }
  });
});
