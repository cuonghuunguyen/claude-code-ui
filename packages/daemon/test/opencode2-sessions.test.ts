// OpenCode 2 sessions over the daemon's WebSocket: a real daemon, the fake OpenCode 2 binary (fixtures/opencode2) and scripted turns cut from a recording of a real OpenCode 2.3.0.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type Part, type ServerMessage } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createDaemon } from "../src/server.ts";
import { createOpenCode2Engine, modeRules, OPENCODE2_CAPABILITIES } from "../src/opencode2-engine.ts";
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

async function boot(o: { script?: string[]; data?: object; env?: Record<string, string>; sessionsJson?: object; allowBypass?: boolean; /** The binary (default: the fake OpenCode 2). */ bin?: string; /** The adapter record on disk before the start. */ adapters?: object; /** A folder where the record file should be: a save of the record fails. */ adaptersBroken?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oc2-")));
  const project = join(root, "project");
  const other = join(root, "other");
  mkdirSync(project, { recursive: true });
  mkdirSync(other, { recursive: true });
  const logFile = join(root, "fake.log");
  const dataFile = join(root, "data.json");
  writeFileSync(dataFile, JSON.stringify({ sessions: [], messages: {}, ...o.data }));
  if (o.sessionsJson) writeFileSync(join(root, "sessions.json"), JSON.stringify(o.sessionsJson));
  const adaptersFile = join(root, "opencode-adapters.json");
  if (o.adapters) writeFileSync(adaptersFile, JSON.stringify(o.adapters));
  if (o.adaptersBroken) mkdirSync(adaptersFile);
  const env: Record<string, string> = { FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE2_DATA: dataFile, FAKE_OPENCODE2_SCRIPT: (o.script ?? []).map(turn).join(","), FAKE_OPENCODE_DATA: dataFile, ...o.env };
  const appSettings = createSettings();
  appSettings.set({ terminalAccess: { enabled: false }, inlineTask: { enabled: false } } as never);
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
  const fake = async (path: string) => {
    const port2 = log().find((l) => l.type === "start")!.port;
    await fetch(`http://127.0.0.1:${port2}${path}`, { method: "POST" });
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

const done = { time: { created: 2, completed: 3 } };
const msg = (id: string, type: "user" | "assistant", extra: object = {}) => ({ id, type, time: { created: 1 }, ...(type === "user" ? { text: "q" } : { agent: "build", model: { id: "m", providerID: "fake" }, content: [{ type: "text", text: "a" }] }), ...extra });
/** A daemon whose OpenCode 2 holds `ses_own` (in the project) with `messages`, listed once. */
async function owned(messages: object[], extra: object = {}, o: Parameters<typeof boot>[0] = {}) {
  const d = await boot(o);
  writeFileSync(join(d.root, "data.json"), JSON.stringify({ sessions: [row("ses_own", d.project, "Owner", 5000, extra)], messages: { ses_own: messages } }));
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
    expect(post!.body).toEqual({ location: { directory: d.project }, permissions: modeRules(created.permissionMode) });
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
    expect(d.requests("PATCH", `/api/session/${s.id}`).map((r) => r.body)).toEqual([{ permissions: modeRules("acceptEdits") }]);
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
    const kinds = [...new Set(s.parts().filter((p) => p.type !== "session_state" && p.type !== "context_usage" && p.type !== "commands").map((p) => `${p.type}:${p.id}`))];
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
    expect(writes[0]!.body.permissions).toEqual([...modeRules("default"), { action: "edit", resource: "*", effect: "deny" }]);
    await d.ok({ type: "aside.close", sessionId: session.id });
    await until(() => d.requests("DELETE", `/api/session/${session.id}`).length > 0);
    expect((await d.ok({ type: "session.list" })).sessions.map((s: any) => s.id)).toEqual(["ses_own"]);
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
    expect(rules.at(-1)).toEqual(modeRules("acceptEdits"));
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

  it("a prompt sent here, undone and redone, comes back with its user message", async () => {
    const { d, s } = await opened();
    const id: string = (await s.prompt("four")).messageId ?? lastOf(s.parts(), (p) => p.type === "user_text" && (p as { text: string }).text === "four")!.id;
    await until(() => s.parts().some((p) => p.type === "turn_result"));
    await s.prompt("/undo");
    expect(lastOf(stages(d), () => true)).toMatchObject({ messageID: id });
    const before = s.parts().length;
    await s.prompt("/redo");
    await until(() => d.requests("DELETE", "/api/session/ses_own/revert").length === 1);
    await until(() => s.parts().slice(before).some((p) => p.id === id && p.type === "user_text"));
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
});
