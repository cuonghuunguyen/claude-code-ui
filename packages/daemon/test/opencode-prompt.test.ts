// OpenCode prompting over the daemon's WebSocket: a real daemon, the fake `opencode` binary, scripted turns cut from a real recording (fixtures/opencode/turn-*.json).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
import { fakeQuery } from "./fake-query.ts";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const turn = (name: string) => fileURLToPath(new URL(`./fixtures/opencode/turn-${name}.json`, import.meta.url));
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const until = async (cond: () => boolean, ms = 8000) => {
  for (let i = 0; i < ms / 25 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};
const lastOf = <T,>(a: T[], f: (x: T) => boolean): T | undefined => [...a].reverse().find(f);
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

type Boot = Awaited<ReturnType<typeof boot>>;
async function boot(o: { script?: string[]; allowBypass?: boolean; data?: object; root?: string } = {}) {
  const root = o.root ?? realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const logFile = join(root, "fake.log");
  const dataFile = join(root, "data.json");
  writeFileSync(dataFile, JSON.stringify({ sessions: [], messages: {}, ...o.data }));
  const env: Record<string, string> = { FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_DATA: dataFile, FAKE_OPENCODE_SCRIPT: (o.script ?? []).map(turn).join(",") };
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
    appSettings: createSettings(),
    settingsFile: join(root, "sessions.json"),
    claudeDir: join(root, "claude"),
    projectsDir: join(root, "claude", "projects"),
    uploadSweepMs: 0,
    allowBypass: o.allowBypass,
    opencode: { command: [process.execPath, BIN], env: () => env },
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
    await until(() => inbox.some((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId));
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
  const fake = async (path: string, body: object = {}) => {
    const port = log().find((l) => l.type === "start")!.port;
    await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body) });
  };
  cleanups.push(() => (ws.close(), http.close()));
  /** A new OpenCode session, subscribed. */
  const open = async (engineOpts: object = {}) => {
    const id: string = (await ok({ type: "session.create", cwd: project, engine: "opencode", ...engineOpts })).session.id;
    await ok({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    const parts = () => inbox.filter((m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event" && m.sessionId === id).map((m) => m.part);
    const last = (partId: string) => lastOf(parts(), (p) => p.id === partId) as any;
    const find = <T extends Part["type"]>(type: T, test: (p: Extract<Part, { type: T }>) => boolean = () => true) => lastOf(parts(), (p) => p.type === type && test(p as never)) as Extract<Part, { type: T }> | undefined;
    const states = () => parts().filter((p) => p.type === "session_state").map((p) => (p as { state: string }).state);
    return { id, parts, last, find, states, prompt: (text: string, images?: string[]) => ok({ type: "session.prompt", sessionId: id, text, images }) };
  };
  return { root, project, http, ws, inbox, request, ok, log, requests, fake, open };
}

describe("OpenCode prompting", { timeout: 30_000 }, () => {
  it("a prompt streams reasoning and text, ends with a turn result and sends the message id, agent, text and image", async () => {
    const d = await boot({ script: ["text"] });
    const s = await d.open();
    await s.prompt("hello", [PNG]);
    await until(() => s.states().at(-1) === "idle" && s.states().includes("running"));
    const user = s.find("user_text")!;
    expect(user).toMatchObject({ text: "hello", images: [PNG] });
    expect(user.id).toMatch(/^msg_/);
    expect(s.parts().filter((p) => p.type === "user_text")).toHaveLength(1);
    expect(s.parts().some((p) => p.type === "thinking" && p.streaming)).toBe(true);
    expect(s.find("thinking")).toMatchObject({ streaming: false });
    expect(s.parts().some((p) => p.type === "assistant_text" && p.streaming)).toBe(true);
    expect(s.find("assistant_text")).toMatchObject({ streaming: false, text: expect.stringContaining("a.txt") });
    expect(s.find("turn_result")).toMatchObject({ isError: false, usage: { inputTokens: 297, outputTokens: 102 } });
    const sent = d.requests("POST", `/session/${s.id}/prompt_async`)[0]!.body;
    expect(sent).toMatchObject({ messageID: user.id, agent: "build", parts: [{ type: "text", text: "hello" }, { type: "file", mime: "image/png", url: PNG }] });
    expect(sent.parts[0].id).toMatch(/^prt_/);
    expect(sent.model).toBeUndefined();
  });

  it("a Bash permission shows the Claude card input, the rule and noEdit; Allow replies once and the tool finishes", async () => {
    const d = await boot({ script: ["bash"] });
    const s = await d.open();
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    const req = s.find("permission_request")!;
    expect(req).toMatchObject({ tool: "Bash", input: { command: "ls -la" }, noEdit: true, settled: false, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls *" }], behavior: "allow", destination: "session" }] });
    expect(s.states().at(-1)).toBe("needs_input");
    await d.ok({ type: "permission.respond", requestId: req.requestId, decision: "allow" });
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(d.requests("POST", `/permission/${req.requestId}/reply`)[0]).toMatchObject({ body: { reply: "once" }, query: { directory: d.project } });
    expect(s.last(req.toolUseId)).toMatchObject({ type: "tool_call", tool: "Bash", status: "done" });
    expect(s.last(`${req.toolUseId}:result`)).toMatchObject({ type: "tool_result", isError: false, output: expect.stringContaining("a.txt") });
    expect(s.last(req.requestId)).toMatchObject({ settled: true, decision: "allow" });
  });

  it("Allow always on Bash replies always and appends the rule to the session; on an edit it replies once and switches to acceptEdits", async () => {
    const d = await boot({ script: ["bash", "edit"] });
    const s = await d.open();
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    await d.ok({ type: "permission.respond", requestId: s.find("permission_request")!.requestId, decision: "allow_always" });
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(d.requests("POST", /\/permission\/.*\/reply/)[0]!.body).toEqual({ reply: "always" });
    const patch = d.requests("PATCH", `/session/${s.id}`).at(-1)!.body;
    expect(patch.permission).toEqual([{ permission: "bash", pattern: "ls *", action: "allow" }]);

    await s.prompt("edit a.txt");
    await until(() => s.parts().filter((p) => p.type === "permission_request").some((p: any) => p.tool === "Edit"));
    const edit = lastOf(s.parts(), (p) => p.type === "permission_request" && p.tool === "Edit") as Extract<Part, { type: "permission_request" }>;
    expect(edit.suggestions).toEqual([{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
    await d.ok({ type: "permission.respond", requestId: edit.requestId, decision: "allow_always" });
    await until(() => s.find("session_permission_mode")?.mode === "acceptEdits");
    expect(d.requests("POST", `/permission/${edit.requestId}/reply`)[0]!.body).toEqual({ reply: "once" });
    const block = d.requests("PATCH", `/session/${s.id}`).at(-1)!.body.permission as { permission: string; pattern: string; action: string }[];
    expect(block[0]).toEqual({ permission: "claude-ui", pattern: "mode:acceptEdits", action: "allow" });
    expect(block).toContainEqual({ permission: "edit", pattern: "*", action: "allow" });
    // The rule saved before stays in every later block.
    expect(block.slice(block.findIndex((r) => r.pattern === "always") + 1)).toEqual([{ permission: "bash", pattern: "ls *", action: "allow" }]);
  });

  it("Deny with a message rejects with it, the card stays denied and the turn goes on; Deny without a message rejects and the turn ends", async () => {
    const d = await boot({ script: ["question", "bash-reject"] });
    const s = await d.open();
    await s.prompt("ask me, then run pwd");
    await until(() => !!s.find("question"));
    await d.ok({ type: "question.respond", requestId: s.find("question")!.requestId, answers: { "Which color do you prefer: red or blue?": "Blue" } });
    await until(() => !!s.find("permission_request"));
    const req = s.find("permission_request")!;
    await d.ok({ type: "permission.respond", requestId: req.requestId, decision: "deny", message: "Do not run pwd" });
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(d.requests("POST", `/permission/${req.requestId}/reply`)[0]!.body).toEqual({ reply: "reject", message: "Do not run pwd" });
    expect(s.last(req.toolUseId)).toMatchObject({ type: "tool_call", status: "denied" });
    expect(s.find("assistant_text", (p) => p.text.includes("proj"))).toBeTruthy();

    await s.prompt("run echo one");
    await until(() => new Set(s.parts().filter((p) => p.type === "permission_request").map((p) => p.id)).size === 2);
    const second = lastOf(s.parts(), (p) => p.type === "permission_request") as Extract<Part, { type: "permission_request" }>;
    await d.ok({ type: "permission.respond", requestId: second.requestId, decision: "deny" });
    await until(() => s.parts().filter((p) => p.type === "turn_result").length === 2);
    expect(d.requests("POST", `/permission/${second.requestId}/reply`)[0]!.body).toEqual({ reply: "reject" });
    expect(s.states().at(-1)).toBe("idle");
  });

  it("a question shows as a question part; the answer goes to OpenCode as labels; a subagent shows nested with its permission in this session", async () => {
    const d = await boot({ script: ["question"] });
    const s = await d.open();
    await s.prompt("ask me");
    await until(() => !!s.find("question"));
    const q = s.find("question")!;
    expect(q.questions).toEqual([{ question: "Which color do you prefer: red or blue?", header: "Color preference", options: [{ label: "Red", description: "Prefer red" }, { label: "Blue", description: "Prefer blue" }], multiSelect: false }]);
    await d.ok({ type: "question.respond", requestId: q.requestId, answers: { [q.questions[0]!.question]: "Blue" } });
    expect(d.requests("POST", `/question/${q.requestId}/reply`)[0]!.body).toEqual({ answers: [["Blue"]] });
    // Subagent: the task call is a subagent part, its child session's parts nest under the call.
    await until(() => !!s.find("permission_request"));
    const sub = s.find("subagent")!;
    expect(sub).toMatchObject({ description: "Read a.txt and report", status: "done" });
    const nested = s.parts().filter((p) => p.parentId === sub.id);
    expect(nested.some((p) => p.type === "tool_call" && p.tool === "Read")).toBe(true);
    expect(nested.some((p) => p.type === "assistant_text")).toBe(true);
    expect(s.find("permission_request")).toMatchObject({ tool: "Bash", input: { command: "pwd" } });
  });

  it("Stop during a question rejects it and aborts; Stop mid-stream aborts, shows the interrupted marker and ends idle", async () => {
    const d = await boot({ script: ["question", "abort"] });
    const s = await d.open();
    await s.prompt("ask me");
    await until(() => !!s.find("question"));
    const q = s.find("question")!;
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => s.states().at(-1) === "idle");
    expect(d.requests("POST", `/question/${q.requestId}/reject`)).toHaveLength(1);
    expect(d.requests("POST", `/session/${s.id}/abort`)).toHaveLength(1);
    expect(s.last(q.requestId)).toMatchObject({ settled: true });

    const thinking = s.parts().filter((p) => p.type === "thinking").length;
    await s.prompt("long essay");
    await until(() => s.parts().filter((p) => p.type === "thinking").length > thinking);
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => !!s.find("turn_interrupted") && s.states().at(-1) === "idle");
    expect(d.requests("POST", `/session/${s.id}/abort`)).toHaveLength(2);
  });

  it("models.list for OpenCode groups the models by provider; a chosen model reaches the prompt as providerID and modelID", async () => {
    const d = await boot({ script: ["text"] });
    const models = (await d.ok({ type: "models.list", engine: "opencode" })).models;
    expect(models[0]).toEqual({ value: "default", displayName: "Default (OpenCode Big Pickle)", description: "" });
    expect(models).toContainEqual({ value: "acme/x/y", displayName: "Model X", description: "", group: "Acme" });
    const s = await d.open();
    await d.ok({ type: "session.setModel", sessionId: s.id, model: "acme/x/y" });
    expect(s.find("session_model")).toMatchObject({ model: "acme/x/y" });
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)[0]!.body.model).toEqual({ providerID: "acme", modelID: "x/y" });
  });

  it("modes: create writes the default block; plan appends the plan agent's edit rules and prompts as the plan agent; auto, dontAsk and (without the flag) bypass are refused; leaving plan through OpenCode returns to default", async () => {
    const d = await boot({ script: ["text"] });
    const s = await d.open();
    const created = d.requests("POST", "/session")[0]!.body.permission as { permission: string; pattern: string; action: string }[];
    expect(created.map((r) => `${r.permission}:${r.pattern}:${r.action}`)).toEqual(["claude-ui:mode:default:allow", "bash:*:ask", "edit:*:ask", "webfetch:*:ask", "websearch:*:ask", "claude-ui:always:allow"]);
    for (const mode of ["auto", "dontAsk", "bypassPermissions"]) expect(await d.request({ type: "session.setPermissionMode", sessionId: s.id, mode })).toMatchObject({ type: "error" });
    await d.ok({ type: "session.setPermissionMode", sessionId: s.id, mode: "plan" });
    const plan = d.requests("PATCH", `/session/${s.id}`).at(-1)!.body.permission as { permission: string; pattern: string; action: string }[];
    expect(plan.map((r) => `${r.permission}:${r.pattern}:${r.action}`)).toEqual(["claude-ui:mode:plan:allow", "bash:*:ask", "webfetch:*:ask", "websearch:*:ask", "edit:*:deny", "edit:.opencode/plans/*.md:allow", "claude-ui:always:allow"]);
    await s.prompt("plan it");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)[0]!.body.agent).toBe("plan");
    // plan_exit "Yes": OpenCode writes a user message of the build agent.
    await d.fake("/__emit", { events: [{ type: "message.updated", properties: { sessionID: s.id, info: { id: "msg_fromtui", role: "user", agent: "build", sessionID: s.id } } }] });
    await until(() => s.find("session_permission_mode")?.mode === "default");
    expect(d.requests("PATCH", `/session/${s.id}`).at(-1)!.body.permission[0].pattern).toBe("mode:default");
  });

  it("bypass is offered and applied only with the daemon flag", async () => {
    const d = await boot({ allowBypass: true });
    const s = await d.open();
    await d.ok({ type: "session.setPermissionMode", sessionId: s.id, mode: "bypassPermissions" });
    const block = d.requests("PATCH", `/session/${s.id}`).at(-1)!.body.permission as { permission: string; action: string }[];
    expect(block.filter((r) => r.action === "allow" && r.permission !== "claude-ui").map((r) => r.permission)).toEqual(["bash", "edit", "webfetch", "websearch"]);
  });

  it("a restored session shows the history with Claude card names and message ids, a busy turn as running, and the pending permission of the folder", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const row = { id: "ses_old", slug: "old", projectID: "global", directory: project, title: "Old", version: "1.18.34", time: { created: 1, updated: 2 }, permission: [{ permission: "claude-ui", pattern: "mode:acceptEdits", action: "allow" }, { permission: "claude-ui", pattern: "always", action: "allow" }, { permission: "bash", pattern: "ls *", action: "allow" }] };
    const msg = (id: string, role: string, parts: object[]) => ({ info: { id, role, sessionID: "ses_old", agent: "build" }, parts: parts.map((p, i) => ({ id: `${id}_p${i}`, sessionID: "ses_old", messageID: id, ...p })) });
    const messages = [
      msg("msg_u", "user", [{ type: "text", text: "run it" }, { type: "text", text: "synthetic", synthetic: true }]),
      msg("msg_a", "assistant", [
        { type: "tool", callID: "call_t", tool: "task", state: { status: "running", input: { description: "dig", prompt: "p", subagent_type: "general" }, metadata: { sessionId: "ses_kid" }, time: { start: 5 } } },
        { type: "tool", callID: "call_b", tool: "bash", state: { status: "running", input: { command: "ls" }, time: { start: 6 } } },
      ]),
    ];
    const kid = [{ info: { id: "msg_k", role: "assistant", sessionID: "ses_kid" }, parts: [{ id: "msg_k_p0", sessionID: "ses_kid", messageID: "msg_k", type: "text", text: "child says hi", time: { start: 1, end: 2 } }] }];
    const ask = { type: "permission.asked", id: "per_old", sessionID: "ses_old", permission: "bash", patterns: ["ls"], metadata: {}, always: ["ls *"], tool: { messageID: "msg_a", callID: "call_b" } };
    const d = await boot({ root, data: { sessions: [row, { ...row, id: "ses_kid", parentID: "ses_old", permission: undefined }], messages: { ses_old: messages, ses_kid: kid }, asks: [ask], busy: ["ses_old"] } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    const sub = await d.ok({ type: "session.subscribe", sessionId: "ses_old", sinceSeq: 0, paged: true });
    const parts: any[] = sub.snapshot.page.parts;
    expect(parts.map((p) => `${p.type}:${p.id}${p.parentId ? `<${p.parentId}` : ""}`)).toEqual(["user_text:msg_u", "subagent:call_t", "assistant_text:msg_k_p0<call_t", "tool_call:call_b", "permission_request:per_old"]);
    expect(parts[0]).toMatchObject({ text: "run it" });
    expect(parts.find((p) => p.type === "tool_call")).toMatchObject({ tool: "Bash", input: { command: "ls" } });
    expect(sub.session.state).toBe("needs_input");
    // The saved mode differs from OpenCode's last block after a mode change made elsewhere: the next prompt writes the block first.
    await d.ok({ type: "permission.respond", requestId: "per_old", decision: "allow" });
    expect(d.requests("POST", "/permission/per_old/reply")[0]!.body).toEqual({ reply: "once" });
  });

  it("a dropped event stream reconnects, reads the session again and does not repeat the pending request", async () => {
    const d = await boot({ script: ["bash"] });
    const s = await d.open();
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    const before = d.requests("GET", `/session/${s.id}/message`).length;
    await d.fake("/__drop");
    await until(() => d.requests("GET", "/global/event").length === 2 && d.requests("GET", `/session/${s.id}/message`).length > before, 12000);
    expect(s.parts().filter((p) => p.type === "permission_request")).toHaveLength(1);
    await d.ok({ type: "permission.respond", requestId: s.find("permission_request")!.requestId, decision: "allow" });
    await until(() => !!s.find("turn_result"));
  });

  it("a message queued while a turn runs is sent as the next prompt after the turn", async () => {
    const d = await boot({ script: ["bash", "text"] });
    const s = await d.open();
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    await d.ok({ type: "session.enqueue", sessionId: s.id, text: "and then?" });
    await d.ok({ type: "permission.respond", requestId: s.find("permission_request")!.requestId, decision: "allow" });
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 2, 12000);
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)[1]!.body.parts[0].text).toBe("and then?");
  });

  it("a permission answered in OpenCode itself settles as cancelled here and sends no reply", async () => {
    const d = await boot({ script: ["bash"] });
    const s = await d.open();
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    const req = s.find("permission_request")!;
    await d.fake("/__emit", { events: [{ type: "permission.replied", properties: { sessionID: s.id, requestID: req.requestId, reply: "once" } }] });
    await until(() => (s.last(req.requestId) as any).settled === true);
    expect(s.last(req.requestId)).toMatchObject({ decision: "cancelled" });
    expect(d.requests("POST", /\/permission\/.*\/reply/)).toHaveLength(0);
  });

  it("a prompt while a turn runs is refused", async () => {
    const d = await boot({ script: ["bash"] });
    const s = await d.open();
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    expect(await d.request({ type: "session.prompt", sessionId: s.id, text: "again" })).toMatchObject({ type: "error", code: "prompt_failed" });
  });
});
