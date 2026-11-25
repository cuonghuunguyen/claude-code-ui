// OpenCode 2 sessions over the daemon's WebSocket: a real daemon, the fake OpenCode 2 binary (fixtures/opencode2) and scripted turns cut from a recording of a real OpenCode 2.3.0.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type Part, type ServerMessage } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createDaemon } from "../src/server.ts";
import { createOpenCode2Engine, mcpRules, modeOfRules, modeRules, rulesOf, OPENCODE2_CAPABILITIES } from "../src/opencode2-engine.ts";
import { mcpName } from "../src/opencode-shared.ts";
import { visualizePluginDir, visualizeSystem } from "../src/visualize.ts";
import { fakeQuery } from "./fake-query.ts";

const BIN2 = fileURLToPath(new URL("./fixtures/opencode2/fake-opencode2-bin.mjs", import.meta.url));
const BIN1 = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const turn = (name: string) => fileURLToPath(new URL(`./fixtures/opencode2/turn-${name}.json`, import.meta.url));
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const REPLY_MS = process.platform === "win32" ? 60_000 : 10_000;
const TEST_MS = process.platform === "win32" ? 90_000 : 30_000;
const until = async (cond: () => boolean, ms = REPLY_MS) => {
  for (let i = 0; i < ms / 25 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastOf = <T,>(a: T[], f: (x: T) => boolean): T | undefined => [...a].reverse().find(f);
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

/** A stored OpenCode 2 session row of the fake. */
const row = (id: string, directory: string, title: string, updated: number, extra = {}) => ({ id, directory, title, time: { created: 1, updated }, ...extra });

async function boot(o: { script?: string[]; data?: object; env?: Record<string, string>; sessionsJson?: object; allowBypass?: boolean; /** The binary (default: the fake OpenCode 2). */ bin?: string; /** The adapter record on disk before the start. */ adapters?: object; /** A folder where the record file should be: a save of the record fails. */ adaptersBroken?: boolean; /** "PROJECT" in `data` stands for the project folder. */ projectDirInData?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oc2-")));
  const project = join(root, "project");
  const other = join(root, "other");
  mkdirSync(project, { recursive: true });
  mkdirSync(other, { recursive: true });
  const logFile = join(root, "fake.log");
  const dataFile = join(root, "data.json");
  const data = JSON.stringify({ sessions: [], messages: {}, ...o.data });
  writeFileSync(dataFile, o.projectDirInData ? data.replaceAll('"PROJECT"', JSON.stringify(project)) : data);
  if (o.sessionsJson) writeFileSync(join(root, "sessions.json"), JSON.stringify(o.sessionsJson));
  const adaptersFile = join(root, "opencode-adapters.json");
  if (o.adapters) writeFileSync(adaptersFile, JSON.stringify(o.adapters));
  if (o.adaptersBroken) mkdirSync(adaptersFile);
  const env: Record<string, string> = { FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE2_DATA: dataFile, FAKE_OPENCODE2_SCRIPT: (o.script ?? []).map(turn).join(","), FAKE_OPENCODE_DATA: dataFile, ...o.env };
  const appSettings = createSettings();
  appSettings.set({ terminalAccess: { enabled: false }, inlineTask: { enabled: false }, fork: { enabled: false } } as never);
  const http = createDaemon({
    webRoot: root,
    roots: [root],
    query: fakeQuery as never,
    token,
    projects: (() => {
      const p = createProjects();
      p.open(project);
      return p;
    })(),
    appSettings,
    settingsFile: join(root, "sessions.json"),
    opencodeAdaptersFile: adaptersFile,
    claudeDir: join(root, "claude"),
    projectsDir: join(root, "claude", "projects"),
    uploadSweepMs: 0,
    allowBypass: o.allowBypass,
    modelListWaitMs: 0,
    history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
    opencode: { command: [process.execPath, o.bin ?? BIN2], env: () => env, listWaitMs: 2000 },
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  let n = 0;
  const request = async (msg: object) => {
    const reqId = `r${++n}`;
    ws.send(JSON.stringify({ ...msg, reqId }));
    await until(() => inbox.some((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId), REPLY_MS);
    return inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) as { type: "reply"; result: any } | { type: "error"; code: string; message: string };
  };
  const ok = async (msg: object) => {
    const r = await request(msg);
    if (r.type === "error") throw new Error(`${r.code}: ${r.message}`);
    return r.result;
  };
  const log = () => {
    try {
      return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
    } catch {
      return [];
    }
  };
  const requests = (method: string, path: RegExp | string) => log().filter((l) => l.type === "request" && l.method === method && (typeof path === "string" ? l.path === path : path.test(l.path)));
  /** The fake server's own route (no authentication). */
  const fake = async (path: string, body?: object) => {
    const port2 = log().find((l) => l.type === "start")!.port;
    await fetch(`http://127.0.0.1:${port2}${path}`, { method: "POST", ...(body && { body: JSON.stringify(body) }) });
  };
  const view = (id: string) => {
    const parts = () => inbox.filter((m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event" && m.sessionId === id).map((m) => m.part);
    const last = (partId: string) => lastOf(parts(), (p) => p.id === partId) as any;
    const find = <T extends Part["type"]>(type: T, test: (p: Extract<Part, { type: T }>) => boolean = () => true) => lastOf(parts(), (p) => p.type === type && test(p as never)) as Extract<Part, { type: T }> | undefined;
    const states = () => parts().filter((p) => p.type === "session_state").map((p) => (p as { state: string }).state);
    return { id, parts, last, find, states, prompt: (text: string, images?: string[]) => ok({ type: "session.prompt", sessionId: id, text, images }) };
  };
  /** A new OpenCode session, subscribed. */
  const open = async (opts: object = {}) => {
    const id: string = (await ok({ type: "session.create", cwd: project, engine: "opencode", ...opts })).session.id;
    await ok({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    return view(id);
  };
  cleanups.push(() => (ws.close(), http.close()));
  const recorded = () => (existsSync(adaptersFile) && !o.adaptersBroken ? JSON.parse(readFileSync(adaptersFile, "utf8")) : {}) as Record<string, number>;
  return { root, project, other, recorded, http, ws, inbox, request, ok, log, requests, fake, open, view, appSettings };
}

/** The fake's `build` agent denials: the rules of a mode end with them. */
const BUILD = [{ action: "browser", resource: "*", effect: "deny" }];
/** The daemon MCP servers' rules of a session that has none attached: every session's servers hidden. */
const MCP = mcpRules("default");
const done = { time: { created: 2, completed: 3 } };
const msg = (id: string, type: "user" | "assistant", extra: object = {}) => ({ id, type, time: { created: 1 }, ...(type === "user" ? { text: "q" } : { agent: "build", model: { id: "m", providerID: "fake" }, content: [{ type: "text", text: "a" }] }), ...extra });
/** A daemon whose OpenCode 2 holds `ses_own` (in the project) with `messages`, listed once. */
async function owned(messages: object[], extra: object = {}, o: Parameters<typeof boot>[0] = {}) {
  const d = await boot(o);
  writeFileSync(join(d.root, "data.json"), JSON.stringify({ ...o.data, sessions: [row("ses_own", d.project, "Owner", 5000, extra)], messages: { ses_own: messages } }));
  await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
  await d.ok({ type: "session.list" });
  await until(() => d.log().some((l) => l.type === "start"));
  for (let i = 0; i < 80 && !(await d.ok({ type: "session.list" })).sessions.some((x: any) => x.id === "ses_own"); i++) await sleep(50);
  return d;
}

describe("OpenCode 2 sessions", { timeout: TEST_MS }, () => {
  it("session.create makes a session on the version 2 server through its /api routes, with the rules of its mode, and tags it with the version 2 capabilities", async () => {
    const d = await boot();
    const created = (await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" })).session;
    expect(created).toMatchObject({ engine: "opencode", capabilities: OPENCODE2_CAPABILITIES });
    expect(created.id).toMatch(/^ses_/);
    const [post] = d.requests("POST", "/api/session");
    expect(post!.body).toEqual({ location: { directory: d.project }, permissions: [...modeRules(created.permissionMode), ...MCP] });
    expect(d.log().filter((l) => l.type === "request" && !l.path.startsWith("/api/"))).toEqual([]);
    expect(d.log().filter((l) => l.type === "start")).toHaveLength(1);
    // Once the binary is known to be version 2, the engine rows say what the version 2 adapter has.
    const engines = (await d.ok({ type: "session.list" })).engines;
    expect(engines.find((e: any) => e.engine === "opencode")).toMatchObject({ capabilities: OPENCODE2_CAPABILITIES });
  });

  it("a Claude-only user never starts the version 2 server, even after the binary's version is known", async () => {
    const d = await boot();
    expect(await d.ok({ type: "opencode.status" })).toMatchObject({ major: 2 });
    await d.ok({ type: "session.list" });
    await sleep(300);
    await d.ok({ type: "session.list" });
    expect(d.log().filter((l) => l.type === "start")).toEqual([]);
  });

  it("a prompt streams the recorded turn: Bash card, permission card, Allow replies once, result, text and one turn result with this turn's tokens", async () => {
    const d = await boot({ script: ["shell"] });
    const s = await d.open();
    await s.prompt("make b.txt");
    await until(() => !!s.find("permission_request"));
    const req = s.find("permission_request")!;
    expect(req).toMatchObject({ tool: "Bash", input: { command: "echo hi > b.txt", description: "write b" }, noEdit: true, settled: false, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo *" }], behavior: "allow", destination: "session" }] });
    expect(req.toolUseId).toBe("call_1");
    expect(s.states().at(-1)).toBe("needs_input");
    await d.ok({ type: "permission.respond", requestId: req.requestId, decision: "allow" });
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    const user = s.find("user_text")!;
    expect(user).toMatchObject({ text: "make b.txt" });
    expect(s.parts().filter((p) => p.type === "user_text")).toHaveLength(1);
    // The id the daemon chose is the one OpenCode stores: a stream echo or a restore adds no second user_text.
    expect(d.requests("POST", `/api/session/${s.id}/prompt`)[0]!.body).toEqual({ id: user.id, text: "make b.txt" });
    expect(d.requests("POST", `/api/session/${s.id}/permission/${req.requestId}/reply`)[0]!.body).toEqual({ decision: "once" });
    expect(s.last("call_1")).toMatchObject({ type: "tool_call", tool: "Bash", status: "done", exitCode: 0, input: { command: "echo hi > b.txt" } });
    expect(s.last("call_1:result")).toMatchObject({ type: "tool_result", isError: false, output: "(no output)" });
    expect(s.parts().some((p) => p.type === "assistant_text" && p.streaming)).toBe(true);
    expect(s.find("assistant_text")).toMatchObject({ text: "done", streaming: false });
    expect(s.last(req.requestId)).toMatchObject({ settled: true, decision: "allow" });
    expect(s.parts().filter((p) => p.type === "turn_result")).toHaveLength(1);
    expect(s.find("turn_result")).toMatchObject({ isError: false, usage: { inputTokens: 20, outputTokens: 10 } });
    // The next turn counts its own tokens only (the recorded `session.usage.updated` totals are never used).
    await s.prompt("again");
    await until(() => s.parts().filter((p) => p.type === "turn_result").length === 2);
    expect(s.find("turn_result")).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });
    expect(s.find("context_usage")).toMatchObject({ usage: { maxTokens: 1000 } });
  });

  it("Deny replies reject with the message and the card is denied, not failed; Allow always replies always", async () => {
    const d = await boot({ script: ["shell", "shell"] });
    const s = await d.open();
    await s.prompt("one");
    await until(() => !!s.find("permission_request"));
    const first = s.find("permission_request")!;
    await d.ok({ type: "permission.respond", requestId: first.requestId, decision: "deny", message: "no thanks" });
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(d.requests("POST", new RegExp(`/permission/${first.requestId}/reply$`))[0]!.body).toEqual({ decision: "reject", message: "no thanks" });
    expect(s.last("call_1")).toMatchObject({ status: "denied" });
    expect(s.last("call_1:result")).toMatchObject({ isError: true, output: expect.stringContaining("no thanks") });
    await s.prompt("two");
    await until(() => s.parts().filter((p) => p.type === "permission_request" && !p.settled).some((p) => p.id !== first.requestId));
    const second = lastOf(s.parts(), (p) => p.type === "permission_request" && p.id !== first.requestId) as Extract<Part, { type: "permission_request" }>;
    await d.ok({ type: "permission.respond", requestId: second.requestId, decision: "allow_always" });
    await until(() => d.requests("POST", new RegExp(`/permission/${second.requestId}/reply$`)).length === 1);
    expect(d.requests("POST", new RegExp(`/permission/${second.requestId}/reply$`))[0]!.body).toEqual({ decision: "always" });
  });

  it("Stop interrupts the running turn: one interrupted marker, no turn result, idle", async () => {
    const d = await boot({ script: ["hold"] });
    const s = await d.open();
    await s.prompt("work");
    await until(() => !!s.find("assistant_text", (p) => p.text === "working"));
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => s.states().at(-1) === "idle");
    await sleep(100);
    expect(d.requests("POST", `/api/session/${s.id}/interrupt`)).toHaveLength(1);
    expect(s.parts().filter((p) => p.type === "turn_interrupted")).toHaveLength(1);
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
    expect(s.parts().some((p) => p.type === "notice")).toBe(false);
  });

  it("Stop while the prompt is still being prepared ends the turn at once and the prompt is never sent", async () => {
    // An effort needs the model list; the fake answers it after 600 ms, so the prompt is being prepared.
    const d = await boot({ script: ["hold"], env: { FAKE_OPENCODE2_MODEL_DELAY: "600" } });
    const s = await d.open();
    await d.ok({ type: "session.setEffort", sessionId: s.id, effort: "low" });
    await s.prompt("work");
    await until(() => s.states().at(-1) === "running");
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => s.states().at(-1) === "idle", 400);
    expect(s.parts().filter((p) => p.type === "turn_interrupted")).toHaveLength(1);
    await sleep(1200);
    expect(d.requests("POST", `/api/session/${s.id}/prompt`)).toEqual([]);
    expect(d.requests("POST", `/api/session/${s.id}/interrupt`)).toEqual([]);
    expect(s.states().at(-1)).toBe("idle");
  });

  it("a prompt sent right after Stop waits for the stopped turn to end, then runs as the next turn", async () => {
    const d = await boot({ script: ["hold"] });
    const s = await d.open();
    await s.prompt("work");
    await until(() => !!s.find("assistant_text", (p) => p.text === "working"));
    await Promise.all([d.ok({ type: "session.interrupt", sessionId: s.id }), s.prompt("next")]);
    await until(() => !!s.find("turn_result") && s.states().at(-1) === "idle");
    expect(s.parts().filter((p) => p.type === "turn_interrupted")).toHaveLength(1);
    const events = d.log().filter((l) => l.type === "request" && l.method === "POST" && /\/(prompt|interrupt)$/.test(l.path)).map((l) => l.path.split("/").pop());
    expect(events).toEqual(["prompt", "interrupt", "prompt"]);
    // The stopped turn's end did not end the next one: its result is the next turn's.
    expect(s.find("turn_result")).toMatchObject({ isError: false, usage: { inputTokens: 10, outputTokens: 5 } });
    expect(s.find("assistant_text", (p) => p.text === "pong")).toBeDefined();
  });

  it("Stop while the prompt request is still on its way waits for OpenCode to take the prompt, then interrupts its turn", async () => {
    // The fake takes the prompt after 500 ms: an interrupt sent at once would find no turn, and the turn would then run unseen.
    const d = await boot({ script: ["hold"], env: { FAKE_OPENCODE2_PROMPT_DELAY: "500" } });
    const s = await d.open();
    await s.prompt("work");
    await until(() => d.requests("POST", `/api/session/${s.id}/prompt`).length === 1);
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => s.states().at(-1) === "idle");
    await until(() => d.log().some((l) => l.type === "turn"));
    expect(d.log().filter((l) => l.type === "turn")).toEqual([{ type: "turn", end: "interrupted" }]);
    expect(s.parts().filter((p) => p.type === "turn_interrupted")).toHaveLength(1);
  });

  it("a Stop whose end event is lost (the stream dropped) ends as interrupted when the daemon reads the session again", async () => {
    const d = await boot({ script: ["hold"], env: { FAKE_OPENCODE2_SWALLOW_STOP: "1" } });
    const s = await d.open();
    await s.prompt("work");
    await until(() => !!s.find("assistant_text", (p) => p.text === "working"));
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await sleep(300);
    expect(s.states().at(-1)).toBe("running");
    await d.fake("/__drop");
    await until(() => s.states().at(-1) === "idle", 10_000);
    expect(s.parts().filter((p) => p.type === "turn_interrupted")).toHaveLength(1);
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
  });

  it("a prompt queued behind a stopped turn is not sent when Stop is pressed again before it went", async () => {
    const d = await boot({ script: ["hold"], env: { FAKE_OPENCODE2_SWALLOW_STOP: "1" } });
    const s = await d.open();
    await s.prompt("work");
    await until(() => !!s.find("assistant_text", (p) => p.text === "working"));
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await s.prompt("next");
    await sleep(200);
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await sleep(1500);
    expect(d.requests("POST", `/api/session/${s.id}/prompt`).map((r) => r.body.text)).toEqual(["work"]);
    expect(s.states().at(-1)).toBe("idle");
  });

  it("a failed turn shows one warning with the first line of OpenCode's error, the retry state, and a turn result with isError", async () => {
    const d = await boot({ script: ["fail"] });
    const s = await d.open();
    await s.prompt("go");
    await until(() => !!s.find("turn_result") && s.states().at(-1) === "idle");
    const notices = s.parts().filter((p) => p.type === "notice");
    expect(notices.map((p) => p.id)).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: "warning", text: "Model not found: fake/zzz." });
    expect(s.parts().some((p) => p.type === "model_retry" && p.retry?.attempt === 1 && p.retry.message === "Rate limited")).toBe(true);
    expect(s.find("model_retry")).toMatchObject({ retry: null });
    expect(s.find("turn_result")).toMatchObject({ isError: true });
  });

  it("a mode change replaces the session's rules in OpenCode before the next prompt; the model and effort go as a model switch before the prompt", async () => {
    const d = await boot();
    const s = await d.open();
    await d.ok({ type: "session.setPermissionMode", sessionId: s.id, mode: "acceptEdits" });
    expect(d.requests("PATCH", `/api/session/${s.id}`).map((r) => r.body)).toEqual([{ permissions: [...modeRules("acceptEdits"), ...BUILD, ...MCP] }]);
    await d.ok({ type: "session.setModel", sessionId: s.id, model: "fake/m" });
    await d.ok({ type: "session.setEffort", sessionId: s.id, effort: "low" });
    await s.prompt("hi");
    await until(() => !!s.find("turn_result"));
    const order = d.log().filter((l) => l.type === "request" && l.method !== "GET" && l.path.startsWith(`/api/session/${s.id}`)).map((l) => `${l.method} ${l.path.slice(`/api/session/${s.id}`.length)}`);
    expect(order).toEqual(["PATCH ", "POST /model", "POST /prompt"]);
    expect(d.requests("POST", `/api/session/${s.id}/model`)[0]!.body).toEqual({ model: { providerID: "fake", id: "m", variant: "low" } });
    // Nothing changed since: the next prompt sends no model switch.
    await s.prompt("again");
    await until(() => s.parts().filter((p) => p.type === "turn_result").length === 2);
    expect(d.requests("POST", `/api/session/${s.id}/model`)).toHaveLength(1);
    // An effort the model lacks sends no variant (fake/n has none).
    await d.ok({ type: "session.setModel", sessionId: s.id, model: "fake/n" });
    await s.prompt("third");
    await until(() => s.parts().filter((p) => p.type === "turn_result").length === 3);
    expect(d.requests("POST", `/api/session/${s.id}/model`)[1]!.body).toEqual({ model: { providerID: "fake", id: "n" } });
  });

  it("an image goes as an inline file of the prompt", async () => {
    const d = await boot();
    const s = await d.open();
    await s.prompt("look", [PNG]);
    await until(() => !!s.find("turn_result"));
    const body = d.requests("POST", `/api/session/${s.id}/prompt`)[0]!.body;
    expect(body).toMatchObject({ text: "look", files: [{ uri: PNG, source: { type: "inline" } }] });
    expect(s.find("user_text")).toMatchObject({ images: [PNG] });
  });

  it("models.list gives the default and the connected models with their effort levels", async () => {
    const d = await boot();
    const models = (await d.ok({ type: "models.list", cwd: d.project, engine: "opencode" })).models;
    expect(models[0]).toMatchObject({ value: "default", displayName: "Default (fake Fake M)", supportedEffortLevels: ["low", "high"] });
    expect(models.slice(1)).toMatchObject([{ value: "fake/m", displayName: "Fake M", group: "fake", supportedEffortLevels: ["low", "high"] }, { value: "fake/n", displayName: "Fake N", group: "fake" }]);
    expect(models[2].supportsEffort).toBeUndefined();
  });
});

describe("OpenCode 2 sessions: list and restore", { timeout: TEST_MS }, () => {
  const stored = [
    { id: "msg_u1", type: "user", time: { created: 1 }, text: "list files" },
    { id: "msg_a1", type: "assistant", time: { created: 2 }, agent: "build", model: { id: "m", providerID: "fake" }, tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }, content: [{ type: "reasoning", text: "thinking" }, { type: "tool", id: "call_9", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a.txt" }], metadata: { exit: 0 } }, time: { created: 3, ran: 4, completed: 5 } }, { type: "tool", id: "call_10", name: "shell", state: { status: "error", input: { command: "rm x" }, error: { type: "permission.rejected", message: "no" } }, time: { created: 3 } }, { type: "text", text: "Found a.txt" }] },
  ];
  const data = (project: string, other: string) => ({
    sessions: [row("ses_one", project, "Listed files", 5000), row("ses_child", project, "subagent", 9000, { parentID: "ses_one" }), row("ses_other", other, "Elsewhere", 7000)],
    messages: { ses_one: stored },
  });

  /** A boot whose fake already holds the sessions of `data` (the fake reads its data when its first request starts it). */
  async function bootWith(extra: Parameters<typeof boot>[0] = {}) {
    const d = await boot(extra);
    writeFileSync(join(d.root, "data.json"), JSON.stringify(data(d.project, d.other)));
    return d;
  }

  it("a prompt right after opening a stored session is not ended by the open's resync whose reads began before the prompt", async () => {
    const d = await bootWith({ script: ["hold"], env: { FAKE_OPENCODE2_MESSAGE_DELAY: "400" } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await until(() => d.log().some((l) => l.type === "start"));
    await d.ok({ type: "session.subscribe", sessionId: "ses_one", sinceSeq: 0 });
    const s = d.view("ses_one");
    await until(() => !!s.find("assistant_text"));
    // The resync after the stream connected is reading (the message read is held 400 ms); the prompt goes meanwhile.
    await until(() => d.requests("GET", "/api/session/ses_one/message").length >= 2);
    await s.prompt("work");
    await until(() => !!s.find("assistant_text", (p) => p.text === "working"));
    await sleep(800);
    // OpenCode still runs the held turn: the session must not have been ended as idle with a result.
    expect(d.log().some((l) => l.type === "turn")).toBe(false);
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
    expect(s.states().at(-1)).toBe("running");
  });

  it("session.list shows the root sessions of the project's folder, none of a subagent or another folder, and prunes no settings entry", async () => {
    // Saved long ago: a recent entry is kept by the prune anyway (PRUNE_GRACE_MS).
    const sessionsJson = { ses_old: { model: "default", permissionMode: "default", effort: "default", saved: Date.now() - 3 * 24 * 3600 * 1000 } };
    const d = await bootWith({ sessionsJson });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await until(() => d.inbox.some((m) => m.type === "sessions.changed"));
    const listed = (await d.ok({ type: "session.list" })).sessions.filter((s: any) => s.engine === "opencode");
    expect(listed.map((s: any) => [s.id, s.title])).toEqual([["ses_one", "Listed files"]]);
    expect(listed[0]).toMatchObject({ cwd: d.project, capabilities: OPENCODE2_CAPABILITIES, transcript: true });
    // `ses_old` is no session of OpenCode 2's list (it may be an OpenCode 1 one): its entry stays.
    expect(JSON.parse(readFileSync(join(d.root, "sessions.json"), "utf8"))).toHaveProperty("ses_old");
  });

  it("a stored session opens with its messages as parts, in order, with the ids a live turn would have", async () => {
    const d = await bootWith();
    // The fake read its data at start: the first request starts it, so open after a list.
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await until(() => d.log().some((l) => l.type === "start"));
    await d.ok({ type: "session.subscribe", sessionId: "ses_one", sinceSeq: 0 });
    const s = d.view("ses_one");
    await until(() => !!s.find("assistant_text"));
    // The history is read at the open and again once the stream connected; a re-emit of a part id replaces it.
    const kinds = [...new Set(s.parts().filter((p) => p.type !== "session_state" && p.type !== "context_usage" && p.type !== "commands" && p.type !== "agents").map((p) => `${p.type}:${p.id}`))];
    expect(kinds).toEqual(["user_text:msg_u1", "thinking:msg_a1:reasoning:0", "tool_call:call_9", "tool_result:call_9:result", "tool_call:call_10", "tool_result:call_10:result", "assistant_text:msg_a1:text:0"]);
    expect(s.last("call_9")).toMatchObject({ tool: "Bash", status: "done", exitCode: 0, input: { command: "ls" } });
    expect(s.last("call_10")).toMatchObject({ status: "denied" });
    expect(s.last("msg_a1:text:0")).toMatchObject({ text: "Found a.txt", streaming: false });
    expect(s.states().at(-1)).toBe("idle");
  });

  it("a permission request of a subagent's session is shown and answered under that session's id", async () => {
    const d = await bootWith({ script: ["child-permission"] });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await until(() => d.log().some((l) => l.type === "start"));
    await d.ok({ type: "session.subscribe", sessionId: "ses_one", sinceSeq: 0 });
    const s = d.view("ses_one");
    await until(() => !!s.find("assistant_text"));
    await s.prompt("run the subagent");
    await until(() => !!s.find("permission_request"));
    const req = s.find("permission_request")!;
    expect(req).toMatchObject({ tool: "Bash", input: { command: "ls -la" }, suggestions: [{ rules: [{ toolName: "Bash", ruleContent: "ls *" }] }] });
    expect(s.states().at(-1)).toBe("needs_input");
    await d.ok({ type: "permission.respond", requestId: req.requestId, decision: "allow" });
    await until(() => !!s.find("turn_result") && s.states().at(-1) === "idle");
    expect(d.requests("POST", `/api/session/ses_child/permission/${req.requestId}/reply`)[0]!.body).toEqual({ decision: "once" });
    expect(d.requests("POST", new RegExp(`/api/session/ses_one/permission/`))).toEqual([]);
  });

  it("Don't ask on OpenCode 2: an ask of the session or of its subagent is rejected at once with a message, the card shows denied and no needs-input", async () => {
    const d = await boot({ script: ["shell"] });
    const s = await d.open();
    await d.ok({ type: "session.setPermissionMode", sessionId: s.id, mode: "dontAsk" });
    expect(d.requests("PATCH", `/api/session/${s.id}`).at(-1)!.body.permissions.slice(0, 2)).toEqual([{ action: "claude-ui-mode", resource: "dontAsk", effect: "deny" }, ...modeRules("default").slice(0, 1)]);
    expect(modeOfRules(rulesOf("dontAsk", false))).toBe("dontAsk");
    expect(modeOfRules(rulesOf("default", false))).toBe("default");
    await s.prompt("make b.txt");
    await until(() => d.requests("POST", new RegExp(`/api/session/${s.id}/permission/.+/reply`)).length === 1);
    expect(d.requests("POST", new RegExp(`/api/session/${s.id}/permission/.+/reply`))[0]!.body).toMatchObject({ decision: "reject", message: expect.stringContaining("Don't ask") });
    expect(s.find("permission_request")).toBeUndefined();
    expect(s.states()).not.toContain("needs_input");
    expect(s.last("call_1")).toMatchObject({ status: "denied" });

    const c = await bootWith({ script: ["child-permission"] });
    await c.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await c.ok({ type: "session.list" });
    await until(() => c.log().some((l) => l.type === "start"));
    await c.ok({ type: "session.subscribe", sessionId: "ses_one", sinceSeq: 0 });
    const k = c.view("ses_one");
    await until(() => !!k.find("assistant_text"));
    await c.ok({ type: "session.setPermissionMode", sessionId: "ses_one", mode: "dontAsk" });
    await k.prompt("run the subagent");
    await until(() => c.requests("POST", /^\/api\/session\/ses_child\/permission\/.+\/reply$/).length === 1);
    expect(c.requests("POST", /^\/api\/session\/ses_child\/permission\/.+\/reply$/)[0]!.body).toMatchObject({ decision: "reject" });
    expect(k.find("permission_request")).toBeUndefined();
    expect(k.states()).not.toContain("needs_input");
  });

  it("a question of a subagent's session shows in the session and is answered under the subagent's id", async () => {
    const d = await bootWith({ script: ["child-question"] });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await until(() => d.log().some((l) => l.type === "start"));
    await d.ok({ type: "session.subscribe", sessionId: "ses_one", sinceSeq: 0 });
    const s = d.view("ses_one");
    await until(() => !!s.find("assistant_text"));
    await s.prompt("run the subagent");
    await until(() => !!s.find("question"));
    const q = s.find("question")!;
    await d.ok({ type: "question.respond", requestId: q.requestId, answers: { "Pick a color?": "Red" } });
    await until(() => !!s.find("turn_result") && s.states().at(-1) === "idle");
    expect(d.requests("POST", `/api/session/ses_child/form/${q.requestId}/reply`)[0]!.body).toEqual({ answer: { q0: "Red" } });
  });

  it("an event stream that drops is read again from OpenCode: nothing shows twice and the session works afterwards", async () => {
    const d = await bootWith();
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await until(() => d.log().some((l) => l.type === "start"));
    await d.ok({ type: "session.subscribe", sessionId: "ses_one", sinceSeq: 0 });
    const s = d.view("ses_one");
    await until(() => !!s.find("assistant_text"));
    const reads = () => d.requests("GET", "/api/session/ses_one/message").length;
    // The first read is the open, the second the one after the stream connected.
    await until(() => reads() >= 2);
    const before = reads();
    await d.fake("/__drop");
    // The daemon reconnects after a second and reads the session again (events in the gap are lost).
    await until(() => reads() > before, 10_000);
    expect(new Set(s.parts().filter((p) => p.type === "user_text").map((p) => p.id))).toEqual(new Set(["msg_u1"]));
    await s.prompt("more");
    await until(() => !!s.find("turn_result") && s.states().at(-1) === "idle");
  });
});

// The adapter record (ADR 0015): which OpenCode version a session belongs to, and what a binary of the other version shows.
describe("OpenCode 2 sessions: adapter record and version mismatch", { timeout: TEST_MS }, () => {
  const stored = [{ id: "msg_u1", type: "user", time: { created: 1 }, text: "old question" }, { id: "msg_a1", type: "assistant", time: { created: 2 }, agent: "build", model: { id: "m", providerID: "fake" }, content: [{ type: "text", text: "old answer" }] }];
  const v1row = (id: string, directory: string, updated = 5000) => ({ id, slug: id, projectID: "global", directory, title: "Old session", version: "1.18.34", time: { created: 1, updated } });
  /** What a user's old OpenCode 1 session looks like once OpenCode 2 imported it: the same id in the version 2 store. */
  const imported = (project: string) => ({ sessions: [row("ses_old", project, "Old session", 5000)], messages: { ses_old: stored } });
  const listFirst = async (d: Awaited<ReturnType<typeof boot>>) => {
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await until(() => d.log().some((l) => l.type === "start"));
  };
  const entry = { model: "default", permissionMode: "default", effort: "default" };

  it("session.create records the session as version 2 in opencode-adapters.json", async () => {
    const d = await boot();
    const s = await d.open();
    expect(d.recorded()).toEqual({ [s.id]: 2 });
  });

  it("a session that cannot be recorded is not created: the error names the record", async () => {
    const d = await boot({ adaptersBroken: true });
    const r = await d.request({ type: "session.create", cwd: d.project, engine: "opencode" });
    expect(r).toMatchObject({ type: "error", code: "opencode_failed" });
    expect((r as { message: string }).message).toContain("which OpenCode version");
  });

  it("a session with no record opens with version 2 when version 2 has it; its first prompt records version 2 before OpenCode gets the prompt", async () => {
    const d = await boot({ script: ["hold"] });
    writeFileSync(join(d.root, "data.json"), JSON.stringify(imported(d.project)));
    await listFirst(d);
    await d.ok({ type: "session.subscribe", sessionId: "ses_old", sinceSeq: 0 });
    const s = d.view("ses_old");
    await until(() => !!s.find("assistant_text", (p) => p.text === "old answer"));
    expect(d.recorded()).toEqual({});
    await s.prompt("continue");
    await until(() => d.requests("POST", "/api/session/ses_old/prompt").length === 1);
    expect(d.recorded()).toEqual({ ses_old: 2 });
  });

  it("a prompt whose record cannot be saved is not sent to OpenCode and the session shows why", async () => {
    const d = await boot({ script: ["hold"], adaptersBroken: true });
    writeFileSync(join(d.root, "data.json"), JSON.stringify(imported(d.project)));
    await listFirst(d);
    await d.ok({ type: "session.subscribe", sessionId: "ses_old", sinceSeq: 0 });
    const s = d.view("ses_old");
    await until(() => !!s.find("assistant_text"));
    await s.prompt("continue");
    await until(() => s.parts().some((p) => p.type === "notice" && p.text.includes("which OpenCode version")));
    await sleep(300);
    expect(d.requests("POST", "/api/session/ses_old/prompt")).toEqual([]);
    expect(s.states().at(-1)).toBe("idle");
    // A second prompt meets the same failed save: the failure is not remembered as a saved record.
    await s.prompt("again");
    await sleep(1500);
    expect(d.requests("POST", "/api/session/ses_old/prompt")).toEqual([]);
  });

  it("a session with no record that version 2 lacks, but this daemon knows, says it needs an OpenCode 1 binary; an unknown id is no session", async () => {
    const d = await boot({ sessionsJson: { ses_v1only: { ...entry, saved: Date.now() } } });
    await listFirst(d);
    const r = await d.request({ type: "session.subscribe", sessionId: "ses_v1only", sinceSeq: 0 });
    expect(r).toMatchObject({ type: "error", code: "opencode_version_mismatch" });
    expect((r as { message: string }).message).toContain("OpenCode 1 binary");
    expect(await d.request({ type: "session.subscribe", sessionId: "ses_nowhere", sinceSeq: 0 })).toMatchObject({ type: "error", code: "unknown_session" });
  });

  it("a failed read of a session (the server answers 500) is not 'needs an OpenCode 1 binary'; the next open works", async () => {
    const d = await boot({ sessionsJson: { ses_old: { ...entry, saved: Date.now() } }, env: { FAKE_OPENCODE2_FAIL: JSON.stringify({ ses_old: 1 }) } });
    writeFileSync(join(d.root, "data.json"), JSON.stringify(imported(d.project)));
    await listFirst(d);
    // The list read of the folder is no GET of the session row: the first open meets the failure.
    const first = await d.request({ type: "session.subscribe", sessionId: "ses_old", sinceSeq: 0 });
    expect(first).toMatchObject({ type: "error", code: "unknown_session" });
    const second = await d.request({ type: "session.subscribe", sessionId: "ses_old", sinceSeq: 0 });
    expect(second.type).toBe("reply");
  });

  it("under an OpenCode 1 binary a version 2 session says it needs an OpenCode 2 binary and OpenCode 1 is never asked for it; its settings entry is not pruned", async () => {
    const old = Date.now() - 3 * 24 * 3600 * 1000;
    const d = await boot({
      bin: BIN1,
      adapters: { ses_two: 2 },
      sessionsJson: { ses_two: { ...entry, saved: old }, ses_gone: { ...entry, saved: old } },
    });
    writeFileSync(join(d.root, "data.json"), JSON.stringify({ sessions: [v1row("ses_one", d.project)], messages: {} }));
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    // The list that answered for the folder (the first one does not wait for OpenCode) is the one that prunes.
    let listed: any[] = [];
    await until(() => d.log().some((l) => l.type === "start"));
    for (let i = 0; i < 80 && !listed.some((x) => x.id === "ses_one"); i++) (await sleep(50), (listed = (await d.ok({ type: "session.list" })).sessions));
    expect(listed.some((x) => x.id === "ses_one")).toBe(true);
    const r = await d.request({ type: "session.subscribe", sessionId: "ses_two", sinceSeq: 0 });
    expect(r).toMatchObject({ type: "error", code: "opencode_version_mismatch" });
    expect((r as { message: string }).message).toContain("OpenCode 2 binary");
    expect(d.requests("GET", /^\/session\/ses_two/)).toEqual([]);
    // The version 1 list knows neither ses_two (a version 2 session) nor ses_gone: only the gone one is pruned.
    const kept = JSON.parse(readFileSync(join(d.root, "sessions.json"), "utf8"));
    expect(Object.keys(kept)).toContain("ses_two");
    expect(Object.keys(kept)).not.toContain("ses_gone");
  });

  it("changing opencode.path from the OpenCode 2 binary to an OpenCode 1 binary pushes sessions.changed and the next list has the OpenCode 1 sessions", async () => {
    const d = await boot();
    const wrap = (name: string, bin: string, dataEnv: string, data: object, version: string) => {
      const dataFile = join(d.root, `${name}.json`);
      writeFileSync(dataFile, JSON.stringify(data));
      const file = join(d.root, name);
      writeFileSync(file, `#!/bin/sh\nFAKE_OPENCODE_VERSION=${version} ${dataEnv}=${JSON.stringify(dataFile)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(bin)} "$@"\n`);
      chmodSync(file, 0o755);
      return file;
    };
    const v2 = wrap("oc2", BIN2, "FAKE_OPENCODE2_DATA", { sessions: [row("ses_v2", d.project, "From two", 5000)], messages: {} }, "2.3.0");
    const v1 = wrap("oc1", BIN1, "FAKE_OPENCODE_DATA", { sessions: [v1row("ses_v1", d.project)], messages: {} }, "1.18.34");
    const titles = async () => (await d.ok({ type: "session.list" })).sessions.filter((x: any) => x.engine === "opencode").map((x: any) => x.id);
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" }, opencode: { path: v2 } } });
    await d.ok({ type: "session.list" });
    await until(() => d.inbox.some((m) => m.type === "sessions.changed"));
    for (let i = 0; i < 80 && !(await titles()).includes("ses_v2"); i++) await sleep(50);
    expect(await titles()).toEqual(["ses_v2"]);
    const seen = d.inbox.length;
    await d.ok({ type: "settings.set", patch: { opencode: { path: v1 } } });
    await until(() => d.inbox.slice(seen).some((m) => m.type === "sessions.changed"));
    // The version 1 server starts on this list; its own push follows when it answered.
    for (let i = 0; i < 100 && !(await titles()).includes("ses_v1"); i++) await sleep(50);
    expect(await titles()).toEqual(["ses_v1"]);
  });
});

describe("OpenCode 2 sessions: rename, archive, delete and Aside", { timeout: TEST_MS }, () => {
  const link = (d: Awaited<ReturnType<typeof boot>>, id: string) => JSON.parse(readFileSync(join(d.root, "sessions.json"), "utf8"))[id];

  it("rename, archive, unarchive and delete go to OpenCode 2; the list shows them and the delete drops the adapter record", async () => {
    const d = await owned([msg("msg_u1", "user")]);
    await d.ok({ type: "session.subscribe", sessionId: "ses_own", sinceSeq: 0 });
    await d.ok({ type: "session.prompt", sessionId: "ses_own", text: "hi" });
    await until(() => d.recorded().ses_own === 2);
    await d.ok({ type: "session.rename", sessionId: "ses_own", title: " New name " });
    expect(d.requests("PATCH", "/api/session/ses_own").map((r) => r.body).filter((b) => b.title)).toEqual([{ title: "New name" }]);
    await d.ok({ type: "session.archive", sessionId: "ses_own", archived: true });
    expect((await d.ok({ type: "session.list" })).sessions.find((x: any) => x.id === "ses_own")).toMatchObject({ title: "New name", archived: true });
    await d.ok({ type: "session.archive", sessionId: "ses_own", archived: false });
    expect(d.requests("PATCH", "/api/session/ses_own").map((r) => r.body).filter((b) => "archived" in b)).toEqual([{ archived: true }, { archived: false }]);
    expect((await d.ok({ type: "session.list" })).sessions.find((x: any) => x.id === "ses_own").archived).toBe(false);
    await until(() => (d.view("ses_own").states().at(-1) === "idle"));
    await d.ok({ type: "session.delete", sessionId: "ses_own" });
    expect(d.requests("DELETE", "/api/session/ses_own")).toHaveLength(1);
    expect((await d.ok({ type: "session.list" })).sessions).toEqual([]);
    expect(d.recorded()).toEqual({});
  });

  it("deleting a session OpenCode 2 no longer has removes it from claude-ui", async () => {
    const d = await owned([msg("msg_u1", "user")]);
    await d.ok({ type: "session.subscribe", sessionId: "ses_own", sinceSeq: 0 });
    // Deleted in OpenCode 2's own app after this daemon opened it.
    await d.fake("/__forget/ses_own");
    await d.ok({ type: "session.delete", sessionId: "ses_own" });
    expect(d.requests("DELETE", "/api/session/ses_own")).toHaveLength(1);
    expect(await d.request({ type: "session.subscribe", sessionId: "ses_own", sinceSeq: 0 })).toMatchObject({ type: "error" });
  });

  it("an Aside forks the whole history, titles and records the fork, denies edits before its prompt; closing deletes it", async () => {
    const d = await owned([msg("msg_u1", "user"), msg("msg_a1", "assistant", done)]);
    await d.ok({ type: "session.subscribe", sessionId: "ses_own", sinceSeq: 0 });
    const { session } = await d.ok({ type: "aside.open", sessionId: "ses_own", text: "what is this?\nmore" });
    expect(d.requests("POST", "/api/session/ses_own/fork")[0]!.body ?? {}).toEqual({});
    expect(session.id).not.toBe("ses_own");
    expect(d.requests("PATCH", `/api/session/${session.id}`)[0]!.body).toEqual({ title: "what is this?" });
    expect(d.recorded()[session.id]).toBe(2);
    expect(link(d, session.id)).toMatchObject({ ownerId: "ses_own", readOnly: true });
    await until(() => d.requests("POST", `/api/session/${session.id}/prompt`).length === 1);
    // The rules of the Aside's mode, edits denied last (the last matching rule wins in OpenCode 2), written before the prompt.
    const writes = d.log().filter((l) => l.type === "request" && l.path.startsWith(`/api/session/${session.id}`) && (l.method === "PATCH" ? !!l.body.permissions : l.path.endsWith("/prompt")));
    expect(writes.map((l) => l.method)).toEqual(["PATCH", "POST"]);
    expect(writes[0]!.body.permissions).toEqual([...modeRules("default"), ...BUILD, ...MCP, { action: "edit", resource: "*", effect: "deny" }]);
    await d.ok({ type: "aside.close", sessionId: session.id });
    await until(() => d.requests("DELETE", `/api/session/${session.id}`).length > 0);
    expect((await d.ok({ type: "session.list" })).sessions.map((s: any) => s.id)).toEqual(["ses_own"]);
  });

  it("a Fork run's fork is hidden from the list, restores under its call with its assistant steps only, and is deleted with its parent", async () => {
    const call = { type: "tool", id: "call_fork", name: "claude-ui-ownxxxxxxx_fork", state: { status: "completed", input: { description: "probe fork", prompt: "count" }, content: [{ type: "text", text: "fork answer" }] }, time: { ran: 2, completed: 3 } };
    const parent = [msg("msg_u1", "user"), msg("msg_a1", "assistant", { ...done, content: [call] })];
    // The copied history (3 messages), OpenCode's fork notice, the fork's prompt (not shown), then its own reply.
    const copied = [msg("msg_c_1", "user"), msg("msg_c_2", "assistant", { ...done, content: [{ type: "text", text: "copied reply" }] }), msg("msg_c_3", "user", { text: "copy" })];
    const own = [{ id: "msg_n1", type: "synthetic", text: "<fork-notice>" }, msg("msg_f_u", "user", { text: "You are a fork of the conversation" }), msg("msg_f_a", "assistant", { ...done, content: [{ type: "text", text: "fork answer" }] })];
    const d = await boot({ sessionsJson: { ses_fork: { forkOf: { sessionId: "ses_own", callId: "call_fork", prefix: 3 } } }, projectDirInData: true, adapters: { ses_own: 2, ses_fork: 2 }, data: { sessions: [row("ses_own", "PROJECT", "Owner", 5000), row("ses_fork", "PROJECT", "Fork: probe fork", 6000, { metadata: { "claude-ui.forkOf": "ses_own" } })], messages: { ses_own: parent, ses_fork: [...copied, ...own] } } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await until(() => d.log().some((l) => l.type === "start"));
    for (let i = 0; i < 80 && !(await d.ok({ type: "session.list" })).sessions.some((x: any) => x.id === "ses_own"); i++) await sleep(50);
    expect((await d.ok({ type: "session.list" })).sessions.map((x: any) => x.id)).toEqual(["ses_own"]);
    await d.ok({ type: "session.subscribe", sessionId: "ses_own", sinceSeq: 0 });
    const s = d.view("ses_own");
    await until(() => !!s.parts().find((p) => p.parentId === "call_fork"));
    expect(s.last("call_fork")).toMatchObject({ type: "subagent", agentType: "fork", description: "probe fork", status: "done" });
    const steps = s.parts().filter((p) => p.parentId === "call_fork");
    expect([...new Set(steps.map((p) => `${p.type}:${p.id}`))]).toEqual(["assistant_text:msg_f_a:text:0"]);
    expect(steps.some((p) => p.type === "user_text")).toBe(false);
    await until(() => (s.states().at(-1) === "idle"));
    await d.ok({ type: "session.delete", sessionId: "ses_own" });
    await until(() => d.requests("DELETE", "/api/session/ses_fork").length === 1);
    await until(() => !link(d, "ses_fork"));
  });

  it("a mode change of an Aside drops the edit denial at its next prompt", async () => {
    const d = await owned([msg("msg_u1", "user"), msg("msg_a1", "assistant", done)]);
    const { session } = await d.ok({ type: "aside.open", sessionId: "ses_own", text: "q" });
    await d.ok({ type: "session.subscribe", sessionId: session.id, sinceSeq: 0 });
    await until(() => d.view(session.id).states().at(-1) === "idle");
    await d.ok({ type: "session.setPermissionMode", sessionId: session.id, mode: "acceptEdits" });
    await d.ok({ type: "session.prompt", sessionId: session.id, text: "now edit" });
    await until(() => d.requests("POST", `/api/session/${session.id}/prompt`).length === 2);
    const rules = d.requests("PATCH", `/api/session/${session.id}`).map((r) => r.body.permissions).filter(Boolean);
    expect(rules.at(-1)).toEqual([...modeRules("acceptEdits"), ...BUILD, ...MCP]);
  });

  it("an Aside of a running owner forks before the unfinished assistant message; after a rewind in OpenCode it forks at the revert message", async () => {
    const d = await owned([msg("msg_u1", "user"), msg("msg_a1", "assistant", done), msg("msg_u2", "user"), msg("msg_a2", "assistant")]);
    await d.ok({ type: "aside.open", sessionId: "ses_own", text: "q" });
    expect(d.requests("POST", "/api/session/ses_own/fork")[0]!.body).toEqual({ before: "msg_a2" });
    const r = await owned([msg("msg_u1", "user"), msg("msg_a1", "assistant", done), msg("msg_u2", "user"), msg("msg_a2", "assistant", done)], { revert: { messageID: "msg_u2" } });
    await r.ok({ type: "aside.open", sessionId: "ses_own", text: "q" });
    expect(r.requests("POST", "/api/session/ses_own/fork")[0]!.body).toEqual({ before: "msg_u2" });
  });

  it("an owner without messages, or rewound to its first message, is refused and nothing is forked", async () => {
    const d = await owned([]);
    expect(await d.request({ type: "aside.open", sessionId: "ses_own", text: "q" })).toMatchObject({ type: "error", code: "aside_unavailable" });
    const r = await owned([msg("msg_u1", "user"), msg("msg_a1", "assistant", done)], { revert: { messageID: "msg_u1" } });
    expect(await r.request({ type: "aside.open", sessionId: "ses_own", text: "q" })).toMatchObject({ type: "error", code: "aside_unavailable" });
    expect([...d.requests("POST", /\/fork$/), ...r.requests("POST", /\/fork$/)]).toEqual([]);
  });

  it("an Aside left open by a stopped daemon is deleted in OpenCode 2 at the next start, with its link and record", async () => {
    // The popup was never closed (reload, crash): the fork, its owner link and its adapter record are what the stopped daemon left.
    const d = await boot({
      data: { sessions: [row("ses_own", "PROJECT", "Owner", 5000), row("ses_fork", "PROJECT", "what is two", 6000)], messages: { ses_own: [msg("msg_u1", "user")], ses_fork: [msg("msg_u2", "user")] } },
      sessionsJson: { ses_fork: { ownerId: "ses_own", readOnly: true }, ses_own: {} },
      adapters: { ses_own: 2, ses_fork: 2 },
      projectDirInData: true,
    });
    // The leftover link alone does not start OpenCode 2 at boot (the daemon may never be used for OpenCode).
    await sleep(600);
    expect(d.log().some((l) => l.type === "start")).toBe(false);
    expect(link(d, "ses_fork")).toBeDefined();
    // The first list starts the server; the cleanup follows at once.
    await d.ok({ type: "session.list" });
    await until(() => d.requests("DELETE", "/api/session/ses_fork").length === 1);
    await until(() => !d.recorded().ses_fork && !link(d, "ses_fork"));
    expect(d.recorded()).toEqual({ ses_own: 2 });
  });

  it("a rename of a session OpenCode 2 cannot be asked about answers OpenCode's error code, not request failed", async () => {
    const d = await boot({ sessionsJson: { ses_old: { model: "default", permissionMode: "default", effort: "default" } }, env: { FAKE_OPENCODE2_FAIL: JSON.stringify({ ses_old: 5 }) } });
    const r = await d.request({ type: "session.rename", sessionId: "ses_old", title: "x" });
    expect(r).toMatchObject({ type: "error", code: "opencode_failed" });
  });

  it("a failure after the fork deletes the fork and its record", async () => {
    const d = await owned([msg("msg_u1", "user"), msg("msg_a1", "assistant", done)]);
    expect(await d.request({ type: "aside.open", sessionId: "ses_own", text: "fail-title" })).toMatchObject({ type: "error", code: "aside_failed" });
    expect(d.requests("POST", "/api/session/ses_own/fork")).toHaveLength(1);
    const deleted = d.requests("DELETE", /^\/api\/session\/ses_/);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.path).not.toBe("/api/session/ses_own");
    expect(d.recorded()).toEqual({});
  });
});

describe("OpenCode 2 sessions: owner of a subagent's session", () => {
  /** An engine over a stub server whose session rows are `parents` (id -> parentID) and whose read of `failing` fails once. */
  function engineOver(parents: Record<string, string | undefined>, failing: string) {
    let failed = false;
    const server = {
      client: async () => ({
        session: {
          get: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === failing && !failed) throw new Error("storage busy");
            return { id: sessionID, parentID: parents[sessionID] };
          },
        },
      }),
    };
    const engine = createOpenCode2Engine(server as never);
    // The root is one of this engine's open sessions.
    (engine as unknown as { sessions: Map<string, unknown> }).sessions.set("ses_root", {});
    return { engine, recover: () => (failed = true) };
  }

  it("a failed read up the parent chain is not remembered as 'not ours': the next request finds the owner", async () => {
    const { engine, recover } = engineOver({ ses_grand: "ses_child", ses_child: "ses_root" }, "ses_child");
    expect(await engine.ownerOf("ses_grand")).toBeUndefined();
    recover();
    expect(await engine.ownerOf("ses_grand")).toBe("ses_root");
  });
});

describe("OpenCode 2 sessions: rewind, /undo, /redo, /compact, bash mode and questions", { timeout: TEST_MS }, () => {
  /** Three turns; the first two changed files (the fake's `diff` of a user message: what its turn changed). */
  const history = [
    msg("msg_u1", "user", { text: "one", diff: [{ file: "g1.txt", additions: 1, deletions: 0 }] }),
    msg("msg_a1", "assistant", done),
    msg("msg_u2", "user", { text: "two", diff: [{ file: "g2.txt", additions: 2, deletions: 1 }] }),
    msg("msg_a2", "assistant", done),
    msg("msg_u3", "user", { text: "three" }),
    msg("msg_a3", "assistant", done),
  ];
  async function opened(extra: object = {}, o: Parameters<typeof boot>[0] = {}) {
    const d = await owned(history, extra, o);
    await d.ok({ type: "session.subscribe", sessionId: "ses_own", sinceSeq: 0 });
    const s = d.view("ses_own");
    await until(() => !!s.last("msg_u1"));
    return { d, s };
  }
  /** The user messages shown (a resync re-emits a part under its id). */
  const shown = (s: ReturnType<Awaited<ReturnType<typeof boot>>["view"]>) => [...new Set(s.parts().filter((p) => p.type === "user_text").map((p) => p.id))];
  const stages = (d: Awaited<ReturnType<typeof boot>>) => d.requests("POST", "/api/session/ses_own/revert/stage").map((r) => r.body);

  it("rewind previews the files changed from that message on, offers code and conversation or the conversation only, stages OpenCode's revert and cuts the timeline; a stored cut stays cut", async () => {
    const { d, s } = await opened();
    expect(await d.ok({ type: "session.rewindPreview", sessionId: "ses_own", userMessageId: "msg_u2" })).toEqual({ filesChanged: ["g2.txt"], insertions: 2, deletions: 1, conversation: true, modes: ["both", "conversation"] });
    expect((await d.ok({ type: "session.rewindPreview", sessionId: "ses_own", userMessageId: "msg_u3" })).modes).toEqual(["conversation"]);
    await d.ok({ type: "session.rewind", sessionId: "ses_own", userMessageId: "msg_u2", mode: "both" });
    await d.ok({ type: "session.rewind", sessionId: "ses_own", userMessageId: "msg_u1", mode: "conversation" });
    expect(stages(d)).toEqual([{ messageID: "msg_u2", files: true }, { messageID: "msg_u1", files: false }]);
    // One rewind part per rewind: OpenCode's own `revert.staged` of it adds none.
    await sleep(300);
    expect(s.parts().filter((p) => p.type === "rewind").map((p) => (p as { userMessageId: string }).userMessageId)).toEqual(["msg_u2", "msg_u1"]);
    // A session stored with a cut opens without the messages from it on, and its preview counts only what is shown.
    const r = await opened({ revert: { messageID: "msg_u2" } });
    await sleep(300);
    expect(shown(r.s)).toEqual(["msg_u1"]);
    expect(await r.d.ok({ type: "session.rewindPreview", sessionId: "ses_own", userMessageId: "msg_u1" })).toMatchObject({ filesChanged: ["g1.txt"], insertions: 1 });
  });

  it("/undo takes back the last prompt as a draft, /redo brings the messages back one prompt at a time; the clear's empty execution is no turn; the slash menu lists them", async () => {
    // OpenCode lists the session as active during the clear's empty execution.
    const { d, s } = await opened({}, { env: { FAKE_OPENCODE2_CLEAR_ACTIVE_MS: "300" } });
    const names = (await d.ok({ type: "session.commands", cwd: d.project, engine: "opencode" })).commands.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(["compact", "undo", "redo"]));
    // An open session's slash menu reads its `commands` part.
    expect(s.find("commands")?.commands.map((c) => c.name)).toEqual(expect.arrayContaining(["compact", "undo", "redo"]));
    expect(await s.prompt("/undo")).toMatchObject({ local: true, draft: { text: "three", images: [] } });
    expect(await s.prompt("/undo")).toMatchObject({ local: true, draft: { text: "two" } });
    expect(stages(d)).toEqual([{ messageID: "msg_u3", files: false }, { messageID: "msg_u2", files: true }]);
    await s.prompt("/redo");
    // The revert point moves to the next undone prompt; the messages between come back.
    expect(stages(d).at(-1)).toEqual({ messageID: "msg_u3", files: true });
    const before = s.parts().length;
    await s.prompt("/redo");
    await until(() => d.requests("DELETE", "/api/session/ses_own/revert").length === 1);
    await until(() => s.parts().slice(before).some((p) => p.id === "msg_u3"));
    await sleep(300);
    // OpenCode 2.3.0 follows a clear with an empty execution: no turn, the session stays idle.
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
    expect(s.states().slice(-1)).toEqual(["idle"]);
    expect(s.states()).not.toContain("running");
    await s.prompt("/redo");
    await until(() => s.parts().some((p) => p.type === "notice" && /Nothing to redo/.test((p as { text: string }).text)));
    expect(s.parts().filter((p) => p.type === "user_text" && /^\/(undo|redo)/.test((p as { text: string }).text))).toEqual([]);
  });

  /** The stream drops and the daemon read the session again after it reconnected. */
  const reconnect = async (d: Awaited<ReturnType<typeof boot>>) => {
    const reads = d.requests("GET", "/api/form").length;
    await d.fake("/__drop");
    await until(() => d.requests("GET", "/api/form").length > reads);
    await sleep(300);
  };
  /** How often user message `id` was sent to the client. */
  const sent = (s: ReturnType<Awaited<ReturnType<typeof boot>>["view"]>, id: string) => s.parts().filter((p) => p.type === "user_text" && p.id === id).length;

  it("a prompt sent here is not sent again by a reconnect; undone and redone, it comes back with its user message once, and later reconnects do not send it again", async () => {
    const { d, s } = await opened();
    const id: string = (await s.prompt("four")).messageId ?? lastOf(s.parts(), (p) => p.type === "user_text" && (p as { text: string }).text === "four")!.id;
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    // A reconnect's read does not send it again (a listener, e.g. a brief, would take it as a new message).
    const reads = d.requests("GET", "/api/form").length;
    const mark = s.parts().length;
    await d.fake("/__drop");
    await until(() => d.requests("GET", "/api/form").length > reads);
    await sleep(300);
    expect(s.parts().slice(mark).some((p) => p.id === id)).toBe(false);
    await s.prompt("/undo");
    expect(lastOf(stages(d), () => true)).toMatchObject({ messageID: id });
    const before = s.parts().length;
    await s.prompt("/redo");
    await until(() => d.requests("DELETE", "/api/session/ses_own/revert").length === 1);
    await until(() => s.parts().slice(before).some((p) => p.id === id && p.type === "user_text"));
    await sleep(300);
    expect(sent(s, id)).toBe(2);
    await reconnect(d);
    await reconnect(d);
    expect(sent(s, id)).toBe(2);
  });

  it("a revert staged, moved or cleared in OpenCode's own app cuts the timeline or brings the messages back", async () => {
    const { d, s } = await opened({}, { env: { FAKE_OPENCODE2_CLEAR_ACTIVE_MS: "300" } });
    await d.fake("/__stage/ses_own/msg_u2");
    await until(() => s.find("rewind")?.userMessageId === "msg_u2");
    // Moved to a later message: the messages between come back.
    let before = s.parts().length;
    await d.fake("/__stage/ses_own/msg_u3");
    await until(() => s.find("rewind")?.userMessageId === "msg_u3");
    await until(() => s.parts().slice(before).some((p) => p.id === "msg_u2"));
    before = s.parts().length;
    await d.fake("/__clear/ses_own");
    await until(() => s.parts().slice(before).some((p) => p.id === "msg_u3"));
    await sleep(500);
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
    expect(s.states()).not.toContain("running");
  });

  it("a turn started in OpenCode's own app after a clear whose empty execution never came shows as a turn", async () => {
    const { d, s } = await opened();
    await d.fake("/__clear/ses_own?empty=0");
    await d.fake("/__run/ses_own");
    await until(() => s.states().includes("running"));
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    expect(s.states().at(-1)).toBe("idle");
  });

  it("a prompt sent here, cut and cleared in OpenCode's own app (the cut seen live or only by the read after a reconnect), comes back once", async () => {
    const { d, s } = await opened();
    for (const missed of [false, true]) {
      const text = missed ? "five" : "four";
      const id: string = (await s.prompt(text)).messageId ?? lastOf(s.parts(), (p) => p.type === "user_text" && (p as { text: string }).text === text)!.id;
      await until(() => s.states().at(-1) === "idle" && s.parts().filter((p) => p.type === "turn_result").length === (missed ? 2 : 1));
      const rewinds = s.parts().filter((p) => p.type === "rewind").length;
      if (missed) {
        // The stage happens while the stream is down: only the read after the reconnect sees it.
        const reads = d.requests("GET", "/api/form").length;
        await d.fake("/__drop");
        await d.fake(`/__stage/ses_own/${id}`);
        await until(() => d.requests("GET", "/api/form").length > reads);
      } else await d.fake(`/__stage/ses_own/${id}`);
      await until(() => s.parts().filter((p) => p.type === "rewind").length > rewinds);
      await d.fake("/__clear/ses_own");
      await until(() => sent(s, id) === 2);
      await reconnect(d);
      expect(sent(s, id)).toBe(2);
    }
  });

  it("the empty execution after a clear is no turn even when it starts late, and a prompt sent right after a redo ends at its own turn's end", async () => {
    const { d, s } = await opened({}, { env: { FAKE_OPENCODE2_CLEAR_DELAY_MS: "2500" } });
    await s.prompt("/undo");
    await s.prompt("/redo");
    await until(() => d.requests("DELETE", "/api/session/ses_own/revert").length === 1);
    await sleep(3000);
    expect(s.states()).not.toContain("running");
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
    // Redone and prompted at once: the clear's empty execution runs first, then the prompt's turn.
    await s.prompt("/undo");
    await s.prompt("/redo");
    await until(() => d.requests("DELETE", "/api/session/ses_own/revert").length === 2);
    await s.prompt("four");
    await until(() => s.parts().some((p) => p.type === "turn_result"), 10_000);
    const result = s.parts().findIndex((p) => p.type === "turn_result");
    expect(s.parts().slice(0, result).some((p) => p.type === "assistant_text" && (p as { text: string }).text === "pong")).toBe(true);
    await sleep(300);
    expect(s.parts().filter((p) => p.type === "turn_result")).toHaveLength(1);
    expect(s.states().at(-1)).toBe("idle");
  });

  it("/compact runs OpenCode's compaction as a turn: a compaction part with the summary, then the turn result; nothing to compact shows OpenCode's reason", async () => {
    const { d, s } = await opened();
    expect(await s.prompt("/compact")).toMatchObject({ local: true });
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    expect(d.requests("POST", "/api/session/ses_own/compact")).toHaveLength(1);
    expect(s.find("compaction")).toMatchObject({ trigger: "manual", summary: expect.stringContaining("the fake summary") });
    expect(s.states()).toContain("running");
    expect(s.states().at(-1)).toBe("idle");
    const e = await d.open();
    await e.prompt("/compact");
    await until(() => e.parts().some((p) => p.type === "notice" && /Nothing to compact yet/.test((p as { text: string }).text)));
  });

  it("bash mode runs the command in OpenCode without a model turn: a bash part with its output and exit code, the session recorded first; Stop kills a running command; Run in background frees the session", async () => {
    const { d, s } = await opened();
    expect(d.recorded()).toEqual({});
    await d.ok({ type: "session.bash", sessionId: "ses_own", command: "ls; exit 2" });
    await until(() => s.find("bash")?.status === "error");
    expect(s.find("bash")).toMatchObject({ command: "ls; exit 2", stdout: "out:ls; exit 2\n", exitCode: 2 });
    expect(d.requests("POST", "/api/session/ses_own/shell")[0]!.body).toMatchObject({ command: "ls; exit 2" });
    expect(d.recorded()).toEqual({ ses_own: 2 });
    await until(() => s.states().at(-1) === "idle");
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
    await d.ok({ type: "session.bash", sessionId: "ses_own", command: "sleep 30" });
    await until(() => s.find("bash", (p) => p.command === "sleep 30")?.status === "running");
    // A reconnect's read finds no OpenCode turn: the command still runs as this session's turn.
    const reads = d.requests("GET", "/api/form").length;
    await d.fake("/__drop");
    await until(() => d.requests("GET", "/api/form").length > reads);
    await sleep(300);
    expect(s.states().at(-1)).toBe("running");
    await d.ok({ type: "session.interrupt", sessionId: "ses_own" });
    await until(() => s.find("bash", (p) => p.command === "sleep 30")?.status === "stopped");
    expect(d.requests("DELETE", /^\/api\/shell\/sh_/)).toHaveLength(1);
    await until(() => s.states().at(-1) === "idle");
    expect(s.parts().some((p) => p.type === "turn_interrupted" || p.type === "turn_result")).toBe(false);
    // Run in background: the session is free at once, OpenCode runs the command on.
    await d.ok({ type: "session.bash", sessionId: "ses_own", command: "sleep 31" });
    await until(() => s.find("bash", (p) => p.command === "sleep 31")?.status === "running");
    await d.ok({ type: "session.backgroundShell", sessionId: "ses_own", toolUseId: s.find("bash", (p) => p.command === "sleep 31")!.id });
    await until(() => s.states().at(-1) === "idle");
    expect(s.find("bash", (p) => p.command === "sleep 31")).toMatchObject({ status: "running", shell: "background" });
    expect(d.requests("DELETE", /^\/api\/shell\/sh_/)).toHaveLength(1);
  });

  const shellId = (s: ReturnType<Awaited<ReturnType<typeof boot>>["view"]>, call: string) => /shell ID: (sh_\w+)/.exec(String(s.find("tool_result", (p) => p.toolUseId === call)!.output))![1]!;
  it("a background shell of the model lists in Shells with its output read from OpenCode; its end sets the card's status and exit code; Kill removes it in OpenCode", async () => {
    const d = await boot({ script: ["background-shell", "background-shell"] });
    const s = await d.open();
    await s.prompt("serve");
    await until(() => s.states().at(-1) === "idle" && !!s.find("tool_result"));
    const sh = shellId(s, "call_bg");
    // Still running after its call returned: a background shell with its command, never a user bubble.
    expect(s.find("tool_call", (p) => p.id === "call_bg")).toMatchObject({ tool: "Bash", status: "running", shell: "background", input: { command: "npm run dev" } });
    expect(await d.ok({ type: "session.shellOutput", sessionId: s.id, toolUseId: "call_bg" })).toEqual({ output: "listening on 3000\n", truncated: false });
    // The command finished: exit code on the card, its final output kept, the synthetic notice is no bubble.
    await d.fake("/__shell_exit", { id: sh, exit: 3, output: "boom\n" });
    await until(() => s.find("tool_call", (p) => p.id === "call_bg")?.status === "error");
    expect(s.find("tool_call", (p) => p.id === "call_bg")).toMatchObject({ exitCode: 3, shell: "background" });
    expect(await d.ok({ type: "session.shellOutput", sessionId: s.id, toolUseId: "call_bg" })).toEqual({ output: "boom\n", truncated: false });
    expect(s.parts().filter((p) => p.type === "user_text")).toHaveLength(1);
    expect((await d.request({ type: "session.stopShell", sessionId: s.id, toolUseId: "call_bg" })).type).toBe("error");
    // A second one: Kill deletes the shell in OpenCode and the card shows stopped.
    await until(() => s.states().at(-1) === "idle");
    await s.prompt("serve again");
    await until(() => s.states().at(-1) === "idle" && s.parts().filter((p) => p.type === "tool_result").length === 2);
    const second = s.find("tool_call", (p) => p.id === "call_bg")!;
    expect(second.status).toBe("running");
    await d.ok({ type: "session.stopShell", sessionId: s.id, toolUseId: "call_bg" });
    await until(() => s.find("tool_call", (p) => p.id === "call_bg")?.status === "stopped");
    expect(d.requests("DELETE", /^\/api\/shell\/sh_/)).toHaveLength(1);
  });

  it("a restored background shell shows running while OpenCode lists it, done with its exit code once its end notice is stored, else stopped", async () => {
    const call = (id: string, sh: string) => ({ type: "tool", id, name: "shell", state: { status: "completed", input: { command: `cmd ${id}`, background: true }, content: [{ type: "text", text: `Command moved to the background (shell ID: ${sh}).` }] }, time: { created: 2, completed: 3 } });
    const messages = [
      { id: "msg_u", type: "user", text: "q", time: { created: 1 } },
      { id: "msg_a", type: "assistant", agent: "build", model: { id: "m", providerID: "fake" }, time: { created: 2, completed: 3 }, content: [call("c_run", "sh_run"), call("c_done", "sh_done"), call("c_lost", "sh_lost")] },
      { id: "msg_s", type: "synthetic", time: { created: 4 }, text: '<shell id="sh_done" state="completed" command="cmd c_done">\nall good\n</shell>', metadata: { source: "shell", shellID: "sh_done", state: "completed", exit: 0 } },
    ];
    const d = await owned(messages, {}, { data: { shells: [{ id: "sh_run", command: "cmd c_run", sessionID: "ses_own", output: "still going\n" }] } });
    await d.ok({ type: "session.subscribe", sessionId: "ses_own", sinceSeq: 0 });
    const s = d.view("ses_own");
    const status = (id: string) => s.find("tool_call", (p) => p.id === id)?.status;
    await until(() => status("c_lost") === "stopped");
    expect(status("c_run")).toBe("running");
    expect(status("c_done")).toBe("done");
    expect(await d.ok({ type: "session.shellOutput", sessionId: "ses_own", toolUseId: "c_run" })).toEqual({ output: "still going\n", truncated: false });
    expect(await d.ok({ type: "session.shellOutput", sessionId: "ses_own", toolUseId: "c_done" })).toEqual({ output: "all good", truncated: false });
  });

  it("an agent edit keeps the content before its step in Local history: the step's start snapshot read from OpenCode's store, files relative to the project folder", async () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), "oc2-data-")));
    const before = { "a.txt": "before\n", "sub/c.txt": "sub before\n" };
    // A tree hash depends on the files only: the step's start snapshot is known before the daemon boots.
    const store = (dir: string, worktree: string) => {
      const git = (...a: string[]) => execFileSync("git", ["--git-dir", dir, "--work-tree", worktree, ...a], { encoding: "utf8" }).trim();
      mkdirSync(dir, { recursive: true });
      git("init", "-q");
      for (const [f, c] of Object.entries(before)) (mkdirSync(dirname(join(worktree, f)), { recursive: true }), writeFileSync(join(worktree, f), c));
      git("add", "-A");
      return git("write-tree");
    };
    const scratch = mkdtempSync(join(tmpdir(), "oc2-tree-"));
    const tree = store(join(scratch, "git"), join(scratch, "wt"));
    const d = await boot({ script: ["edit"], env: { FAKE_OPENCODE_DATA_DIR: data, FAKE_OPENCODE2_SNAPSHOT: tree } });
    // The store as OpenCode 2 lays it out: <data>/snapshot/<projectID>/<sha1 of the project folder>.
    expect(store(join(data, "snapshot", "global", createHash("sha1").update(d.project).digest("hex")), d.project)).toBe(tree);
    // The agent's step then changed a.txt and sub/c.txt and created new.txt.
    writeFileSync(join(d.project, "a.txt"), "after\n");
    writeFileSync(join(d.project, "sub", "c.txt"), "sub after\n");
    writeFileSync(join(d.project, "new.txt"), "new\n");
    const s = await d.open();
    await s.prompt("edit");
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    const entries = async (file: string) => (await d.ok({ type: "history.list", path: join(d.project, file) })).entries as { id: string; reason: string }[];
    for (let i = 0; i < 100 && !(await entries("a.txt")).length; i++) await sleep(50);
    const [a] = await entries("a.txt");
    expect(a).toMatchObject({ reason: "agent" });
    expect((await d.ok({ type: "history.read", path: join(d.project, "a.txt"), id: a!.id })).content).toBe("before\n");
    const [c] = await entries("sub/c.txt");
    expect((await d.ok({ type: "history.read", path: join(d.project, "sub/c.txt"), id: c!.id })).content).toBe("sub before\n");
    // A file the step created has no content before.
    expect(await entries("new.txt")).toEqual([]);
  });

  it("Stop before OpenCode named the shell kills the command once it is named", async () => {
    const { d, s } = await opened({}, { env: { FAKE_OPENCODE2_SHELL_START_MS: "400" } });
    await d.ok({ type: "session.bash", sessionId: "ses_own", command: "sleep 30" });
    await d.ok({ type: "session.interrupt", sessionId: "ses_own" });
    await until(() => s.find("bash", (p) => p.command === "sleep 30")?.status === "stopped");
    expect(d.requests("DELETE", /^\/api\/shell\/sh_/)).toHaveLength(1);
    await until(() => s.states().at(-1) === "idle");
  });

  it("a question shows as a question part under its call; the answer goes back by field, a multi-select as a list; it survives a stream reconnect; Stop cancels it", async () => {
    const d = await boot({ script: ["question", "question"] });
    const s = await d.open();
    await s.prompt("ask");
    await until(() => !!s.find("question"));
    const q = s.find("question")!;
    expect(q.questions).toEqual([
      { question: "Pick a color?", header: "Color", options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }], multiSelect: false },
      { question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: true },
    ]);
    expect(q.toolUseId).toBe(s.find("tool_call")!.toolUseId);
    // A reconnect reads the session again: the question OpenCode still waits for stays open.
    await d.fake("/__drop");
    await until(() => d.requests("GET", "/api/form").length > 0);
    await sleep(300);
    expect(s.find("question")!.settled).toBe(false);
    await d.ok({ type: "question.respond", requestId: q.requestId, answers: { "Pick a color?": "Blue", "Which?": "A, B" } });
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    expect(d.requests("POST", new RegExp(`/form/${q.requestId}/reply$`))[0]!.body).toEqual({ answer: { q0: "Blue", q1: ["A", "B"] } });
    expect(s.find("question")!.settled).toBe(true);
    await s.prompt("ask again");
    await until(() => s.find("question", (p) => p.requestId !== q.requestId) !== undefined);
    const q2 = s.find("question", (p) => p.requestId !== q.requestId)!;
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => d.requests("DELETE", new RegExp(`/form/${q2.requestId}$`)).length === 1);
    await until(() => s.states().at(-1) === "idle");
  });

  // A form of OpenCode with these fields, asked by the turn (`kind` other than question: no call of the question tool).
  const formTurn = (fields: object[], kind?: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "oc2-form-")), "turn.json");
    const step = (event: string, data: object) => ({ event, data: { sessionID: "$SESSION", ...data } });
    writeFileSync(file, JSON.stringify([step("session.execution.started", {}), step("session.step.started", { agent: "build", model: { id: "m", providerID: "fake" }, assistantMessageID: "$A1" }), { form: { fields, ...(kind && { kind }) } }, { wait: "form" }, step("session.step.ended", { assistantMessageID: "$A1", finish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, files: [] }), step("session.execution.succeeded", {})]));
    return file;
  };
  const opts = [{ value: "v1", label: "One", description: "first" }, { value: "v2", label: "Two" }];
  it.each([
    ["a string with options answers with the option's value", [{ key: "a", type: "string", title: "A", description: "Pick", options: opts, custom: true }], undefined, [{ question: "Pick", header: "A", options: [{ label: "One", description: "first" }, { label: "Two", description: "" }], multiSelect: false }], { Pick: "Two" }, { a: "v2" }],
    ["a string with no options is a question with the free text", [{ key: "a", type: "string", title: "Name", description: "Your name?" }], undefined, [{ question: "Your name?", header: "Name", options: [], multiSelect: false }], { "Your name?": "Ada" }, { a: "Ada" }],
    ["a boolean offers Yes and No and answers true or false", [{ key: "b", type: "boolean", title: "Sure" }], undefined, [{ question: "Sure", header: "Sure", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiSelect: false }], { Sure: "No" }, { b: false }],
    ["a number and an integer answer as numbers", [{ key: "n", type: "number", title: "Ratio" }, { key: "i", type: "integer", title: "Count", minimum: 1, maximum: 5 }], undefined, [{ question: "Ratio", header: "Ratio", options: [], multiSelect: false }, { question: "Count", header: "Count", options: [], multiSelect: false }], { Ratio: "0.5", Count: "3" }, { n: 0.5, i: 3 }],
    ["a hidden field is not shown and answers with its default", [{ key: "h", type: "string", title: "H", hidden: true, default: "dflt" }, { key: "a", type: "string", title: "A" }], undefined, [{ question: "A", header: "A", options: [], multiSelect: false }], { A: "x" }, { h: "dflt", a: "x" }],
    ["a field with a condition says so and is left out of the answer when the condition fails", [{ key: "b", type: "boolean", title: "Deploy" }, { key: "w", type: "string", title: "Where", when: [{ key: "b", op: "eq", value: true }] }], undefined, [{ question: "Deploy", header: "Deploy", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiSelect: false }, { question: "Where", header: "Where (if Deploy is true)", options: [], multiSelect: false }], { Deploy: "No", Where: "prod" }, { b: false }],
    ["two fields with the same question text get a number", [{ key: "a", type: "string", title: "A", description: "Same?" }, { key: "b", type: "string", title: "B", description: "Same?" }], undefined, [{ question: "Same?", header: "A", options: [], multiSelect: false }, { question: "Same? (2)", header: "B", options: [], multiSelect: false }], { "Same?": "one", "Same? (2)": "two" }, { a: "one", b: "two" }],
    ["a multi-select answers with the values of the chosen options", [{ key: "m", type: "multiselect", title: "M", description: "Which?", options: opts }], undefined, [{ question: "Which?", header: "M", options: [{ label: "One", description: "first" }, { label: "Two", description: "" }], multiSelect: true }], { "Which?": "One, Two" }, { m: ["v1", "v2"] }],
    ["an external field shows its address and is acknowledged with Done", [{ key: "e", type: "external", title: "Sign in", url: "https://example.com/x" }], undefined, [{ question: "Sign in", header: "Sign in", options: [{ label: "Done", description: "https://example.com/x" }], multiSelect: false }], { "Sign in": "Done" }, { e: true }],
    ["a form of another kind shows as a question with the form's title", [{ key: "a", type: "string", title: "A", description: "Value?" }], "input", [{ question: "Value?", header: "Questions", options: [], multiSelect: false }], { "Value?": "z" }, { a: "z" }],
  ])("OpenCode 2 form: %s", async (_name, fields, kind, questions, answers, body) => {
    const d = await boot({ env: { FAKE_OPENCODE2_SCRIPT: formTurn(fields, kind) } });
    const s = await d.open();
    await s.prompt("ask");
    await until(() => !!s.find("question"));
    const q = s.find("question")!;
    expect(q.questions).toEqual(questions);
    if (kind) expect(q.toolUseId).toBe(q.requestId);
    await d.ok({ type: "question.respond", requestId: q.requestId, answers });
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    expect(d.requests("POST", new RegExp(`/form/${q.requestId}/reply$`))[0]!.body).toEqual({ answer: body });
  });

  it("a number that is not a whole number or out of range is not sent: a warning names the field and the question comes back", async () => {
    const d = await boot({ env: { FAKE_OPENCODE2_SCRIPT: formTurn([{ key: "i", type: "integer", title: "Count", minimum: 1, maximum: 5 }]) } });
    const s = await d.open();
    await s.prompt("ask");
    await until(() => !!s.find("question"));
    const q = s.find("question")!;
    for (const [bad, text] of [["2.5", /Count needs a whole number/], ["9", /Count must be between 1 and 5/]] as const) {
      await d.ok({ type: "question.respond", requestId: q.requestId, answers: { Count: bad } });
      await until(() => !!s.find("notice", (n) => text.test(n.text)));
      await until(() => s.find("question")!.settled === false);
    }
    expect(d.requests("POST", /\/form\/[^/]+\/reply$/)).toHaveLength(0);
    await d.ok({ type: "question.respond", requestId: q.requestId, answers: { Count: "4" } });
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    expect(d.requests("POST", /\/form\/[^/]+\/reply$/).map((r) => r.body)).toEqual([{ answer: { i: 4 } }]);
  });
});

describe("OpenCode 2 sessions: agents and slash commands", { timeout: TEST_MS }, () => {
  const plan = [{ action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: "/plans/*", effect: "allow" }, { action: "browser", resource: "*", effect: "deny" }];
  const base = [{ action: "*", resource: "*", effect: "allow" }];
  const plan2 = { id: "plan", mode: "primary", hidden: false, permissions: [...base, ...plan] };
  const build2 = { id: "build", mode: "primary", hidden: false, permissions: [...base, ...BUILD] };
  const names = (list: { name: string }[] | undefined) => (list ?? []).map((a) => a.name);

  it("the chooser lists OpenCode's primary agents once the folder loaded, the config's default first; a chosen agent is switched in OpenCode with its denials in the rules; plan mode is the plan agent", async () => {
    // 2.3.0 lists no agent before the folder loaded; the config's `default_agent` comes from its documents.
    const agents = [plan2, build2, { id: "general", mode: "subagent", hidden: false, permissions: [] }, { id: "title", mode: "primary", hidden: true, permissions: [] }, { id: "mine", mode: "all", hidden: false, permissions: [] }];
    const d = await boot({ env: { FAKE_OPENCODE2_COLD_AGENTS: "2", FAKE_OPENCODE2_PARTIAL_AGENTS: "1" }, data: { agents, config: [{ type: "document", path: "/x/opencode.json", info: { default_agent: "mine" } }] } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    // The chooser read the folder before OpenCode listed its own agents (2.3.0 lists the built-ins first; its `agent.updated` came before any event stream).
    expect(names((await d.ok({ type: "session.agents", cwd: d.project, engine: "opencode" })).agents)).toEqual(["build", "plan"]);
    await sleep(900); // the background re-read of the cold folder: its own default agent shows
    const s = await d.open();
    await until(() => names(s.find("agents")?.agents).join() === "mine,plan,build");
    await d.ok({ type: "session.setPermissionMode", sessionId: s.id, mode: "default" });
    expect(d.requests("PATCH", `/api/session/${s.id}`).at(-1)!.body.permissions).toEqual([...modeRules("default"), ...MCP]);
    await expect(d.ok({ type: "session.setAgent", sessionId: s.id, agent: "general" })).rejects.toThrow(/unknown agent general/);
    await d.ok({ type: "session.setAgent", sessionId: s.id, agent: "plan" });
    expect(d.requests("POST", `/api/session/${s.id}/agent`).map((r) => r.body)).toEqual([{ agent: "plan" }]);
    // The plan agent's denials (with its plan-file exception) come after the mode's rules: the mode's `edit ask` must not beat them.
    expect(d.requests("PATCH", `/api/session/${s.id}`).at(-1)!.body.permissions).toEqual([...modeRules("default"), ...plan, ...MCP]);
    expect(s.find("session_agent")).toMatchObject({ agent: "plan" });
    await s.prompt("hi");
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    expect(d.requests("POST", `/api/session/${s.id}/agent`)).toHaveLength(1);
    // Plan mode is the plan agent: chosen back to build, then plan again by the mode.
    await d.ok({ type: "session.setAgent", sessionId: s.id, agent: "mine" });
    await d.ok({ type: "session.setPermissionMode", sessionId: s.id, mode: "plan" });
    expect(d.requests("POST", `/api/session/${s.id}/agent`).map((r) => r.body.agent)).toEqual(["plan", "mine", "plan"]);
    expect((await d.ok({ type: "session.list" })).sessions.find((x: { id: string }) => x.id === s.id)).toMatchObject({ agent: "plan", permissionMode: "default" });
  });

  it("the chooser of a new session, before any session runs, shows the folder's own agents that OpenCode lists after its built-ins soon after the first list, with no wait of the first read", async () => {
    const d = await boot({ env: { FAKE_OPENCODE2_COLD_AGENTS: "1", FAKE_OPENCODE2_PARTIAL_AGENTS: "1" }, data: { agents: [plan2, build2, { id: "mine", mode: "primary", hidden: false, permissions: [] }] } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const chooser = async () => names((await d.ok({ type: "session.agents", cwd: d.project, engine: "opencode" })).agents);
    // A cold folder: the first list OpenCode gives has its built-ins only; one background read soon after adds the own agents.
    expect(await chooser()).toEqual(["build", "plan"]);
    await sleep(900);
    expect(await chooser()).toEqual(["build", "plan", "mine"]);
  });

  it("agents and commands that changed in a folder OpenCode names by another path (a link to it) reach the session of that folder", async () => {
    const d = await boot({ data: { commands2: [{ name: "deploy" }] } });
    // The name OpenCode gives the folder matches no folder of ours.
    const link = join(d.root, "link");
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const s = await d.open();
    await until(() => names(s.find("commands")?.commands).includes("hello"));
    await d.fake(`/__lists?dir=${encodeURIComponent(link)}`);
    await until(() => names(s.find("commands")?.commands).join() === "compact,undo,redo,visualize,deploy");
  });

  it("a /name typed before OpenCode's command list loaded runs the command once the list came; an unknown one goes as a prompt", async () => {
    const d = await boot({ env: { FAKE_OPENCODE2_COMMAND_LIST_MS: "800" } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const s = await d.open();
    expect(await s.prompt("/hello world")).toEqual({ local: true });
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    expect(d.requests("POST", `/api/session/${s.id}/command`).map((r) => r.body)).toEqual([{ name: "hello", text: "world" }]);
    expect(d.requests("POST", `/api/session/${s.id}/prompt`)).toEqual([]);
    const t = await d.open();
    await t.prompt("/nosuch x");
    await until(() => t.parts().some((p) => p.type === "turn_result"));
    expect(d.requests("POST", `/api/session/${t.id}/prompt`).map((r) => r.body.text)).toEqual(["/nosuch x"]);
    expect(t.parts().filter((p) => p.type === "user_text").map((p) => (p as { text: string }).text)).toEqual(["/nosuch x"]);
  });

  it("a plain prompt typed while an early /name waits for OpenCode's command list is sent after the command", async () => {
    const d = await boot({ env: { FAKE_OPENCODE2_COMMAND_LIST_MS: "800" } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const s = await d.open();
    await s.prompt("/hello world");
    await s.prompt("then this");
    await until(() => d.requests("POST", `/api/session/${s.id}/prompt`).length === 1);
    const sent = d.log().filter((l) => l.type === "request" && l.method === "POST" && new RegExp(`/api/session/${s.id}/(command|prompt)$`).test(l.path));
    expect(sent.map((l) => l.path.split("/").at(-1))).toEqual(["command", "prompt"]);
    await until(() => s.parts().filter((p) => p.type === "turn_result").length === 2);
    expect(s.parts().filter((p) => p.type === "user_text").map((p) => (p as { text: string }).text)).toEqual(["Run hello: world", "then this"]);
  });

  it("a Stop while an early /name prepares drops the prompt typed meanwhile", async () => {
    const d = await boot({ env: { FAKE_OPENCODE2_COMMAND_LIST_MS: "300", FAKE_OPENCODE2_COMMAND_MS: "1500" }, script: ["hold"] });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const s = await d.open();
    await s.prompt("/hello world");
    await s.prompt("then this");
    // The command reached OpenCode, which has not answered yet: the session is running, the prompt still waits.
    await until(() => d.requests("POST", `/api/session/${s.id}/command`).length === 1);
    expect(s.states().at(-1)).toBe("running");
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await sleep(1200);
    expect(d.requests("POST", `/api/session/${s.id}/prompt`)).toEqual([]);
    expect(s.parts().filter((p) => p.type === "user_text").map((p) => (p as { text: string }).text)).not.toContain("then this");
  });

  it("a command shows running until OpenCode answers: one that starts no turn ends at once; Stop while OpenCode takes one interrupts its turn", async () => {
    const d = await boot({ env: { FAKE_OPENCODE2_COMMAND_MS: "600" }, script: ["hold"], data: { commands: ["noturn", "hello"].map((name) => ({ name })) } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const s = await d.open();
    await until(() => names(s.find("commands")?.commands).includes("noturn"));
    await s.prompt("/noturn");
    await until(() => s.states().includes("running") && s.states().at(-1) === "idle");
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
    await s.prompt("/hello");
    // The command reached OpenCode, which has not taken it yet.
    await until(() => d.requests("POST", `/api/session/${s.id}/command`).length === 2);
    expect(s.states().at(-1)).toBe("running");
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => !!s.find("turn_interrupted") && s.states().at(-1) === "idle");
    expect(d.requests("POST", `/api/session/${s.id}/interrupt`)).toHaveLength(1);
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
  });

  it("a restored session opens as the agent OpenCode has; an agent chosen in OpenCode's own app is followed; an agent the config lost runs the prompt as the default with a notice", async () => {
    const d = await owned([msg("msg_u1", "user"), msg("msg_a1", "assistant", done)], { agent: "plan" }, { data: { agents2: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] } });
    await d.ok({ type: "session.subscribe", sessionId: "ses_own", sinceSeq: 0 });
    const s = d.view("ses_own");
    expect((await d.ok({ type: "session.list" })).sessions.find((x: { id: string }) => x.id === "ses_own")).toMatchObject({ agent: "plan" });
    await d.fake("/__agent/ses_own/build");
    await until(() => s.find("session_agent")?.agent === "build");
    await d.fake("/__agent/ses_own/plan");
    await until(() => s.find("session_agent")?.agent === "plan");
    // The config loses plan: OpenCode says its agents changed; the prompt runs as the default agent, the chosen one stays.
    await d.fake("/__lists");
    await until(() => names(s.find("agents")?.agents).join() === "build");
    await s.prompt("hi");
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    expect(d.requests("POST", "/api/session/ses_own/agent").map((r) => r.body)).toEqual([{ agent: "build" }]);
    expect(s.find("notice", (n) => /no agent plan here any more; this prompt runs as build/.test(n.text))).toBeTruthy();
  });

  it("the slash menu lists OpenCode's commands after the daemon's; /name args runs the command as a turn showing the prompt OpenCode stored; a failing command is a notice; changed commands reach the menu", async () => {
    const d = await boot({ data: { commands: ["init", "review", "hello", "fail"].map((name) => ({ name })), commands2: [{ name: "deploy", description: "Deploy it" }] } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const s = await d.open();
    const menu = ["compact", "undo", "redo", "visualize", "init", "review", "hello", "fail"];
    await until(() => names(s.find("commands")?.commands).join() === menu.join());
    expect(names((await d.ok({ type: "session.commands", cwd: d.project, engine: "opencode" })).commands)).toEqual(menu);
    await s.prompt("first");
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    expect(await s.prompt("/undo")).toMatchObject({ local: true, draft: { text: "first" } });
    // A command has no message of ours: no draft (not the undone one), the web drops its pending bubble.
    expect(await s.prompt("/hello world")).toEqual({ local: true });
    await until(() => s.parts().filter((p) => p.type === "turn_result").length === 2);
    expect(d.requests("POST", `/api/session/${s.id}/command`).map((r) => r.body)).toEqual([{ name: "hello", text: "world" }]);
    expect(d.requests("POST", `/api/session/${s.id}/prompt`).map((r) => r.body.text)).toEqual(["first"]);
    // The prompt OpenCode made of the command shows, not the typed command.
    expect(s.parts().filter((p) => p.type === "user_text").map((p) => (p as { text: string }).text)).toEqual(["first", "Run hello: world"]);
    // A command OpenCode refuses runs no turn: its reason is a notice.
    const results = s.parts().filter((p) => p.type === "turn_result").length;
    await s.prompt("/fail now");
    await until(() => !!s.find("notice", (n) => /^\/fail failed: .*Usage: \/fail <what>/.test(n.text)) && s.states().at(-1) === "idle");
    expect(s.parts().filter((p) => p.type === "turn_result")).toHaveLength(results);
    await d.fake("/__lists");
    await until(() => names(s.find("commands")?.commands).join() === "compact,undo,redo,visualize,deploy");
  });

  it("with visualizations on, the menu offers /visualize and each prompt carries the claude-ui-visualize instruction entry; off removes it; /visualize what shows the typed text and adds the hidden directive", async () => {
    const d = await boot({ data: { commands: [{ name: "init" }] } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const s = await d.open();
    const menu = (on: boolean) => ["compact", "undo", "redo", ...(on ? ["visualize"] : []), "init"];
    await until(() => names(s.find("commands")?.commands).join() === menu(true).join());
    const entry = () => d.log().filter((l) => l.type === "request" && l.path === `/api/experimental/session/${s.id}/instructions/entries/claude-ui-visualize`);
    const results = () => s.parts().filter((p) => p.type === "turn_result").length;
    await s.prompt("one");
    await until(() => results() === 1);
    // Put once, not again for the next prompt while its text is the same.
    await s.prompt("/visualize draw x");
    await until(() => results() === 2);
    expect(entry().map((r) => r.method)).toEqual(["PUT"]);
    expect(entry()[0]!.body.value).toBe(visualizeSystem(visualizePluginDir(), "opencode"));
    // The typed text is the prompt (never a server command); the directive is a hidden message right before it.
    expect(d.requests("POST", `/api/session/${s.id}/command`)).toHaveLength(0);
    expect(d.requests("POST", `/api/session/${s.id}/prompt`).map((r) => r.body.text)).toEqual(["one", "/visualize draw x"]);
    expect(d.requests("POST", `/api/session/${s.id}/synthetic`).map((r) => r.body)).toEqual([{ text: "Answer this with a visualize fence: draw x", delivery: "steer", resume: false }]);
    expect(s.parts().filter((p) => p.type === "user_text").map((p) => (p as { text: string }).text)).toEqual(["one", "/visualize draw x"]);
    // Off: the entry is removed with the next prompt, the menu drops /visualize, and /visualize is a plain prompt.
    await d.ok({ type: "settings.set", patch: { chat: { visualize: false } } });
    expect(names((await d.ok({ type: "session.commands", cwd: d.project, engine: "opencode" })).commands)).toEqual(menu(false));
    await s.prompt("/visualize off");
    await until(() => results() === 3);
    expect(entry().map((r) => r.method)).toEqual(["PUT", "DELETE"]);
    expect(d.requests("POST", `/api/session/${s.id}/synthetic`)).toHaveLength(1);
  });
});


describe("OpenCode 2 sessions: the daemon's MCP servers (orchestration, claude-ui tools)", { timeout: TEST_MS }, () => {
  const on = (d: Awaited<ReturnType<typeof boot>>) => d.ok({ type: "settings.set", patch: { orchestration: { enabled: true, workerCap: 20 }, terminalAccess: { enabled: true }, fork: { enabled: true } } });
  const adds = (d: Awaited<ReturnType<typeof boot>>, name?: string) => d.requests("PUT", /^\/api\/experimental\/mcp\//).filter((r) => !name || r.path.endsWith(`/${name}`));
  const mcpClient = async (url: string, bearer: string) => {
    const c = new Client({ name: "test", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: bearer } } }));
    cleanups.push(() => void c.close());
    return c;
  };

  it("a session attaches its orchestration and claude-ui servers to its folder before its first prompt, Code Mode off; the route serves their tools; the rules hide other sessions' servers, allow its own and ask for worker_start and terminal_run; the delete removes both", async () => {
    const d = await boot();
    // Both off: nothing attached, other sessions' servers hidden.
    const off = await d.open();
    await off.prompt("hi");
    await until(() => off.states().at(-1) === "idle" && !!off.find("turn_result"));
    expect(adds(d)).toEqual([]);
    await on(d);
    const s = await d.open();
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    const orch = mcpName(s.id);
    const cui = mcpName(s.id, "claude-ui");
    const port = (d.http.address() as AddressInfo).port;
    const [o] = adds(d, orch);
    const [c] = adds(d, cui);
    expect(o!.query).toEqual({ "location[directory]": d.project });
    expect(o!.body.config).toMatchObject({ type: "remote", url: `http://127.0.0.1:${port}/opencode-mcp`, oauth: false, codemode: false, timeout: { execution: 30 * 60_000 + 60_000 } });
    expect(c!.body.config).toMatchObject({ type: "remote", oauth: false, codemode: false, timeout: { execution: expect.any(Number) } });
    expect(o!.body.config.headers.authorization).toMatch(/^Bearer .{40,}$/);
    expect(c!.body.config.headers.authorization).not.toBe(o!.body.config.headers.authorization);
    // Attached and ruled before the prompt.
    const log = d.log().filter((l) => l.type === "request").map((l) => `${l.method} ${l.path}`);
    expect(log.indexOf(`PUT /api/experimental/mcp/${orch}`)).toBeLessThan(log.indexOf(`POST /api/session/${s.id}/prompt`));
    const rules = d.requests("PATCH", `/api/session/${s.id}`).filter((r) => r.body.permissions).at(-1)!.body.permissions as { action: string; effect: string }[];
    const at = (action: string, effect: string) => rules.findIndex((r) => r.action === action && r.effect === effect);
    expect(at("claude-ui-*", "deny")).toBeGreaterThan(-1);
    expect(at(`${cui}_terminal_list`, "allow")).toBeGreaterThan(at("claude-ui-*", "deny"));
    expect(at(`${cui}_terminal_run`, "ask")).toBeGreaterThan(at("claude-ui-*", "deny"));
    // The fork tool (Fork runs work on OpenCode 2) is one of the claude-ui tools: no rule hides it.
    expect(at(`${cui}_fork`, "allow")).toBeGreaterThan(at("claude-ui-*", "deny"));
    expect(at(`${cui}_fork`, "deny")).toBe(-1);
    expect(at(`${orch}_*`, "allow")).toBeGreaterThan(at("orchestration-*", "deny"));
    expect(at(`${orch}_worker_start`, "ask")).toBeGreaterThan(at(`${orch}_*`, "allow"));
    // A token serves only its own server.
    const oc = await mcpClient(o!.body.config.url, o!.body.config.headers.authorization);
    expect((await oc.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["worker_start", "worker_list", "worker_wait"]));
    const cc = await mcpClient(c!.body.config.url, c!.body.config.headers.authorization);
    expect((await cc.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["terminal_run"]));
    expect((await cc.listTools()).tools.map((t) => t.name)).not.toContain("worker_start");
    // A second prompt finds both connected: no second add.
    await s.prompt("again");
    await until(() => d.requests("POST", `/api/session/${s.id}/prompt`).length === 2);
    expect(adds(d)).toHaveLength(2);
    await until(() => s.states().at(-1) === "idle");
    await d.ok({ type: "session.delete", sessionId: s.id });
    await until(() => d.requests("DELETE", /^\/api\/experimental\/mcp\//).length === 2);
    expect(d.requests("DELETE", /^\/api\/experimental\/mcp\//).map((r) => r.path).sort()).toEqual([`/api/experimental/mcp/${cui}`, `/api/experimental/mcp/${orch}`].sort());
    expect((await fetch(o!.body.config.url, { method: "POST", headers: { authorization: o!.body.config.headers.authorization, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("worker_start asks with the orchestration card and no always-allow; Allow replies once", async () => {
    const d = await boot({ script: ["worker-start"] });
    await on(d);
    const s = await d.open();
    await s.prompt("start a worker");
    await until(() => !!s.find("permission_request"));
    const call = s.find("tool_call");
    expect(call).toMatchObject({ tool: "mcp__orchestration__worker_start" });
    expect(s.find("permission_request")).toMatchObject({ tool: "mcp__orchestration__worker_start", suggestions: [], title: expect.stringMatching(/^Start OpenCode worker w2/) });
    const req = s.find("permission_request")!;
    await d.ok({ type: "permission.respond", requestId: req.requestId, decision: "allow" });
    await until(() => d.requests("POST", /\/permission\/.+\/reply$/).length === 1);
    expect(d.requests("POST", /\/permission\/.+\/reply$/)[0]!.body).toEqual({ decision: "once" });
  });

  it("worker_start over the worker cap shows no card: OpenCode is answered once (the tool then repeats the refusal)", async () => {
    const d = await boot({ script: ["worker-start"] });
    await d.ok({ type: "settings.set", patch: { orchestration: { enabled: true, workerCap: 1 } } });
    const s = await d.open();
    // One worker already runs: the cap is reached.
    await until(() => adds(d, mcpName(s.id)).length === 1);
    const o = adds(d, mcpName(s.id))[0]!.body.config;
    const c = await mcpClient(o.url, o.headers.authorization);
    expect(JSON.parse(((await c.callTool({ name: "worker_start", arguments: { name: "w1", cwd: d.project, prompt: "do it" } })) as any).content[0].text)).toMatchObject({ name: "w1" });
    await s.prompt("start a worker");
    await until(() => d.requests("POST", /\/permission\/.+\/reply$/).length === 1);
    expect(d.requests("POST", /\/permission\/.+\/reply$/)[0]!.body).toEqual({ decision: "once" });
    expect(s.find("permission_request")).toBeUndefined();
  });

  it("servers an OpenCode restart dropped are attached again at the next prompt; an attach that fails is a warning and the prompt still goes", async () => {
    const d = await boot();
    await on(d);
    const s = await d.open();
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(adds(d)).toHaveLength(2);
    await d.fake("/__mcp_drop");
    await s.prompt("again");
    await until(() => d.requests("POST", `/api/session/${s.id}/prompt`).length === 2);
    expect(adds(d)).toHaveLength(4);
    await until(() => s.states().at(-1) === "idle");
    await d.fake("/__mcp_drop");
    await d.fake("/__mcp_fail");
    await s.prompt("third");
    await until(() => d.requests("POST", `/api/session/${s.id}/prompt`).length === 3);
    expect(s.find("notice", (n) => n.id.startsWith(`${s.id}:mcp_failed:`))).toMatchObject({ level: "warning", text: expect.stringMatching(/^Could not attach the orchestration tools to OpenCode: /) });
  });
});

describe("OpenCode 2 sessions: a subagent's run timeline", { timeout: TEST_MS }, () => {
  /** The session row of the subagent's child session (its parent is not ours to name: the link comes from the call). */
  const withChild = { projectDirInData: true, data: { sessions: [row("ses_child", "PROJECT", "Look around", 9000, { parentID: "ses_parent" })] } };
  const statuses = (s: ReturnType<Awaited<ReturnType<typeof boot>>["view"]>, id: string) => s.parts().filter((p) => p.id === id).map((p) => (p as { status?: string }).status);

  it("the parts of the child session show under the call; the card runs on after the call returned and only the end notice ends it", async () => {
    const d = await boot({ script: ["subagent"], ...withChild });
    const s = await d.open();
    await s.prompt("Run a subagent");
    await until(() => s.find("subagent", (p) => p.id === "call_sub")?.status === "done");
    expect(s.find("tool_call", (p) => p.id === "call_child")).toMatchObject({ parentId: "call_sub", tool: "Bash", status: "done", input: { command: "echo sub" } });
    expect(s.last("call_child:result")).toMatchObject({ parentId: "call_sub", output: "sub\n", isError: false });
    expect(s.last("msg_c2:text:0")).toMatchObject({ parentId: "call_sub", text: "done" });
    // The call returned with status running and the child went idle with work left (state running): neither ended the card.
    expect(statuses(s, "call_sub").slice(0, -1)).not.toContain("done");
    expect(statuses(s, "call_sub")).toContain("running");
    // The prompt that started the child and the notices are no bubbles.
    expect(s.parts().filter((p) => p.type === "user_text").map((p) => p.type === "user_text" && p.text)).toEqual(["Run a subagent"]);
  });

  it("an early event of the child, before its call names it, shows in order once the link comes", async () => {
    const d = await boot({ script: ["subagent-early"], ...withChild });
    const s = await d.open();
    await s.prompt("Run a subagent");
    await until(() => !!s.last("msg_c1:text:0"));
    expect(s.last("msg_c1:text:0")).toMatchObject({ parentId: "call_sub", text: "early words" });
  });

  it("a permission ask of the child is a step of the card: Deny marks it denied under the call and answers under the child's id", async () => {
    const d = await boot({ script: ["subagent-permission"], ...withChild });
    const s = await d.open();
    await s.prompt("Run a subagent");
    await until(() => !!s.find("permission_request"));
    const req = s.find("permission_request")!;
    expect(req).toMatchObject({ tool: "Bash", toolUseId: "call_child", input: { command: "echo sub" } });
    await d.ok({ type: "permission.respond", requestId: req.requestId, decision: "deny", message: "no" });
    await until(() => s.find("tool_call", (p) => p.id === "call_child")?.status === "denied");
    expect(s.find("tool_call", (p) => p.id === "call_child")).toMatchObject({ parentId: "call_sub" });
    expect(d.requests("POST", `/api/session/ses_child/permission/${req.requestId}/reply`)[0]!.body).toMatchObject({ decision: "reject" });
  });

  it("Stop agent interrupts the child session; an idle child has nothing to interrupt, the card stops at once", async () => {
    const d = await boot({ script: ["subagent"], ...withChild });
    const s = await d.open();
    await s.prompt("Run a subagent");
    await until(() => s.find("subagent", (p) => p.id === "call_sub")?.status === "done");
    // A second notice would end it again: Stop on a finished card still reaches the child (OpenCode answers it is not running).
    await d.ok({ type: "session.stopSubagent", sessionId: s.id, subagentId: "call_sub" });
    expect(d.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
    expect((await d.request({ type: "session.stopSubagent", sessionId: s.id, subagentId: "call_unknown" })).type).toBe("error");
  });

  it("Stop agent on a subagent whose session is gone answers unknown_subagent, not a failure", async () => {
    // No session row for the child: OpenCode answers the interrupt 404.
    const d = await boot({ script: ["subagent"] });
    const s = await d.open();
    await s.prompt("Run a subagent");
    await until(() => s.find("subagent", (p) => p.id === "call_sub")?.status === "done");
    const r = await d.request({ type: "session.stopSubagent", sessionId: s.id, subagentId: "call_sub" });
    expect(r).toMatchObject({ type: "error", code: "unknown_subagent" });
    expect(d.requests("POST", "/api/session/ses_child/interrupt")).toHaveLength(1);
  });

  it("restore: the stored subagent call, its child's messages (nested subagents too) and its end notice give the parts and ids of the live run", async () => {
    const tool = (id: string, name: string, input: object, extra: object = {}) => ({ type: "tool", id, name, state: { status: "completed", input, content: [{ type: "text", text: "ok" }], ...extra }, time: { created: 2, ran: 3, completed: 4 } });
    const sub = (id: string, child: string, description: string) => tool(id, "subagent", { description, prompt: "p" }, { metadata: { sessionID: child, status: "running" } });
    const messages = {
      ses_own: [
        { id: "msg_u", type: "user", text: "Run a subagent", time: { created: 1 } },
        { id: "msg_a", type: "assistant", agent: "build", model: { id: "m", providerID: "fake" }, time: { created: 2 }, content: [sub("call_sub", "ses_child", "Look around")] },
        { id: "msg_n", type: "synthetic", time: { created: 9 }, text: '<subagent sessionID="ses_child" state="completed" description="Look around">\ndone\n</subagent>', metadata: { source: "subagent", childID: "ses_child", state: "completed" } },
      ],
      ses_child: [
        { id: "msg_c1", type: "assistant", agent: "general", model: { id: "m", providerID: "fake" }, time: { created: 5 }, content: [tool("call_child", "shell", { command: "echo sub" }), sub("call_inner", "ses_inner", "Dig")] },
        { id: "msg_cn", type: "synthetic", time: { created: 8 }, text: "n", metadata: { source: "subagent", childID: "ses_inner", state: "error" } },
      ],
      ses_inner: [{ id: "msg_i1", type: "assistant", agent: "general", model: { id: "m", providerID: "fake" }, time: { created: 6 }, content: [tool("call_deep", "read", { path: "a.txt" })] }],
    };
    const d = await boot({ projectDirInData: true, data: { sessions: [row("ses_own", "PROJECT", "Owner", 5000), row("ses_child", "PROJECT", "Look around", 4000, { parentID: "ses_own" }), row("ses_inner", "PROJECT", "Dig", 3000, { parentID: "ses_child" })], messages } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    for (let i = 0; i < 80 && !(await d.ok({ type: "session.list" })).sessions.some((x: any) => x.id === "ses_own"); i++) await sleep(50);
    await d.ok({ type: "session.subscribe", sessionId: "ses_own", sinceSeq: 0 });
    const s = d.view("ses_own");
    await until(() => !!s.last("call_deep"));
    expect(s.last("call_sub")).toMatchObject({ type: "subagent", status: "done", description: "Look around" });
    expect(s.last("call_sub").parentId).toBeUndefined();
    expect(s.last("call_child")).toMatchObject({ parentId: "call_sub", tool: "Bash", status: "done" });
    // A nested subagent: its card shows under the outer call, its steps under its own call; its notice says error.
    expect(s.last("call_inner")).toMatchObject({ type: "subagent", parentId: "call_sub", status: "error" });
    expect(s.last("call_deep")).toMatchObject({ parentId: "call_inner", tool: "Read" });
  });
});
