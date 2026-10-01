import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { PushPayload, ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createDaemon } from "../src/server.ts";
import { calls, fakeQuery, planCalls, history, interruptQuery, models, permissionQuery, questionQuery, setModelCalls } from "./fake-query.ts";

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
  return new Promise<{ ws: WebSocket; request: typeof request; waitFor: typeof waitFor; inbox: ServerMessage[] }>((r) =>
    ws.on("open", () => r({ ws, request, waitFor, inbox })),
  );
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
    expect(sub).toMatchObject({ result: { session: { permissionMode: "plan", effort: "max", permissionModes: ["default", "acceptEdits", "plan"] } } });
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
      expect(list.result.sessions).toMatchObject([
        { id: created.result.session.id, cwd: webRoot, state: "idle", model: "default", title: "New session", lastActivity: expect.any(Number), archived: false, transcript: false },
        { id: inside, cwd, state: "closed", model: "default", title: "fix the bug", lastActivity: 1000, archived: false, transcript: true },
      ]);

      expect(await c.request({ type: "session.subscribe", sessionId: outside, sinceSeq: 0 })).toMatchObject({ code: "unknown_session" });
      await c.request({ type: "session.subscribe", sessionId: inside, sinceSeq: 0 });
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

  it("project.open keeps a project with no sessions across a restart; project.remove hides it and its sessions", async () => {
    const cwd = mkdtempSync(join(webRoot, "proj-"));
    const opened = mkdtempSync(join(webRoot, "opened-"));
    const file = join(mkdtempSync(join(tmpdir(), "cfg-")), "projects.json");
    const transcripts = [{ sessionId: "5b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", summary: "old", lastModified: 1000, cwd }];
    const start = async () => {
      const d = createDaemon({
        webRoot,
        token,
        roots: [webRoot],
        query: fakeQuery as never,
        projects: createProjects({ file }),
        history: { listSessions: (async () => transcripts) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
      });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      return { d, c: await client((d.address() as AddressInfo).port) };
    };
    const list = async (c: Awaited<ReturnType<typeof client>>) =>
      ((await c.request({ type: "session.list" })) as { result: { projects: string[]; sessions: { id: string }[] } }).result;

    const a = await start();
    try {
      expect(await a.c.request({ type: "project.open", cwd: opened })).toMatchObject({ result: { cwd: opened } });
      expect(await a.c.request({ type: "project.open", cwd: "/etc" })).toMatchObject({ code: "cwd_not_allowed" });
      expect(await a.c.request({ type: "project.open", cwd: join(webRoot, "index.html") })).toMatchObject({ code: "cwd_not_allowed" });
      expect((await list(a.c)).projects).toEqual([opened, cwd]);
    } finally {
      a.d.close();
    }
    const b = await start();
    try {
      expect((await list(b.c)).projects).toEqual([opened, cwd]);
      await b.c.request({ type: "project.remove", cwd });
      expect(await list(b.c)).toEqual({ projects: [opened], sessions: [] });
      expect(await b.c.request({ type: "project.remove", cwd: 7 })).toMatchObject({ code: "bad_cwd" });
      // Files stay.
      expect(statSync(cwd).isDirectory()).toBe(true);
    } finally {
      b.d.close();
    }
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
