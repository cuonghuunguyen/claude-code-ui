import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { PageResult, PushPayload, ServerMessage, Snapshot } from "@claude-ui/protocol";
import { MAX_TERMINAL_INPUT_BYTES, MAX_UPLOAD_BYTES, PAGE_TURNS, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { ARTIFACT_ASSET_HEADERS, ARTIFACT_HEADERS } from "../src/artifact-preview.ts";
import { openChecked } from "../src/fd-check.ts";
import { gitBlobRead, listWorktrees } from "../src/git.ts";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createDaemon, MAX_FRAME_BYTES, MAX_SETTINGS } from "../src/server.ts";
import { scanThreadConfig } from "../src/session-scan.ts";
import { SideSocket } from "../src/sides.ts";
import { MAX_TERMINALS, MAX_TERMINALS_PER_CLIENT } from "../src/terminals.ts";
import { calls, CLEAR_RECORD, clearQuery, closedQueries, controlCalls, fakeQuery, firstTurnLastAssistant, planCalls, history, interruptQuery, models, permissionQuery, permissionResults, questionQuery, setModelCalls, stopped, subagentQuery, yielded } from "./fake-query.ts";

/** A projects store with these cwds added. */
// Counts `git worktree list` reads (the session list's cache); behaviour unchanged.
vi.mock("../src/git.ts", async (importOriginal) => {
  const git = await importOriginal<typeof import("../src/git.ts")>();
  return { ...git, listWorktrees: vi.fn(git.listWorktrees), gitBlobRead: vi.fn(git.gitBlobRead) };
});

// The seam between allowed() and the open: a test runs code there (a swap) through mockImplementationOnce; behaviour unchanged.
vi.mock("../src/fd-check.ts", async (importOriginal) => {
  const fd = await importOriginal<typeof import("../src/fd-check.ts")>();
  return { ...fd, openChecked: vi.fn(fd.openChecked) };
});

const added = (...cwds: string[]) => {
  const p = createProjects();
  cwds.forEach((c) => p.open(c));
  return p;
};

// POSIX-only assertions (sh syntax, symlinks without admin rights) are skipped or swapped on Windows.
const posix = process.platform !== "win32";
// Git for Windows takes 0.2-0.6 s per process, so tests that drive many git commands (worktrees) exceed the 15 s default there.
if (!posix) vi.setConfig({ testTimeout: 120_000 });
const webRoot = mkdtempSync(join(tmpdir(), "web-"));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const uploadParent = join(mkdtempSync(join(tmpdir(), "up-")), "claude-ui-uploads");
const http = createDaemon({ webRoot, roots: [webRoot], query: fakeQuery as never, token, uploadDir: uploadParent });
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

function client(p = port, wsOpts: { autoPong?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, protocols(), { origin: `http://127.0.0.1:${p}`, ...wsOpts });
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

  it.skipIf(!posix)("session.bash runs in the session cwd and streams a bash part; empty command => bad_command; prompt while running => bash_running", async () => {
    const c = await client();
    const id = ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    expect(await c.request({ type: "session.bash", sessionId: id, command: "  " })).toMatchObject({ type: "error", code: "bad_command" });
    expect(await c.request({ type: "session.bash", sessionId: id, command: "pwd; sleep 1" })).toMatchObject({ type: "reply" });
    expect(await c.request({ type: "session.prompt", sessionId: id, text: "hi" })).toMatchObject({ type: "error", code: "bash_running" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "bash" && m.part.status === "done");
    const done = c.inbox.filter((m) => m.type === "event" && m.part.type === "bash").at(-1) as { part: { stdout: string } };
    expect(done.part.stdout).toBe(`${realpathSync(webRoot)}\n`);
  });

  it("session.bash on a session whose folder left the allowlisted roots (removed) => cwd_not_allowed, nothing runs", async () => {
    const c = await client();
    const dir = mkdtempSync(join(webRoot, "gone-"));
    const id = ((await c.request({ type: "session.create", cwd: dir })) as { result: { session: { id: string } } }).result.session.id;
    rmSync(dir, { recursive: true });
    expect(await c.request({ type: "session.bash", sessionId: id, command: "echo hi" })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
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
    const live = a.inbox.filter((m) => m.type === "event") as { seq: number }[];
    const seen = live.at(-1)!.seq;

    const b = await client();
    const again = await b.request({ type: "session.subscribe", sessionId, sinceSeq: 5, logEpoch: sub.result.logEpoch });
    expect(again).toMatchObject({ result: { logEpoch: sub.result.logEpoch, session: { id: sessionId, cwd: webRoot }, title: "New session" } });
    // Streaming updates a later event of the same part replaced are not replayed (GH-139): gaps in seq.
    await b.waitFor(() => (b.inbox.filter((m) => m.type === "event").at(-1) as { seq: number } | undefined)?.seq === seen);
    const replayed = b.inbox.filter((m) => m.type === "event") as { seq: number }[];
    expect(replayed[0]!.seq).toBeGreaterThan(5);
    expect(replayed.length).toBeLessThan(live.filter((e) => e.seq > 5).length);

    await b.request({ type: "session.prompt", sessionId, text: "again" });
    await b.waitFor((m) => m.type === "event" && m.part.type === "turn_result" && m.seq > seen);
  });

  it("session.media replies the payload a paged snapshot left out; errors unknown_media and bad_request (GH-274)", async () => {
    const sessionId = "6c3d4e5f-7081-4b92-8ca3-b4c5d6e7f809";
    const png = `data:image/png;base64,${"iVBOR".repeat(4000)}`;
    const turn = [
      { type: "user", uuid: "u1", session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png.split(",")[1] } }] } },
      { type: "assistant", uuid: "a1", session_id: sessionId, parent_tool_use_id: null, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } },
    ];
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (sid: string) => (sid === sessionId ? { sessionId, cwd: webRoot, summary: "Img" } : undefined)) as never,
        getSessionMessages: (async () => turn) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const b = await client((d.address() as AddressInfo).port);
      const sub = (await b.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true })) as { result: { snapshot: Snapshot } };
      expect(JSON.stringify(sub).length).toBeLessThan(5000);
      const user = sub.result.snapshot.page.parts.find((p) => p.type === "user_text")!;
      expect(user.type === "user_text" && user.images[0]!.startsWith("omitted:image/png;")).toBe(true);
      expect(await b.request({ type: "session.media", sessionId, partId: user.id, index: 0 })).toMatchObject({ result: { dataUrl: png } });
      expect(await b.request({ type: "session.media", sessionId, partId: user.id, index: 3 })).toMatchObject({ type: "error", code: "unknown_media" });
      expect(await b.request({ type: "session.media", sessionId, partId: user.id, index: -1 })).toMatchObject({ type: "error", code: "bad_request" });
    } finally {
      d.close();
    }
  });

  it("paged subscribe replies with the last page and replays no event; session.page, session.edits and their errors; from snapshots a new epoch at that turn", async () => {
    const sessionId = "5b2c3d4e-6f70-4a81-9b92-a3b4c5d6e7f8";
    // 16 turns (the fixture has two), each prompt with its own uuid.
    const many = Array.from({ length: 8 }, () => history).flat().map((m, i) => ({ ...(m as object), uuid: `m${i}-${(m as { uuid?: string }).uuid ?? ""}` }));
    const restarted = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (sid: string) => (sid === sessionId ? { sessionId, cwd: webRoot, summary: "Long" } : undefined)) as never,
        getSessionMessages: (async () => many) as never,
      },
    });
    await new Promise<void>((r) => restarted.listen(0, "127.0.0.1", r));
    const users = (parts: { type: string }[]) => parts.filter((p) => p.type === "user_text").length;
    try {
      const b = await client((restarted.address() as AddressInfo).port);
      const sub = (await b.request({ type: "session.subscribe", sessionId, sinceSeq: 0, paged: true })) as { result: { logEpoch: string; seq: number; snapshot: Snapshot } };
      const { snapshot } = sub.result;
      expect(users(snapshot.page.parts)).toBe(PAGE_TURNS);
      expect(snapshot.page.older).toBeDefined();
      expect(snapshot.heads.some((e) => e.part.type === "session_state")).toBe(true);
      expect(snapshot.aux.every((x) => x.pos < snapshot.page.older!.pos)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      // Only the commands list loads live (a restored session fetches it on its first subscribe); no history replays.
      expect(b.inbox.filter((m) => m.type === "event").map((m) => (m as { part: { type: string } }).part.type)).toEqual(["commands"]);

      // Live events stream after the snapshot.
      await b.request({ type: "session.prompt", sessionId, text: "live" });
      await b.waitFor((m) => m.type === "event" && m.part.type === "user_text" && m.part.text === "live");

      const page = (await b.request({ type: "session.page", sessionId, logEpoch: sub.result.logEpoch, before: snapshot.page.older!.before })) as { result: PageResult };
      expect(users(page.result.page.parts)).toBe(6);
      expect(page.result.page.older).toBeUndefined();
      expect(await b.request({ type: "session.page", sessionId, logEpoch: "old", before: "x" })).toMatchObject({ type: "error", code: "stale_epoch" });
      expect(await b.request({ type: "session.page", sessionId, logEpoch: sub.result.logEpoch, before: "nope" })).toMatchObject({ type: "error", code: "unknown_cursor" });
      expect(await b.request({ type: "session.edits", sessionId, logEpoch: sub.result.logEpoch, before: snapshot.page.older!.before })).toMatchObject({ result: { parts: [] } });
      expect(await b.request({ type: "session.edits", sessionId, logEpoch: sub.result.logEpoch, before: "nope" })).toMatchObject({ code: "unknown_cursor" });

      // A client of an older epoch that holds a turn gets a snapshot from it.
      const from = snapshot.page.older!.before;
      const c = await client((restarted.address() as AddressInfo).port);
      const again = (await c.request({ type: "session.subscribe", sessionId, sinceSeq: 40, logEpoch: "old-epoch", paged: true, from })) as { result: { snapshot: Snapshot } };
      expect(again.result.snapshot.page.parts[0]!.id).toBe(from);
      expect(users(again.result.snapshot.page.parts)).toBe(PAGE_TURNS + 1);
    } finally {
      restarted.close();
    }
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
        getSessionInfo: (async (sid: string) => (sid === id ? { sessionId: id, cwd: webRoot, summary: "Fix the parser" } : undefined)) as never,
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
      // The title as session.list gives it: a tab opened before the list shows it.
      expect(sub).toMatchObject({ result: { session: { id, cwd: webRoot, state: "idle" }, title: "Fix the parser" } });
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

    it("two daemons of one user change different settings of one session: the file keeps both (GH-91)", async () => {
      const f = file();
      const a = await daemon(f);
      const id = ((await a.c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      await a.c.request({ type: "session.setModel", sessionId: id, model: "haiku" });
      const b = await daemon(f);
      await b.c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await a.c.request({ type: "session.setEffort", sessionId: id, effort: "high" });
      await b.c.request({ type: "session.setPermissionMode", sessionId: id, mode: "acceptEdits" });
      expect(read(f)[id]).toMatchObject({ model: "haiku", effort: "high", permissionMode: "acceptEdits" });
      a.d.close();
      b.d.close();
    });

    it("a list on another daemon keeps the entry of a new session live on the first one, before its transcript exists (GH-91)", async () => {
      const f = file();
      const a = await daemon(f);
      const id = ((await a.c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      await a.c.request({ type: "session.setModel", sessionId: id, model: "haiku" });
      const b = await daemon(f);
      await b.c.request({ type: "session.list" });
      expect(read(f)[id]).toMatchObject({ model: "haiku" });
      a.d.close();
      b.d.close();
    });

    it("a saved mode this daemon does not enable stays in the file when another setting changes (GH-91)", async () => {
      const f = file();
      const id = uuid(8);
      writeFileSync(f, JSON.stringify({ [id]: { model: "haiku", permissionMode: "bypassPermissions", effort: "high" } }));
      const { d, c } = await daemon(f, [{ sessionId: id, cwd: webRoot }]);
      const sub = (await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 })) as { result: { session: object } };
      expect(sub.result.session).toMatchObject({ permissionMode: "default" });
      await c.request({ type: "session.setEffort", sessionId: id, effort: "low" });
      expect(read(f)[id]).toMatchObject({ model: "haiku", permissionMode: "bypassPermissions", effort: "low" });
      d.close();
    });

    it("picking a setting saves it even when it equals the value this daemon saved last (GH-91)", async () => {
      const f = file();
      const id = uuid(9);
      writeFileSync(f, JSON.stringify({ [id]: { model: "haiku", permissionMode: "default", effort: "low" } }));
      const a = await daemon(f, [{ sessionId: id, cwd: webRoot }]);
      const b = await daemon(f, [{ sessionId: id, cwd: webRoot }]);
      await b.c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await a.c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await a.c.request({ type: "session.setEffort", sessionId: id, effort: "high" });
      await a.c.request({ type: "session.setPermissionMode", sessionId: id, mode: "plan" });
      await b.c.request({ type: "session.setEffort", sessionId: id, effort: "low" });
      await b.c.request({ type: "session.setPermissionMode", sessionId: id, mode: "default" });
      expect(read(f)[id]).toMatchObject({ effort: "low", permissionMode: "default" });
      a.d.close();
      b.d.close();
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

    it("session.list gives a session without a CLI process live: false (before its first prompt, not loaded); a running one has no live", async () => {
      const unloaded = uuid(99);
      const first = await daemon(file(), [{ sessionId: unloaded, cwd: webRoot }]);
      const idle = ((await first.c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      const ran = ((await first.c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      await first.c.request({ type: "session.prompt", sessionId: ran, text: "hi" });
      const items = async (c: typeof first.c) => ((await c.request({ type: "session.list" })) as { result: { sessions: { id: string; live?: false }[] } }).result.sessions;
      const l1 = await items(first.c);
      expect(l1.find((s) => s.id === idle)?.live).toBe(false);
      expect(l1.find((s) => s.id === unloaded)?.live).toBe(false);
      expect(l1.find((s) => s.id === ran)?.live).toBeUndefined();
      first.d.close();
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

  it("stores an upload in its session's folder and replies the path", async () => {
    const c = await client();
    const created = (await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
    const id = created.result.session.id;
    const data = Buffer.from("hi").toString("base64");
    const r = (await c.request({ type: "fs.upload", name: "../notes.txt", data, sessionId: id })) as { result: { path: string } };
    expect(r.result.path).toMatch(new RegExp(`claude-ui-uploads[\\\\/]${id}[\\\\/]u-[^\\\\/]+[\\\\/]notes\\.txt$`));
    expect(readFileSync(r.result.path, "utf8")).toBe("hi");
    expect(await c.request({ type: "fs.upload", name: "x", data: 5, sessionId: id })).toMatchObject({ code: "bad_upload" });
    expect(await c.request({ type: "fs.upload", name: "x", data })).toMatchObject({ code: "bad_upload" });
    expect(await c.request({ type: "fs.upload", name: "x", data, sessionId: randomUUID() })).toMatchObject({ code: "unknown_session" });
    expect(await c.request({ type: "fs.upload", name: "x", data, sessionId: "../x" })).toMatchObject({ code: "unknown_session" });
    expect(await c.request({ type: "fs.upload", name: "x", data, draft: "short" })).toMatchObject({ code: "bad_upload" });
    expect(existsSync(join(uploadParent, "..", "x"))).toBe(false);
  });

  it("refuses an upload above the size limit", async () => {
    const c = await client();
    const created = (await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString("base64");
    expect(await c.request({ type: "fs.upload", name: "big", data: big, sessionId: created.result.session.id })).toMatchObject({ code: "too_large" });
  });

  it("a session gets only its own upload folder as an additional directory, so Claude reads an attachment without a permission request and not another session's", async () => {
    // A prompt with an image is a block array; the CLI does not expand @path there and Claude calls Read on the upload.
    const c = await client();
    const make = async () => ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
    const [a, b] = [await make(), await make()];
    const up = (await c.request({ type: "fs.upload", name: "notes.txt", data: Buffer.from("hi").toString("base64"), sessionId: a })) as { result: { path: string } };
    await c.request({ type: "session.prompt", sessionId: a, text: "read it" });
    await c.request({ type: "session.prompt", sessionId: b, text: "read it" });
    const dirs = (id: string) => calls.find((o) => o.sessionId === id)!.additionalDirectories!;
    expect(dirs(a)).toEqual([join(uploadParent, a)]);
    expect(dirs(b)).toEqual([join(uploadParent, b)]);
    expect(up.result.path.startsWith(`${dirs(a)[0]}${sep}`)).toBe(true);
    expect(up.result.path.startsWith(`${dirs(b)[0]}${sep}`)).toBe(false);
    expect([...dirs(a), ...dirs(b)]).not.toContain(uploadParent);
  });

  it("draft uploads go to the session created with the draft token; a second create cannot claim them", async () => {
    const c = await client();
    const T = randomBytes(32).toString("hex");
    const data = Buffer.from("hi").toString("base64");
    const [u1, u2] = (await Promise.all([1, 2].map((n) => c.request({ type: "fs.upload", name: `f${n}.txt`, data, draft: T })))) as { result: { path: string } }[];
    const X = relative(uploadParent, u1!.result.path).split(sep)[0]!;
    expect(X).toMatch(/^[0-9a-f-]{36}$/);
    expect(relative(uploadParent, u2!.result.path).split(sep)[0]).toBe(X);
    const created = (await c.request({ type: "session.create", cwd: webRoot, draft: T })) as { result: { session: { id: string } } };
    expect(created.result.session.id).toBe(X);
    await c.request({ type: "session.prompt", sessionId: X, text: "read it" });
    expect(calls.find((o) => o.sessionId === X)!.additionalDirectories![0]).toBe(join(uploadParent, X));
    const second = (await c.request({ type: "session.create", cwd: webRoot, draft: T })) as { result: { session: { id: string } } };
    expect(second.result.session.id).not.toBe(X);
    // A claimed token is spent: a copy of it (duplicated tab) cannot place files in that session's folder.
    expect(await c.request({ type: "fs.upload", name: "f3.txt", data, draft: T })).toMatchObject({ code: "draft_claimed" });
    expect(readdirSync(join(uploadParent, X)).length).toBe(2);
    // The retry path uses the session id.
    const again = (await c.request({ type: "fs.upload", name: "f3.txt", data, sessionId: X })) as { result: { path: string } };
    expect(relative(uploadParent, again.result.path).split(sep)[0]).toBe(X);
    const bad = (await c.request({ type: "session.create", cwd: webRoot, draft: "zz" })) as { type: string; result: { session: { id: string } } };
    expect(bad.type).toBe("reply");
    expect(bad.result.session.id).not.toBe(X);
  });

  it("a restored session keeps its upload folder", async () => {
    const id = "6d3d4e5f-6071-4829-9bac-1d2e3f4a5b6c";
    const cwd = join(webRoot, "restore-proj");
    mkdirSync(cwd, { recursive: true });
    const P = join(mkdtempSync(join(tmpdir(), "up-")), "uploads");
    const daemon = () =>
      createDaemon({
        webRoot,
        token,
        roots: [webRoot],
        query: permissionQuery as never,
        projects: added(cwd),
        uploadDir: P,
        history: {
          listSessions: (async () => [{ sessionId: id, summary: "s", lastModified: 1000, cwd }]) as never,
          getSessionInfo: (async (sid: string) => (sid === id ? { sessionId: id, summary: "s", lastModified: 1000, cwd } : undefined)) as never,
          getSessionMessages: (async () => history) as never,
        },
      });
    const run = async (d: ReturnType<typeof daemon>, f: (c: Awaited<ReturnType<typeof client>>) => Promise<void>) => {
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      try {
        await f(await client((d.address() as AddressInfo).port));
      } finally {
        d.close();
      }
    };
    let path = "";
    await run(daemon(), async (c) => {
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      path = ((await c.request({ type: "fs.upload", name: "a.txt", data: Buffer.from("hi").toString("base64"), sessionId: id })) as { result: { path: string } }).result.path;
    });
    calls.length = 0;
    await run(daemon(), async (c) => {
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await c.request({ type: "session.prompt", sessionId: id, text: "again" });
      expect(calls.filter((o) => o.resume === id).at(-1)!.additionalDirectories![0]).toBe(join(P, id));
      expect(readFileSync(path, "utf8")).toBe("hi");
    });
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

  // Spawning a PTY and waiting for shell output takes seconds on a loaded machine (30 s was not enough on a fully loaded one; waitFor has no timeout of its own).
  describe("terminals", { timeout: 120_000 }, () => {
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

    // The tests above and below speak sh; on Windows the default shell is PowerShell (no SHELL that exists there).
    it.runIf(!posix)("Windows: opens PowerShell in the cwd, keeps its scrollback for a new connection, drops it on exit", async () => {
      const c = await client();
      expect(await c.request({ type: "terminal.create", cwd: tmpdir(), cols: 80, rows: 24 })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
      const t = await create(c);
      await c.request({ type: "terminal.attach", terminalId: t.id });
      await c.request({ type: "terminal.input", terminalId: t.id, data: "(Get-Location).Path; echo \"win-$(40+2)\"\r" });
      await c.waitFor(() => output(c.inbox, t.id).includes("win-42"));
      expect(output(c.inbox, t.id)).toContain(realpathSync.native(webRoot));
      c.ws.close();
      const b = await client();
      expect(((await b.request({ type: "terminal.attach", terminalId: t.id })) as { result: { buffer: string } }).result.buffer).toContain("win-42");
      await b.request({ type: "terminal.input", terminalId: t.id, data: "exit\r" });
      await b.waitFor((m) => m.type === "terminal.exit" && m.terminalId === t.id);
      expect(await b.request({ type: "terminal.list", cwd: webRoot })).toMatchObject({ result: { terminals: [] } });
      b.ws.close();
    });

    it.runIf(posix)("opens a shell in a cwd inside the roots only", async () => {
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

    it.runIf(posix)("numbers terminals per cwd, lists them, resizes, and drops one whose shell exits", async () => {
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

    it.runIf(posix)("keeps running after the connection drops; a new connection gets the scrollback, then live output", async () => {
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

    // 32 ConPTY shells start in ~20 s on Windows alone, longer under the parallel suite.
    it("caps terminals per connection and per daemon: too_many_terminals", { timeout: posix ? 30_000 : 120_000 }, async () => {
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

    it.runIf(posix)("rejects terminal.input above 64 KiB and a size above 1000", async () => {
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

    it.runIf(posix)("the shell env has no CLAUDE_UI_* and no daemon PORT, the rest of the user's env stays", async () => {
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

  it("answers git.fetch for a cwd inside the roots only", async () => {
    const c = await client();
    expect(await c.request({ type: "git.fetch", cwd: join(webRoot, "..") })).toMatchObject({ code: "cwd_not_allowed" });
    expect(await c.request({ type: "git.fetch", cwd: webRoot })).toMatchObject({ result: { remote: null } });
  });

  it("answers git.branch, git.push and git.pull for a cwd inside the roots only, with checked arguments", async () => {
    const c = await client();
    const ref = "refs/heads/main";
    const local = "a".repeat(40);
    const outside = join(webRoot, "..");
    for (const m of [{ type: "git.branch", ref }, { type: "git.push", ref, local, argv: [] }, { type: "git.pull", ref, local, argv: [] }]) {
      expect(await c.request({ ...m, cwd: outside })).toMatchObject({ code: "cwd_not_allowed" });
    }
    expect(await c.request({ type: "git.branch", cwd: webRoot, ref })).toMatchObject({ result: { branch: null } });
    expect(await c.request({ type: "git.push", cwd: webRoot, ref, local, argv: [] })).toMatchObject({ result: { remote: null } });
    expect(await c.request({ type: "git.pull", cwd: webRoot, ref, local, argv: [] })).toMatchObject({ result: { remote: null } });
    expect(await c.request({ type: "git.push", cwd: webRoot, ref, local: "nope", argv: [] })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "git.pull", cwd: webRoot, ref, local: 5, argv: [] })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "git.push", cwd: webRoot, ref, local })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "git.pull", cwd: webRoot, ref, local, argv: [1] })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "git.branch", cwd: webRoot, ref: 7 })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "git.branch", cwd: webRoot, ref: "HEAD" })).toMatchObject({ code: "bad_request" });
  });

  it("answers git.log, git.commit and git.fileAt for a cwd inside the roots only", async () => {
    const c = await client();
    expect(await c.request({ type: "git.log", cwd: webRoot })).toMatchObject({ result: { log: null } });
    for (const type of ["git.log", "git.commit", "git.fileAt"]) expect(await c.request({ type, cwd: join(webRoot, ".."), hash: "a".repeat(40), path: "x" })).toMatchObject({ code: "cwd_not_allowed" });
    const repo = join(webRoot, "gitproj");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", ...a], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "bin"), Buffer.from([0, 1]));
    writeFileSync(join(repo, "t.txt"), "hi\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    const hash = git("rev-parse", "HEAD");
    expect(await c.request({ type: "git.log", cwd: repo })).toMatchObject({ result: { log: { commits: [{ hash, subject: "first" }], more: false } } });
    expect(await c.request({ type: "git.commit", cwd: repo, hash })).toMatchObject({ result: { commit: { hash, files: [{ path: "bin" }, { path: "t.txt", added: 1 }] } } });
    expect(await c.request({ type: "git.fileAt", cwd: repo, hash, path: "t.txt" })).toMatchObject({ result: { content: "hi\n" } });
    expect(await c.request({ type: "git.fileAt", cwd: repo, hash, path: "bin" })).toMatchObject({ code: "binary" });
    expect(await c.request({ type: "git.fileAt", cwd: repo, hash, path: "../x" })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "git.fileAt", cwd: repo, hash, path: "nope" })).toMatchObject({ code: "not_found" });
  });

  describe("submodule folders and gitlink paths (GH-388)", () => {
    /** A repo under webRoot with gitlinks libs/lib and libs/lib.png (never initialised: empty folder). */
    function gitlinkRepo() {
      const repo = join(webRoot, `gl-${randomUUID().slice(0, 8)}`);
      mkdirSync(join(repo, "libs", "lib"), { recursive: true });
      const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", ...a], { cwd: repo, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "t.txt"), "hi\n");
      git("add", ".");
      git("commit", "-q", "-m", "first");
      const id = git("rev-parse", "HEAD");
      for (const p of ["libs/lib", "libs/lib.png"]) git("update-index", "--add", "--cacheinfo", `160000,${id},${p}`);
      git("commit", "-q", "-m", "gitlinks");
      return { repo, hash: git("rev-parse", "HEAD") };
    }

    it("git requests with exact answer only for a repository top; without exact an uninitialised submodule folder answers for the superproject", async () => {
      const c = await client();
      const { repo, hash } = gitlinkRepo();
      const sub = join(repo, "libs", "lib");
      const base = { cwd: sub, exact: true };
      const msgs: Record<string, unknown>[] = [
        { type: "git.status" },
        { type: "git.refs" },
        { type: "git.log" },
        { type: "git.diff", base: "head" },
        { type: "git.commit", hash },
        { type: "git.fileAt", hash, path: "t.txt" },
        { type: "git.fetch" },
        { type: "git.branch", ref: "refs/heads/main" },
        { type: "git.push", ref: "refs/heads/main", local: hash, argv: ["push"] },
        { type: "git.pull", ref: "refs/heads/main", local: hash, argv: ["pull"] },
        { type: "fs.media", hash, path: "x.png" },
      ];
      for (const m of msgs) expect(await c.request({ ...m, ...base }), String(m.type)).toMatchObject({ code: "not_git", message: "Not a repository top" });
      expect(await c.request({ type: "git.status", cwd: repo, exact: true })).toMatchObject({ result: { status: { branch: "main" } } });
      expect(await c.request({ type: "git.diff", cwd: repo, base: "head", exact: true })).toMatchObject({ result: { diff: { prefix: "" } } });
      expect(await c.request({ type: "git.diff", cwd: sub, base: "head" })).toMatchObject({ result: { diff: { prefix: "libs/lib/" } } });
    });

    it("git.fileAt and fs.media {hash} on a gitlink path are bad_request \"Submodule: open its repository\"", async () => {
      const c = await client();
      const { repo, hash } = gitlinkRepo();
      const bad = { code: "bad_request", message: "Submodule: open its repository" };
      expect(await c.request({ type: "git.fileAt", cwd: repo, hash, path: "libs/lib" })).toMatchObject(bad);
      expect(await c.request({ type: "fs.media", cwd: repo, hash, path: "libs/lib.png" })).toMatchObject(bad);
    });
  });

  describe.skipIf(process.platform === "win32")("a .git that leaves the roots (GH-290)", () => {
    /** An outer repository outside the roots with one commit; a project in the roots whose .git is a symlink to it or a gitdir file. */
    const outer = () => {
      const out = realpathSync(mkdtempSync(join(tmpdir(), "gh290-out-")));
      const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", ...a], { cwd, encoding: "utf8" }).trim();
      git(out, "init", "-q", "-b", "main");
      writeFileSync(join(out, "secret.txt"), "secret\n");
      git(out, "add", ".");
      git(out, "commit", "-q", "-m", "outer");
      return { out, hash: git(out, "rev-parse", "HEAD") };
    };
    for (const kind of ["symlink", "gitdir file"]) {
      it(`refuses every git request of a project whose .git is a ${kind} to a repository outside the roots`, async () => {
        const { out, hash } = outer();
        const proj = join(webRoot, `gh290-${kind.replace(" ", "-")}`);
        mkdirSync(proj, { recursive: true });
        if (kind === "symlink") symlinkSync(join(out, ".git"), join(proj, ".git"));
        else writeFileSync(join(proj, ".git"), `gitdir: ${join(out, ".git")}\n`);
        const c = await client();
        expect(await c.request({ type: "git.status", cwd: proj })).toMatchObject({ result: { status: null } });
        expect(await c.request({ type: "git.refs", cwd: proj })).toMatchObject({ result: { refs: null } });
        for (const type of ["git.log", "git.commit", "git.fileAt"]) expect(await c.request({ type, cwd: proj, hash, path: "secret.txt" })).toMatchObject({ code: "cwd_not_allowed" });
        expect(await c.request({ type: "git.diff", cwd: proj, base: "head" })).toMatchObject({ code: "cwd_not_allowed" });
        expect(await c.request({ type: "worktree.create", cwd: proj, name: "x" })).toMatchObject({ code: "cwd_not_allowed" });
        expect(await c.request({ type: "worktree.status", cwd: proj, path: proj })).toMatchObject({ code: "cwd_not_allowed" });
        expect(await c.request({ type: "worktree.remove", cwd: proj, path: proj })).toMatchObject({ code: "cwd_not_allowed" });
      });
    }

    it("git.status is null for a project without .git below a repository outside the roots (GH-282)", async () => {
      const { out } = outer();
      const root = join(out, "sub");
      mkdirSync(join(root, "proj"), { recursive: true });
      const d = createDaemon({ webRoot, token, roots: [root], query: fakeQuery as never });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      try {
        const c = await client((d.address() as AddressInfo).port);
        expect(await c.request({ type: "git.status", cwd: join(root, "proj") })).toMatchObject({ result: { status: null } });
      } finally {
        d.close();
      }
    });

    it("a .git file without a gitdir line: git.status is null, git.log refused (GH-282)", async () => {
      const proj = join(webRoot, "gh282-nogitdir");
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, ".git"), "nonsense\n");
      const c = await client();
      expect(await c.request({ type: "git.status", cwd: proj })).toMatchObject({ result: { status: null } });
      expect(await c.request({ type: "git.log", cwd: proj })).toMatchObject({ code: "cwd_not_allowed" });
    });

    it("git.refs is null for a project without .git below a repository outside the roots", async () => {
      const { out } = outer();
      // The root itself lies inside the outer repository; the project has no .git of its own.
      const root = join(out, "sub");
      mkdirSync(join(root, "proj"), { recursive: true });
      const d = createDaemon({ webRoot, token, roots: [root], query: fakeQuery as never });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      try {
        const c = await client((d.address() as AddressInfo).port);
        expect(await c.request({ type: "git.refs", cwd: join(root, "proj") })).toMatchObject({ result: { refs: null } });
      } finally {
        d.close();
      }
    });

    it("session.list lists no worktrees for a project whose main repository is outside the roots", async () => {
      const { out } = outer();
      const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", ...a], { cwd, encoding: "utf8" }).trim();
      const root = realpathSync(mkdtempSync(join(tmpdir(), "gh290-list-")));
      const linked = join(root, "linked");
      git(out, "worktree", "add", "-q", "-b", "l", linked);
      const d = createDaemon({
        webRoot,
        token,
        roots: [root],
        query: fakeQuery as never,
        projects: added(linked),
        history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
      });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      try {
        const c = await client((d.address() as AddressInfo).port);
        const r = ((await c.request({ type: "session.list" })) as { result: { worktrees: Record<string, unknown[]> } }).result;
        expect(r.worktrees[linked] ?? []).toEqual([]);
      } finally {
        d.close();
      }
    });

    it("a linked worktree of a repository inside the roots still works; one whose main repository is outside is refused", async () => {
      const { out } = outer();
      const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", ...a], { cwd, encoding: "utf8" }).trim();
      const main = join(webRoot, "gh290-main");
      mkdirSync(main, { recursive: true });
      git(main, "init", "-q", "-b", "main");
      git(main, "commit", "-q", "--allow-empty", "-m", "in");
      git(main, "worktree", "add", "-q", "-b", "w", join(main, ".claude", "worktrees", "w"));
      const c = await client();
      expect(await c.request({ type: "git.status", cwd: join(main, ".claude", "worktrees", "w") })).toMatchObject({ result: { status: { branch: "w" } } });
      expect(await c.request({ type: "git.log", cwd: join(main, ".claude", "worktrees", "w") })).toMatchObject({ result: { log: { commits: [{ subject: "in" }] } } });
      // Main repository outside the roots, linked worktree inside.
      git(out, "worktree", "add", "-q", "-b", "o", join(webRoot, "zz290x"));
      expect(await c.request({ type: "git.status", cwd: join(webRoot, "zz290x") })).toMatchObject({ result: { status: null } });
      expect(await c.request({ type: "git.log", cwd: join(webRoot, "zz290x") })).toMatchObject({ code: "cwd_not_allowed" });
    });
  });

  it("answers git.diff for a cwd inside the roots only", async () => {
    const c = await client();
    expect(await c.request({ type: "git.diff", cwd: webRoot, base: "head" })).toMatchObject({ result: { diff: null } });
    expect(await c.request({ type: "git.diff", cwd: join(webRoot, ".."), base: "head" })).toMatchObject({ code: "cwd_not_allowed" });
    const repo = join(webRoot, "diffproj");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", ...a], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "t.txt"), "hi\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    writeFileSync(join(repo, "t.txt"), "hi\nthere\n");
    expect(await c.request({ type: "git.diff", cwd: repo, base: "head" })).toMatchObject({ result: { diff: { prefix: "", files: [{ path: "t.txt", status: "M", added: 1, removed: 0 }] } } });
    expect(await c.request({ type: "git.diff", cwd: repo, base: "nope" })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "git.diff", cwd: repo, base: "branch", ref: "refs/heads/zzz" })).toMatchObject({ code: "bad_request" });
  });

  it("does not offer a symlink whose real path is outside the roots as an @-mention", async () => {
    // Junctions on Windows: a directory symlink needs admin rights there (the type is ignored elsewhere).
    symlinkSync(mkdtempSync(join(tmpdir(), "outside-")), join(webRoot, "linkedout"), "junction");
    symlinkSync(join(webRoot, "proj"), join(webRoot, "linkedin"), "junction");
    const c = await client();
    expect(await c.request({ type: "fs.search", cwd: webRoot, query: "linked" })).toMatchObject({ result: { paths: ["linkedin"] } });
  });

  it("two consecutive saves with the returned mtime both succeed (GH-282)", async () => {
    const file = join(webRoot, "proj", "twice.txt");
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    writeFileSync(file, "one");
    const c = await client();
    const read = (await c.request({ type: "fs.read", path: file })) as { result: { mtime: number } };
    const w1 = (await c.request({ type: "fs.write", path: file, content: "two", baseMtime: read.result.mtime })) as { result: { mtime: number } };
    expect(w1.result.mtime).toBe(statSync(file).mtimeMs);
    expect(await c.request({ type: "fs.write", path: file, content: "three", baseMtime: w1.result.mtime })).toMatchObject({ result: {} });
    expect(readFileSync(file, "utf8")).toBe("three");
  });

  it("fs.write keeps the inode, leaves no tail bytes, and refuses a directory (GH-282)", async () => {
    const file = join(webRoot, "proj", "w.txt");
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    writeFileSync(file, "long content here");
    const ino = statSync(file).ino;
    const c = await client();
    await c.request({ type: "fs.write", path: file, content: "short" });
    expect(readFileSync(file, "utf8")).toBe("short");
    expect(statSync(file).ino).toBe(ino);
    expect(await c.request({ type: "fs.write", path: join(webRoot, "proj"), content: "x" })).toMatchObject({ code: "not_a_file" });
  });

  describe("file tree operations (GH-360)", () => {
    const base = join(webRoot, "ops");
    mkdirSync(base, { recursive: true });
    let k = 0;
    const fresh = () => {
      const d = join(base, `c${k++}`);
      mkdirSync(d);
      return realpathSync(d);
    };
    const outsideDir = () => {
      const o = mkdtempSync(join(tmpdir(), "ops-outside-"));
      writeFileSync(join(o, "secret.txt"), "outside secret");
      return o;
    };

    it("GH-360: creates a file and a folder inside the roots, refuses an existing name", async () => {
      const d = fresh();
      const c = await client();
      expect(await c.request({ type: "fs.create", path: join(d, "a.txt") })).toMatchObject({ result: { path: join(d, "a.txt") } });
      expect(await c.request({ type: "fs.create", path: join(d, "sub"), dir: true })).toMatchObject({ result: { path: join(d, "sub") } });
      expect(statSync(join(d, "a.txt")).size).toBe(0);
      expect(statSync(join(d, "sub")).isDirectory()).toBe(true);
      expect(await c.request({ type: "fs.create", path: join(d, "a.txt") })).toMatchObject({ code: "exists" });
    });

    it("GH-360: refuses a parent outside the roots and a bad name", async () => {
      const d = fresh();
      const o = outsideDir();
      const c = await client();
      for (const type of ["fs.create", "fs.delete", "fs.duplicate"] as const) {
        expect(await c.request({ type, path: join(o, "secret.txt") }), type).toMatchObject({ code: "path_not_allowed" });
      }
      expect(await c.request({ type: "fs.rename", path: join(o, "secret.txt"), name: "x" })).toMatchObject({ code: "path_not_allowed" });
      expect(readFileSync(join(o, "secret.txt"), "utf8")).toBe("outside secret");
      expect(existsSync(join(o, "x"))).toBe(false);
      expect(await c.request({ type: "fs.create", path: `${d}${sep}..` })).toMatchObject({ code: "bad_name" });
      writeFileSync(join(d, "f"), "");
      for (const name of ["a/b", "..", ".", "", "a\\b"]) expect(await c.request({ type: "fs.rename", path: join(d, "f"), name }), name).toMatchObject({ code: "bad_name" });
      expect(await c.request({ type: "fs.rename", path: join(d, "f") })).toMatchObject({ code: "bad_name" });
      expect(existsSync(join(d, "f"))).toBe(true);
    });

    it.runIf(posix)("GH-360: a dangling link to the outside counts as existing; nothing is created outside", async () => {
      const d = fresh();
      const o = outsideDir();
      symlinkSync(join(o, "new.txt"), join(d, "ln"));
      const c = await client();
      expect(await c.request({ type: "fs.create", path: join(d, "ln") })).toMatchObject({ code: "exists" });
      expect(existsSync(join(o, "new.txt"))).toBe(false);
    });

    it("GH-360: renames inside a folder; an existing name is refused and both stay", async () => {
      const d = fresh();
      writeFileSync(join(d, "a.txt"), "a");
      writeFileSync(join(d, "b.txt"), "b");
      const c = await client();
      expect(await c.request({ type: "fs.rename", path: join(d, "a.txt"), name: "b.txt" })).toMatchObject({ code: "exists" });
      expect(readFileSync(join(d, "a.txt"), "utf8") + readFileSync(join(d, "b.txt"), "utf8")).toBe("ab");
      expect(await c.request({ type: "fs.rename", path: join(d, "a.txt"), name: "A.txt" })).toMatchObject({ result: { path: join(d, "A.txt") } });
      expect(readdirSync(d).sort()).toEqual(["A.txt", "b.txt"]);
      expect(await c.request({ type: "fs.rename", path: join(d, "gone.txt"), name: "z" })).toMatchObject({ code: "not_found" });
    });

    it("GH-360: a root cannot be renamed or deleted; a folder holding a live session cwd is in use", async () => {
      const d = fresh();
      mkdirSync(join(d, "work/deep"), { recursive: true });
      const c = await client();
      expect(await c.request({ type: "fs.rename", path: webRoot, name: "x" })).toMatchObject({ code: "root_protected" });
      expect(await c.request({ type: "fs.delete", path: webRoot })).toMatchObject({ code: "root_protected" });
      expect(await c.request({ type: "fs.delete", path: realpathSync(webRoot) })).toMatchObject({ code: "root_protected" });
      const created = await c.request({ type: "session.create", cwd: join(d, "work/deep") });
      expect(created).toMatchObject({ type: "reply" });
      expect(await c.request({ type: "fs.delete", path: join(d, "work") })).toMatchObject({ code: "in_use" });
      expect(await c.request({ type: "fs.rename", path: join(d, "work"), name: "w2" })).toMatchObject({ code: "in_use" });
      expect(await c.request({ type: "fs.delete", path: join(d, "work"), dryRun: true })).toMatchObject({ code: "in_use" });
      expect(existsSync(join(d, "work/deep"))).toBe(true);
    });

    it.runIf(posix)("GH-360: a folder holding a running terminal's cwd cannot be deleted or renamed", async () => {
      const d = fresh();
      mkdirSync(join(d, "tw"));
      const c = await client();
      expect(await c.request({ type: "terminal.create", cwd: join(d, "tw"), cols: 80, rows: 24 })).toMatchObject({ type: "reply" });
      for (const m of [{ type: "fs.delete", path: join(d, "tw") }, { type: "fs.rename", path: join(d, "tw"), name: "tw2" }])
        expect(await c.request(m), m.type).toMatchObject({ code: "in_use" });
      expect(existsSync(join(d, "tw"))).toBe(true);
    });

    it.runIf(posix)("GH-360: deleting a link, or a folder holding a link, leaves the outside folder intact", async () => {
      const d = fresh();
      const o = outsideDir();
      symlinkSync(o, join(d, "ln"));
      mkdirSync(join(d, "sub"));
      symlinkSync(o, join(d, "sub/ln2"));
      const c = await client();
      expect(await c.request({ type: "fs.delete", path: join(d, "ln") })).toMatchObject({ result: { files: 0, folders: 0 } });
      expect(existsSync(join(d, "ln"))).toBe(false);
      expect(await c.request({ type: "fs.delete", path: join(d, "sub") })).toMatchObject({ result: { files: 1, folders: 0 } });
      expect(existsSync(join(d, "sub"))).toBe(false);
      expect(readFileSync(join(o, "secret.txt"), "utf8")).toBe("outside secret");
    });

    it("GH-360: dryRun counts and removes nothing; the real delete returns the same count", async () => {
      const d = fresh();
      mkdirSync(join(d, "t/a"), { recursive: true });
      writeFileSync(join(d, "t/f1"), "");
      writeFileSync(join(d, "t/a/f2"), "");
      const c = await client();
      expect(await c.request({ type: "fs.delete", path: join(d, "t"), dryRun: true })).toMatchObject({ result: { files: 2, folders: 1 } });
      expect(existsSync(join(d, "t/a/f2"))).toBe(true);
      expect(await c.request({ type: "fs.delete", path: join(d, "t") })).toMatchObject({ result: { files: 2, folders: 1 } });
      expect(existsSync(join(d, "t"))).toBe(false);
      expect(await c.request({ type: "fs.delete", path: join(d, "t") })).toMatchObject({ code: "not_found" });
    });

    it("GH-360: duplicates a file as 'x copy.txt', then 'x copy 2.txt'; a folder is refused", async () => {
      const d = fresh();
      writeFileSync(join(d, "x.txt"), "content");
      mkdirSync(join(d, "dir"));
      const c = await client();
      expect(await c.request({ type: "fs.duplicate", path: join(d, "x.txt") })).toMatchObject({ result: { path: join(d, "x copy.txt") } });
      expect(await c.request({ type: "fs.duplicate", path: join(d, "x.txt") })).toMatchObject({ result: { path: join(d, "x copy 2.txt") } });
      expect(readFileSync(join(d, "x copy 2.txt"), "utf8")).toBe("content");
      expect(await c.request({ type: "fs.duplicate", path: join(d, "dir") })).toMatchObject({ code: "not_a_file" });
    });

    it.runIf(posix)("GH-360: duplicating a link to a file outside the roots is refused", async () => {
      const d = fresh();
      const o = outsideDir();
      symlinkSync(join(o, "secret.txt"), join(d, "ln"));
      const c = await client();
      const reply = await c.request({ type: "fs.duplicate", path: join(d, "ln") });
      expect(reply).toMatchObject({ code: "not_a_file" });
      expect(readdirSync(d)).toEqual(["ln"]);
    });

    it("GH-360: refuses a UNC path on Windows with no file system call", async () => {
      const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
      const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
      const native = vi.spyOn(fs.realpathSync, "native");
      const exists = vi.spyOn(fs, "existsSync");
      syncBuiltinESMExports();
      const c = await client();
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        for (const type of ["fs.create", "fs.rename", "fs.delete", "fs.duplicate"]) {
          for (const path of ["\\\\evil\\s\\x", "//evil/s/x", "\\\\.host\\s\\x"]) {
            native.mockClear();
            exists.mockClear();
            expect(await c.request({ type, path, name: "y" }), `${type} ${path}`).toMatchObject({ type: "error" });
            expect(native, `${type} ${path}`).not.toHaveBeenCalled();
            expect(exists, `${type} ${path}`).not.toHaveBeenCalled();
          }
        }
      } finally {
        Object.defineProperty(process, "platform", orig);
        native.mockRestore();
        exists.mockRestore();
        syncBuiltinESMExports();
      }
    });
  });

  it.skipIf(!posix)("fs.read and fs.write refuse a folder swapped for a symlink between the root check and the open (GH-282)", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "outside-"));
    const outside = join(outsideDir, "f.txt");
    writeFileSync(outside, "outside secret");
    for (const type of ["fs.read", "fs.write"] as const) {
      const dir = join(webRoot, `swap-${type}`);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "f.txt");
      writeFileSync(file, "inside");
      const real = vi.mocked(openChecked).getMockImplementation()!;
      // allowed() already passed for `file`; now the folder becomes a link to the outside folder.
      vi.mocked(openChecked).mockImplementationOnce((path, flags) => {
        rmSync(dir, { recursive: true });
        symlinkSync(outsideDir, dir);
        return real(path, flags);
      });
      const c = await client();
      const reply = await c.request({ type, path: file, content: "overwritten" });
      expect(reply, type).toMatchObject({ code: "path_not_allowed" });
      expect(JSON.stringify(reply), type).not.toContain("outside secret");
      expect(readFileSync(outside, "utf8"), type).toBe("outside secret");
    }
  });

  it("fs.read refuses a UNC path on Windows with no file system call (GH-282)", async () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    // The CommonJS fs object: spying there and syncing makes the daemon's named imports call the spy.
    const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
    const native = vi.spyOn(fs.realpathSync, "native");
    const exists = vi.spyOn(fs, "existsSync");
    syncBuiltinESMExports();
    const c = await client();
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      for (const path of ["\\\\evil\\s\\x", "//evil/s/x", "\\\\.host\\s\\x"]) {
        native.mockClear();
        exists.mockClear();
        expect(await c.request({ type: "fs.read", path }), path).toMatchObject({ code: "path_not_allowed" });
        expect(native, path).not.toHaveBeenCalled();
        expect(exists, path).not.toHaveBeenCalled();
      }
    } finally {
      Object.defineProperty(process, "platform", orig);
      native.mockRestore();
      exists.mockRestore();
      syncBuiltinESMExports();
    }
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
    // A symlink inside a root pointing outside it is outside. Windows: a junction to its folder (a file symlink needs admin rights).
    const link = posix ? join(webRoot, "proj", "link.txt") : join(webRoot, "proj", "linkdir", "secret.txt");
    symlinkSync(posix ? outside : dirname(outside), posix ? link : dirname(link), posix ? "file" : "junction");
    expect(await c.request({ type: "fs.read", path: link })).toMatchObject({
      code: "path_not_allowed",
    });
    expect(await c.request({ type: "fs.read", path: join(webRoot, "proj") })).toMatchObject({ code: "not_a_file" });
    writeFileSync(join(webRoot, "proj", "bin"), Buffer.from([1, 0, 2]));
    expect(await c.request({ type: "fs.read", path: join(webRoot, "proj", "bin") })).toMatchObject({ code: "binary" });
  });

  it("fs.read: binary, too large, UTF-16 and invalid UTF-8 files fail with their own code and the size; empty and just-under-limit files read", async () => {
    const dir = join(webRoot, "proj");
    mkdirSync(dir, { recursive: true });
    const put = (name: string, data: Buffer) => (writeFileSync(join(dir, name), data), join(dir, name));
    const MAX = 2 * 1024 * 1024;
    const png = put("a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]));
    const utf16 = put("u16.txt", Buffer.from("\ufeffhi", "utf16le"));
    const utf16be = put("u16be.txt", Buffer.from([0xfe, 0xff, 0, 0x68]));
    const bad = put("bad.txt", Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x20]));
    const over = put("over.bin", Buffer.alloc(MAX + 1, 0x61));
    const overBinary = put("over.zip", Buffer.alloc(MAX + 1, 0));
    const under = put("under.txt", Buffer.alloc(MAX, 0x61));
    const empty = put("empty", Buffer.alloc(0));
    const c = await client();
    expect(await c.request({ type: "fs.read", path: png })).toMatchObject({ code: "binary", size: 12 });
    expect(await c.request({ type: "fs.read", path: utf16 })).toMatchObject({ code: "not_utf8", size: 6 });
    expect(await c.request({ type: "fs.read", path: utf16be })).toMatchObject({ code: "not_utf8", size: 4 });
    expect(await c.request({ type: "fs.read", path: bad })).toMatchObject({ code: "not_utf8", size: 5 });
    expect(await c.request({ type: "fs.read", path: over })).toMatchObject({ code: "too_large", size: MAX + 1 });
    expect(await c.request({ type: "fs.read", path: overBinary })).toMatchObject({ code: "too_large", size: MAX + 1 });
    expect(await c.request({ type: "fs.read", path: under })).toMatchObject({ result: { content: "a".repeat(MAX) } });
    expect(await c.request({ type: "fs.read", path: empty })).toMatchObject({ result: { content: "" } });
    // The daemon still answers on the same and on a new connection.
    expect(await c.request({ type: "session.create", cwd: "/nonexistent" })).toMatchObject({ code: "bad_cwd" });
    expect(await (await client()).request({ type: "fs.read", path: empty })).toMatchObject({ result: { content: "" } });
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
    console.log("A");
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

  it("lists the sessions of an added project's git worktrees and reports the worktrees; one outside the roots is marked and refuses new sessions", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wtroot-")));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "wtout-")));
    const repo = join(root, "repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    mkdirSync(repo);
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", "-b", "feat", join(root, "wt-in"));
    git("worktree", "add", "-q", "-b", "far", join(elsewhere, "wt-out"));
    const transcripts = [
      { sessionId: "5b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", summary: "in the worktree", lastModified: 2000, cwd: join(root, "wt-in") },
      { sessionId: "6b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", summary: "in the main checkout", lastModified: 1000, cwd: repo },
    ];
    const d = createDaemon({
      webRoot,
      token,
      roots: [root],
      query: fakeQuery as never,
      projects: added(repo),
      history: { listSessions: (async () => transcripts) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      type L = { result: { sessions: { id: string }[]; projects: string[]; recentProjects: unknown[]; worktrees: Record<string, unknown> } };
      const list = (await c.request({ type: "session.list" })) as L;
      expect(list.result.sessions.map((s) => s.id)).toEqual(transcripts.map((t) => t.sessionId));
      expect(list.result.recentProjects).toEqual([]);
      expect(list.result.worktrees).toEqual({
        [repo]: [
          { path: repo, branch: "main", main: true },
          { path: join(elsewhere, "wt-out"), branch: "far", main: false, outsideRoots: true },
          { path: join(root, "wt-in"), branch: "feat", main: false },
        ],
      });
      expect(await c.request({ type: "session.create", cwd: join(elsewhere, "wt-out") })).toMatchObject({ code: "cwd_not_allowed" });
      // A session started in a worktree shows under its project: the worktree is not added as a project of its own.
      expect(await c.request({ type: "session.create", cwd: join(root, "wt-in") })).toMatchObject({ result: { session: { cwd: join(root, "wt-in") } } });
      expect(((await c.request({ type: "session.list" })) as L).result.projects).toEqual([repo]);
    } finally {
      d.close();
    }
  });

  /** A repository at `<root>/repo` with one commit, added as the only project of a daemon whose transcripts are `listed`. */
  const repoDaemon = async (prefix: string, listed: unknown[] = []) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    const repo = join(root, "repo");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const projects = added(repo);
    const d = createDaemon({
      webRoot,
      token,
      roots: [root],
      query: fakeQuery as never,
      projects,
      history: { listSessions: (async () => listed) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const c = await client((d.address() as AddressInfo).port);
    type L = { result: { projects: string[]; worktrees: Record<string, { path: string; branch?: string }[]>; sessions: { id: string }[] } };
    const list = async () => {
      const r = ((await c.request({ type: "session.list" })) as L).result;
      return { projects: r.projects, worktrees: r.worktrees[repo]?.map((w) => `${w.path}@${w.branch}`) ?? [], sessions: r.sessions.map((s) => s.id) };
    };
    return { root, repo, git, projects, d, c, list };
  };

  it("session.list shows a worktree added or removed from a terminal, and a branch checkout, on the very next list", async () => {
    const listed: unknown[] = [];
    const { root, repo, git, d, list } = await repoDaemon("wtstamp-", listed);
    try {
      const wt = join(root, "wt-outside");
      expect((await list()).worktrees).toEqual([`${repo}@main`]);
      git(repo, "worktree", "add", "-q", "-b", "outside", wt);
      // A session in it (from the CLI) shows at once too: it is a worktree of the project.
      listed.push({ sessionId: "11111111-2222-4333-8444-555555555555", summary: "in wt", lastModified: Date.now(), cwd: wt });
      expect(await list()).toMatchObject({ worktrees: [`${repo}@main`, `${wt}@outside`], sessions: ["11111111-2222-4333-8444-555555555555"] });
      git(repo, "checkout", "-q", "-b", "renamed-main");
      git(wt, "checkout", "-q", "-b", "renamed-outside");
      expect((await list()).worktrees).toEqual([`${repo}@renamed-main`, `${wt}@renamed-outside`]);
      // A move renames the folder and rewrites only the path in .git/worktrees/<name>/gitdir.
      const moved = join(root, "wt-moved");
      git(repo, "worktree", "move", wt, moved);
      expect((await list()).worktrees).toEqual([`${repo}@renamed-main`, `${moved}@renamed-outside`]);
      git(repo, "worktree", "remove", moved);
      expect(await list()).toMatchObject({ worktrees: [`${repo}@renamed-main`], sessions: [] });
    } finally {
      d.close();
    }
  });

  it("session.list reuses a project's git worktree list while its git files are unchanged; worktree.create and remove show at once", async () => {
    const { repo, git, d, c, list } = await repoDaemon("wtcache-");
    try {
      expect((await list()).worktrees).toEqual([`${repo}@main`]);
      const reads = vi.mocked(listWorktrees).mock.calls.filter(([cwd]) => cwd === repo).length;
      expect(reads).toBe(1);
      // Unchanged files: the cached list is answered without a git process (a commit does not touch HEAD).
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "second");
      expect((await list()).worktrees).toEqual([`${repo}@main`]);
      expect((await list()).worktrees).toEqual([`${repo}@main`]);
      expect(vi.mocked(listWorktrees).mock.calls.filter(([cwd]) => cwd === repo).length).toBe(reads);
      const made = join(repo, ".claude", "worktrees", "feat");
      expect(await c.request({ type: "worktree.create", cwd: repo, name: "feat" })).toMatchObject({ result: { path: made } });
      expect((await list()).worktrees.map((w) => w.split("@")[0])).toEqual([repo, made]);
      expect(await c.request({ type: "worktree.remove", cwd: repo, path: made })).toMatchObject({ type: "reply" });
      expect((await list()).worktrees).toEqual([`${repo}@main`]);
    } finally {
      d.close();
    }
  });

  it("a session created in a worktree just made from a terminal does not add the worktree as its own project", async () => {
    const { root, repo, git, projects, d, c, list } = await repoDaemon("wtadd-");
    try {
      expect((await list()).projects).toEqual([repo]);
      const wt = join(root, "wt-fresh");
      git(repo, "worktree", "add", "-q", "-b", "fresh", wt);
      // No list in between: the daemon's last list does not have the worktree.
      expect(await c.request({ type: "session.create", cwd: wt })).toMatchObject({ type: "reply" });
      expect(projects.has(wt)).toBe(false);
      expect(await list()).toMatchObject({ projects: [repo], worktrees: [`${repo}@main`, `${wt}@fresh`] });
    } finally {
      d.close();
    }
  });

  it("a git worktree list that failed is read again on the next session.list, not reused", async () => {
    const { repo, d, list } = await repoDaemon("wtfail-");
    const before = process.env.PATH;
    const restore = () => void (process.env.PATH = before);
    try {
      // git fails without any change to the repository's files (a spawn error): no git on the PATH.
      process.env.PATH = join(repo, "no-such-bin");
      expect((await list()).worktrees).toEqual([]);
      restore();
      expect((await list()).worktrees).toEqual([`${repo}@main`]);
    } finally {
      restore();
      d.close();
    }
  });

  it("worktree.create replies path and branch and broadcasts sessions.changed; the new worktree is listed; bad names and cwds outside the roots are refused", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wtcreate-")));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "wtout-")));
    const repo = join(root, "repo");
    const plain = join(root, "plain");
    mkdirSync(repo);
    mkdirSync(plain);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    const d = createDaemon({
      webRoot,
      token,
      roots: [root],
      query: fakeQuery as never,
      projects: added(repo),
      history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const p = (d.address() as AddressInfo).port;
      const [a, b] = await Promise.all([client(p), client(p)]);
      const path = join(repo, ".claude", "worktrees", "feat");
      expect(await a.request({ type: "worktree.create", cwd: repo, name: "feat" })).toMatchObject({ result: { path, branch: "worktree-feat" } });
      await b.waitFor((m) => m.type === "sessions.changed");
      type L = { result: { worktrees: Record<string, { path: string }[]> } };
      expect(((await a.request({ type: "session.list" })) as L).result.worktrees[repo]!.map((w) => w.path)).toContain(path);
      expect(await a.request({ type: "worktree.create", cwd: repo, name: "a b" })).toMatchObject({ code: "bad_name" });
      expect(await a.request({ type: "worktree.create", cwd: repo, name: "feat" })).toMatchObject({ code: "exists" });
      expect(await a.request({ type: "worktree.create", cwd: elsewhere })).toMatchObject({ code: "cwd_not_allowed" });
      expect(await a.request({ type: "worktree.create", cwd: plain })).toMatchObject({ code: "not_git" });
      expect(await a.request({ type: "worktree.remove", cwd: repo, path: elsewhere })).toMatchObject({ code: "cwd_not_allowed" });
    } finally {
      d.close();
    }
  });

  it("worktree.remove is refused for the main worktree and while a session in it needs input; removes hand-made ones; blocks new sessions and terminals while it runs; then removes and broadcasts", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wtremove-")));
    const repo = join(root, "repo");
    const hand = join(root, "hand");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    execFileSync("git", ["worktree", "add", "-q", "-b", "hand", hand], { cwd: repo });
    const d = createDaemon({
      webRoot,
      token,
      roots: [root],
      query: permissionQuery as never,
      projects: added(repo),
      history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const p = (d.address() as AddressInfo).port;
      const [a, b] = await Promise.all([client(p), client(p)]);
      const { result: made } = (await a.request({ type: "worktree.create", cwd: repo, name: "feat" })) as { result: { path: string } };
      const wt = made.path;
      const { result } = (await a.request({ type: "session.create", cwd: wt })) as { result: { session: { id: string } } };
      const sessionId = result.session.id;
      await a.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await a.request({ type: "session.prompt", sessionId, text: "run tests" });
      const req = (await a.waitFor((m) => m.type === "event" && m.part.type === "permission_request")) as Extract<ServerMessage, { type: "event" }>;
      expect(await a.request({ type: "worktree.remove", cwd: repo, path: wt })).toMatchObject({ code: "has_sessions_running" });
      expect(await a.request({ type: "worktree.remove", cwd: repo, path: repo })).toMatchObject({ code: "not_worktree" });
      expect(await a.request({ type: "worktree.status", cwd: repo, path: wt })).toMatchObject({ result: { safety: "blocked", blocked: "sessions_running", running: 1 } });
      expect(await a.request({ type: "worktree.remove", cwd: repo, path: hand })).toMatchObject({ result: {} });
      expect(existsSync(hand)).toBe(false);
      // A refused removal leaves no block behind.
      expect(await a.request({ type: "session.create", cwd: wt })).toMatchObject({ type: "reply" });
      await a.request({ type: "permission.respond", requestId: (req.part as { requestId: string }).requestId, decision: "deny" });
      for (let i = 0; i < 100; i++) {
        const l = (await a.request({ type: "session.list" })) as { result: { sessions: { id: string; state: string }[] } };
        if (l.result.sessions.find((s) => s.id === sessionId)?.state === "idle") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await a.request({ type: "worktree.status", cwd: repo, path: wt })).toMatchObject({ result: { uncommitted: 0, commits: 0, branch: "worktree-feat", safety: "safe" } });
      // Messages of one connection start in order: while git removes, no session or terminal starts in the worktree.
      const removed = a.request({ type: "worktree.remove", cwd: repo, path: wt });
      expect(await a.request({ type: "session.create", cwd: wt })).toMatchObject({ code: "worktree_removing" });
      expect(await a.request({ type: "terminal.create", cwd: wt, cols: 80, rows: 24 })).toMatchObject({ code: "worktree_removing" });
      expect(await removed).toMatchObject({ result: {} });
      await b.waitFor((m) => m.type === "sessions.changed");
      // A create sent just before the remove passes the first check, then must not leave a live session in the deleted directory.
      const again = (await a.request({ type: "worktree.create", cwd: repo, name: "feat2" })) as { result: { path: string } };
      const early = a.request({ type: "session.create", cwd: again.result.path });
      const late = a.request({ type: "worktree.remove", cwd: repo, path: again.result.path });
      expect(await early).toMatchObject({ code: "worktree_removing" });
      await late;
      const l2 = (await a.request({ type: "session.list" })) as { result: { sessions: { cwd: string }[] } };
      expect(l2.result.sessions.filter((s) => s.cwd === again.result.path)).toEqual([]);
      expect(existsSync(wt)).toBe(false);
      expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
      const l = (await a.request({ type: "session.list" })) as { result: { sessions: { id: string }[] } };
      expect(l.result.sessions.find((s) => s.id === sessionId)).toBeUndefined();
    } finally {
      d.close();
    }
  });

  async function wtDaemon(prefix: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    const d = createDaemon({
      webRoot,
      token,
      roots: [root],
      query: fakeQuery as never,
      projects: added(repo),
      history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    return { root, repo, d, c: await client((d.address() as AddressInfo).port) };
  }

  it("worktree.remove with expectSafe skips a worktree that changed (stale) and keeps it", async () => {
    const { root, repo, d, c } = await wtDaemon("wtstale-");
    try {
      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-q", "-b", "wt", wt], { cwd: repo });
      writeFileSync(join(wt, "new.txt"), "x");
      expect(await c.request({ type: "worktree.remove", cwd: repo, path: wt, expectSafe: true })).toMatchObject({ code: "stale" });
      expect(existsSync(wt)).toBe(true);
      expect(await c.request({ type: "worktree.remove", cwd: repo, path: wt })).toMatchObject({ result: {} });
      expect(existsSync(wt)).toBe(false);
    } finally {
      d.close();
    }
  });

  it.skipIf(process.platform === "win32")("worktree.status and worktree.remove refuse a symlinked path (not_removable)", async () => {
    const { root, repo, d, c } = await wtDaemon("wtlink-");
    try {
      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-q", "-b", "wt", wt], { cwd: repo });
      const link = join(root, "link");
      symlinkSync(wt, link);
      expect(await c.request({ type: "worktree.status", cwd: repo, path: link })).toMatchObject({ code: "not_removable" });
      expect(await c.request({ type: "worktree.remove", cwd: repo, path: link })).toMatchObject({ code: "not_removable" });
      expect(existsSync(wt)).toBe(true);
    } finally {
      d.close();
    }
  });

  it("worktree.remove rejects non-boolean expectSafe/deleteBranch (bad_request)", async () => {
    const { root, repo, d, c } = await wtDaemon("wtbool-");
    try {
      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-q", "-b", "wt", wt], { cwd: repo });
      for (const extra of [{ expectSafe: "yes" }, { deleteBranch: 1 }]) expect(await c.request({ type: "worktree.remove", cwd: repo, path: wt, ...extra } as never)).toMatchObject({ code: "bad_request" });
      expect(existsSync(wt)).toBe(true);
    } finally {
      d.close();
    }
  });

  it("worktree.remove validates expect (bad types and negative counts refused) and answers stale on more work than listed", async () => {
    const { root, repo, d, c } = await wtDaemon("wtexpect-");
    try {
      const wt = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-q", "-b", "wt", wt], { cwd: repo });
      for (const expect_ of ["x", null, { uncommitted: -1, ahead: 0, ignored: 0 }, { uncommitted: "1", ahead: 0, ignored: 0 }, { uncommitted: 0, ahead: 0 }, { uncommitted: 1.5, ahead: 0, ignored: 0 }])
        expect(await c.request({ type: "worktree.remove", cwd: repo, path: wt, expect: expect_ } as never), JSON.stringify(expect_)).toMatchObject({ code: "bad_request" });
      expect(existsSync(wt)).toBe(true);
      writeFileSync(join(wt, "a.txt"), "1");
      writeFileSync(join(wt, "b.txt"), "2");
      expect(await c.request({ type: "worktree.remove", cwd: repo, path: wt, expect: { uncommitted: 1, ahead: 0, ignored: 0 } })).toMatchObject({ code: "stale" });
      expect(existsSync(wt)).toBe(true);
      expect(await c.request({ type: "worktree.remove", cwd: repo, path: wt, expect: { uncommitted: 2, ahead: 0, ignored: 0 } })).toMatchObject({ result: {} });
      expect(existsSync(wt)).toBe(false);
    } finally {
      d.close();
    }
  });

  it.skipIf(process.platform === "win32")("a session.create in an external worktree during its removal gets worktree_removing", async () => {
    const { root, repo, d, c } = await wtDaemon("wtext-");
    const bin = mkdtempSync(join(tmpdir(), "slowgit-"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const started = join(bin, "started");
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *"worktree remove"*) touch ${started}; sleep 1;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    try {
      const wt = join(root, "hand");
      execFileSync("git", ["worktree", "add", "-q", "-b", "hand", wt], { cwd: repo });
      process.env.PATH = `${bin}:${path}`;
      const removed = c.request({ type: "worktree.remove", cwd: repo, path: wt });
      // The hand-made path has no `.claude/worktrees` part: the mark comes from the lock, so wait until git is removing.
      for (let i = 0; i < 100 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(started)).toBe(true);
      expect(await c.request({ type: "session.create", cwd: wt })).toMatchObject({ code: "worktree_removing" });
      expect(await removed).toMatchObject({ result: {} });
    } finally {
      process.env.PATH = path;
      d.close();
    }
  });

  it.skipIf(process.platform === "win32")("restoring a transcript whose cwd is being removed is refused (unknown_session)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wtrestore-")));
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    const id = "7b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
    let cwd = "";
    const d = createDaemon({
      webRoot,
      token,
      roots: [root],
      query: fakeQuery as never,
      projects: added(repo),
      history: { listSessions: (async () => []) as never, getSessionInfo: (async (sid: string) => (sid === id ? { sessionId: id, summary: "old", lastModified: 1, cwd } : undefined)) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    // `git worktree remove` takes a second: the removal is in flight while the directory still exists.
    const bin = mkdtempSync(join(tmpdir(), "slowgit-"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\ncase "$*" in *"worktree remove"*) sleep 1;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    try {
      const c = await client((d.address() as AddressInfo).port);
      cwd = ((await c.request({ type: "worktree.create", cwd: repo, name: "feat" })) as { result: { path: string } }).result.path;
      process.env.PATH = `${bin}:${path}`;
      const removed = c.request({ type: "worktree.remove", cwd: repo, path: cwd });
      expect(await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 })).toMatchObject({ code: "unknown_session" });
      expect(await removed).toMatchObject({ result: {} });
    } finally {
      process.env.PATH = path;
      d.close();
    }
  });

  it("projects that are subfolders of one repository are no worktrees: listed apart, the repository root stays unlisted", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mono-")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", "-b", "feat", join(root, "wt"));
    const [pa, pb] = [join(root, "pa"), join(root, "pb")];
    mkdirSync(pa), mkdirSync(pb);
    const atRoot = { sessionId: "7b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", summary: "at the root", lastModified: 1000, cwd: root };
    const d = createDaemon({
      webRoot,
      token,
      roots: [root],
      query: fakeQuery as never,
      projects: added(pa, pb),
      history: { listSessions: (async () => [atRoot]) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      type L = { result: { sessions: { id: string }[]; projects: string[]; worktrees: Record<string, unknown> } };
      const list = (await c.request({ type: "session.list" })) as L;
      expect(list.result.worktrees).toEqual({});
      expect(list.result.sessions).toEqual([]);
      // A session at the repository root adds it as a project: it is no worktree of pa or pb.
      await c.request({ type: "session.create", cwd: root });
      expect(((await c.request({ type: "session.list" })) as L).result.projects).toContain(root);
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

  it("warmUp lists once when the server starts: the first session.list reuses that scan", async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
    mkdirSync(join(projectsDir, "-p"));
    writeFileSync(join(projectsDir, "-p", "4b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b.jsonl"), "{}\n");
    let scans = 0;
    const make = (warmUp?: boolean) =>
      createDaemon({
        webRoot,
        token,
        roots: [webRoot],
        query: fakeQuery as never,
        projectsDir,
        listCache: true,
        warmUp,
        history: { listSessions: (async () => (scans++, [])) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
      });
    const cold = make();
    await new Promise<void>((r) => cold.listen(0, "127.0.0.1", r));
    await new Promise((r) => setTimeout(r, 100));
    cold.close();
    expect(scans).toBe(0);
    const d = make(true);
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      await vi.waitFor(() => expect(scans).toBe(1));
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "session.list" });
      expect(scans).toBe(1);
    } finally {
      d.close();
    }
  });

  it("the default history scans transcripts in the worker thread, not on the main thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-cfg-"));
    mkdirSync(join(root, "projects"));
    const mark = join(root, "thread-ran");
    const realEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    scanThreadConfig.reset();
    const realScript = scanThreadConfig.script;
    scanThreadConfig.script = `const { parentPort } = require("node:worker_threads"); parentPort.on("message", ({ id }) => { require("node:fs").writeFileSync(${JSON.stringify(mark)}, "x"); parentPort.postMessage({ id, sessions: [] }); });`;
    const d = createDaemon({ webRoot, token, roots: [webRoot], query: fakeQuery as never, claudeDir: root });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "session.list" });
      expect(existsSync(mark)).toBe(true);
    } finally {
      d.close();
      scanThreadConfig.script = realScript;
      scanThreadConfig.reset();
      if (realEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = realEnv;
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

  it("session.list requests that arrive while a list runs share one next list, not one list each", async () => {
    const p = added(webRoot);
    const listProjects = vi.fn(p.list);
    let scans = 0;
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      projects: { ...p, list: listProjects } as never,
      history: { listSessions: (async () => (scans++, await new Promise((r) => setTimeout(r, 100)), [])) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "session.list" });
      listProjects.mockClear();
      const replies = await Promise.all(Array.from({ length: 6 }, () => c.request({ type: "session.list" })));
      expect(replies.every((r) => r.type === "reply")).toBe(true);
      // The first runs; the five that arrived meanwhile get one list that starts after it (it sees what changed before them).
      expect(listProjects).toHaveBeenCalledTimes(2);
    } finally {
      d.close();
    }
  });

  it("does not open a transcript again for its last message time while the scan reports the same mtime and size", async () => {
    const id = "7b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
    const cwd = join(webRoot, "stamp proj");
    mkdirSync(cwd, { recursive: true });
    const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
    const dir = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir);
    const file = join(dir, `${id}.jsonl`);
    const write = (at: string) => writeFileSync(file, JSON.stringify({ type: "user", timestamp: at }) + "\n");
    write("2026-10-01T10:00:05.000Z");
    const size = statSync(file).size;
    const t = { sessionId: id, summary: "s", lastModified: 9_000, fileSize: size, cwd };
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      projectsDir,
      projects: added(cwd),
      history: { listSessions: (async () => [t]) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const at = async () => ((await c.request({ type: "session.list" })) as { result: { sessions: { lastActivity: number }[] } }).result.sessions[0]!.lastActivity;
      expect(await at()).toBe(Date.parse("2026-10-01T10:00:05.000Z"));
      // Same length, other time: the file is not read while the scan reports the same mtime and size.
      write("2026-10-01T10:00:09.000Z");
      expect(statSync(file).size).toBe(size);
      expect(await at()).toBe(Date.parse("2026-10-01T10:00:05.000Z"));
      t.lastModified = 9_500;
      expect(await at()).toBe(Date.parse("2026-10-01T10:00:09.000Z"));
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

  it("settings.get / settings.set: a patch changes only its fields, other clients hear settings_changed, an invalid value is refused", async () => {
    const d = createDaemon({ webRoot, token, roots: [webRoot], query: fakeQuery as never });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const port = (d.address() as AddressInfo).port;
      const c = await client(port);
      const other = await client(port);
      expect(await c.request({ type: "settings.get" })).toMatchObject({ result: { settings: { orchestration: { enabled: false, workerCap: 4 } } } });
      expect(await c.request({ type: "settings.set", patch: { orchestration: { workerCap: 6 } } })).toMatchObject({ result: { settings: { orchestration: { enabled: false, workerCap: 6 } } } });
      await other.waitFor((m) => m.type === "settings_changed" && m.settings.orchestration.workerCap === 6);
      expect(await c.request({ type: "settings.set", patch: { orchestration: { workerCap: 21 } } })).toMatchObject({ code: "bad_settings" });
    } finally {
      d.close();
    }
  });

  it("settings.get and settings.set replies name the daemon's host, and say when desktop notifications were turned off at start (GH-158)", async () => {
    const run = async (extra: object) => {
      const d = createDaemon({ webRoot, token, roots: [webRoot], query: fakeQuery as never, ...extra });
      await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
      try {
        const c = await client((d.address() as AddressInfo).port);
        const got = await c.request({ type: "settings.get" });
        const set = await c.request({ type: "settings.set", patch: { notifications: { desktop: false } } });
        return [got, set];
      } finally {
        d.close();
      }
    };
    const [got, set] = await run({ host: "box" });
    expect(got).toMatchObject({ result: { settings: { notifications: { desktop: true } }, daemon: { host: "box" } } });
    expect((got as { result: { daemon: object } }).result.daemon).not.toHaveProperty("desktopForcedOff");
    expect(set).toMatchObject({ result: { settings: { notifications: { desktop: false } }, daemon: { host: "box" } } });
    expect(got).toMatchObject({ result: { daemon: {} } });
    expect((got as { result: { daemon: object } }).result.daemon).not.toHaveProperty("version");
    const [versioned] = await run({ host: "box", buildInfo: { version: "9.8.7", stale: () => undefined } });
    expect(versioned).toMatchObject({ result: { daemon: { host: "box", version: "9.8.7" } } });
    const [forced] = await run({ host: "box", desktopForcedOff: true });
    expect(forced).toMatchObject({ result: { daemon: { host: "box", desktopForcedOff: true } } });
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

    it("session.ids names every session inside the roots, of added projects or not, and none outside", async () => {
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
        const r = (await x.c.request({ type: "session.ids" })) as { result: { ids: string[] } };
        expect([...r.result.ids].sort()).toEqual([sid(1), sid(2), sid(3)]);
        expect((await list(x.c)).sessions).toEqual([]);
      } finally {
        x.d.close();
      }
    });

    it("session.ids names a live session that has no transcript yet", async () => {
      const x = await start([], createProjects());
      try {
        const created = (await x.c.request({ type: "session.create", cwd: cwdOf("live") })) as { result: { session: { id: string } } };
        const r = (await x.c.request({ type: "session.ids" })) as { result: { ids: string[] } };
        expect(r.result.ids).toEqual([created.result.session.id]);
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
    const uploads = join(mkdtempSync(join(tmpdir(), "up-")), "uploads");
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: permissionQuery as never,
      projects: added(cwd),
      uploadDir: uploads,
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
      const up = (sid: string) => a.request({ type: "fs.upload", name: "f.txt", data: "aGk=", sessionId: sid });
      await up(live);
      await up(id);
      expect(existsSync(join(uploads, id))).toBe(true);
      expect(await a.request({ type: "session.delete", sessionId: live })).toMatchObject({ code: "session_running" });
      expect(existsSync(join(uploads, live))).toBe(true);
      // Never prompted into a transcript (fake history): it has nothing to rename.
      expect(await a.request({ type: "session.rename", sessionId: live, title: "x" })).toMatchObject({ code: "rename_failed" });

      expect(await a.request({ type: "session.delete", sessionId: id })).toMatchObject({ type: "reply" });
      expect(mutations.at(-1)).toEqual(["delete", id, { dir: cwd }]);
      expect(existsSync(join(uploads, id))).toBe(false);
      expect(existsSync(join(uploads, live))).toBe(true);
      await b.waitFor((m) => m.type === "sessions.changed" && m.deleted === id);
      expect((await listed()).map((s) => s.id)).toEqual([live]);
      expect(await a.request({ type: "session.delete", sessionId: id })).toMatchObject({ code: "unknown_session" });
    } finally {
      d.close();
    }
  });

  it("session.ids leaves out a session whose delete is in progress", async () => {
    const id = "5c2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5c";
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
      const ids = async () => ((await b.request({ type: "session.ids" })) as { result: { ids: string[] } }).result.ids;
      expect(await ids()).toEqual([id]);
      const deleted = a.request({ type: "session.delete", sessionId: id });
      await new Promise((r) => setTimeout(r, 20));
      expect(await ids()).toEqual([]);
      release();
      await deleted;
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
      // The transcript still exists while the delete runs: only the deleting guard refuses an upload now.
      expect(await b.request({ type: "fs.upload", name: "late.txt", data: "aGk=", sessionId: id })).toMatchObject({ code: "unknown_session" });
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

describe("/clear", () => {
  it("subscribing to the session a /clear went on in replies 'New session' without reading its transcript", async () => {
    const leak = (id: string) => [{ type: "user", uuid: randomUUID(), session_id: id, message: { role: "user", content: "leaked prompt" }, parent_tool_use_id: null, parent_agent_id: null }];
    const born = new Set<string>();
    const getSessionInfo = vi.fn(async (id: string) => (born.has(id) ? { sessionId: id, summary: "/clear", cwd: webRoot } : undefined));
    const getSessionMessages = vi.fn(async (id: string) => (born.has(id) ? leak(id) : []));
    const d = createDaemon({ webRoot, roots: [webRoot], query: clearQuery as never, token, settingsFile: join(mkdtempSync(join(tmpdir(), "cfg-")), "sessions.json"), history: { listSessions: (async () => []) as never, getSessionInfo: getSessionInfo as never, getSessionMessages: getSessionMessages as never } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const { result } = (await c.request({ type: "session.create", cwd: webRoot, model: "haiku" })) as { result: { session: { id: string } } };
      const old = result.session.id;
      await c.request({ type: "session.subscribe", sessionId: old, sinceSeq: 0 });
      await c.request({ type: "session.prompt", sessionId: old, text: "hi" });
      await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
      await c.request({ type: "session.prompt", sessionId: old, text: "/clear" });
      const cleared = (await c.waitFor((m) => m.type === "event" && m.part.type === "session_cleared")) as Extract<ServerMessage, { type: "event" }>;
      const next = (cleared.part as { sessionId: string }).sessionId;
      born.add(next);
      getSessionInfo.mockClear();
      getSessionMessages.mockClear();
      expect(await c.request({ type: "session.subscribe", sessionId: next, sinceSeq: 0 })).toMatchObject({ result: { session: { id: next }, title: "New session" } });
      expect(getSessionInfo.mock.calls.some((a) => (a as unknown[])[0] === next)).toBe(false);
    } finally {
      d.close();
    }
  });

  it("session.list titles a live /clear heir 'New session' without reading its transcript", async () => {
    const leak = (id: string) => [{ type: "user", uuid: randomUUID(), session_id: id, message: { role: "user", content: "leaked prompt" }, parent_tool_use_id: null, parent_agent_id: null }];
    const getSessionMessages = vi.fn(async (id: string) => (born.has(id) ? leak(id) : []));
    const born = new Set<string>();
    let listed = "";
    const d = createDaemon({ webRoot, roots: [webRoot], projects: added(webRoot), query: clearQuery as never, token, settingsFile: join(mkdtempSync(join(tmpdir(), "cfg-")), "sessions.json"), history: { listSessions: (async () => (listed ? [{ sessionId: listed, summary: "/clear", lastModified: 1, cwd: webRoot }] : [])) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: getSessionMessages as never, listSubagents: (async () => []) as never } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const { result } = (await c.request({ type: "session.create", cwd: webRoot, model: "haiku" })) as { result: { session: { id: string } } };
      const old = result.session.id;
      await c.request({ type: "session.subscribe", sessionId: old, sinceSeq: 0 });
      await c.request({ type: "session.prompt", sessionId: old, text: "hi" });
      await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
      await c.request({ type: "session.prompt", sessionId: old, text: "/clear" });
      const cleared = (await c.waitFor((m) => m.type === "event" && m.part.type === "session_cleared")) as Extract<ServerMessage, { type: "event" }>;
      const next = (cleared.part as { sessionId: string }).sessionId;
      listed = next;
      born.add(next);
      getSessionMessages.mockClear();
      const titled = async () => ((await c.request({ type: "session.list" })) as { result: { sessions: { id: string; title: string }[] } }).result.sessions.find((s) => s.id === next)?.title;
      expect(await titled()).toBe("New session");
      expect(getSessionMessages.mock.calls.some((a) => (a as unknown[])[0] === next)).toBe(false);
    } finally {
      d.close();
    }
  });

  it("session.list reads a cleared session without a prompt once, not on every list, until its transcript changes", async () => {
    const id = "8b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
    const t = { sessionId: id, summary: "/clear", lastModified: 1, fileSize: 10, cwd: webRoot };
    let prompt = false;
    const getSessionMessages = vi.fn(async () => (prompt ? [{ type: "user", uuid: randomUUID(), session_id: id, message: { role: "user", content: "later prompt" }, parent_tool_use_id: null, parent_agent_id: null }] : []));
    const d = createDaemon({ webRoot, roots: [webRoot], projects: added(webRoot), query: fakeQuery as never, token, history: { listSessions: (async () => [t]) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: getSessionMessages as never, listSubagents: (async () => []) as never } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const titled = async () => ((await c.request({ type: "session.list" })) as { result: { sessions: { id: string; title: string }[] } }).result.sessions.find((s) => s.id === id)?.title;
      expect(await titled()).toBe("New session");
      expect(await titled()).toBe("New session");
      expect(getSessionMessages).toHaveBeenCalledTimes(1);
      // A prompt was written: the scan reports another size, the transcript is read again.
      prompt = true;
      t.fileSize = 99;
      expect(await titled()).toBe("later prompt");
      expect(getSessionMessages).toHaveBeenCalledTimes(2);
    } finally {
      d.close();
    }
  });

  it("the live query goes on as the CLI's new session: tabs see session_cleared, both sessions are listed, prompts reach the new one, settings are saved under its ID", async () => {
    const settingsFile = join(mkdtempSync(join(tmpdir(), "cfg-")), "sessions.json");
    const d = createDaemon({ webRoot, roots: [webRoot], query: clearQuery as never, token, settingsFile, history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const other = await client((d.address() as AddressInfo).port);
      const { result } = (await c.request({ type: "session.create", cwd: webRoot, model: "haiku" })) as { result: { session: { id: string } } };
      const old = result.session.id;
      await c.request({ type: "session.subscribe", sessionId: old, sinceSeq: 0 });
      await c.request({ type: "session.prompt", sessionId: old, text: "hi" });
      await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
      // Prompt queries; throwaway ones (context usage, plan usage) have no canUseTool.
      const prompting = () => calls.filter((o) => o.canUseTool).length;
      const queries = prompting();
      await c.request({ type: "session.prompt", sessionId: old, text: "/clear" });
      const cleared = (await c.waitFor((m) => m.type === "event" && m.part.type === "session_cleared")) as Extract<ServerMessage, { type: "event" }>;
      expect(cleared.sessionId).toBe(old);
      const next = (cleared.part as { sessionId: string }).sessionId;
      // Every client refreshes its list: the new session appears.
      await other.waitFor((m) => m.type === "sessions.changed");
      const list = (await c.request({ type: "session.list" })) as { result: { sessions: { id: string; state: string }[] } };
      expect(list.result.sessions.map((s) => s.id)).toEqual(expect.arrayContaining([old, next]));
      expect(list.result.sessions.find((s) => s.id === old)?.state).toBe("idle");
      expect(JSON.parse(readFileSync(settingsFile, "utf8"))[next]).toMatchObject({ model: "haiku" });

      expect(await c.request({ type: "session.subscribe", sessionId: next, sinceSeq: 0 })).toMatchObject({ result: { session: { id: next, model: "haiku" } } });
      await c.request({ type: "session.prompt", sessionId: next, text: "after" });
      await c.waitFor((m) => m.type === "event" && m.sessionId === next && m.part.type === "turn_result");
      expect(prompting()).toBe(queries);
      expect(c.inbox.some((m) => m.type === "event" && m.part.type === "raw")).toBe(false);
      // The old session goes on in its own transcript.
      await c.request({ type: "session.prompt", sessionId: old, text: "old again" });
      expect(calls.at(-1)).toMatchObject({ resume: old });
    } finally {
      d.close();
    }
  });

  it("lists a session whose transcript holds only the /clear as 'New session' until it has a title of its own", async () => {
    const id = randomUUID();
    const d = createDaemon({ webRoot, token, roots: [webRoot], projects: added(webRoot), query: fakeQuery as never, history: { listSessions: (async () => [{ sessionId: id, summary: "/clear", lastModified: 1, cwd: webRoot }]) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const list = (await c.request({ type: "session.list" })) as { result: { sessions: { id: string; title: string }[] } };
      expect(list.result.sessions.find((s) => s.id === id)?.title).toBe("New session");
    } finally {
      d.close();
    }
  });

  it("lists a cleared session by its first prompt when the SDK titles it '/clear' (prompt past the SDK's head read window)", async () => {
    const id = randomUUID();
    const user = (content: string, extra = {}) => ({ type: "user", uuid: randomUUID(), session_id: id, message: { role: "user", content }, parent_tool_use_id: null, parent_agent_id: null, ...extra });
    // The /clear record, a background task's notification turn, then the first prompt.
    const main = [user(CLEAR_RECORD), user("<task-notification><task-id>t1</task-id><status>completed</status></task-notification>"), user("fix the bug")];
    const d = createDaemon({ webRoot, token, roots: [webRoot], projects: added(webRoot), query: fakeQuery as never, history: { listSessions: (async () => [{ sessionId: id, summary: "/clear", lastModified: 1, cwd: webRoot }]) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => main) as never, listSubagents: (async () => []) as never } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const list = (await c.request({ type: "session.list" })) as { result: { sessions: { id: string; title: string }[] } };
      expect(list.result.sessions.find((s) => s.id === id)?.title).toBe("fix the bug");
      // A one-shot read: no parsed transcript stays in memory.
      expect(d.transcriptCaches()).toEqual([]);
    } finally {
      d.close();
    }
  });

  it("after a restart both transcripts restore: the old one with its history, the new one without the /clear record", async () => {
    const [old, next] = [randomUUID(), randomUUID()];
    const user = (uuid: string, content: string) => ({ type: "user", uuid, session_id: next, message: { role: "user", content }, parent_tool_use_id: null, parent_agent_id: null });
    const transcripts: Record<string, unknown[]> = { [old]: history, [next]: [user("c1", CLEAR_RECORD), user("a1", "after")] };
    const d = createDaemon({
      webRoot,
      token,
      roots: [webRoot],
      query: fakeQuery as never,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (sid: string) => (transcripts[sid] ? { sessionId: sid, cwd: webRoot } : undefined)) as never,
        getSessionMessages: (async (sid: string) => transcripts[sid]) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const prompts = async (sid: string) => {
        await c.request({ type: "session.subscribe", sessionId: sid, sinceSeq: 0 });
        await c.waitFor((m) => m.type === "event" && m.sessionId === sid && m.part.type === "session_state");
        return c.inbox.flatMap((m) => (m.type === "event" && m.sessionId === sid && m.part.type === "user_text" ? [m.part.text] : []));
      };
      expect(await prompts(old)).toEqual(["first", "second"]);
      expect(await prompts(next)).toEqual(["after"]);
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
  async function daemon(push?: ReturnType<typeof fakePush>["push"], pingMs?: number) {
    const d = createDaemon({ webRoot, roots: [webRoot], query: permissionQuery as never, token, push, pingMs, history: { ...history, getSessionInfo: async () => undefined } as never });
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

  it("push.focus covered: the sessions an in-app page shows cards for get no push; an empty push.focus and a closed socket lift it; bad values are refused (GH-158)", async () => {
    const f = fakePush();
    const { d, c } = await daemon(f.push);
    try {
      const create = async () => ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      const covered = await create();
      const other = await create();
      for (const id of [covered, other]) await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      for (const bad of ["x", [1], Array.from({ length: 2001 }, () => "a"), ["a".repeat(201)]])
        expect(await c.request({ type: "push.focus", covered: bad })).toMatchObject({ code: "bad_request" });
      await c.request({ type: "push.focus", covered: [covered] });
      await c.request({ type: "session.prompt", sessionId: covered, text: "run tests" });
      await c.waitFor((m) => m.type === "event" && m.sessionId === covered && m.part.type === "permission_request");
      await new Promise((r) => setTimeout(r, 50));
      expect(f.sent).toEqual([]);
      // Not covered: pushed as before.
      await c.request({ type: "session.prompt", sessionId: other, text: "run tests" });
      await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      expect(f.sent[0]!.sessionId).toBe(other);
    } finally {
      d.close();
    }
  });

  it("Notifications from workers off: a worker's request pushes nothing, a plain session's does; on again: the worker's next one pushes (GH-387)", async () => {
    const f = fakePush();
    const [w, w2, plain, coordinator] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const settingsFile = join(dir, "sessions.json");
    writeFileSync(settingsFile, JSON.stringify({ [w]: { coordinatorId: coordinator, name: "w" }, [w2]: { coordinatorId: coordinator, name: "w2" }, [plain]: {}, [coordinator]: {} }));
    const d = createDaemon({
      webRoot, roots: [webRoot], query: permissionQuery as never, token, push: f.push, settingsFile,
      appSettings: createSettings({ file: join(dir, "settings.json") }),
      history: { listSessions: (async () => []) as never, getSessionInfo: (async (sid: string) => ({ sessionId: sid, cwd: webRoot })) as never, getSessionMessages: (async () => history) as never },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      for (const id of [w, w2, plain]) await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      expect(await c.request({ type: "settings.set", patch: { orchestration: { workerNotifications: false } } })).toMatchObject({ type: "reply" });
      await c.request({ type: "session.prompt", sessionId: w, text: "run tests" });
      await c.waitFor((m) => m.type === "event" && m.sessionId === w && m.part.type === "permission_request");
      await new Promise((r) => setTimeout(r, 50));
      expect(f.sent).toEqual([]);
      await c.request({ type: "session.prompt", sessionId: plain, text: "run tests" });
      await vi.waitFor(() => expect(f.sent.map((p) => p.sessionId)).toEqual([plain]));
      // On again: the next worker's request pushes (a second worker, so the first one's blocked turn is not in the way).
      expect(await c.request({ type: "settings.set", patch: { orchestration: { workerNotifications: true } } })).toMatchObject({ type: "reply" });
      await c.request({ type: "session.prompt", sessionId: w2, text: "run tests" });
      await vi.waitFor(() => expect(f.sent.map((p) => p.sessionId)).toEqual([plain, w2]));
    } finally {
      d.close();
    }
  });

  it("push.focus without covered lifts the suppression, and so does closing the connection that set it (GH-158)", async () => {
    const f = fakePush();
    const { d, c } = await daemon(f.push);
    try {
      const create = async () => ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      const a = await create();
      const b = await create();
      for (const id of [a, b]) await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      const page = await client((d.address() as AddressInfo).port);
      await page.request({ type: "push.focus", covered: [a, b] });
      await page.request({ type: "push.focus", covered: [a] });
      await page.request({ type: "push.focus" });
      await c.request({ type: "session.prompt", sessionId: a, text: "run tests" });
      await vi.waitFor(() => expect(f.sent.map((p) => p.sessionId)).toEqual([a]));
      await page.request({ type: "push.focus", covered: [b] });
      page.ws.close();
      await new Promise((r) => setTimeout(r, 50));
      await c.request({ type: "session.prompt", sessionId: b, text: "run tests" });
      await vi.waitFor(() => expect(f.sent.map((p) => p.sessionId)).toEqual([a, b]));
    } finally {
      d.close();
    }
  });

  it("a request handler that throws fails that request (internal_error) and the daemon keeps running", async () => {
    const f = fakePush();
    const { d, c } = await daemon({ ...f.push, subscribe: (_s: unknown): _s is {} => { throw new Error("boom"); } });
    try {
      const sub = { endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } };
      expect(await c.request({ type: "push.subscribe", subscription: sub })).toMatchObject({ type: "error", code: "internal_error" });
      expect(await c.request({ type: "push.key" })).toMatchObject({ result: { publicKey: "BPUBLIC" } });
    } finally {
      d.close();
    }
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

  describe("ws ping", () => {
    const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once("close", (code) => r(code)));

    it("drops a socket that stops answering pings and keeps one that answers", async () => {
      const { d, c: healthy } = await daemon(undefined, 100);
      try {
        const dead = await client((d.address() as AddressInfo).port, { autoPong: false });
        const t0 = Date.now();
        expect(await closed(dead.ws)).toBe(1006);
        expect(Date.now() - t0).toBeLessThan(1500);
        await new Promise((r) => setTimeout(r, 500));
        expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
        expect(await healthy.request({ type: "push.key" })).toMatchObject({ code: "push_unavailable" });
      } finally {
        d.close();
      }
    });

    it("a half-open tab no longer suppresses push for the session it showed", async () => {
      const f = fakePush();
      const { d, c } = await daemon(f.push, 300);
      try {
        const port = (d.address() as AddressInfo).port;
        const dead = await client(port, { autoPong: false });
        const { result } = (await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
        const sessionId = result.session.id;
        await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
        await dead.request({ type: "push.focus", sessionId });
        await c.request({ type: "session.prompt", sessionId, text: "run tests" });
        const req = (await c.waitFor((m) => m.type === "event" && m.part.type === "permission_request")) as { part: { requestId: string } };
        // Control: while the dead socket is still registered it suppresses the push.
        await new Promise((r) => setTimeout(r, 50));
        expect(f.sent).toEqual([]);
        await closed(dead.ws);
        await c.request({ type: "permission.respond", requestId: req.part.requestId, decision: "allow" });
        await c.waitFor((m) => m.type === "event" && m.part.type === "session_state" && m.part.state === "idle");
        await c.request({ type: "session.prompt", sessionId, text: "again" });
        await vi.waitFor(() => expect(f.sent).toHaveLength(1));
        expect(f.sent[0]).toMatchObject({ sessionId });
      } finally {
        d.close();
      }
    });
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

  it("answers a ping request with an empty reply (the page's liveness probe)", async () => {
    const c = await client();
    expect(await c.request({ type: "ping" })).toMatchObject({ type: "reply", result: {} });
    c.ws.close();
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
  async function syncDaemon(query: unknown = fakeQuery, restored: Record<string, Msg[]> = {}, restoredCwd = webRoot) {
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
        getSessionInfo: (async (sid: string) => (restored[sid] ? { sessionId: sid, cwd: restoredCwd } : undefined)) as never,
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

  it("a restore without subscriber keeps no parsed transcript; a subscriber's mirror keeps it until it leaves", { timeout: 15_000 }, async () => {
    const id = randomUUID();
    const { d, c, touch } = await syncDaemon(fakeQuery, { [id]: own("p1") });
    try {
      touch(id, webRoot);
      expect(await c.request({ type: "session.setEffort", sessionId: id, effort: "high" })).toMatchObject({ type: "reply" });
      expect(d.transcriptCaches()).toEqual([]);
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      touch(id, webRoot);
      await quiet();
      expect(d.transcriptCaches()).toEqual([id]);
      c.ws.close();
      await vi.waitFor(() => expect(d.transcriptCaches()).toEqual([]));
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

  it("a task notification the own CLI only logs (queueTranscriptOnly, no turn) is no terminal CLI turn: no external_turn, the live query stays", { timeout: 15_000 }, async () => {
    // Shape of session 35769a83: a subagent's report came as a message, its notification then only went to the transcript.
    const { d, c, files, touch, create, prompt } = await syncDaemon(clearQuery);
    try {
      const s = await create();
      const mine = () => calls.filter((o) => o.sessionId === s.id || o.resume === s.id);
      const p1 = await prompt(s.id, "bg");
      const p2 = await prompt(s.id, "notify");
      const notice = msg("user", "notice", "<task-notification>\n<task-id>bg-task</task-id>\n<tool-use-id>bg</tool-use-id>\n<status>completed</status>\n</task-notification>");
      files[s.id] = [msg("user", p1, "bg"), msg("user", p2, "notify"), notice];
      touch(s.id, s.cwd);
      await quiet();
      expect(events(c).some((e) => e.part.type === "external_turn")).toBe(false);
      expect(closedQueries).not.toContain(mine()[0]);
      await prompt(s.id, "now");
      expect(mine()).toHaveLength(1);
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

  it("Windows: a restored session whose CLI ran in a junction (cwd differs from the canonical path) still reads and mirrors its transcript by the cwd the CLI wrote", { timeout: 15_000 }, async () => {
    // The native realpath on Linux resolves a symlink as it does a junction or subst drive on Windows.
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const link = join(webRoot, "junction");
    mkdirSync(join(webRoot, "proj"), { recursive: true });
    symlinkSync(join(webRoot, "proj"), link, "junction");
    const id = "4d5e6f7a-8b9c-4dad-8f10-2b3c4d5e6f7a";
    const { d, c, files, touch, reads } = await syncDaemon(fakeQuery, { [id]: history as never }, link);
    try {
      await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
      await c.waitFor(isPart("session_state"));
      const before = reads.main;
      files[id] = [...(history as Msg[]), ...external("junction")];
      touch(id, link);
      await c.waitFor(isPart("user_text", "cli-junction"));
      expect(reads.main).toBeGreaterThan(before);
    } finally {
      d.close();
      platform.mockRestore();
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

describe("default permission mode from Claude settings (permissions.defaultMode)", () => {
  const write = (file: string, mode: unknown) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, JSON.stringify({ permissions: { defaultMode: mode } })));
  /** A daemon with its own Claude user dir and project dir (a root, so cwd is allowed). */
  async function setup(allowBypass = false) {
    const claudeDir = mkdtempSync(join(tmpdir(), "claude-user-"));
    const project = mkdtempSync(join(tmpdir(), "proj-"));
    const d = createDaemon({ webRoot, token, roots: [project], query: fakeQuery as never, claudeDir, allowBypass, history: { listSessions: (async () => []) as never } as never });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const c = await client((d.address() as AddressInfo).port);
    const mode = async (cwd = project) => ((await c.request({ type: "session.defaultMode", cwd })) as { result: { mode: string } }).result.mode;
    return { claudeDir, project, d, c, mode, user: join(claudeDir, "settings.json"), shared: join(project, ".claude", "settings.json"), local: join(project, ".claude", "settings.local.json") };
  }

  it("user settings give the mode; unset, invalid or unreadable settings give default", async () => {
    const t = await setup();
    expect(await t.mode()).toBe("default");
    write(t.user, "acceptEdits");
    expect(await t.mode()).toBe("acceptEdits");
    write(t.user, "yolo");
    expect(await t.mode()).toBe("default");
    writeFileSync(t.user, "{ not json");
    expect(await t.mode()).toBe("default");
    t.d.close();
  });

  it("local overrides project overrides user, per cwd", async () => {
    const t = await setup();
    write(t.user, "acceptEdits");
    write(t.shared, "plan");
    expect(await t.mode()).toBe("plan");
    write(t.local, "dontAsk");
    expect(await t.mode()).toBe("dontAsk");
    mkdirSync(join(t.project, "other"));
    expect(await t.mode(join(t.project, "other"))).toBe("acceptEdits");
    t.d.close();
  });

  it("an invalid higher-precedence value is skipped for the next valid one, like Claude Code", async () => {
    const t = await setup();
    write(t.user, "plan");
    write(t.shared, "nonsense");
    expect(await t.mode()).toBe("plan");
    write(t.local, 5);
    expect(await t.mode()).toBe("plan");
    t.d.close();
  });

  it.each(["shared", "local"] as const)("auto and bypassPermissions in the %s project settings are ignored (user settings decide), like Claude Code", async (file) => {
    const t = await setup(true);
    write(t.user, "plan");
    for (const mode of ["bypassPermissions", "auto"]) {
      write(t[file], mode);
      expect(await t.mode()).toBe("plan");
    }
    // Other values still count from project files.
    write(t[file], "acceptEdits");
    expect(await t.mode()).toBe("acceptEdits");
    t.d.close();
  });

  it("bypassPermissions from the user settings still counts (with allow-bypass)", async () => {
    const t = await setup(true);
    write(t.user, "bypassPermissions");
    write(t.shared, "bypassPermissions");
    expect(await t.mode()).toBe("bypassPermissions");
    t.d.close();
  });

  it("bypassPermissions needs the daemon's allow-bypass; auto needs a model with auto support", async () => {
    const t = await setup();
    write(t.user, "bypassPermissions");
    expect(await t.mode()).toBe("default");
    write(t.user, "auto");
    // The default model has no supportsAutoMode in the fake list.
    expect(await t.mode()).toBe("default");
    t.d.close();
    const b = await setup(true);
    write(b.user, "bypassPermissions");
    expect(await b.mode()).toBe("bypassPermissions");
    b.d.close();
  });

  it("session.commands lists the commands of a project without a session, caches them per cwd, and refuses a cwd outside the roots", async () => {
    const t = await setup();
    const ask = (cwd: string) => t.c.request({ type: "session.commands", cwd }) as Promise<{ result: { commands: { name: string }[] } }>;
    const before = calls.length;
    expect((await ask(t.project)).result.commands.map((c) => c.name)).toEqual(["review"]);
    await ask(t.project);
    const mine = calls.slice(before).filter((o) => o.cwd === t.project);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ persistSession: false });
    expect(await t.c.request({ type: "session.commands", cwd: tmpdir() })).toMatchObject({ code: "cwd_not_allowed" });
    // A skill change drops the cache: the next ask starts a new throwaway.
    await t.c.request({ type: "skills.setState", cwd: t.project, name: "x", state: "off" });
    await ask(t.project);
    expect(calls.slice(before).filter((o) => o.cwd === t.project && o.persistSession === false && !("resume" in o)).length).toBeGreaterThanOrEqual(2);
    t.d.close();
  });

  it("session.defaultMode refuses a cwd outside the roots", async () => {
    const t = await setup();
    expect(await t.c.request({ type: "session.defaultMode", cwd: tmpdir() })).toMatchObject({ code: "cwd_not_allowed" });
    t.d.close();
  });

  it("session.create without a mode starts in the default mode (auto on a supporting model); the CLI gets it; settings edits apply to the next session", async () => {
    const t = await setup();
    write(t.user, "auto");
    const create = async (model?: string) => ((await t.c.request({ type: "session.create", cwd: t.project, model })) as { result: { session: { id: string; permissionMode: string } } }).result.session;
    const sonnet = await create("sonnet");
    expect(sonnet.permissionMode).toBe("auto");
    await t.c.request({ type: "session.prompt", sessionId: sonnet.id, text: "hi" });
    expect(calls.find((o) => o.sessionId === sonnet.id)).toMatchObject({ permissionMode: "auto" });
    expect((await create("haiku")).permissionMode).toBe("default");
    write(t.shared, "plan");
    expect((await create("sonnet")).permissionMode).toBe("plan");
    t.d.close();
  });
});

describe("updates", () => {
  it("update_available on connect; update.restart waits for the running turn; update.* fail without updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-versions-"));
    const exit = vi.fn();
    const run = async (_cmd: string, args: string[]) => {
      const pkg = join(args[args.indexOf("--prefix") + 1]!, "node_modules", "claude-code-ui");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.2.1" }));
      writeFileSync(join(pkg, "dist", "cli.js"), "");
      return { code: 0, output: "" };
    };
    const fetch = (async () => ({ ok: true, json: async () => ({ version: "0.2.1" }) })) as never;
    const d = createDaemon({ webRoot, roots: [webRoot], query: permissionQuery as never, token, update: { current: "0.2.0", dir, fetch, run, exit, pollMs: 10, graceMs: 30 } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const p = (d.address() as AddressInfo).port;
    try {
      // The check at start resolves on a later tick: a connection after it gets the version at once.
      await new Promise((r) => setTimeout(r, 20));
      const a = await client(p);
      expect(await a.waitFor((m) => m.type === "update_available")).toEqual({ type: "update_available", version: "0.2.1", current: "0.2.0" });
      const { result } = (await a.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } };
      const sessionId = result.session.id;
      await a.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
      await a.request({ type: "session.prompt", sessionId, text: "run tests" });
      const req = (await a.waitFor((m) => m.type === "event" && m.part.type === "permission_request")) as Extract<ServerMessage, { type: "event" }>;

      expect(await a.request({ type: "update.install" })).toMatchObject({ result: { installed: "0.2.1" } });
      expect(await a.request({ type: "update.restart" })).toMatchObject({ result: { waitingFor: 1 } });
      await a.waitFor((m) => m.type === "update_state" && m.phase === "waiting");
      await new Promise((r) => setTimeout(r, 50));
      expect(exit).not.toHaveBeenCalled();
      await a.request({ type: "permission.respond", requestId: (req.part as { requestId: string }).requestId, decision: "allow" });
      await a.waitFor((m) => m.type === "update_state" && m.phase === "restarting");
      expect(exit).toHaveBeenCalledWith(75);
    } finally {
      d.close();
    }
    const c = await client();
    expect(await c.request({ type: "update.install" })).toMatchObject({ type: "error", code: "update_unavailable" });
    expect(c.inbox.some((m) => m.type === "update_available")).toBe(false);
    c.ws.close();
  });
});

describe("sessions.search", () => {
  const line = (o: object) => JSON.stringify(o) + "\n";
  const setup = (bigMB = 0) => {
    const inside = join(webRoot, "search proj");
    const other = join(webRoot, "other proj");
    mkdirSync(inside, { recursive: true });
    mkdirSync(other, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const projectsDir = mkdtempSync(join(tmpdir(), "projects-"));
    const make = (id: string, cwd: string, text: string, lastModified: number) => {
      const dir = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.jsonl`), line({ type: "user", uuid: `u-${id}`, message: { role: "user", content: text } }));
      return { sessionId: id, summary: `title ${id}`, lastModified, cwd };
    };
    const transcripts = [make("a1", inside, "the Zebra here", 3), make("a2", other, "zebra too", 2), make("a3", outside, "zebra outside", 1)];
    // A big transcript without a match, newest: a scan has to read it before the others.
    if (bigMB) {
      const big = make("big", inside, "x", 10);
      const row = line({ type: "user", uuid: "x", message: { role: "user", content: "filler ".repeat(1000) } });
      writeFileSync(join(projectsDir, inside.replace(/[^a-zA-Z0-9]/g, "-"), "big.jsonl"), row.repeat(Math.ceil((bigMB << 20) / row.length)));
      transcripts.push(big);
    }
    const d = createDaemon({ webRoot, token, roots: [webRoot], query: fakeQuery as never, projectsDir, history: { listSessions: (async () => transcripts) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never } });
    return { d, inside, outside };
  };
  const results = (c: Awaited<ReturnType<typeof client>>) => c.inbox.filter((m): m is Extract<ServerMessage, { type: "sessions.search.result" }> => m.type === "sessions.search.result");

  it("streams hits of transcripts inside the roots only, then replies the scan stats", async () => {
    const { d } = setup();
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const reply = (await c.request({ type: "sessions.search", query: "ZEBRA" })) as { reqId: string; result: { scannedFiles: number } };
      expect(results(c).map((r) => [r.sessionId, r.reqId, r.hits[0]!.messageId])).toEqual([["a1", reply.reqId, "u-a1"], ["a2", reply.reqId, "u-a2"]]);
      expect(reply.result.scannedFiles).toBe(2);
    } finally {
      d.close();
    }
  });

  it("cwd limits the search to that project; a cwd outside the roots is cwd_not_allowed; a 1-char query replies empty; 201 chars is bad_query", async () => {
    const { d, inside, outside } = setup();
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      await c.request({ type: "sessions.search", query: "zebra", cwd: inside });
      expect(results(c).map((r) => r.sessionId)).toEqual(["a1"]);
      expect(await c.request({ type: "sessions.search", query: "zebra", cwd: outside })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
      expect(await c.request({ type: "sessions.search", query: "z" })).toMatchObject({ type: "reply", result: { scannedFiles: 0 } });
      expect(await c.request({ type: "sessions.search", query: "z".repeat(201) })).toMatchObject({ type: "error", code: "bad_query" });
      expect(results(c)).toHaveLength(1);
    } finally {
      d.close();
    }
  });

  it("a new sessions.search cancels the running one", async () => {
    const { d } = setup(150);
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      // Both sent at once: the first has not finished (it reads 150 MB first), the second replaces it.
      const first = c.request({ type: "sessions.search", query: "zebra" });
      const second = c.request({ type: "sessions.search", query: "the zebra" });
      expect(await first).toMatchObject({ type: "reply", result: { stopped: "canceled" } });
      expect(((await second) as { result: { stopped?: string } }).result.stopped).toBeUndefined();
      expect(results(c).map((r) => r.sessionId)).toEqual(["a1"]);
    } finally {
      d.close();
    }
  });

  it("closing the connection cancels the running search", async () => {
    const { d } = setup(150);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      c.ws.send(JSON.stringify({ type: "sessions.search", query: "zebra", reqId: "1" }));
      await new Promise((r) => setTimeout(r, 30));
      c.ws.close();
      await vi.waitFor(() => expect(log.mock.calls.map((a) => String(a[0])).some((l) => l.startsWith("sessions.search:") && l.endsWith("stopped: canceled"))).toBe(true), { timeout: 5000 });
    } finally {
      log.mockRestore();
      d.close();
    }
  });
});

describe("fs.media and /media", () => {
  const dir = join(webRoot, "mediaproj");
  mkdirSync(dir, { recursive: true });
  const png = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
  writeFileSync(join(dir, "a.png"), png);
  writeFileSync(join(dir, "v.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
  writeFileSync(join(dir, "n.txt"), "x");
  writeFileSync(join(dir, "n.html"), "<b>x</b>");
  mkdirSync(join(dir, "d.png"), { recursive: true });
  const media = async (c: Awaited<ReturnType<typeof client>>, path: string) => (await c.request({ type: "fs.media", path })) as { type: string; code?: string; result: { url: string; mime: string; size: number; mtime: number } };
  const get = (url: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: url, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });

  it("fs.media refuses outside the roots, a symlink out of the roots and a .. path (path_not_allowed); missing not_found; directory not_a_file; .txt/.html unsupported_type", async () => {
    const c = await client();
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "o.png");
    writeFileSync(outside, png);
    expect(await media(c, outside)).toMatchObject({ code: "path_not_allowed" });
    expect(await media(c, join(dir, "..", "..", basename(dirname(outside)), "o.png"))).toMatchObject({ code: "path_not_allowed" });
    if (posix) {
      symlinkSync(outside, join(dir, "link.png"));
      expect(await media(c, join(dir, "link.png"))).toMatchObject({ code: "path_not_allowed" });
    }
    expect(await media(c, join(dir, "missing.png"))).toMatchObject({ code: "not_found" });
    expect(await media(c, join(dir, "d.png"))).toMatchObject({ code: "not_a_file" });
    expect(await media(c, join(dir, "n.txt"))).toMatchObject({ code: "unsupported_type" });
    expect(await media(c, join(dir, "n.html"))).toMatchObject({ code: "unsupported_type" });
    c.ws.close();
  });

  it("GET returns the bytes with type, length and the security headers; HEAD has headers and no body", async () => {
    const c = await client();
    const { url, mime } = (await media(c, join(dir, "a.png"))).result;
    expect(mime).toBe("image/png");
    const r = await get(url);
    expect(r.status).toBe(200);
    expect(r.body.equals(png)).toBe(true);
    expect(r.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": "300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "cache-control": "no-store",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "accept-ranges": "bytes",
    });
    expect(String(r.headers["content-disposition"])).toMatch(/^inline/);
    const h = await get(url, {}, "HEAD");
    expect(h.status).toBe(200);
    expect(h.headers["content-length"]).toBe("300");
    expect(h.body.length).toBe(0);
    c.ws.close();
  });

  it("Range bytes=0-99 -> 206 with 100 bytes; bytes=-10 -> last 10; bytes=300- -> 416; multi-range -> 200 full", async () => {
    const c = await client();
    const { url } = (await media(c, join(dir, "a.png"))).result;
    const a = await get(url, { range: "bytes=0-99" });
    expect(a.status).toBe(206);
    expect(a.headers["content-range"]).toBe("bytes 0-99/300");
    expect(a.body.equals(png.subarray(0, 100))).toBe(true);
    const b = await get(url, { range: "bytes=-10" });
    expect(b.status).toBe(206);
    expect(b.body.equals(png.subarray(290))).toBe(true);
    const u = await get(url, { range: "bytes=300-" });
    expect(u.status).toBe(416);
    expect(u.headers["content-range"]).toBe("bytes */300");
    const m = await get(url, { range: "bytes=0-1,5-6" });
    expect(m.status).toBe(200);
    expect(m.body.length).toBe(300);
    c.ws.close();
  });

  it("SVG is served as image/svg+xml, attachment, with the sandbox CSP", async () => {
    const c = await client();
    const { url } = (await media(c, join(dir, "v.svg"))).result;
    const r = await get(url);
    expect(r.headers["content-type"]).toBe("image/svg+xml");
    expect(String(r.headers["content-disposition"])).toMatch(/^attachment/);
    expect(String(r.headers["content-security-policy"])).toContain("sandbox");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    c.ws.close();
  });

  it("unknown nonce, malformed nonce and other /media/ paths -> 404, never index.html; POST -> 405", async () => {
    const c = await client();
    const { url } = (await media(c, join(dir, "a.png"))).result;
    for (const p of [`/media/${"0".repeat(32)}/a.png`, "/media/abc/a.png", "/media/", "/media", `/media/${"0".repeat(32)}`, "/media/../index.html", "/media/%2e%2e/index.html"]) {
      const r = await get(p);
      expect(r.status, p).toBe(p === "/media" ? 200 : 404);
      if (p !== "/media") expect(r.body.toString()).not.toContain("<h1>app</h1>");
    }
    expect((await get(url, {}, "POST")).status).toBe(405);
    c.ws.close();
  });

  it("the pairing token is never a URL credential", async () => {
    expect((await get(`/media/${token}/a.png`)).status).toBe(404);
    expect((await get(`/media/${token}`)).status).toBe(404);
  });

  it("the nonce is dead after its connection closes", async () => {
    const c = await client();
    const { url } = (await media(c, join(dir, "a.png"))).result;
    expect((await get(url)).status).toBe(200);
    c.ws.close();
    await vi.waitFor(async () => expect((await get(url)).status).toBe(404));
  });

  const readPiece = async (c: Awaited<ReturnType<typeof client>>, m: Record<string, unknown>) => (await c.request({ type: "media.read", ...m })) as { type: string; code?: string; result: { data: string; size: number; mtime: number; mime: string } };

  it("media.read returns base64 bytes at an offset with size, mtime and mime; length 0 gives only the facts", async () => {
    const c = await client();
    const f = join(dir, "a.png");
    const a = await readPiece(c, { path: f, offset: 10, length: 20 });
    expect(Buffer.from(a.result.data, "base64").equals(png.subarray(10, 30))).toBe(true);
    expect(a.result).toMatchObject({ size: 300, mime: "image/png", mtime: statSync(f).mtimeMs });
    expect(Buffer.from((await readPiece(c, { path: f, offset: 290, length: 20 })).result.data, "base64").length).toBe(10);
    expect((await readPiece(c, { path: f, offset: 0, length: 0 })).result).toMatchObject({ data: "", size: 300 });
    c.ws.close();
  });

  it("media.read refuses: bad offset or length (bad_request), outside the roots and .. paths (path_not_allowed), .txt (unsupported_type), a directory (not_a_file), missing (not_found)", async () => {
    const c = await client();
    const f = join(dir, "a.png");
    for (const bad of [{ offset: 0, length: (1 << 20) + 1 }, { offset: -1, length: 1 }, { offset: 0.5, length: 1 }, { offset: 0, length: -1 }, { offset: "0", length: 1 }]) expect(await readPiece(c, { path: f, ...bad }), JSON.stringify(bad)).toMatchObject({ code: "bad_request" });
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "o.png");
    writeFileSync(outside, png);
    expect(await readPiece(c, { path: outside, offset: 0, length: 1 })).toMatchObject({ code: "path_not_allowed" });
    expect(await readPiece(c, { path: join(dir, "..", "..", basename(dirname(outside)), "o.png"), offset: 0, length: 1 })).toMatchObject({ code: "path_not_allowed" });
    expect(await readPiece(c, { path: join(dir, "..", "..", "..", "etc", "x.png"), offset: 0, length: 1 })).toMatchObject({ type: "error" });
    expect(await readPiece(c, { path: join(dir, "n.txt"), offset: 0, length: 1 })).toMatchObject({ code: "unsupported_type" });
    expect(await readPiece(c, { path: join(dir, "d.png"), offset: 0, length: 1 })).toMatchObject({ code: "not_a_file" });
    expect(await readPiece(c, { path: join(dir, "missing.png"), offset: 0, length: 1 })).toMatchObject({ code: "not_found" });
    expect(await readPiece(c, { path: outside, cwd: outside, hash: "a".repeat(40), offset: 0, length: 1 })).toMatchObject({ code: "cwd_not_allowed" });
    c.ws.close();
  });

  describe("a file at a commit (cwd + hash)", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "img"), { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    const bytesA = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) % 256));
    const bytesB = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 3) % 256));
    writeFileSync(join(repo, "img", "p.png"), bytesA);
    writeFileSync(join(repo, "n.txt"), "x");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    const hash = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "img", "p.png"), bytesB);
    const at = async (c: Awaited<ReturnType<typeof client>>, m: Record<string, unknown>) => (await c.request({ type: "fs.media", cwd: repo, hash, path: "img/p.png", ...m })) as { type: string; code?: string; size?: number; result: { url: string; mime: string; size: number; mtime: number } };

    it("fs.media with cwd and hash serves the file at that commit; the plain fs.media serves the disk", async () => {
      const c = await client();
      const { url, mtime, size } = (await at(c, {})).result;
      expect(url).toMatch(new RegExp(`\\?v=${hash}$`));
      expect(mtime).toBe(0);
      expect(size).toBe(300);
      const r = await get(url);
      expect(r.status).toBe(200);
      expect(r.body.equals(bytesA)).toBe(true);
      expect(r.headers).toMatchObject({ "content-type": "image/png", "x-content-type-options": "nosniff" });
      expect(String(r.headers["content-security-policy"])).toContain("sandbox");
      const rg = await get(url, { range: "bytes=0-99" });
      expect(rg.status).toBe(206);
      expect(rg.body.length).toBe(100);
      expect(rg.headers["content-range"]).toBe("bytes 0-99/300");
      expect((await get(url, { range: "bytes=300-" })).status).toBe(416);
      expect((await get(url, {}, "HEAD")).body.length).toBe(0);
      const disk = (await media(c, join(repo, "img", "p.png"))).result;
      expect((await get(disk.url)).body.equals(bytesB)).toBe(true);
      c.ws.close();
    });

    it("with a hash: not_found for a path missing at the commit, unsupported_type for .txt, cwd_not_allowed outside the roots, bad_request for a short hash", async () => {
      const c = await client();
      expect(await at(c, { path: "img/none.png" })).toMatchObject({ code: "not_found" });
      expect(await at(c, { path: "n.txt" })).toMatchObject({ code: "unsupported_type" });
      expect(await at(c, { cwd: tmpdir() })).toMatchObject({ code: "cwd_not_allowed" });
      expect(await at(c, { hash: "abc" })).toMatchObject({ type: "error" });
      expect(await at(c, { path: "../x.png" })).toMatchObject({ type: "error" });
      c.ws.close();
    });

    it("the size comes from git without reading the blob; two images at once read each blob once", async () => {
      writeFileSync(join(repo, "img", "q.png"), bytesB);
      git("add", "-A");
      git("commit", "-q", "-m", "two");
      const hash2 = git("rev-parse", "HEAD");
      const c = await client();
      const reads = vi.mocked(gitBlobRead);
      reads.mockClear();
      const a = (await at(c, {})).result;
      const b = (await at(c, { hash: hash2, path: "img/q.png" })).result;
      expect(a.size).toBe(300);
      expect(b.size).toBe(300);
      expect(reads).not.toHaveBeenCalled();
      // Pieces of both images interleaved (a viewer asks for both): each blob is read from git once.
      for (const u of [a.url, b.url, a.url, b.url]) expect((await get(u)).status).toBe(200);
      expect((await get(a.url, { range: "bytes=10-19" })).body.equals(bytesA.subarray(10, 20))).toBe(true);
      expect(reads).toHaveBeenCalledTimes(2);
      c.ws.close();
    });

    it("a commit nonce is dead after its connection closes", async () => {
      const c = await client();
      const { url } = (await at(c, {})).result;
      expect((await get(url)).status).toBe(200);
      c.ws.close();
      await vi.waitFor(async () => expect((await get(url)).status).toBe(404));
    });
  });

  it("the nonce expires after 10 min idle; a GET extends it", async () => {
    const c = await client();
    const { url } = (await media(c, join(dir, "a.png"))).result;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0 + 9 * 60_000);
      expect((await get(url)).status).toBe(200);
      vi.setSystemTime(t0 + 18 * 60_000);
      expect((await get(url)).status).toBe(200);
      vi.setSystemTime(t0 + 29 * 60_000);
      expect((await get(url)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
    c.ws.close();
  });

  it("same connection and path reuse the nonce; ?v= changes with the mtime", async () => {
    const c = await client();
    const f = join(dir, "reuse.png");
    writeFileSync(f, png);
    utimesSync(f, 1_000, 1_000);
    const a = (await media(c, f)).result;
    utimesSync(f, 2_000, 2_000);
    const b = (await media(c, f)).result;
    expect(a.url.split("?")[0]).toBe(b.url.split("?")[0]);
    expect(a.url).not.toBe(b.url);
    expect(b.url).toMatch(/\?v=2000000$/);
    const other = await client();
    expect((await media(other, f)).result.url.split("?")[0]).not.toBe(a.url.split("?")[0]);
    c.ws.close();
    other.ws.close();
  });

  it.runIf(posix)("a file swapped for a symlink out of the roots after issue -> 404", async () => {
    const c = await client();
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "secret.png");
    writeFileSync(outside, "secret");
    const f = join(dir, "swap.png");
    writeFileSync(f, png);
    const { url } = (await media(c, f)).result;
    expect((await get(url)).status).toBe(200);
    rmSync(f);
    symlinkSync(outside, f);
    expect((await get(url)).status).toBe(404);
    c.ws.close();
  });

  /** Issues a nonce for a PNG, lets `swap` replace the file, and GETs the URL. */
  const afterSwap = async (name: string, swap: (f: string) => void) => {
    const c = await client();
    const f = join(dir, name);
    writeFileSync(f, png);
    const { url } = (await media(c, f)).result;
    expect((await get(url)).status).toBe(200);
    rmSync(f);
    swap(f);
    const r = await get(url);
    c.ws.close();
    return r.status;
  };
  it.runIf(posix)("a file swapped for a symlink to a regular file inside the roots -> 404 (O_NOFOLLOW / realpath re-check)", async () => {
    const target = join(dir, "swap-target.png");
    writeFileSync(target, png);
    expect(await afterSwap("swap-in.png", (f) => symlinkSync(target, f))).toBe(404);
  });
  it("a file swapped for a directory -> 404 (isFile check)", async () => {
    expect(await afterSwap("swap-dir.png", (f) => mkdirSync(f))).toBe(404);
  });
  it.runIf(posix)("a file swapped for a FIFO -> 404 without blocking the daemon", async () => {
    const status = await Promise.race([afterSwap("swap-fifo.png", (f) => execFileSync("mkfifo", [f])), new Promise<string>((r) => setTimeout(() => r("blocked"), 3_000))]);
    expect(status).toBe(404);
  });
  it("filename* encodes ' ( ) * (RFC 5987)", async () => {
    const c = await client();
    // `*` cannot be in a Windows file name; the RFC 5987 escape of `*` is checked where the file system allows it.
    const f = join(dir, posix ? "it's (a) *.png" : "it's (a).png");
    writeFileSync(f, png);
    const r = await get((await media(c, f)).result.url);
    expect(String(r.headers["content-disposition"])).toContain(`filename*=UTF-8''it%27s%20%28a%29${posix ? "%20%2A" : ""}.png`);
    c.ws.close();
  });

  it("origin rules: foreign Host 403, foreign Origin 403, Sec-Fetch-Site cross-site/same-site 403, same-origin/none/no Origin 200", async () => {
    const c = await client();
    const { url } = (await media(c, join(dir, "a.png"))).result;
    expect((await get(url, { host: "evil.example:1" })).status).toBe(403);
    expect((await get(url, { origin: "http://evil.example" })).status).toBe(403);
    expect((await get(url, { origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect((await get(url, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(url, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await get(url, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await get(url, { "sec-fetch-site": "none" })).status).toBe(200);
    expect((await get(url)).status).toBe(200);
    c.ws.close();
  });
});

describe("idle close", () => {
  const IDLE = 150;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const daemons: ReturnType<typeof createDaemon>[] = [];
  afterEach(() => void daemons.splice(0).forEach((d) => d.close()));
  /** A daemon of its own with a short idle close (0: off); its client. */
  const open = async (query: unknown = fakeQuery, idleCloseMs = IDLE) => {
    const d = createDaemon({ webRoot, roots: [webRoot], query: query as never, token, idleCloseMs });
    daemons.push(d);
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const c = await client((d.address() as AddressInfo).port);
    const id = ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
    return { c, id, d };
  };
  const closes = (id: string) => closedQueries.filter((o) => o.sessionId === id || o.resume === id).length;
  const turns = (c: Awaited<ReturnType<typeof client>>, id: string) => c.inbox.filter((m) => m.type === "event" && m.sessionId === id && m.part.type === "turn_result").length;

  it("idle close broadcasts sessions.changed and lists the session live: false", async () => {
    const { c, id } = await open();
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    const item = async () => ((await c.request({ type: "session.list" })) as { result: { sessions: { id: string; live?: false }[] } }).result.sessions.find((s) => s.id === id);
    expect((await item())?.live).toBeUndefined();
    const seen = c.inbox.length;
    await c.request({ type: "session.unsubscribe", sessionId: id });
    await vi.waitFor(() => expect(closes(id)).toBe(1), { timeout: 3000 });
    await vi.waitFor(() => expect(c.inbox.slice(seen).some((m) => m.type === "sessions.changed")).toBe(true));
    expect((await item())?.live).toBe(false);
  });

  it("an idle session no tab holds closes its CLI after the idle time; the next prompt resumes it", async () => {
    const { c, id } = await open();
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    expect(await c.request({ type: "session.unsubscribe", sessionId: id })).toMatchObject({ type: "reply" });
    await vi.waitFor(() => expect(closes(id)).toBe(1), { timeout: 3000 });
    const before = calls.length;
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "again" });
    // The subscribe replays the first turn: 1 + 1 + the new one.
    await vi.waitFor(() => expect(turns(c, id)).toBe(3));
    expect(calls.slice(before).at(-1)).toMatchObject({ resume: id });
  });

  it("a holding subscription (paged too) keeps the CLI; a background one does not", async () => {
    const { c, id } = await open();
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0, paged: true });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    await sleep(IDLE * 3);
    expect(closes(id)).toBe(0);
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0, background: true });
    await vi.waitFor(() => expect(closes(id)).toBe(1), { timeout: 3000 });
  });

  it("the idle time counts from the hold's release, not from the last event", async () => {
    const { c, id } = await open(fakeQuery, 600);
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    await sleep(900);
    expect(closes(id)).toBe(0);
    await c.request({ type: "session.unsubscribe", sessionId: id });
    await sleep(450);
    expect(closes(id)).toBe(0);
    await vi.waitFor(() => expect(closes(id)).toBe(1), { timeout: 3000 });
  });

  it("two connections hold a session: it closes only after both released", async () => {
    const { c, id, d } = await open();
    const other = await client((d.address() as AddressInfo).port);
    for (const x of [c, other]) await x.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    await c.request({ type: "session.unsubscribe", sessionId: id });
    await sleep(IDLE * 3);
    expect(closes(id)).toBe(0);
    other.ws.close();
    await vi.waitFor(() => expect(closes(id)).toBe(1), { timeout: 3000 });
  });

  it("closing a WebSocket releases its holds", async () => {
    const { c, id } = await open();
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    c.ws.close();
    await vi.waitFor(() => expect(closes(id)).toBe(1), { timeout: 3000 });
  });

  it("idleCloseMs 0 never closes", async () => {
    const { c, id } = await open(fakeQuery, 0);
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0, background: true });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    await sleep(IDLE * 4);
    expect(closes(id)).toBe(0);
  });

  it("a session waiting for input is never closed", async () => {
    const { c, id } = await open(permissionQuery);
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0, background: true });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    const req = (await c.waitFor((m) => m.type === "event" && m.part.type === "permission_request")) as { part: { requestId: string } };
    await sleep(IDLE * 3);
    expect(closes(id)).toBe(0);
    const results = permissionResults.length;
    await c.request({ type: "permission.respond", requestId: req.part.requestId, decision: "allow" });
    await vi.waitFor(() => expect(permissionResults.length).toBe(results + 1));
  });

  it("session.unsubscribe stops this connection's events; an unknown session replies {} and is not restored", async () => {
    const { c, id, d } = await open();
    const other = await client((d.address() as AddressInfo).port);
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await other.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.unsubscribe", sessionId: id });
    const seen = c.inbox.length;
    await other.request({ type: "session.prompt", sessionId: id, text: "hi" });
    await other.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    expect(c.inbox.slice(seen).filter((m) => m.type === "event")).toEqual([]);
    expect(await c.request({ type: "session.unsubscribe", sessionId: randomUUID() })).toMatchObject({ type: "reply" });
    expect(c.inbox.slice(seen).filter((m) => m.type === "error")).toEqual([]);
  });
});

describe("keep-alive ping on a side's virtual connection (GH-263)", () => {
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pingDaemon = () => createDaemon({ webRoot, roots: [webRoot], query: fakeQuery as never, token, pingMs: 30, history: { ...history, getSessionInfo: async () => undefined } as never });

  it("a SideSocket survives several ping ticks and still answers", async () => {
    const d = pingDaemon();
    const out: ServerMessage[] = [];
    const ws = new SideSocket((data) => out.push(JSON.parse(data)), () => 0);
    const ping = vi.spyOn(ws, "ping");
    try {
      d.accept(ws);
      await nap(300); // ~10 ticks
      expect(ping.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(ws.readyState).toBe(1);
      ws.emit("message", JSON.stringify({ type: "ping", reqId: "r1" }));
      await vi.waitFor(() => expect(out).toContainEqual({ type: "reply", reqId: "r1", result: {} }));
    } finally {
      ws.close();
      d.close();
    }
  });

  it("SideSocket.ping() answers pong after a microtask; terminate() closes it", async () => {
    const ws = new SideSocket(() => {}, () => 0);
    const events: string[] = [];
    ws.on("pong", () => events.push("pong"));
    ws.on("close", () => events.push("close"));
    ws.ping();
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(events).toEqual(["pong"]);
    ws.terminate();
    expect(events).toEqual(["pong", "close"]);
    expect(ws.readyState).toBe(3);
    ws.ping();
    await Promise.resolve();
    expect(events).toEqual(["pong", "close"]);
  });

  it("a socket whose ping and terminate throw does not crash the pinger and is dropped once", async () => {
    const d = pingDaemon();
    const ping = vi.fn(() => {
      throw new Error("ping unsupported");
    });
    const terminate = vi.fn(() => {
      throw new Error("terminate unsupported");
    });
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), ping, terminate });
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      d.accept(ws);
      await nap(300);
      expect(ping).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
      d.close();
    }
  });
});

describe("uploads after the session id changes under a running CLI", () => {
  const setup = async (extra: Record<string, unknown> = {}) => {
    const P = join(mkdtempSync(join(tmpdir(), "up-")), "uploads");
    const gone = new Set<string>();
    let oldId = "";
    const d = createDaemon({ webRoot, roots: [webRoot], projects: added(webRoot), query: clearQuery as never, token, uploadDir: P, settingsFile: join(mkdtempSync(join(tmpdir(), "cfg-")), "sessions.json"), ...extra, history: { listSessions: (async () => []) as never, getSessionInfo: (async (id: string) => (id === oldId && !gone.has(id) ? { sessionId: id, summary: "s", cwd: webRoot } : undefined)) as never, getSessionMessages: (async () => []) as never, deleteSession: (async (id: string) => void gone.add(id)) as never } });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    const c = await client((d.address() as AddressInfo).port);
    const old = ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
    oldId = old;
    await c.request({ type: "session.subscribe", sessionId: old, sinceSeq: 0 });
    calls.length = 0;
    await c.request({ type: "session.prompt", sessionId: old, text: "hi" });
    await c.waitFor((m) => m.type === "event" && m.part.type === "turn_result");
    await c.request({ type: "session.prompt", sessionId: old, text: "/clear" });
    const cleared = (await c.waitFor((m) => m.type === "event" && m.part.type === "session_cleared")) as Extract<ServerMessage, { type: "event" }>;
    const heir = (cleared.part as { sessionId: string }).sessionId;
    return { P, d, c, old, heir };
  };
  const covered = (path: string, o: { additionalDirectories?: string[] }) => !!o.additionalDirectories?.some((g) => path.startsWith(`${g}${sep}`));

  it("after /clear an upload with the heir's id lands in the folder the running CLI was granted", async () => {
    const { P, d, c, old, heir } = await setup();
    try {
      const granted = calls.at(-1)!;
      const queries = calls.length;
      const up = (await c.request({ type: "fs.upload", name: "after-clear.txt", data: "aGk=", sessionId: heir })) as { result: { path: string } };
      expect(calls.length).toBe(queries); // the CLI was not restarted
      expect(granted.additionalDirectories).toEqual([join(P, old)]);
      expect(covered(up.result.path, granted)).toBe(true);
      // Deleting the parent session keeps the folder while the heir's CLI is still granted it.
      expect(await c.request({ type: "session.delete", sessionId: old })).toMatchObject({ type: "reply" });
      expect(existsSync(up.result.path)).toBe(true);
    } finally {
      d.close();
    }
  });

  it("after /clear and an idle close the heir's next upload lands in the folder its next query is granted", async () => {
    const { P, d, c, old, heir } = await setup({ idleCloseMs: 60 });
    try {
      await c.request({ type: "session.unsubscribe", sessionId: old });
      await c.request({ type: "session.unsubscribe", sessionId: heir });
      await c.request({ type: "session.subscribe", sessionId: heir, sinceSeq: 0, background: true });
      await vi.waitFor(() => expect(closedQueries.some((o) => o.sessionId === old || o.resume === old)).toBe(true), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 150));
      const up = (await c.request({ type: "fs.upload", name: "late.txt", data: "aGk=", sessionId: heir })) as { result: { path: string } };
      expect(up.result.path.startsWith(`${join(P, heir)}${sep}`)).toBe(true);
      const before = calls.length;
      await c.request({ type: "session.prompt", sessionId: heir, text: "read it" });
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
      expect(covered(up.result.path, calls.at(-1)!)).toBe(true);
      // The dormant heir no longer pins the parent's folder: deleting the parent removes it.
      expect(await c.request({ type: "session.delete", sessionId: old })).toMatchObject({ type: "reply" });
      expect(existsSync(join(P, old))).toBe(false);
    } finally {
      d.close();
    }
  });

  it("the sweep spares the parent's folder while a live heir's CLI reads it", async () => {
    const { P, d, c, old, heir } = await setup({ uploadSweepFirstMs: 30, uploadSweepMs: 100 });
    try {
      const up = (await c.request({ type: "fs.upload", name: "f.txt", data: "aGk=", sessionId: heir })) as { result: { path: string } };
      expect(await c.request({ type: "session.delete", sessionId: old })).toMatchObject({ type: "reply" });
      const t = new Date(Date.now() - 48 * 3600_000);
      for (const x of [up.result.path, dirname(up.result.path), join(P, old)]) utimesSync(x, t, t);
      await new Promise((r) => setTimeout(r, 400));
      expect(existsSync(up.result.path)).toBe(true);
    } finally {
      d.close();
    }
  });
});

describe("upload sweep wiring", () => {
  const aged = (P: string, id: string) => {
    const dir = join(P, id, "u-aaaaaa");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "f.txt"), "x");
    const t = new Date(Date.now() - 48 * 3600_000);
    for (const x of [join(dir, "f.txt"), dir, join(P, id)]) utimesSync(x, t, t);
    return join(P, id);
  };
  it("sweeps orphans on a timer and spares live sessions, transcript-only sessions and sessions whose transcript read fails", async () => {
    const P = join(mkdtempSync(join(tmpdir(), "up-")), "uploads");
    const [known, broken, orphan, later] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const d = createDaemon({
      webRoot,
      roots: [webRoot],
      projects: added(webRoot),
      query: fakeQuery as never,
      token,
      uploadDir: P,
      uploadSweepFirstMs: 30,
      uploadSweepMs: 100,
      history: {
        listSessions: (async () => []) as never,
        getSessionInfo: (async (id: string) => {
          if (id === broken) throw new Error("EBUSY");
          return id === known ? { sessionId: id, summary: "s", cwd: webRoot } : undefined;
        }) as never,
        getSessionMessages: (async () => []) as never,
      },
    });
    await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
    try {
      const c = await client((d.address() as AddressInfo).port);
      const live = ((await c.request({ type: "session.create", cwd: webRoot })) as { result: { session: { id: string } } }).result.session.id;
      await c.request({ type: "fs.upload", name: "f.txt", data: "aGk=", sessionId: live });
      const t = new Date(Date.now() - 48 * 3600_000);
      for (const x of [join(P, live), ...readdirSync(join(P, live)).map((n) => join(P, live, n))]) utimesSync(x, t, t);
      const dirs = [known, broken, orphan].map((id) => aged(P, id));
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
        expect(f()).toBe(true);
      };
      await until(() => !existsSync(dirs[2]!));
      expect(existsSync(join(P, live))).toBe(true);
      expect(existsSync(dirs[0]!)).toBe(true);
      expect(existsSync(dirs[1]!)).toBe(true);
      // The interval keeps running.
      const l = aged(P, later);
      await until(() => !existsSync(l));
    } finally {
      d.close();
    }
  });
});

describe("artifact.preview and /artifact (GH-175)", () => {
  const sessionId = "7d4e5f60-8192-4ca3-9db4-c5d6e7f8091a";
  const otherId = "8e5f6071-92a3-4db4-8ec5-d6e7f8091a2b";
  const outside = mkdtempSync(join(tmpdir(), "art-"));
  const page = join(outside, "page.html");
  const pageBytes = "<!doctype html><script>document.title='x'</script><p>hello</p>";
  writeFileSync(page, pageBytes);
  mkdirSync(join(webRoot, "rel"), { recursive: true });
  writeFileSync(join(webRoot, "rel", "p.html"), "<p>relative</p>");
  writeFileSync(join(outside, "n.txt"), "x");
  mkdirSync(join(outside, "d.html"));
  writeFileSync(join(outside, "big.html"), "");
  const MAX = 16 << 20;
  truncateSync(join(outside, "big.html"), MAX + 1);
  let canSymlink = true;
  try {
    symlinkSync(page, join(outside, "link.html"));
  } catch {
    canSymlink = false;
  }
  const publish = (id: string, input: object) => ({ id, input: { title: "T", ...input } });
  const calls_ = [
    publish("toolu_a", { file_path: page }),
    publish("toolu_rel", { file_path: "rel/p.html" }),
    publish("toolu_txt", { file_path: join(outside, "n.txt") }),
    publish("toolu_link", { file_path: join(outside, "link.html") }),
    publish("toolu_gone", { file_path: join(outside, "gone.html") }),
    publish("toolu_dir", { file_path: join(outside, "d.html") }),
    publish("toolu_big", { file_path: join(outside, "big.html") }),
    publish("toolu_read", { action: "read", file_path: page }),
    publish("toolu_err", { file_path: page }),
    publish("toolu_grow", { file_path: join(outside, "grow.html") }),
  ];
  const turn = (sid: string, items: { id: string; input: object }[], extra: { id: string; name: string; input: object }[] = []) => {
    const all = [...items.map((c) => ({ id: c.id, name: "Artifact", input: c.input })), ...extra];
    return [
      { type: "user", uuid: `u-${sid}`, session_id: sid, parent_tool_use_id: null, message: { role: "user", content: "publish" } },
      { type: "assistant", uuid: `a-${sid}`, session_id: sid, parent_tool_use_id: null, message: { id: `m-${sid}`, role: "assistant", content: all.map((c) => ({ type: "tool_use", ...c })), stop_reason: "tool_use" } },
      { type: "user", uuid: `r-${sid}`, session_id: sid, parent_tool_use_id: null, message: { role: "user", content: all.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "ok", ...(c.id === "toolu_err" && { is_error: true }) })) } },
    ];
  };
  const transcripts: Record<string, unknown[]> = {
    [sessionId]: turn(sessionId, calls_, [{ id: "toolu_r", name: "Read", input: { file_path: page } }]),
    [otherId]: turn(otherId, [publish("toolu_other", { file_path: page })]),
  };
  const d = createDaemon({
    webRoot,
    token,
    roots: [webRoot],
    query: fakeQuery as never,
    history: {
      listSessions: (async () => []) as never,
      getSessionInfo: (async (sid: string) => (transcripts[sid] ? { sessionId: sid, cwd: webRoot, summary: "Art" } : undefined)) as never,
      getSessionMessages: (async (sid: string) => transcripts[sid] ?? []) as never,
    },
  });
  const listening = new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
  afterAll(() => d.close());
  const dport = () => (d.address() as AddressInfo).port;
  const open = async () => {
    await listening;
    const c = await client(dport());
    await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
    return c;
  };
  const preview = async (c: Awaited<ReturnType<typeof client>>, partId: unknown, sid: unknown = sessionId) =>
    (await c.request({ type: "artifact.preview", sessionId: sid, partId })) as { type: string; code?: string; result: { url: string; size: number; mtime: number } };
  const get = (url: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: dport(), path: url, method, headers: { "sec-fetch-dest": "iframe", ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (x) => chunks.push(x));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });

  it("replies a nonce URL for a done publish outside the roots; GET serves the bytes with the sandbox headers", async () => {
    const c = await open();
    const r = await preview(c, "toolu_a");
    expect(r.type).toBe("reply");
    expect(r.result.url).toMatch(/^\/artifact\/[0-9a-f]{32}\/page\.html\?v=\d/);
    expect(r.result.size).toBe(pageBytes.length);
    const g = await get(r.result.url);
    expect(g.status).toBe(200);
    expect(g.body.toString()).toBe(pageBytes);
    expect(g.headers).toMatchObject(ARTIFACT_HEADERS);
    expect(g.headers["x-frame-options"]).toBeUndefined();
    const h = await get(r.result.url, {}, "HEAD");
    expect(h.status).toBe(200);
    expect(h.headers["content-length"]).toBe(String(pageBytes.length));
    expect(h.body.length).toBe(0);
    c.ws.close();
  });

  it("resolves a relative file_path against the session cwd", async () => {
    const c = await open();
    const g = await get((await preview(c, "toolu_rel")).result.url);
    expect(g.status).toBe(200);
    expect(g.body.toString()).toBe("<p>relative</p>");
    c.ws.close();
  });

  it("refuses any part not an Artifact publish of this session", async () => {
    const c = await open();
    for (const id of ["toolu_r", "toolu_read", "toolu_err", "nope"]) expect(await preview(c, id), id).toMatchObject({ type: "error", code: "unknown_part" });
    expect(await preview(c, "toolu_other")).toMatchObject({ type: "error", code: "unknown_part" });
    expect(await preview(c, 5)).toMatchObject({ type: "error", code: "bad_request" });
    expect(await preview(c, "toolu_a", "00000000-0000-4000-8000-000000000000")).toMatchObject({ type: "error", code: "unknown_session" });
    c.ws.close();
  });

  it("refuses a non-HTML, a symlink, a directory, a missing and a too large file", async () => {
    const c = await open();
    expect(await preview(c, "toolu_txt")).toMatchObject({ type: "error", code: "unsupported_type" });
    if (canSymlink) expect(await preview(c, "toolu_link")).toMatchObject({ type: "error", code: "path_not_allowed" });
    expect(await preview(c, "toolu_dir")).toMatchObject({ type: "error", code: "not_a_file" });
    expect(await preview(c, "toolu_gone")).toMatchObject({ type: "error", code: "not_found" });
    expect(await preview(c, "toolu_big")).toMatchObject({ type: "error", code: "too_large" });
    c.ws.close();
  });

  it("GET re-checks the file: replaced by a symlink, deleted or grown past the cap after the URL was issued -> 404", async () => {
    const c = await open();
    writeFileSync(join(outside, "swap.html"), "<p>x</p>");
    const url = (await preview(c, "toolu_a")).result.url;
    expect((await get(url)).status).toBe(200);
    if (canSymlink) {
      const keep = readFileSync(page);
      rmSync(page);
      symlinkSync(join(outside, "swap.html"), page);
      expect((await get(url)).status).toBe(404);
      rmSync(page);
      writeFileSync(page, keep);
    }
    const grown = (await preview(c, "toolu_a")).result.url;
    const keep = readFileSync(page);
    truncateSync(page, MAX + 1);
    expect((await get(grown)).status).toBe(404);
    writeFileSync(page, keep);
    const gone = (await preview(c, "toolu_a")).result.url;
    rmSync(page);
    expect((await get(gone)).status).toBe(404);
    writeFileSync(page, keep);
    c.ws.close();
  });

  it("a page that grows while it streams is cut at Content-Length (review attack)", async () => {
    const MiB = 1 << 20;
    const grow = join(outside, "grow.html");
    writeFileSync(grow, Buffer.alloc(15 * MiB, 0x41));
    const c = await open();
    const r = await preview(c, "toolu_grow");
    expect(r.type).toBe("reply");
    const wire = await new Promise<{ cl: number; body: number }>((ok, fail) => {
      const s = connect(dport(), "127.0.0.1", () => s.write(`GET ${r.result.url} HTTP/1.1\r\nhost: 127.0.0.1:${dport()}\r\nsec-fetch-dest: iframe\r\nsec-fetch-site: same-origin\r\nconnection: close\r\n\r\n`));
      let buf = Buffer.alloc(0);
      let appended = false;
      s.on("data", (x) => {
        buf = Buffer.concat([buf, x as Buffer]);
        if (!appended && buf.includes("\r\n\r\n")) {
          appended = true;
          s.pause(); // backpressure: the daemon's stream stops before EOF
          appendFileSync(grow, Buffer.alloc(4 * MiB, 0x42));
          setTimeout(() => s.resume(), 200);
        }
      });
      s.on("end", () => {
        const i = buf.indexOf("\r\n\r\n");
        ok({ cl: Number(/content-length: (\d+)/i.exec(buf.subarray(0, i).toString())![1]), body: buf.length - i - 4 });
      });
      s.on("error", fail);
    });
    c.ws.close();
    expect(wire.cl).toBe(15 * MiB);
    expect(wire.body).toBe(wire.cl);
  });

  it("the page carries X-DNS-Prefetch-Control: off", async () => {
    const c = await open();
    expect((await get((await preview(c, "toolu_a")).result.url)).headers["x-dns-prefetch-control"]).toBe("off");
    c.ws.close();
  });

  it("GET refuses a top-level load, a cross-site or foreign-origin request, an unknown host and POST", async () => {
    const c = await open();
    const { url } = (await preview(c, "toolu_a")).result;
    expect((await get(url, { "sec-fetch-dest": "document" })).status).toBe(403);
    expect((await get(url, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get(url, { origin: "http://evil.example" })).status).toBe(403);
    expect((await get(url, { host: "evil.example" })).status).toBe(403);
    expect((await get(url, {}, "POST")).status).toBe(405);
    c.ws.close();
  });

  it("nonces do not cross routes and die with the connection", async () => {
    const c = await open();
    const { url } = (await preview(c, "toolu_a")).result;
    const nonce = /\/artifact\/([0-9a-f]{32})\//.exec(url)![1]!;
    expect((await get(`/media/${nonce}/x.html`)).status).toBe(404);
    const png = join(webRoot, "rel", "a.png");
    writeFileSync(png, "png");
    const m = (await c.request({ type: "fs.media", path: png })) as { result: { url: string } };
    expect((await get(m.result.url.replace("/media/", "/artifact/"))).status).toBe(404);
    for (const p of [`/artifact/${"0".repeat(32)}/a.html`, "/artifact/abc/a.html", "/artifact/", "/artifact/../index.html"]) {
      const r = await get(p);
      expect(r.status, p).toBe(404);
      expect(r.body.toString()).not.toContain("<h1>app</h1>");
    }
    expect((await get(url)).status).toBe(200);
    c.ws.close();
    await expect.poll(async () => (await get(url)).status).toBe(404);
  });
});

describe("artifact supporting files (GH-335)", () => {
  const sessionId = "9a6071a2-a3b4-4ec5-9fd6-e7f8091a2b3c";
  const site = mkdtempSync(join(webRoot, "art335-")); // the page lives in the session cwd
  const far = mkdtempSync(join(tmpdir(), "far335-")); // outside the cwd and the page's directory
  const cfg = join(site, "cfg"); // the daemon's private dir, inside the page's directory
  const upDir = join(cfg, "uploads"); // the uploads folder lives inside it (POSIX default)
  const outer = mkdtempSync(join(tmpdir(), "outer335-")); // a page directory outside the cwd
  // The CLI's scratchpad of a session: <tmp>/claude/<cwd slug>/<session id>/scratchpad (the slug: every non-alphanumeric of the cwd -> "-").
  const claudeTmp = join(tmpdir(), "claude", webRoot.replace(/[^a-zA-Z0-9]/g, "-"));
  const otherSession = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
  const scratch = join(claudeTmp, sessionId, "scratchpad");
  const otherScratch = join(claudeTmp, otherSession, "scratchpad");
  for (const d of [scratch, otherScratch]) {
    mkdirSync(join(d, "img"), { recursive: true });
    writeFileSync(join(d, "index.html"), "<p>scratch</p>");
    writeFileSync(join(d, "s.css"), "s{x:1}");
    writeFileSync(join(d, "img", "i.png"), "png-bytes");
  }
  mkdirSync(join(site, "img"), { recursive: true });
  mkdirSync(cfg, { recursive: true });
  mkdirSync(join(webRoot, "proj"), { recursive: true });
  const SECRET = "TOP-SECRET-335";
  const index = '<!doctype html><link rel="stylesheet" href="style.css"><p>multi</p>';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  writeFileSync(join(site, "index.html"), index);
  writeFileSync(join(site, "style.css"), "body{color:red}");
  writeFileSync(join(site, "other.css"), "body{color:blue}");
  writeFileSync(join(site, "app.js"), "window.x=1");
  writeFileSync(join(site, "data.json"), '{"a":1}');
  writeFileSync(join(site, "img", "a.png"), png);
  writeFileSync(join(site, "secret.txt"), SECRET);
  writeFileSync(join(site, "big.css"), "");
  truncateSync(join(site, "big.css"), (16 << 20) + 1);
  writeFileSync(join(cfg, "settings.json"), SECRET);
  writeFileSync(join(cfg, "x.html"), "<p>cfg</p>");
  mkdirSync(join(upDir, sessionId), { recursive: true });
  writeFileSync(join(upDir, sessionId, "up.html"), "<p>uploaded</p>");
  writeFileSync(join(upDir, sessionId, "up.css"), "u{x:1}");
  writeFileSync(join(upDir, sessionId, "u.txt"), SECRET);
  writeFileSync(join(outer, "page.html"), "<p>outer</p>");
  writeFileSync(join(outer, "sib.css"), SECRET);
  writeFileSync(join(far, "far.css"), SECRET);
  let canHardLink = true;
  try {
    linkSync(join(far, "far.css"), join(webRoot, "proj", "hard.css")); // a hard link inside the cwd to an outside file
  } catch {
    canHardLink = false;
  }
  writeFileSync(join(webRoot, "proj", "inproj.css"), "p{margin:0}");
  let canSymlink = true;
  try {
    symlinkSync(join(site, "style.css"), join(site, "link.css"));
    symlinkSync(join(far, "far.css"), join(webRoot, "proj", "farfile.css"));
  } catch {
    canSymlink = false; // Windows without the privilege: file links are skipped, directory junctions still run
  }
  let canJunction = true;
  try {
    symlinkSync(far, join(webRoot, "proj", "farlink"), "junction"); // a link inside the cwd that points outside
  } catch {
    canJunction = false;
  }
  const homeFile = join(homedir(), `.claude-ui-gh335-${randomUUID()}.css`);
  let homeOk = true;
  try {
    writeFileSync(homeFile, SECRET);
  } catch {
    homeOk = false;
  }
  const short83 = (p: string) => {
    if (process.platform !== "win32") return undefined;
    try {
      const o = execFileSync("cmd", ["/d", "/c", `for %I in ("${p}") do @echo %~sI`], { encoding: "utf8" }).trim();
      return o && o.toLowerCase() !== p.toLowerCase() ? o : undefined;
    } catch {
      return undefined;
    }
  };
  const farCss = join(far, "far.css");
  const named = {
    "style.css": "style.css",
    "js/app.js": { from: join(site, "app.js"), contentType: "text/html" },
    "img/a.png": "img/a.png",
    "data.json": "data.json",
    "inproj.css": join(webRoot, "proj", "inproj.css"),
    "copied.css": { artifact: "https://claude.ai/artifact/x", path: "a.css" },
    "removed.css": null,
    "../up.css": "style.css",
    "x.exe": "style.css",
    "link.css": "link.css",
    "missing.css": "nope.css",
    "big.css": "big.css",
    "index.html": "secret.txt",
    "cfg.json": "cfg/settings.json",
    "far.css": farCss,
    "farup.css": relative(site, join(far, "far.css")),
    "hard.css": join(webRoot, "proj", "hard.css"),
    "home.css": homeFile,
    "upper.css": farCss.toUpperCase(),
    "short.css": short83(farCss) ?? farCss,
    "farlink.css": join(webRoot, "proj", "farlink", "far.css"),
    "farfile.css": join(webRoot, "proj", "farfile.css"),
  };
  const publish = (id: string, input: object) => ({ id, name: "Artifact", input: { title: "T", ...input } });
  const items = [
    publish("toolu_m", { file_path: join(site, "index.html"), root: site, files: named }),
    publish("toolu_l", { file_path: join(site, "index.html"), root: site, files: [{ path: "style.css" }, { path: "img/a.png" }] }),
    publish("toolu_o", { file_path: join(site, "index.html"), files: { "style.css": join(site, "other.css") } }),
    publish("toolu_e", { file_path: join(site, "index.html"), files: { "style.css": join(site, "style.css") } }),
    publish("toolu_s", { file_path: join(site, "index.html") }),
    publish("toolu_cfg", { file_path: join(cfg, "x.html") }),
    publish("toolu_up", { file_path: join(upDir, sessionId, "up.html"), root: join(upDir, sessionId), files: { "up.css": "up.css", "u.txt": "u.txt", "settings.json": join(cfg, "settings.json") } }),
    publish("toolu_sp", { file_path: join(scratch, "index.html"), root: scratch, files: { "s.css": "s.css", "img/i.png": "img/i.png", "far.css": farCss } }),
    publish("toolu_osp", { file_path: join(otherScratch, "index.html"), root: otherScratch, files: { "s.css": "s.css" } }),
    publish("toolu_outer", { file_path: join(outer, "page.html"), root: outer, files: { "sib.css": "sib.css" } }),
  ];
  const transcript = [
    { type: "user", uuid: "u1", session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: "publish" } },
    { type: "assistant", uuid: "a1", session_id: sessionId, parent_tool_use_id: null, message: { id: "m1", role: "assistant", content: items.map((c) => ({ type: "tool_use", ...c })), stop_reason: "tool_use" } },
    { type: "user", uuid: "r1", session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: items.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "ok", ...(c.id === "toolu_e" && { is_error: true }) })) } },
  ];
  const d = createDaemon({
    webRoot,
    token,
    roots: [webRoot],
    query: fakeQuery as never,
    privateDir: cfg,
    uploadDir: upDir,
    history: {
      listSessions: (async () => []) as never,
      getSessionInfo: (async (sid: string) => (sid === sessionId ? { sessionId: sid, cwd: webRoot, summary: "Art" } : undefined)) as never,
      getSessionMessages: (async (sid: string) => (sid === sessionId ? transcript : [])) as never,
    },
  });
  const listening = new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
  afterAll(() => {
    d.close();
    if (homeOk) rmSync(homeFile, { force: true });
    rmSync(claudeTmp, { recursive: true, force: true });
  });
  const dport = () => (d.address() as AddressInfo).port;
  const open = async () => {
    await listening;
    const c = await client(dport());
    await c.request({ type: "session.subscribe", sessionId, sinceSeq: 0 });
    return c;
  };
  type Reply = { type: string; code?: string; result: { url: string; size: number; mtime: number; unavailable?: string[] } };
  const preview = async (c: Awaited<ReturnType<typeof client>>, partId: string) => (await c.request({ type: "artifact.preview", sessionId, partId })) as Reply;
  const nonceOf = (url: string) => /\/artifact\/([0-9a-f]{32})\//.exec(url)![1]!;
  const get = (url: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: dport(), path: url, method, headers: { "sec-fetch-dest": "iframe", ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (x) => chunks.push(x));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  // What a sandboxed page's subresource load sends: cross-site, no Origin (no-cors) or Origin: null (cors).
  const aget = (nonce: string, rest: string, headers: Record<string, string> = {}, method = "GET") => get(`/artifact/${nonce}/${rest}`, { "sec-fetch-dest": "style", "sec-fetch-site": "cross-site", ...headers }, method);
  const expectedUnavailable = ["copied.css", "../up.css", "x.exe", "missing.css", "big.css", "index.html", "cfg.json", "far.css", "farup.css", "home.css", "upper.css", "short.css", "farlink.css", "farfile.css", "link.css", ...(canHardLink ? ["hard.css"] : [])]; // link.css is a symlink, or missing where links cannot be made

  it("serves each named supporting file under the page's nonce with its type and the asset headers", async () => {
    const c = await open();
    const nonce = nonceOf((await preview(c, "toolu_m")).result.url);
    const cases: [string, string, string, Buffer | string][] = [
      ["style.css", "style", "text/css; charset=utf-8", "body{color:red}"],
      ["js/app.js", "script", "text/javascript; charset=utf-8", "window.x=1"],
      ["img/a.png", "image", "image/png", png],
      ["data.json", "empty", "application/json", '{"a":1}'],
      ["inproj.css", "style", "text/css; charset=utf-8", "p{margin:0}"],
    ];
    for (const [rest, dest, type, body] of cases) {
      const g = await aget(nonce, rest, { "sec-fetch-dest": dest });
      expect(g.status, rest).toBe(200);
      expect(g.body.equals(Buffer.from(body)), rest).toBe(true);
      expect(g.headers["content-type"]).toBe(type);
      expect(g.headers).toMatchObject(ARTIFACT_ASSET_HEADERS);
      expect(g.headers["content-length"]).toBe(String(Buffer.from(body).length));
      const h = await aget(nonce, rest, { "sec-fetch-dest": dest }, "HEAD");
      expect(h.status).toBe(200);
      expect(h.headers["content-length"]).toBe(String(Buffer.from(body).length));
      expect(h.body.length).toBe(0);
    }
    c.ws.close();
  });

  it("a module script, font or fetch (Origin: null, cors) gets Access-Control-Allow-Origin: null", async () => {
    const c = await open();
    const nonce = nonceOf((await preview(c, "toolu_m")).result.url);
    const g = await aget(nonce, "js/app.js", { origin: "null", "sec-fetch-dest": "script", "sec-fetch-mode": "cors" });
    expect(g.status).toBe(200);
    expect(g.headers["access-control-allow-origin"]).toBe("null");
    expect(g.headers["access-control-allow-credentials"]).toBeUndefined();
    c.ws.close();
  });

  it("the list form and root resolve like the Artifact tool", async () => {
    const c = await open();
    const r = await preview(c, "toolu_l");
    expect(r.result.unavailable).toBeUndefined();
    const nonce = nonceOf(r.result.url);
    expect((await aget(nonce, "style.css")).body.toString()).toBe("body{color:red}");
    expect((await aget(nonce, "img/a.png", { "sec-fetch-dest": "image" })).status).toBe(200);
    c.ws.close();
  });

  it("the reply lists what the preview does not serve; removed entries are not listed", async () => {
    const c = await open();
    const r = await preview(c, "toolu_m");
    expect([...r.result.unavailable!].sort()).toEqual([...expectedUnavailable].sort());
    expect(r.result.unavailable).not.toContain("removed.css");
    expect(Object.keys((await preview(c, "toolu_s")).result)).not.toContain("unavailable");
    c.ws.close();
  });

  it("the page of a multi-file publish allows exactly its nonce directory; a single-file page keeps ARTIFACT_CSP", async () => {
    const c = await open();
    const m = await preview(c, "toolu_m");
    const g = await get(m.result.url);
    expect(g.status).toBe(200);
    expect(g.body.toString()).toBe(index);
    const base = `http://127.0.0.1:${dport()}/artifact/${nonceOf(m.result.url)}/`;
    const csp = g.headers["content-security-policy"] as string;
    expect(csp.match(/https?:\/\/[^\s;]+/g)).toEqual(Array(6).fill(base));
    for (const k of ["script-src", "style-src", "img-src", "font-src", "media-src", "connect-src"]) expect(csp.split("; ").find((x) => x.startsWith(k + " ")), k).toContain(base);
    expect(csp.replace("frame-ancestors 'self'", "")).not.toContain("'self'");
    const s = await get((await preview(c, "toolu_s")).result.url);
    expect(s.headers).toMatchObject(ARTIFACT_HEADERS);
    c.ws.close();
  });

  it("ATTACK: paths not named in the call are refused (404), whatever their spelling", async () => {
    const c = await open();
    const nonce = nonceOf((await preview(c, "toolu_m")).result.url);
    const targets = [
      "secret.txt", "STYLE.CSS", "Style.css", "style.css/", "style.css%00", "img%2Fa.png", "img%2fa.png", "img%5Ca.png", "img\\a.png", "./style.css", "img//a.png",
      "%2e%2e/secret.txt", "img/..%2f..%2fsecret.txt", "..%5csecret.txt", "%252e%252e%252fsecret.txt", "C:%5CWindows%5Cwin.ini", "copied.css", "removed.css", "missing.css", "link.css", "cfg.json", "../up.css",
      "far.css", "farup.css", "home.css", "upper.css", "short.css", "farlink.css", "farfile.css", "x.exe", "big.css",
    ];
    for (const t of targets) {
      const r = await aget(nonce, t);
      expect(r.status, t).toBe(404);
      expect(r.body.toString(), t).not.toContain(SECRET);
    }
    const dots = await get(`/artifact/${nonce}/../${nonce}/secret.txt`, { "sec-fetch-dest": "style" });
    expect(dots.status).toBe(404);
    expect(dots.body.toString()).not.toContain(SECRET);
    c.ws.close();
  });

  it("ATTACK: a named source outside the cwd and the page's directory is never served (temp dir, home dir, ..-path, symlink inside the cwd, Windows case and 8.3 aliases)", async () => {
    const c = await open();
    const r = await preview(c, "toolu_m");
    const un = r.result.unavailable!;
    for (const k of ["far.css", "farup.css", "upper.css", "short.css", "farlink.css", "farfile.css", "home.css"]) expect(un, k).toContain(k);
    const nonce = nonceOf(r.result.url);
    for (const k of ["far.css", "farup.css", "upper.css", "short.css", "farlink.css", "farfile.css", "home.css"]) {
      const g = await aget(nonce, k);
      expect(g.status, k).toBe(404);
      expect(g.body.toString(), k).not.toContain(SECRET);
    }
    c.ws.close();
  });

  it("ATTACK: the page name serves the page only as an iframe, never an asset", async () => {
    const c = await open();
    const m = await preview(c, "toolu_m");
    const nonce = nonceOf(m.result.url);
    expect((await aget(nonce, "index.html")).status).toBe(403);
    const g = await get(`/artifact/${nonce}/index.html`);
    expect(g.status).toBe(200);
    expect(g.body.toString()).toBe(index);
    expect(g.body.toString()).not.toContain(SECRET);
    c.ws.close();
  });

  it("ATTACK: an asset GET refuses navigation, frames, a foreign Origin, an unknown Host and POST", async () => {
    const c = await open();
    const nonce = nonceOf((await preview(c, "toolu_m")).result.url);
    for (const dest of ["document", "iframe", "embed", "object"]) expect((await aget(nonce, "style.css", { "sec-fetch-dest": dest })).status, dest).toBe(403);
    expect((await aget(nonce, "style.css", { "sec-fetch-mode": "navigate" })).status).toBe(403);
    expect((await aget(nonce, "style.css", { origin: "http://evil.example" })).status).toBe(403);
    expect((await aget(nonce, "style.css", { host: "evil.example" })).status).toBe(403);
    expect((await aget(nonce, "style.css", {}, "POST")).status).toBe(405);
    c.ws.close();
  });

  it("ATTACK: an asset replaced by a symlink, deleted, grown past the cap or behind a swapped directory after the URL was issued -> 404", async () => {
    const c = await open();
    const nonce = nonceOf((await preview(c, "toolu_m")).result.url);
    const file = join(site, "style.css");
    const keep = readFileSync(file);
    expect((await aget(nonce, "style.css")).status).toBe(200);
    if (canSymlink) {
      rmSync(file);
      symlinkSync(farCss, file);
      const g = await aget(nonce, "style.css");
      expect(g.status).toBe(404);
      expect(g.body.toString()).not.toContain(SECRET);
      rmSync(file);
      writeFileSync(file, keep);
    }
    truncateSync(file, (16 << 20) + 1);
    expect((await aget(nonce, "style.css")).status).toBe(404);
    writeFileSync(file, keep);
    rmSync(file);
    expect((await aget(nonce, "style.css")).status).toBe(404);
    writeFileSync(file, keep);
    if (canJunction) {
      const other = mkdtempSync(join(tmpdir(), "swap335-"));
      writeFileSync(join(other, "a.png"), SECRET);
      const dir = join(site, "img");
      renameSync(dir, join(site, "img-real"));
      symlinkSync(other, dir, "junction");
      const g = await aget(nonce, "img/a.png", { "sec-fetch-dest": "image" });
      expect(g.status).toBe(404);
      expect(g.body.toString()).not.toContain(SECRET);
      rmSync(dir, { recursive: true });
      renameSync(join(site, "img-real"), dir);
    }
    expect((await aget(nonce, "style.css")).status).toBe(200);
    c.ws.close();
  });

  it("the same page in two parts gets two nonces with their own files", async () => {
    const c = await open();
    const a = (await preview(c, "toolu_m")).result.url;
    const b = (await preview(c, "toolu_o")).result.url;
    expect(nonceOf(a)).not.toBe(nonceOf(b));
    expect((await aget(nonceOf(a), "style.css")).body.toString()).toBe("body{color:red}");
    expect((await aget(nonceOf(b), "style.css")).body.toString()).toBe("body{color:blue}");
    c.ws.close();
  });

  it("assets live and die with the nonce and never cross routes", async () => {
    const c = await open();
    const nonce = nonceOf((await preview(c, "toolu_m")).result.url);
    expect((await get(`/media/${nonce}/style.css`, { "sec-fetch-dest": "style" })).status).toBe(404);
    expect((await aget(nonce, "style.css")).status).toBe(200);
    c.ws.close();
    await expect.poll(async () => (await aget(nonce, "style.css")).status).toBe(404);
  });

  it("ATTACK (review A1): a page outside the cwd does not make its directory servable", async () => {
    const c = await open();
    const r = await preview(c, "toolu_outer");
    expect(r.type).toBe("reply");
    expect(r.result.unavailable).toEqual(["sib.css"]);
    const g = await aget(nonceOf(r.result.url), "sib.css");
    expect(g.status).toBe(404);
    expect(g.body.toString()).not.toContain(SECRET);
    c.ws.close();
  });

  it("page and supporting files in this session's scratchpad are served; another session's scratchpad and a file outside it are not", async () => {
    const c = await open();
    const r = await preview(c, "toolu_sp");
    expect(r.type).toBe("reply");
    expect(r.result.unavailable).toEqual(["far.css"]);
    const nonce = nonceOf(r.result.url);
    expect((await get(r.result.url)).body.toString()).toBe("<p>scratch</p>");
    expect((await aget(nonce, "s.css")).body.toString()).toBe("s{x:1}");
    expect((await aget(nonce, "img/i.png", { "sec-fetch-dest": "image" })).body.toString()).toBe("png-bytes");
    const o = await preview(c, "toolu_osp");
    expect(o.type).toBe("reply");
    expect(o.result.unavailable).toEqual(["s.css"]);
    expect((await aget(nonceOf(o.result.url), "s.css")).status).toBe(404);
    c.ws.close();
  });

  it("ATTACK (review A1): a page outside the cwd inside the cwd to an outside file is not served, also when made after the URL was issued", async () => {
    if (!canHardLink) return;
    const c = await open();
    const r = await preview(c, "toolu_m");
    expect(r.result.unavailable).toContain("hard.css");
    const nonce = nonceOf(r.result.url);
    const g = await aget(nonce, "hard.css");
    expect(g.status).toBe(404);
    expect(g.body.toString()).not.toContain(SECRET);
    // made after the URL was issued: style.css gets a second name
    const l2 = join(webRoot, "proj", "style-second.css");
    linkSync(join(site, "style.css"), l2);
    try {
      expect((await aget(nonce, "style.css")).status).toBe(404);
    } finally {
      rmSync(l2);
    }
    expect((await aget(nonce, "style.css")).status).toBe(200);
    c.ws.close();
  });

  it("a page the user uploaded previews although the uploads folder is inside the config dir; the rest of the config dir stays refused", async () => {
    const c = await open();
    const r = await preview(c, "toolu_up");
    expect(r.type).toBe("reply");
    const g = await get(r.result.url);
    expect(g.status).toBe(200);
    expect(g.body.toString()).toBe("<p>uploaded</p>");
    const nonce = nonceOf(r.result.url);
    expect(r.result.unavailable, JSON.stringify(r.result)).not.toContain("up.css");
    expect((await aget(nonce, "up.css")).body.toString()).toBe("u{x:1}");
    expect(r.result.unavailable).toEqual(expect.arrayContaining(["settings.json"]));
    expect((await aget(nonce, "settings.json")).status).toBe(404);
    expect((await preview(c, "toolu_cfg")).code).toBe("path_not_allowed");
    c.ws.close();
  });

  it("a failed publish has no preview", async () => {
    const c = await open();
    expect(await preview(c, "toolu_e")).toMatchObject({ type: "error", code: "unknown_part" });
    c.ws.close();
  });

  it("a page inside the daemon config dir is refused (path_not_allowed)", async () => {
    const c = await open();
    expect(await preview(c, "toolu_cfg")).toMatchObject({ type: "error", code: "path_not_allowed" });
    c.ws.close();
  });
});
