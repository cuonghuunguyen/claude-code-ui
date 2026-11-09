// OpenCode prompting over the daemon's WebSocket: a real daemon, the fake `opencode` binary, scripted turns cut from a real recording (fixtures/opencode/turn-*.json).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type Part, type ServerMessage } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createDaemon } from "../src/server.ts";
import { mcpName, type Rule } from "../src/opencode-engine.ts";
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
/** The warnings of a turn OpenCode ended on its own (GH-682). */
const abortNotices = (s: { parts: () => Part[] }) => s.parts().filter((p) => p.type === "notice" && p.id.includes(":aborted:")) as Extract<Part, { type: "notice" }>[];
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

type Boot = Awaited<ReturnType<typeof boot>>;
async function boot(o: { script?: string[]; allowBypass?: boolean; data?: object; root?: string; env?: Record<string, string> } = {}) {
  const root = o.root ?? realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const logFile = join(root, "fake.log");
  const dataFile = join(root, "data.json");
  writeFileSync(dataFile, JSON.stringify({ sessions: [], messages: {}, ...o.data }));
  const env: Record<string, string> = { FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_DATA: dataFile, FAKE_OPENCODE_SCRIPT: (o.script ?? []).map(turn).join(","), ...o.env };
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
  it("plugins.reload counts no OpenCode session as reloaded", async () => {
    const d = await boot();
    await d.open();
    expect(await d.ok({ type: "plugins.reload", cwd: d.project })).toEqual({ reloaded: 0, failed: [], errorCount: 0 });
  });

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
    // A Stop is not an abort OpenCode did on its own: no warning, no reload of the folder.
    expect(abortNotices(s)).toHaveLength(0);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  it("a message sent right after Stop starts the next turn after the aborted one ended", async () => {
    const d = await boot({ script: ["abort", "text"] });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => s.parts().some((p) => p.type === "thinking"));
    await Promise.all([d.ok({ type: "session.interrupt", sessionId: s.id }), s.prompt("say DONE")]);
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 2 && !!s.find("turn_result"));
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)[1]!.body).toMatchObject({ messageID: s.parts().find((p) => p.type === "user_text" && p.text === "say DONE")!.id });
    expect(s.parts().filter((p) => p.type === "user_text" && p.text === "say DONE")).toHaveLength(1);
    expect(s.find("turn_interrupted")).toBeTruthy();
    expect(s.states().at(-1)).toBe("idle");
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

  it("effort: models with reasoning variants list them as effort levels; the prompt carries the variant only when the model has it", async () => {
    const d = await boot({ script: ["text", "text", "text"] });
    const models = (await d.ok({ type: "models.list", engine: "opencode" })).models;
    expect(models.find((m: any) => m.value === "opencode/thinker")).toMatchObject({ supportsEffort: true, supportedEffortLevels: ["low", "high"] });
    expect(models.find((m: any) => m.value === "acme/x/y")).not.toHaveProperty("supportsEffort");
    expect(models[0]).not.toHaveProperty("supportsEffort");
    const s = await d.open();
    await d.ok({ type: "session.setEffort", sessionId: s.id, effort: "high" });
    const turns = async (n: number) => until(() => s.parts().filter((p) => p.type === "turn_result").length === n);
    await d.ok({ type: "session.setModel", sessionId: s.id, model: "opencode/thinker" });
    await s.prompt("one");
    await turns(1);
    await d.ok({ type: "session.setEffort", sessionId: s.id, effort: "medium" });
    await s.prompt("two");
    await turns(2);
    await d.ok({ type: "session.setModel", sessionId: s.id, model: "acme/x/y" });
    await d.ok({ type: "session.setEffort", sessionId: s.id, effort: "high" });
    await s.prompt("three");
    await turns(3);
    const bodies = d.requests("POST", `/session/${s.id}/prompt_async`).map((r) => r.body);
    expect(bodies[0]).toMatchObject({ variant: "high" });
    expect(bodies[1]).not.toHaveProperty("variant");
    expect(bodies[2]).not.toHaveProperty("variant");
  });

  it("/compact summarizes with the default model: compaction marker, summary text, turn result; while a turn runs it is refused with a notice", async () => {
    const d = await boot({ script: ["compact", "bash"] });
    const s = await d.open();
    expect(await s.prompt("/compact")).toEqual({ local: true });
    await until(() => !!s.find("turn_result") && s.states().at(-1) === "idle");
    expect(d.requests("POST", `/session/${s.id}/summarize`).map((r) => r.body)).toEqual([{ providerID: "opencode", modelID: "big-pickle" }]);
    expect(s.find("compaction")).toMatchObject({ trigger: "manual" });
    expect(s.find("assistant_text")).toMatchObject({ text: expect.stringContaining("Summary") });
    expect(s.parts().some((p) => p.type === "user_text")).toBe(false);
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)).toHaveLength(0);
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    await s.prompt("/compact");
    await until(() => !!s.find("notice", (p) => p.text === "Stop the turn first"));
    expect(d.requests("POST", `/session/${s.id}/summarize`)).toHaveLength(1);
    expect(s.parts().filter((p) => p.type === "user_text").map((p) => (p as { text: string }).text)).toEqual(["run ls"]);
  });

  it("/compact uses the chosen model", async () => {
    const d = await boot({ script: ["compact"] });
    const s = await d.open();
    await d.ok({ type: "session.setModel", sessionId: s.id, model: "acme/x/y" });
    await s.prompt("/compact");
    await until(() => !!s.find("turn_result"));
    expect(d.requests("POST", `/session/${s.id}/summarize`)[0]!.body).toEqual({ providerID: "acme", modelID: "x/y" });
  });

  it("bash mode runs the command through OpenCode's shell as a Bash card without a model call, user message or turn result; during a turn it is queued", async () => {
    const d = await boot({ script: ["bash"] });
    const s = await d.open();
    await d.ok({ type: "session.bash", sessionId: s.id, command: "echo e2e-ok" });
    await until(() => !!s.find("tool_result") && s.states().at(-1) === "idle");
    const shell = d.requests("POST", `/session/${s.id}/shell`);
    expect(shell).toHaveLength(1);
    expect(shell[0]!.body).toMatchObject({ command: "echo e2e-ok", agent: "build", messageID: expect.stringMatching(/^msg_/) });
    expect(shell[0]!.body.model).toBeUndefined();
    expect(s.find("tool_call")).toMatchObject({ tool: "Bash", input: { command: "echo e2e-ok" }, status: "done" });
    expect(s.find("tool_result")).toMatchObject({ isError: false, output: expect.stringContaining("e2e-ok") });
    expect(s.states()).toEqual(["running", "idle"]);
    expect(s.parts().some((p) => p.type === "user_text" || p.type === "turn_result")).toBe(false);
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)).toHaveLength(0);
    // During a turn the command waits in the queue (the shell would refuse a busy session).
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    expect(await d.ok({ type: "session.bash", sessionId: s.id, command: "echo later" })).toHaveProperty("itemId");
    expect(d.requests("POST", `/session/${s.id}/shell`)).toHaveLength(1);
  });

  it("a failing shell request is a notice and ends the run idle", async () => {
    const d = await boot();
    const s = await d.open();
    await d.fake("/__fail", { path: `/session/${s.id}/shell` });
    await d.ok({ type: "session.bash", sessionId: s.id, command: "echo x" });
    await until(() => !!s.last(`${s.id}:shell_failed`) && s.states().at(-1) === "idle");
  });

  it("modes: create writes the default block; plan appends the plan agent's edit rules and prompts as the plan agent; auto, dontAsk and (without the flag) bypass are refused; leaving plan through OpenCode returns to default", async () => {
    const d = await boot({ script: ["text"] });
    const s = await d.open();
    const created = d.requests("POST", "/session")[0]!.body.permission as { permission: string; pattern: string; action: string }[];
    expect(created.map((r) => `${r.permission}:${r.pattern}:${r.action}`)).toEqual(["claude-ui:mode:default:allow", "bash:*:ask", "edit:*:ask", "webfetch:*:ask", "websearch:*:ask", "orchestration-*:*:deny", "claude-ui:always:allow"]);
    for (const mode of ["auto", "dontAsk", "bypassPermissions"]) expect(await d.request({ type: "session.setPermissionMode", sessionId: s.id, mode })).toMatchObject({ type: "error" });
    await d.ok({ type: "session.setPermissionMode", sessionId: s.id, mode: "plan" });
    const plan = d.requests("PATCH", `/session/${s.id}`).at(-1)!.body.permission as { permission: string; pattern: string; action: string }[];
    expect(plan.map((r) => `${r.permission}:${r.pattern}:${r.action}`)).toEqual(["claude-ui:mode:plan:allow", "bash:*:ask", "webfetch:*:ask", "websearch:*:ask", "edit:*:deny", "edit:.opencode/plans/*.md:allow", "orchestration-*:*:deny", "claude-ui:always:allow"]);
    await s.prompt("plan it");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)[0]!.body.agent).toBe("plan");
    // plan_exit "Yes": OpenCode writes a user message of the build agent.
    const patches = d.requests("PATCH", `/session/${s.id}`).length;
    const buildMessage = (id: string) => ({ type: "message.updated", properties: { sessionID: s.id, info: { id, role: "user", agent: "build", sessionID: s.id } } });
    // OpenCode repeats message.updated: one block only.
    await d.fake("/__emit", { events: [buildMessage("msg_fromtui"), buildMessage("msg_fromtui")] });
    await until(() => s.find("session_permission_mode")?.mode === "default");
    await new Promise((r) => setTimeout(r, 300));
    expect(d.requests("PATCH", `/session/${s.id}`)).toHaveLength(patches + 1);
    expect(d.requests("PATCH", `/session/${s.id}`).at(-1)!.body.permission[0].pattern).toBe("mode:default");
  });

  it("bypass is offered and applied only with the daemon flag", async () => {
    const d = await boot({ allowBypass: true });
    const s = await d.open();
    await d.ok({ type: "session.setPermissionMode", sessionId: s.id, mode: "bypassPermissions" });
    const block = d.requests("PATCH", `/session/${s.id}`).at(-1)!.body.permission as { permission: string; action: string }[];
    expect(block.filter((r) => r.action === "allow" && r.permission !== "claude-ui").map((r) => r.permission)).toEqual(["bash", "edit", "webfetch", "websearch", "external_directory", "doom_loop"]);
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
    // No saved mode: the mode of the last block in OpenCode.
    expect(sub.session.permissionMode).toBe("acceptEdits");
    // Events between the history read and the stream connecting are lost: the session is read again once the stream is open.
    await until(() => d.requests("GET", "/session/ses_old/message").length >= 2);
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

  it("a prompt that failed to send does not block the turn-end check of a later turn started in OpenCode", async () => {
    const d = await boot();
    const s = await d.open();
    await d.fake("/__fail", { path: `/session/${s.id}/prompt_async` });
    await s.prompt("hello");
    await until(() => !!s.last(`${s.id}:prompt_failed`) && s.states().at(-1) === "idle");
    // A turn started in OpenCode's own UI; it ends while the stream is down: the reconnect read ends it (3 s after the failed send).
    await d.fake("/__emit", { events: [{ type: "session.status", properties: { sessionID: s.id, status: { type: "busy" } } }] });
    await until(() => s.states().at(-1) === "running");
    await d.fake("/__emit", { events: [{ type: "session.status", properties: { sessionID: s.id, status: { type: "idle" } } }] });
    await new Promise((r) => setTimeout(r, 3200));
    await d.fake("/__drop");
    await until(() => s.states().at(-1) === "idle", 5000);
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

  it("a prompt while a turn runs is steering: sent at once, shown, the state stays and the turn ends once", async () => {
    const d = await boot({ script: ["bash"] });
    const s = await d.open();
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    const states = s.states().length;
    await s.prompt("also say DONE");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 2);
    const steer = d.requests("POST", `/session/${s.id}/prompt_async`)[1]!.body;
    expect(steer).toMatchObject({ agent: "build", parts: [{ type: "text", text: "also say DONE" }] });
    expect(s.parts().filter((p) => p.type === "user_text").map((p: any) => p.text)).toEqual(["run ls", "also say DONE"]);
    expect(s.states()).toHaveLength(states);
    expect(s.states().at(-1)).toBe("needs_input");
    await d.ok({ type: "permission.respond", requestId: s.find("permission_request")!.requestId, decision: "allow" });
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(s.parts().filter((p) => p.type === "turn_result")).toHaveLength(1);
  });

  it("a /command text sent while the turn runs is steering (plain prompt_async), not POST /command", async () => {
    const d = await boot({ script: ["bash"] });
    const s = await d.open();
    await s.prompt("run ls");
    await until(() => !!s.find("permission_request"));
    await s.prompt("/review main");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 2);
    expect(d.requests("POST", `/session/${s.id}/command`)).toHaveLength(0);
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)[1]!.body.parts[0].text).toBe("/review main");
  });

  it("a multi-select answer with choices reaches OpenCode exactly as chosen, also when a label holds the separator", async () => {
    const d = await boot();
    const s = await d.open();
    const options = ["Blue", "Blue, green", "Red"].map((label) => ({ label, description: "" }));
    await d.fake("/__emit", { directory: d.project, events: [{ type: "question.asked", properties: { id: "que_multi", sessionID: s.id, questions: [{ question: "Q", header: "H", options, multiple: true }] } }] });
    await until(() => !!s.find("question"));
    // "Blue, green" is the label Blue plus the user's own text "green": only the structure tells it from the label "Blue, green".
    await d.ok({ type: "question.respond", requestId: "que_multi", answers: { Q: "Blue, green" }, choices: { Q: ["Blue", "green"] } });
    expect(d.requests("POST", "/question/que_multi/reply")[0]!.body).toEqual({ answers: [["Blue", "green"]] });
    expect(await d.request({ type: "question.respond", requestId: "x", answers: { Q: "a" }, choices: { Q: [1] } })).toMatchObject({ type: "error", code: "bad_request" });
  });

  it("Stop agent aborts the child session of the task call", async () => {
    const d = await boot({ script: ["question"] });
    const s = await d.open();
    await s.prompt("ask me");
    await until(() => !!s.find("question"));
    await d.ok({ type: "question.respond", requestId: s.find("question")!.requestId, answers: { [s.find("question")!.questions[0]!.question]: "Blue" } });
    await until(() => !!s.find("subagent"));
    await d.ok({ type: "session.stopSubagent", sessionId: s.id, subagentId: s.find("subagent")!.id });
    expect(d.requests("POST", `/session/${s.id}_child/abort`)).toHaveLength(1);
  });

  it("slash commands: the session lists GET /command, session.commands answers for a draft; /name args runs POST /command, other /x is a plain prompt, a failure is a notice and idle", async () => {
    const d = await boot({ script: ["text"] });
    const s = await d.open();
    await until(() => !!s.find("commands"));
    expect(s.find("commands")!.commands.map((c) => c.name)).toEqual(["compact", "undo", "redo", "init", "review", "fail"]);
    expect(s.find("commands")!.commands[3]).toEqual({ name: "init", description: "guided AGENTS.md setup", argumentHint: "$ARGUMENTS" });
    expect(s.find("commands")!.commands[4]).toMatchObject({ description: "", argumentHint: "" });
    expect((await d.ok({ type: "session.commands", cwd: d.project, engine: "opencode" })).commands.map((c: { name: string }) => c.name)).toContain("review");

    await s.prompt("/review main");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    const sent = d.requests("POST", `/session/${s.id}/command`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ command: "review", arguments: "main", agent: "build", messageID: expect.stringMatching(/^msg_/), parts: [] });
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)).toHaveLength(0);
    expect(s.parts().filter((p) => p.type === "user_text").map((p: any) => p.text)).toEqual(["/review main"]);

    await s.prompt("/fail");
    await until(() => !!s.find("notice", (n) => n.id.endsWith("prompt_failed")));
    expect(s.states().at(-1)).toBe("idle");

    await s.prompt("/unknown x");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 1);
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)[0]!.body.parts[0].text).toBe("/unknown x");
  });

  it("context usage: after a turn the last completed assistant message's tokens over the model's window; a restored session has it before any prompt", async () => {
    const d = await boot({ script: ["text"] });
    const s = await d.open();
    expect(s.find("context_usage")).toBeUndefined();
    await s.prompt("hello");
    await until(() => !!s.find("context_usage"));
    expect(s.find("context_usage")!.usage).toEqual({ totalTokens: 14389, maxTokens: 200000, percentage: 7, categories: [{ name: "Used", tokens: 14389, kind: "used" }, { name: "Free", tokens: 185611, kind: "free" }] });
    expect(d.requests("GET", "/config/providers")).toHaveLength(1);

    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const row = { id: "ses_ctx", slug: "c", projectID: "global", directory: project, title: "Ctx", version: "1.18.34", time: { created: 1, updated: 2 } };
    const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 75 } };
    const msg = (id: string, info: object) => ({ info: { id, sessionID: "ses_ctx", ...info }, parts: [] });
    const messages = [
      msg("msg_u", { role: "user" }),
      msg("msg_a", { role: "assistant", providerID: "opencode", modelID: "big-pickle", tokens, time: { created: 1, completed: 2 } }),
      msg("msg_b", { role: "assistant", providerID: "opencode", modelID: "big-pickle", tokens: { ...tokens, input: 0 }, time: { created: 3 } }),
    ];
    const r = await boot({ root, data: { sessions: [row], messages: { ses_ctx: messages } } });
    await r.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await r.ok({ type: "session.list" });
    await r.ok({ type: "session.subscribe", sessionId: "ses_ctx", sinceSeq: 0 });
    await until(() => r.inbox.some((m) => m.type === "event" && m.part.type === "context_usage"));
    const usage = (r.inbox.find((m) => m.type === "event" && m.part.type === "context_usage") as any).part.usage;
    expect(usage).toMatchObject({ totalTokens: 1200, maxTokens: 200000, percentage: 1 });
  });

  it("Stop pressed while the prompt waits for the event stream sends nothing and ends the turn as interrupted", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_STREAM_DELAY_MS: "1200" } });
    const s = await d.open();
    await s.prompt("hello");
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => !!s.find("turn_interrupted") && s.states().at(-1) === "idle", 12000);
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)).toHaveLength(0);
  });
});

describe("OpenCode event stream", { timeout: 30_000 }, () => {
  it("after a drop a prompt waits for the reconnect instead of sending into a closed stream", async () => {
    const d = await boot();
    const s = await d.open();
    await until(() => d.requests("GET", "/global/event").length === 1);
    await d.fake("/__drop");
    await new Promise((r) => setTimeout(r, 300));
    const before = Date.now();
    await s.prompt("hi");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 1, 12000);
    expect(d.requests("GET", "/global/event")).toHaveLength(2);
    expect(Date.now() - before).toBeGreaterThan(400);
  });
});

describe("OpenCode restore", { timeout: 30_000 }, () => {
  it("a restored busy session whose idle event was lost ends its turn when the stream connects", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const row = { id: "ses_busy", slug: "b", projectID: "global", directory: project, title: "Busy", version: "1.18.34", time: { created: 1, updated: 2 } };
    const d = await boot({ root, env: { FAKE_OPENCODE_STREAM_DELAY_MS: "800" }, data: { sessions: [row], messages: { ses_busy: [] }, busy: ["ses_busy"] } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    const sub = await d.ok({ type: "session.subscribe", sessionId: "ses_busy", sinceSeq: 0 });
    expect(sub.session.state).toBe("running");
    // OpenCode finishes before the stream is open: the idle event reaches nobody.
    await d.fake("/__emit", { events: [{ type: "session.status", properties: { sessionID: "ses_busy", status: { type: "idle" } } }] });
    await until(() => d.inbox.some((m) => m.type === "event" && m.part.type === "turn_result"), 10000);
    const states = d.inbox.filter((m) => m.type === "event" && m.part.type === "session_state").map((m: any) => m.part.state);
    expect(states.at(-1)).toBe("idle");
  });

  it("a prompt waiting for a slow reconnect is not ended by the resync that comes with it", async () => {
    const d = await boot({ env: { FAKE_OPENCODE_STREAM_DELAY_MS: "3500" } });
    const s = await d.open();
    await until(() => d.requests("GET", "/global/event").length === 1);
    await new Promise((r) => setTimeout(r, 3700));
    await d.fake("/__drop");
    await new Promise((r) => setTimeout(r, 200));
    await s.prompt("hi");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 1, 15000);
    await new Promise((r) => setTimeout(r, 500));
    expect(s.parts().some((p) => p.type === "turn_result")).toBe(false);
    expect(s.states().at(-1)).toBe("running");
  });
});


describe("OpenCode rewind", { timeout: 30_000 }, () => {
  const diff = (file: string, additions: number, deletions: number) => ({ file, additions, deletions });
  const user = (id: string, text: string, diffs: object[] = []) => ({ info: { id, role: "user", sessionID: "ses_rw", agent: "build", summary: { diffs } }, parts: [{ id: `${id}_p`, sessionID: "ses_rw", messageID: id, type: "text", text }] });
  const messages = [user("msg_u1", "one"), user("msg_u2", "two", [diff("a.ts", 2, 1)]), user("msg_u3", "three", [diff("a.ts", 1, 0), diff("b.ts", 3, 0)]), user("msg_u4", "four")];
  const row = (project: string, extra: object = {}) => ({ id: "ses_rw", slug: "rw", projectID: "global", directory: project, title: "Rewind", version: "1.18.34", time: { created: 1, updated: 2 }, ...extra });
  /** A stored OpenCode session, subscribed. */
  async function restored(o: { revert?: string; busy?: boolean; env?: Record<string, string> } = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const d = await boot({ root, data: { sessions: [row(project, o.revert ? { revert: { messageID: o.revert, snapshot: "s" } } : {})], messages: { ses_rw: messages }, busy: o.busy ? ["ses_rw"] : [] }, env: o.env });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    const sub = await d.ok({ type: "session.subscribe", sessionId: "ses_rw", sinceSeq: 0, paged: true });
    const parts = () => d.inbox.filter((m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event" && m.sessionId === "ses_rw").map((m) => m.part);
    return { d, sub, parts, preview: (id: string) => d.ok({ type: "session.rewindPreview", sessionId: "ses_rw", userMessageId: id }), rewind: (id: string, mode: string) => d.request({ type: "session.rewind", sessionId: "ses_rw", userMessageId: id, mode }) };
  }

  it("the preview sums the files of the message's turn and every later one; modes are both with files, conversation without", async () => {
    const r = await restored();
    expect(await r.preview("msg_u2")).toEqual({ filesChanged: ["a.ts", "b.ts"], insertions: 6, deletions: 1, conversation: true, modes: ["both"] });
    expect(await r.preview("msg_u4")).toEqual({ filesChanged: [], insertions: 0, deletions: 0, conversation: true, modes: ["conversation"] });
  });

  it("after an earlier rewind the preview counts only the messages still shown", async () => {
    const r = await restored({ revert: "msg_u3" });
    expect(await r.preview("msg_u1")).toEqual({ filesChanged: ["a.ts"], insertions: 2, deletions: 1, conversation: true, modes: ["both"] });
  });

  it("rewind posts the revert, emits the rewind part and refuses a mode the preview does not offer", async () => {
    const r = await restored();
    expect(await r.rewind("msg_u2", "conversation")).toMatchObject({ type: "error", code: "rewind_failed" });
    expect(await r.rewind("msg_u4", "code")).toMatchObject({ type: "error", code: "rewind_failed" });
    expect(r.d.requests("POST", "/session/ses_rw/revert")).toHaveLength(0);
    expect(await r.rewind("msg_u2", "both")).toMatchObject({ type: "reply" });
    expect(r.d.requests("POST", "/session/ses_rw/revert")[0]).toMatchObject({ body: { messageID: "msg_u2" }, query: { directory: r.d.project } });
    await until(() => r.parts().some((p) => p.type === "rewind"));
    // The session.updated of our own revert adds no second rewind part.
    await new Promise((x) => setTimeout(x, 150));
    expect(r.parts().filter((p) => p.type === "rewind")).toMatchObject([{ userMessageId: "msg_u2" }]);
  });

  it("rewind is refused while a turn runs", async () => {
    const r = await restored({ busy: true });
    expect(await r.rewind("msg_u2", "both")).toMatchObject({ type: "error", code: "rewind_failed", message: "Stop the turn first" });
    expect(r.d.requests("POST", "/session/ses_rw/revert")).toHaveLength(0);
  });

  it("a restored reverted session hides the cut messages", async () => {
    const r = await restored({ revert: "msg_u3" });
    expect(r.sub.snapshot.page.parts.map((p: any) => p.id)).toEqual(["msg_u1", "msg_u2"]);
  });

  it("/undo, /undo, /redo and /redo walk the revert point; each is local: no echo, no prompt, reply local", async () => {
    const r = await restored();
    await until(() => r.parts().some((p) => p.type === "user_text" && p.id === "msg_u4"));
    const run = (text: string) => r.d.ok({ type: "session.prompt", sessionId: "ses_rw", text });
    const reverts = () => r.d.requests("POST", "/session/ses_rw/revert").map((q) => q.body.messageID);
    expect(await run("/undo")).toEqual({ local: true });
    await until(() => r.parts().some((p) => p.type === "rewind" && p.userMessageId === "msg_u4"));
    expect(reverts()).toEqual(["msg_u4"]);
    await run("/undo");
    await until(() => r.parts().some((p) => p.type === "rewind" && p.userMessageId === "msg_u3"));
    expect(reverts()).toEqual(["msg_u4", "msg_u3"]);
    // Redo moves the revert point to the next undone message: the messages before it are read again.
    const shown = () => r.parts().filter((p) => p.id === "msg_u3").length;
    const before = shown();
    await run("/redo");
    await until(() => reverts().length === 3 && shown() > before);
    expect(reverts()[2]).toBe("msg_u4");
    // The last undone message is redone with unrevert.
    await run("/redo");
    await until(() => r.d.requests("POST", "/session/ses_rw/unrevert").length === 1);
    expect(r.parts().filter((p) => p.type === "user_text" && p.text.startsWith("/"))).toEqual([]);
    expect(r.d.requests("POST", "/session/ses_rw/prompt_async")).toHaveLength(0);
    expect(r.parts().filter((p) => p.type === "notice")).toEqual([]);
  });

  it("a message sent after Stop in a session restored while busy waits for the aborted turn and starts the next one", async () => {
    const r = await restored({ busy: true });
    await Promise.all([r.d.ok({ type: "session.interrupt", sessionId: "ses_rw" }), r.d.ok({ type: "session.prompt", sessionId: "ses_rw", text: "next" })]);
    await until(() => r.d.requests("POST", "/session/ses_rw/prompt_async").length === 1);
    // The aborted turn ended (idle), then "next" started a new turn (running again); sent into the aborted loop it would leave the session idle.
    const states = () => r.parts().filter((p) => p.type === "session_state").map((p) => (p as { state: string }).state);
    await until(() => states().at(-1) === "running");
    expect(states()).toContain("idle");
  });

  it("/undo and /redo with nothing to do are notices; with arguments or while a turn runs they are not run", async () => {
    const r = await restored({ revert: "msg_u1" });
    const run = (text: string) => r.d.ok({ type: "session.prompt", sessionId: "ses_rw", text });
    const notices = () => r.parts().filter((p) => p.type === "notice").map((p) => (p as { text: string }).text);
    await run("/undo");
    await until(() => notices().includes("Nothing to undo"));
    const busy = await restored({ busy: true });
    await busy.d.ok({ type: "session.prompt", sessionId: "ses_rw", text: "/undo" });
    await until(() => busy.parts().some((p) => p.type === "notice" && p.text === "Stop the turn first"));
    expect(busy.d.requests("POST", "/session/ses_rw/revert")).toHaveLength(0);
  });

  it("the commands list has /compact, /undo and /redo first, before the server's", async () => {
    const r = await restored();
    await until(() => r.parts().some((p) => p.type === "commands"));
    const names = (r.parts().filter((p) => p.type === "commands").at(-1) as { commands: { name: string }[] }).commands.map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(["compact", "undo", "redo"]);
    expect(names).toContain("review");
  });

  it("a revert made in OpenCode shows as a rewind; its unrevert brings the messages back", async () => {
    const r = await restored();
    await until(() => r.parts().some((p) => p.type === "user_text" && p.id === "msg_u4")); // the read after the stream connected is done
    await r.d.fake("/__revert", { sessionId: "ses_rw", messageID: "msg_u3" });
    await until(() => r.parts().some((p) => p.type === "rewind" && p.userMessageId === "msg_u3"));
    const cut = () => r.parts().filter((p) => p.id === "msg_u3").length;
    const before = cut();
    await r.d.fake("/__unrevert", { sessionId: "ses_rw" });
    await until(() => cut() > before);
  });

  it("an unrevert that comes while a slow read predating it is in flight brings the cut messages back", async () => {
    const r = await restored({ env: { FAKE_OPENCODE_MESSAGE_DELAY_MS: "600" } });
    // The read after the stream connected has finished (it re-emits the history), so none is in flight from before the revert.
    await until(() => r.parts().some((p) => p.type === "user_text" && p.id === "msg_u4"), 12000);
    await r.d.fake("/__revert", { sessionId: "ses_rw", messageID: "msg_u3" });
    await until(() => r.parts().some((p) => p.type === "rewind" && p.userMessageId === "msg_u3"));
    // A stream reconnect starts a read; its session row (still reverted) is read at once, its messages 600 ms later.
    const reads = r.d.requests("GET", "/session/ses_rw/message").length;
    await r.d.fake("/__drop");
    await until(() => r.d.requests("GET", "/session/ses_rw/message").length > reads, 12000);
    const cut = () => r.parts().filter((p) => p.id === "msg_u3").length;
    const before = cut();
    await r.d.fake("/__unrevert", { sessionId: "ses_rw" });
    await until(() => cut() > before, 3000);
  });
});

describe("OpenCode Aside and session management", { timeout: 30_000 }, () => {
  const row = (project: string, id = "ses_own") => ({ id, slug: id, projectID: "global", directory: project, title: "Owner", version: "1.18.34", time: { created: 1, updated: 2 } });
  const msg = (id: string, info: object) => ({ info: { id, sessionID: "ses_own", ...info }, parts: [] });
  const done = { role: "assistant", time: { created: 1, completed: 2 } };
  const link = (d: Boot, id: string) => JSON.parse(readFileSync(join(d.root, "sessions.json"), "utf8"))[id];
  async function owned(messages: object[]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const d = await boot({ root, script: ["text"], data: { sessions: [row(project)], messages: { ses_own: messages } } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    return d;
  }

  it("an Aside forks the whole history, titles the fork, writes a block that denies edit and prompts it; closing deletes it", async () => {
    const d = await owned([msg("msg_u1", { role: "user" }), msg("msg_a1", done)]);
    const { session } = await d.ok({ type: "aside.open", sessionId: "ses_own", text: "what is this?\nmore" });
    expect(d.requests("POST", "/session/ses_own/fork")[0]!.body).toEqual({});
    expect(d.requests("PATCH", `/session/${session.id}`)[0]!.body).toEqual({ title: "what is this?" });
    await until(() => d.requests("POST", `/session/${session.id}/prompt_async`).length === 1);
    const block = d.requests("PATCH", `/session/${session.id}`).flatMap((r) => r.body.permission ?? []);
    expect(block).toContainEqual({ permission: "edit", pattern: "*", action: "deny" });
    expect(d.requests("PATCH", `/session/${session.id}`).findIndex((r) => r.body.permission)).toBeGreaterThan(-1);
    expect(link(d, session.id)).toMatchObject({ ownerId: "ses_own", readOnly: true });
    await d.ok({ type: "aside.close", sessionId: session.id });
    expect(d.requests("DELETE", `/session/${session.id}`)).toHaveLength(1);
    expect((await d.ok({ type: "session.list" })).sessions.map((s: any) => s.id)).toEqual(["ses_own"]);
  });

  it("a running owner turn is forked before its unfinished assistant message", async () => {
    const d = await owned([msg("msg_u1", { role: "user" }), msg("msg_a1", done), msg("msg_u2", { role: "user" }), msg("msg_a2", { role: "assistant", time: { created: 3 } })]);
    await d.ok({ type: "aside.open", sessionId: "ses_own", text: "q" });
    expect(d.requests("POST", "/session/ses_own/fork")[0]!.body).toEqual({ messageID: "msg_a2" });
  });

  it("an Aside after a rewind forks at the revert message and ignores the cut messages", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const msgs = [msg("msg_u1", { role: "user" }), msg("msg_a1", done), msg("msg_u2", { role: "user" }), msg("msg_a2", done)];
    const d = await boot({ root, script: ["text"], data: { sessions: [{ ...row(project), revert: { messageID: "msg_u2", snapshot: "s" } }], messages: { ses_own: msgs } } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await d.ok({ type: "aside.open", sessionId: "ses_own", text: "q" });
    expect(d.requests("POST", "/session/ses_own/fork")[0]!.body).toEqual({ messageID: "msg_u2" });
  });

  it("an owner without messages is refused and nothing is forked", async () => {
    const d = await owned([]);
    expect(await d.request({ type: "aside.open", sessionId: "ses_own", text: "q" })).toMatchObject({ type: "error", code: "aside_unavailable" });
    expect(d.requests("POST", "/session/ses_own/fork")).toHaveLength(0);
  });

  it("a failure after the fork deletes the fork", async () => {
    const d = await owned([msg("msg_u1", { role: "user" })]);
    expect(await d.request({ type: "aside.open", sessionId: "ses_own", text: "fail-title" })).toMatchObject({ type: "error", code: "aside_failed" });
    const forked = d.requests("POST", "/session/ses_own/fork").length;
    expect(forked).toBe(1);
    expect(d.requests("DELETE", /^\/session\/ses_fake/)).toHaveLength(1);
  });

  it("Keep as session drops the link", async () => {
    const d = await owned([msg("msg_u1", { role: "user" })]);
    const { session } = await d.ok({ type: "aside.open", sessionId: "ses_own", text: "q" });
    await d.ok({ type: "aside.keep", sessionId: session.id });
    expect(link(d, session.id).ownerId).toBeUndefined();
  });

  it("rename, archive, unarchive and delete go to OpenCode", async () => {
    const d = await owned([msg("msg_u1", { role: "user" })]);
    await d.ok({ type: "session.rename", sessionId: "ses_own", title: " New name " });
    expect(d.requests("PATCH", "/session/ses_own")[0]!.body).toEqual({ title: "New name" });
    await d.ok({ type: "session.archive", sessionId: "ses_own", archived: true });
    expect(d.requests("PATCH", "/session/ses_own")[1]!.body.time.archived).toBeGreaterThan(0);
    expect((await d.ok({ type: "session.list" })).sessions[0]).toMatchObject({ title: "New name", archived: true });
    await d.ok({ type: "session.archive", sessionId: "ses_own", archived: false });
    expect(d.requests("PATCH", "/session/ses_own")[2]!.body).toEqual({ time: { archived: 0 } });
    await d.ok({ type: "session.delete", sessionId: "ses_own" });
    expect(d.requests("DELETE", "/session/ses_own")).toHaveLength(1);
    expect((await d.ok({ type: "session.list" })).sessions).toEqual([]);
  });
});

describe("OpenCode orchestration", { timeout: 30_000 }, () => {
  const on = (d: Boot) => d.ok({ type: "settings.set", patch: { orchestration: { enabled: true, workerCap: 20 } } });
  /** The bearer token of the session's attach (`POST /mcp`), once it came. */
  const attached = async (d: Boot, id: string) => {
    await until(() => d.requests("POST", "/mcp").some((r) => r.body.name === mcpName(id)));
    return d.requests("POST", "/mcp").find((r) => r.body.name === mcpName(id))!.body;
  };
  const mcpClient = async (url: string, bearer: string) => {
    const c = new Client({ name: "test", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: bearer } } }));
    cleanups.push(() => void c.close());
    return c;
  };
  const json = (r: any) => JSON.parse(r.content[0].text);

  it("begin attaches the session's MCP server with the daemon URL and a bearer; the route serves the tools bound to that coordinator, only with that token", async () => {
    const d = await boot({ script: ["text"] });
    await on(d);
    const s = await d.open();
    const body = await attached(d, s.id);
    const port = (d.http.address() as AddressInfo).port;
    expect(body).toMatchObject({ name: `orchestration-${s.id.slice(-10)}`, config: { type: "remote", url: `http://127.0.0.1:${port}/opencode-mcp`, oauth: false, timeout: 30 * 60_000 + 60_000 } });
    const bearer: string = body.config.headers.authorization;
    expect(bearer).toMatch(/^Bearer .{40,}$/);
    expect(d.requests("POST", "/mcp")[0]!.query).toEqual({ directory: d.project });
    for (const authorization of [undefined, "Bearer wrong"]) expect((await fetch(body.config.url, { method: "POST", headers: { ...(authorization && { authorization }), "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const c = await mcpClient(body.config.url, bearer);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["worker_start", "worker_list", "worker_wait"]));
    // A worker started through the route belongs to this coordinator; absent engine = the coordinator's (OpenCode).
    const started = json(await c.callTool({ name: "worker_start", arguments: { name: "w1", cwd: d.project, prompt: "do it" } }));
    expect(started).toMatchObject({ name: "w1", engine: "opencode", mode: "default" });
    expect(started.sessionId).toMatch(/^ses_/);
    await until(() => d.requests("POST", `/session/${started.sessionId}/prompt_async`).length === 1);
    expect(d.requests("POST", `/session/${started.sessionId}/prompt_async`)[0]!.body.parts[0].text).toBe("do it");
    expect(json(await c.callTool({ name: "worker_list", arguments: {} })).workers.map((w: any) => w.sessionId)).toEqual([started.sessionId]);
    // OpenCode connects again (restart, dispose): a new initialize replaces the MCP session.
    const again = await mcpClient(body.config.url, bearer);
    expect(json(await again.callTool({ name: "worker_list", arguments: {} })).workers).toHaveLength(1);
  });

  it("with a slow MCP load the attach waits instead of timing out: no warning, the server is attached before the prompt, the turn gets its reply (GH-681)", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_MCP_LOAD_MS: "4000" } });
    await on(d);
    const s = await d.open();
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"), 15_000);
    expect(s.parts().some((p) => p.type === "notice" && p.id === `${s.id}:mcp_failed`)).toBe(false);
    expect((await attached(d, s.id)).name).toBe(mcpName(s.id));
    const log = d.log().filter((l) => l.type === "request").map((l) => `${l.method} ${l.path}`);
    expect(log.indexOf("POST /mcp")).toBeLessThan(log.indexOf(`POST /session/${s.id}/prompt_async`));
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
    expect(s.parts().some((p) => p.type === "notice" && p.id.includes(":aborted:"))).toBe(false);
  });

  it("an attach that fails is a warning notice and the prompt is still sent (GH-681)", async () => {
    const d = await boot({ script: ["text"] });
    await on(d);
    const s = await d.open();
    await attached(d, s.id);
    await d.fake("/__fail", { path: "/mcp" });
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    expect(s.find("notice", (n) => n.id === `${s.id}:mcp_failed`)).toMatchObject({ level: "warning", text: expect.stringMatching(/^Could not attach the orchestration tools to OpenCode: /) });
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)).toHaveLength(1);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
  });

  it("the mode block hides other sessions' tools, allows the own ones and asks for worker_start; tool keys map to the orchestration cards", async () => {
    const d = await boot({ script: ["text"] });
    await on(d);
    const s = await d.open();
    const name = mcpName(s.id);
    expect(d.requests("POST", "/session")[0]!.body.permission).toContainEqual({ permission: "orchestration-*", pattern: "*", action: "deny" });
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"));
    const block = d.requests("PATCH", `/session/${s.id}`)[0]!.body.permission as Rule[];
    const at = (r: object) => block.findIndex((x) => JSON.stringify(x) === JSON.stringify(r));
    expect(at({ permission: "orchestration-*", pattern: "*", action: "deny" })).toBeGreaterThan(-1);
    expect(at({ permission: `${name}_*`, pattern: "*", action: "allow" })).toBeGreaterThan(at({ permission: "orchestration-*", pattern: "*", action: "deny" }));
    expect(at({ permission: `${name}_worker_start`, pattern: "*", action: "ask" })).toBeGreaterThan(at({ permission: `${name}_*`, pattern: "*", action: "allow" }));
    // The attach and its rules went in before the prompt.
    const log = d.log().filter((l) => l.type === "request").map((l) => `${l.method} ${l.path}`);
    expect(log.indexOf("POST /mcp")).toBeLessThan(log.indexOf(`POST /session/${s.id}/prompt_async`));
    const call = { id: "prt_ws", sessionID: s.id, messageID: "msg_ws", type: "tool", callID: "call_ws", tool: `${name}_worker_start`, state: { status: "pending", input: { name: "w2", cwd: d.project, prompt: "p", engine: "opencode" } } };
    await d.fake("/__emit", { directory: d.project, events: [{ type: "message.part.updated", properties: { part: call } }, { type: "permission.asked", properties: { id: "per_ws", sessionID: s.id, permission: call.tool, patterns: ["*"], always: ["*"], metadata: {}, tool: { messageID: "msg_ws", callID: "call_ws" } } }] });
    await until(() => !!s.find("permission_request"));
    expect(s.last("call_ws")).toMatchObject({ type: "tool_call", tool: "mcp__orchestration__worker_start" });
    expect(s.find("permission_request")).toMatchObject({ tool: "mcp__orchestration__worker_start", suggestions: [], title: expect.stringMatching(/^Start OpenCode worker w2 in default mode/) });
  });

  it("no attach while orchestration is off; the session's close disconnects it", async () => {
    const d = await boot();
    const off = await d.open();
    await off.prompt("hi");
    await until(() => d.requests("POST", `/session/${off.id}/prompt_async`).length === 1);
    expect(d.requests("POST", "/mcp")).toHaveLength(0);
    expect(d.requests("PATCH", `/session/${off.id}`).flatMap((r) => r.body.permission ?? []).some((r: Rule) => r.action === "allow" && r.permission.startsWith("orchestration-"))).toBe(false);
    await on(d);
    const s = await d.open();
    await attached(d, s.id);
    await d.ok({ type: "session.delete", sessionId: s.id });
    await until(() => d.requests("POST", `/mcp/${mcpName(s.id)}/disconnect`).length === 1);
  });

  it("an unkept Aside gets no MCP server", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const d = await boot({ root, script: ["text"], data: { sessions: [{ id: "ses_own", slug: "o", projectID: "global", directory: project, title: "Owner", version: "1.18.34", time: { created: 1, updated: 2 } }], messages: { ses_own: [{ info: { id: "msg_u1", sessionID: "ses_own", role: "user" }, parts: [] }] } } });
    await on(d);
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    const { session } = await d.ok({ type: "aside.open", sessionId: "ses_own", text: "q" });
    await until(() => d.requests("POST", `/session/${session.id}/prompt_async`).length === 1);
    expect(d.requests("POST", "/mcp").map((r) => r.body.name)).not.toContain(mcpName(session.id));
  });

  it("worker_start with engine opencode from a Claude coordinator starts a ses_ worker; an unknown OpenCode model is refused with OpenCode's list; agent is one of OpenCode's primary agents and is used for its prompts", async () => {
    const d = await boot({ script: ["text"] });
    await on(d);
    const coord: string = (await d.ok({ type: "session.create", cwd: d.project })).session.id;
    await d.ok({ type: "session.setPermissionMode", sessionId: coord, mode: "default" });
    const call = async (args: object) => {
      const r = (await d.http.orchestration.tools(coord).find((t) => t.name === "worker_start")!.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
      return r.isError ? { error: r.content[0]!.text } : JSON.parse(r.content[0]!.text);
    };
    expect(await call({ name: "bad", cwd: d.project, prompt: "p", engine: "opencode", model: "nope/x" })).toEqual({ error: expect.stringContaining("Valid values: default, opencode/big-pickle, opencode/alpha, opencode/thinker, acme/x/y") });
    // Subagents and hidden agents are not offered.
    expect(await call({ name: "agt", cwd: d.project, prompt: "p", engine: "opencode", agent: "general" })).toEqual({ error: expect.stringContaining("OpenCode agents here: build, docs, plan") });
    const w = await call({ name: "oc", cwd: d.project, prompt: "go", engine: "opencode", model: "opencode/alpha", effort: "high", agent: "docs" });
    expect(w).toMatchObject({ agent: "docs" });
    expect(w).toMatchObject({ name: "oc", engine: "opencode", mode: "default" });
    expect(w).not.toHaveProperty("effortNote");
    expect((await d.ok({ type: "session.subscribe", sessionId: w.sessionId, sinceSeq: 0 })).session.effort).toBe("high");
    expect(w.sessionId).toMatch(/^ses_/);
    expect(d.requests("POST", "/session").at(-1)!.body.permission).toContainEqual({ permission: "claude-ui", pattern: "mode:default", action: "allow" });
    await until(() => d.requests("POST", `/session/${w.sessionId}/prompt_async`).length === 1);
    expect(d.requests("POST", `/session/${w.sessionId}/prompt_async`)[0]!.body).toMatchObject({ parts: [{ text: "go" }], agent: "docs", model: { providerID: "opencode", modelID: "alpha" } });
    expect(JSON.parse(readFileSync(join(d.root, "sessions.json"), "utf8"))[w.sessionId]).toMatchObject({ agent: "docs" });
  });
});

describe("OpenCode broken MCP state (GH-682, GH-681)", { timeout: 30_000 }, () => {
  const on = (d: Boot) => d.ok({ type: "settings.set", patch: { orchestration: { enabled: true, workerCap: 20 } } });
  const done = (s: { states: () => string[]; find: (t: "turn_result") => unknown }) => until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"), 10_000);
  /** A root whose project path is known before the fake OpenCode starts (it is broken from its start). */
  const brokenRoot = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    return { root, env: { FAKE_OPENCODE_BROKEN: join(root, "project") } };
  };

  it("a turn OpenCode aborts on its own shows a warning notice, ends as an error turn and reloads the broken folder", async () => {
    const d = await boot();
    const s = await d.open();
    await until(() => !!s.find("commands"));
    await d.fake("/__break", { directory: d.project });
    await s.prompt("hi");
    await until(() => abortNotices(s).some((n) => /reloaded the folder in OpenCode\. Send the prompt again/.test(n.text)));
    const [notice] = abortNotices(s);
    expect(notice).toMatchObject({ id: expect.stringMatching(new RegExp(`^${s.id}:aborted:msg_selfabort_`)), level: "warning", text: expect.stringMatching(/ended this turn on its own/) });
    await until(() => s.states().at(-1) === "idle");
    expect(s.find("turn_result")).toMatchObject({ isError: true });
    expect(s.find("turn_interrupted")).toBeUndefined();
    expect(d.requests("POST", "/instance/dispose").map((r) => r.query.directory)).toEqual([d.project]);
    // The reloaded folder works.
    await d.fake("/__script", { files: [turn("text")] });
    const results = s.parts().filter((p) => p.type === "turn_result").length;
    await s.prompt("again");
    await until(() => s.parts().filter((p) => p.type === "turn_result").length > results && s.states().at(-1) === "idle");
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(s.find("assistant_text")).toBeTruthy();
  });

  it("a folder with a busy OpenCode session is not reloaded; the notice says it will be", async () => {
    const d = await boot();
    const s = await d.open();
    await until(() => !!s.find("commands"));
    await d.fake("/__break", { directory: d.project });
    await d.fake("/__emit", { directory: d.project, events: [{ type: "session.status", properties: { sessionID: "ses_other", status: { type: "busy" } } }] });
    await s.prompt("hi");
    await until(() => abortNotices(s).some((n) => /reloads the folder when the turn running in it ends/.test(n.text)));
    await until(() => s.states().at(-1) === "idle");
    expect(s.find("turn_result")).toMatchObject({ isError: true });
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  it("a session opened in a broken folder reloads it: the commands list arrives and the first prompt gets its reply", async () => {
    const { root, env } = brokenRoot();
    const d = await boot({ root, env, script: ["text"] });
    const s = await d.open();
    await until(() => !!s.find("commands"));
    expect(s.find("commands")!.commands.map((c) => c.name)).toContain("init");
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(1);
    expect(d.requests("GET", "/command")).toHaveLength(2);
    await s.prompt("hi");
    await done(s);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(abortNotices(s)).toHaveLength(0);
  });

  it("with orchestration on, a broken folder is reloaded at open and the session's MCP server is attached after it, once", async () => {
    const { root, env } = brokenRoot();
    const d = await boot({ root, env, script: ["text"] });
    await on(d);
    const s = await d.open();
    await until(() => d.requests("POST", "/mcp").some((r) => r.body.name === mcpName(s.id)));
    const order = d.log().filter((l) => l.type === "request").map((l) => `${l.method} ${l.path}`);
    expect(order.indexOf("POST /instance/dispose")).toBeGreaterThan(-1);
    expect(order.indexOf("POST /instance/dispose")).toBeLessThan(order.indexOf("POST /mcp"));
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(1);
    await s.prompt("hi");
    await done(s);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(abortNotices(s)).toHaveLength(0);
  });

  it("requests that wait for OpenCode's MCP load are not cut off: a 4 s load breaks nothing", async () => {
    const d = await boot({ env: { FAKE_OPENCODE_MCP_LOAD_MS: "4000" }, script: ["text"] });
    const s = await d.open();
    await until(() => !!s.find("commands"), 12_000);
    await s.prompt("hi");
    await done(s);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(abortNotices(s)).toHaveLength(0);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  it("with orchestration on, attach waits for a 4 s MCP load too (GET and POST /mcp are never cut off)", async () => {
    const d = await boot({ env: { FAKE_OPENCODE_MCP_LOAD_MS: "4000" }, script: ["text"] });
    await on(d);
    const s = await d.open();
    await until(() => d.requests("POST", "/mcp").some((r) => r.body.name === mcpName(s.id)), 12_000);
    await s.prompt("hi");
    await done(s);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(s.parts().filter((p) => p.type === "notice")).toHaveLength(0);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  it("closing a session does not wait for the MCP disconnect and does not cut it off", async () => {
    const d = await boot({ env: { FAKE_OPENCODE_DISCONNECT_DELAY_MS: "4000" }, script: ["text"] });
    await on(d);
    const s = await d.open();
    await until(() => d.requests("POST", "/mcp").some((r) => r.body.name === mcpName(s.id)));
    const t = Date.now();
    await d.ok({ type: "session.delete", sessionId: s.id });
    expect(Date.now() - t).toBeLessThan(2500);
    await until(() => d.requests("POST", `/mcp/${mcpName(s.id)}/disconnect`).length === 1);
    // The disconnect (4 s) is not cut off at 3 s: the folder is not broken, so a session opened now lists its commands without a reload.
    await new Promise((r) => setTimeout(r, 4500));
    const next = await d.open();
    await until(() => !!next.find("commands"));
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
    await next.prompt("hi");
    await done(next);
    expect(next.find("turn_result")).toMatchObject({ isError: false });
  });
});

describe("OpenCode on a cold folder: slow GET /session and POST /session lose nothing (GH-682)", { timeout: 40_000 }, () => {
  it("a session created while POST /session takes 4 s still arrives and gets its reply", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_SESSION_DELAY_MS: "4000" } });
    const t = Date.now();
    const s = await d.open();
    expect(Date.now() - t).toBeGreaterThanOrEqual(3900);
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"), 15_000);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(s.parts().some((p) => p.type === "notice")).toBe(false);
  });

  it("a session list that OpenCode answers after 4 s is pushed as sessions.changed and then lists the sessions", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const row = { id: "ses_cold", slug: "c", projectID: "global", directory: project, title: "Cold", version: "1.18.34", time: { created: 1, updated: 2 } };
    const d = await boot({ root, env: { FAKE_OPENCODE_SESSION_DELAY_MS: "4000" }, data: { sessions: [row], messages: { ses_cold: [] } } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const first = await d.ok({ type: "session.list" });
    expect(first.sessions.filter((x: any) => x.engine === "opencode")).toEqual([]);
    await until(() => d.inbox.some((m) => m.type === "sessions.changed"), 15_000);
    const second = await d.ok({ type: "session.list" });
    expect(second.sessions.filter((x: any) => x.engine === "opencode").map((x: any) => x.id)).toEqual(["ses_cold"]);
  });

  it("a stored session opens when its messages and row come after 4 s", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const row = { id: "ses_cold", slug: "c", projectID: "global", directory: project, title: "Cold", version: "1.18.34", time: { created: 1, updated: 2 } };
    const d = await boot({ root, env: { FAKE_OPENCODE_MESSAGE_DELAY_MS: "4000" }, data: { sessions: [row], messages: { ses_cold: [{ info: { id: "msg_u", role: "user", sessionID: "ses_cold" }, parts: [{ id: "p1", sessionID: "ses_cold", messageID: "msg_u", type: "text", text: "old question" }] }] } } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    await d.ok({ type: "session.list" });
    await until(() => d.requests("GET", "/session").length >= 1);
    const sub = await d.ok({ type: "session.subscribe", sessionId: "ses_cold", sinceSeq: 0, paged: true });
    expect(sub.snapshot.page.parts.map((p: any) => p.id)).toContain("msg_u");
  });
});

describe("OpenCode: Stop, shared list reads, reload after a busy folder, slow prompt_async (GH-682 review)", { timeout: 40_000 }, () => {
  const on = (d: Boot) => d.ok({ type: "settings.set", patch: { orchestration: { enabled: true, workerCap: 20 } } });

  it("Stop while send() waits for the attach ends the turn as interrupted at once; the attach request is not cancelled", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_MCP_LOAD_MS: "6000" } });
    await on(d);
    const s = await d.open();
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "running");
    await new Promise((r) => setTimeout(r, 300));
    const t = Date.now();
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => !!s.find("turn_interrupted") && s.states().at(-1) === "idle", 3000);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)).toHaveLength(0);
    // The attach goes on and ends: its POST /mcp comes after the load, nothing was cut off.
    await until(() => d.requests("POST", "/mcp").some((r) => r.body.name === mcpName(s.id)), 12_000);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  it("concurrent lists share one GET /session; one slow read gives one refresh push", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ocp-")));
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const row = { id: "ses_cold", slug: "c", projectID: "global", directory: project, title: "Cold", version: "1.18.34", time: { created: 1, updated: 2 } };
    const d = await boot({ root, env: { FAKE_OPENCODE_SESSION_DELAY_MS: "9000" }, data: { sessions: [row], messages: { ses_cold: [] } } });
    await d.ok({ type: "settings.set", patch: { sessions: { engine: "opencode" } } });
    const changed = () => d.inbox.filter((m) => m.type === "sessions.changed").length;
    const before = changed();
    // Lists queue one behind the other (each waits up to 3 s for OpenCode): sent without the helper's 8 s wait.
    const ids = ["la", "lb", "lc", "ld"];
    for (const reqId of ids) d.ws.send(JSON.stringify({ type: "session.list", reqId }));
    await until(() => ids.every((id) => d.inbox.some((m) => m.type === "reply" && m.reqId === id)), 25_000);
    expect(d.requests("GET", "/session")).toHaveLength(1);
    await until(() => changed() > before, 15_000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(changed() - before).toBe(1);
    expect(d.requests("GET", "/session")).toHaveLength(1);
    const listed = await d.ok({ type: "session.list" });
    expect(listed.sessions.filter((x: any) => x.engine === "opencode").map((x: any) => x.id)).toEqual(["ses_cold"]);
  });

  it("a folder found broken while a turn of ours runs in it is reloaded when that turn ends, and the notice says so", async () => {
    const d = await boot({ script: ["question"] });
    const busy = await d.open();
    await busy.prompt("ask me");
    await until(() => !!busy.find("question"));
    const s = await d.open();
    await until(() => !!s.find("commands"));
    await d.fake("/__break", { directory: d.project });
    await s.prompt("hi");
    await until(() => abortNotices(s).some((n) => /reloads the folder when the turn running in it ends/.test(n.text)));
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
    await d.ok({ type: "session.interrupt", sessionId: busy.id });
    await until(() => abortNotices(s).some((n) => /reloaded the folder in OpenCode\. Send the prompt again/.test(n.text)), 10_000);
    expect(d.requests("POST", "/instance/dispose").map((r) => r.query.directory)).toEqual([d.project]);
  });

  it("a prompt_async that answers after 4 s is not a failed prompt: no notice, the turn gets its reply", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_PROMPT_DELAY_MS: "4000" } });
    const s = await d.open();
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"), 15_000);
    await new Promise((r) => setTimeout(r, 4000));
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(s.parts().some((p) => p.type === "notice")).toBe(false);
  });

  it("Stop drops every prompt waiting for the attach, steering ones included: only the prompt sent after it reaches OpenCode", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_MCP_LOAD_MS: "5000" } });
    await on(d);
    const s = await d.open();
    await s.prompt("first");
    await until(() => s.states().at(-1) === "running");
    await s.prompt("second"); // steers the turn that still waits for the attach
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => s.states().at(-1) === "idle", 3000);
    await s.prompt("third");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length >= 1, 15_000);
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_result"), 15_000);
    expect(d.requests("POST", `/session/${s.id}/prompt_async`).map((r) => r.body.parts[0].text)).toEqual(["third"]);
    expect(s.parts().filter((p) => p.type === "turn_interrupted")).toHaveLength(1);
  });

  it("Stop ends the wait for a slow prompt_async at once: the session leaves running, the request is not cancelled", async () => {
    const d = await boot({ env: { FAKE_OPENCODE_PROMPT_DELAY_MS: "5000" } });
    const s = await d.open();
    await s.prompt("hi");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 1);
    const t = Date.now();
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => s.states().at(-1) === "idle" && !!s.find("turn_interrupted"), 3000);
    expect(Date.now() - t).toBeLessThan(2500);
    // The request goes on to its answer: no notice about a failed prompt, nothing disposed.
    await new Promise((r) => setTimeout(r, 5000));
    expect(s.parts().some((p) => p.type === "notice")).toBe(false);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  const markers = (s: { parts: () => Part[] }) => s.parts().filter((p) => p.type === "turn_interrupted").length;
  const at = (d: Boot, f: (l: Record<string, any>) => boolean) => d.log().findIndex(f);

  it("Stop during a slow prompt_async whose turn OpenCode already runs: one interrupted marker, running until OpenCode's turn ends, the next prompt after it (review 3 #1)", async () => {
    const d = await boot({ script: ["abort", "text"], env: { FAKE_OPENCODE_PROMPT_DELAY_MS: "4000", FAKE_OPENCODE_ABORT_DELAY_MS: "1500" } });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => s.parts().some((p) => p.type === "thinking"));
    await Promise.all([d.ok({ type: "session.interrupt", sessionId: s.id }), s.prompt("say DONE")]);
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 2 && !!s.find("turn_result"), 20_000);
    // The prompt sent after Stop reached OpenCode only after the aborted turn ended there: it never joined it.
    const aborted = at(d, (l) => l.type === "aborted");
    expect(aborted).toBeGreaterThanOrEqual(0);
    expect(at(d, (l) => l.type === "request" && l.path === `/session/${s.id}/prompt_async` && l.body.parts[0].text === "say DONE")).toBeGreaterThan(aborted);
    expect(markers(s)).toBe(1);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(s.states().at(-1)).toBe("idle");
  });

  it("Stop during a slow prompt_async while OpenCode asks a question: one interrupted marker (review 3 #1, the reviewer's probe)", async () => {
    const d = await boot({ script: ["question"], env: { FAKE_OPENCODE_PROMPT_DELAY_MS: "3000" } });
    const s = await d.open();
    await s.prompt("ask me");
    await until(() => !!s.find("question"));
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => s.states().at(-1) === "idle");
    await new Promise((r) => setTimeout(r, 4000)); // the prompt_async answers meanwhile
    expect(markers(s)).toBe(1);
    expect(s.states().at(-1)).toBe("idle");
  });

  it("Stop while the permission block is written ends the turn at once; the prompt is never sent (review 3 #3)", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_PATCH_DELAY_MS: "5000" } });
    await on(d); // the first prompt writes a block that allows the session's MCP tools
    const s = await d.open();
    await s.prompt("hi");
    await until(() => d.requests("PATCH", `/session/${s.id}`).some((r) => !!r.body.permission));
    const t = Date.now();
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle", 3000);
    expect(Date.now() - t).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 4000)); // the PATCH answers meanwhile
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)).toHaveLength(0);
    expect(s.parts().some((p) => p.type === "notice")).toBe(false);
  });

  it("a stopped prompt that reaches OpenCode only after the abort is aborted again without a second marker; the prompt sent after Stop waits for that and gets its reply", async () => {
    const d = await boot({ script: ["abort", "text"], env: { FAKE_OPENCODE_PROMPT_LATE_MS: "2500" } });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 1);
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle", 3000);
    await s.prompt("say DONE");
    await until(() => !!s.find("turn_result"), 20_000);
    const prompts = d.requests("POST", `/session/${s.id}/prompt_async`);
    expect(prompts.map((r) => r.body.parts[0].text)).toEqual(["long essay", "say DONE"]);
    const aborts = d.log().flatMap((l, i) => (l.type === "request" && l.path === `/session/${s.id}/abort` ? [i] : []));
    expect(aborts).toHaveLength(2);
    expect(at(d, (l) => l.type === "request" && l.path === `/session/${s.id}/prompt_async` && l.body.parts[0].text === "say DONE")).toBeGreaterThan(aborts[1]!);
    expect(markers(s)).toBe(1);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(s.states().at(-1)).toBe("idle");
  });

  it("the stopped message's late aborted update, arriving while the next prompt's turn runs, is no self-abort of that turn (acceptance round 5)", async () => {
    const d = await boot({ script: ["abort", "question"] });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => s.parts().some((p) => p.type === "thinking"));
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle");
    await s.prompt("next");
    await until(() => !!s.find("question"));
    // OpenCode stores the stopped assistant message as aborted a moment later: the update comes during the new turn.
    const stoppedUser = s.parts().find((p) => p.type === "user_text" && p.text === "long essay")!.id;
    const info = { id: "msg_stopped_reply", sessionID: s.id, role: "assistant", parentID: stoppedUser, agent: "build", providerID: "opencode", modelID: "big-pickle", time: { created: 2, completed: 3 }, error: { name: "MessageAbortedError", data: { message: "Aborted" } } };
    await d.fake("/__emit", { directory: d.project, events: [{ type: "message.updated", properties: { sessionID: s.id, info } }] });
    await new Promise((r) => setTimeout(r, 500));
    expect(abortNotices(s)).toHaveLength(0);
    expect(s.states().at(-1)).toBe("needs_input"); // the new turn goes on (its question waits)
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => s.states().at(-1) === "idle");
    expect(abortNotices(s)).toHaveLength(0);
    expect(s.parts().some((p) => p.type === "turn_result" && p.isError)).toBe(false);
  });

  it("Stop when OpenCode answers the abort after 4 s: no error, the Stop is answered at once, the turn ends with one marker (acceptance round 6)", async () => {
    const d = await boot({ script: ["abort", "text"], env: { FAKE_OPENCODE_ABORT_ANSWER_MS: "4000" } });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => s.parts().some((p) => p.type === "thinking"));
    const t = Date.now();
    const r = await d.request({ type: "session.interrupt", sessionId: s.id });
    expect(r.type).toBe("reply");
    expect(Date.now() - t).toBeLessThan(2000);
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle");
    await new Promise((r) => setTimeout(r, 4500)); // the abort answers meanwhile
    expect(s.parts().some((p) => p.type === "notice")).toBe(false);
    expect(markers(s)).toBe(1);
    await s.prompt("say DONE");
    await until(() => !!s.find("turn_result"));
    expect(s.find("turn_result")).toMatchObject({ isError: false });
  });

  it("a Stop whose abort OpenCode refuses shows that as a notice", async () => {
    const d = await boot({ script: ["abort"] });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => s.parts().some((p) => p.type === "thinking"));
    await d.fake("/__fail", { path: `/session/${s.id}/abort` });
    expect((await d.request({ type: "session.interrupt", sessionId: s.id })).type).toBe("reply");
    await until(() => s.parts().some((p) => p.type === "notice" && /Could not stop the turn in OpenCode/.test(p.text)));
  });

  it("a prompt sent after Stop does not wait for a late abort answer: it is sent within a few seconds although the abort answers after 15 s (review 4 N2, PROBE4a)", async () => {
    const d = await boot({ script: ["abort", "text"], env: { FAKE_OPENCODE_PROMPT_DELAY_MS: "3000", FAKE_OPENCODE_ABORT_ANSWER_MS: "15000" } });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => s.parts().some((p) => p.type === "thinking"));
    const t = Date.now();
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle", 5000);
    await s.prompt("say DONE");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 2, 12_000);
    // The stopped request (3 s) and the capped abort wait (3 s) and the 1 s watch: well before the abort's answer at 15 s.
    expect(Date.now() - t).toBeLessThan(10_000);
    await until(() => !!s.find("turn_result"), 10_000);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(markers(s)).toBe(1);
  });

  it("a stopped prompt that OpenCode starts after the turn ended here, before its prompt_async answers, is aborted unseen: idle, no reply shown (review 4 N1, PROBE4b)", async () => {
    const d = await boot({ script: ["abort", "text"], env: { FAKE_OPENCODE_PROMPT_LATE_MS: "2500", FAKE_OPENCODE_PROMPT_DELAY_MS: "2000" } });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 1);
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle", 3000);
    const states = s.states().length;
    // OpenCode starts it at 2.5 s, answers at 4.5 s; the second abort follows.
    await until(() => d.requests("POST", `/session/${s.id}/abort`).length === 2, 12_000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(s.states().slice(states)).toEqual([]);
    expect(s.states().at(-1)).toBe("idle");
    expect(s.parts().some((p) => p.type === "thinking")).toBe(false);
    expect(markers(s)).toBe(1);
    await s.prompt("say DONE");
    await until(() => !!s.find("turn_result"), 15_000);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
  });

  it("a stopped prompt that reaches OpenCode after the abort while the abort answers late is still aborted: one marker, idle (review 4 #3)", async () => {
    const d = await boot({ script: ["abort", "text"], env: { FAKE_OPENCODE_PROMPT_LATE_MS: "2500", FAKE_OPENCODE_ABORT_ANSWER_MS: "8000" } });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 1);
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle", 8000);
    expect(d.requests("POST", `/session/${s.id}/abort`).length).toBeGreaterThanOrEqual(2);
    await s.prompt("say DONE");
    await until(() => !!s.find("turn_result"), 20_000);
    expect(s.find("turn_result")).toMatchObject({ isError: false });
    expect(markers(s)).toBe(1);
  });

  it("a turn a resync finds busy after a Stop takes a fresh Stop state: Stop on it ends it with its own marker (review 4 N5)", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_MCP_LOAD_MS: "5000" } });
    await on(d);
    const s = await d.open();
    await s.prompt("hi");
    await until(() => s.states().at(-1) === "running");
    await d.ok({ type: "session.interrupt", sessionId: s.id }); // dropped while it waits for the attach
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle");
    // The stream drops; meanwhile a turn starts in OpenCode's own UI; the reconnect's resync finds it busy.
    await d.fake("/__drop");
    await d.fake("/__emit", { directory: d.project, events: [{ type: "session.status", properties: { sessionID: s.id, status: { type: "busy" } } }] });
    await until(() => s.states().at(-1) === "running", 15_000);
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 2 && s.states().at(-1) === "idle", 8000);
  });

  it("Stop while the prompt waits for the effort levels ends the turn at once; the prompt is never sent (review 4)", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_PROVIDERS_DELAY_MS: "4000" } });
    const s = await d.open();
    await d.ok({ type: "session.setEffort", sessionId: s.id, effort: "high" });
    const before = d.requests("GET", "/config/providers").length;
    await s.prompt("hi");
    await until(() => d.requests("GET", "/config/providers").length > before || before > 0);
    await until(() => s.states().at(-1) === "running");
    const t = Date.now();
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle", 3000);
    expect(Date.now() - t).toBeLessThan(1500);
    await new Promise((r) => setTimeout(r, 4500)); // the providers answer (or the read times out) meanwhile
    expect(d.requests("POST", `/session/${s.id}/prompt_async`)).toHaveLength(0);
  });

  it("bash mode right after a Stop that left a prompt_async on its way waits for it, then shows its output and ends idle (review 5, PROBE5a)", async () => {
    const d = await boot({ script: ["abort", "text"], env: { FAKE_OPENCODE_PROMPT_LATE_MS: "4000", FAKE_OPENCODE_PROMPT_DELAY_MS: "5000" } });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 1);
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle", 3000);
    await d.ok({ type: "session.bash", sessionId: s.id, command: "echo after-stop" });
    // The stopped request answers at 9 s and is aborted unseen; then the command runs and shows.
    await until(() => !!s.find("tool_result") && s.states().at(-1) === "idle", 20_000);
    const shell = d.requests("POST", `/session/${s.id}/shell`);
    expect(shell).toHaveLength(1);
    const aborts = d.log().flatMap((l, i) => (l.type === "request" && l.path === `/session/${s.id}/abort` ? [i] : []));
    expect(aborts).toHaveLength(2);
    expect(at(d, (l) => l.type === "request" && l.path === `/session/${s.id}/shell`)).toBeGreaterThan(aborts[1]!);
    expect(markers(s)).toBe(1);
  });

  it("/compact right after a Stop that left a prompt_async on its way waits for it, then summarizes and ends idle (review 5)", async () => {
    const d = await boot({ script: ["abort", "compact"], env: { FAKE_OPENCODE_PROMPT_LATE_MS: "4000", FAKE_OPENCODE_PROMPT_DELAY_MS: "5000" } });
    const s = await d.open();
    await s.prompt("long essay");
    await until(() => d.requests("POST", `/session/${s.id}/prompt_async`).length === 1);
    await d.ok({ type: "session.interrupt", sessionId: s.id });
    await until(() => markers(s) === 1 && s.states().at(-1) === "idle", 3000);
    await s.prompt("/compact");
    await until(() => !!s.find("compaction") && !!s.find("turn_result") && s.states().at(-1) === "idle", 20_000);
    expect(d.requests("POST", `/session/${s.id}/abort`).length).toBe(2);
    expect(markers(s)).toBe(1);
  });

  it("a busy broken folder that another session's open reloads first: the notice says it was reloaded", async () => {
    const d = await boot();
    await on(d); // the other session attaches at its open: that read of the broken folder reloads it
    const s = await d.open();
    await until(() => !!s.find("commands"));
    await d.fake("/__break", { directory: d.project });
    await d.fake("/__emit", { directory: d.project, events: [{ type: "session.status", properties: { sessionID: "ses_other", status: { type: "busy" } } }] });
    await s.prompt("hi");
    await until(() => abortNotices(s).some((n) => /reloads the folder when the turn running in it ends/.test(n.text)));
    await d.fake("/__emit", { directory: d.project, events: [{ type: "session.status", properties: { sessionID: "ses_other", status: { type: "idle" } } }] });
    const other = await d.open();
    await until(() => !!other.find("commands"));
    await until(() => abortNotices(s).some((n) => /reloaded the folder in OpenCode\. Send the prompt again/.test(n.text)));
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(1);
  });

  it("a busy broken folder that is healthy again when the turn ends: the notice says it works again, nothing is disposed", async () => {
    const d = await boot({ script: ["question"] });
    const busy = await d.open();
    await busy.prompt("ask me");
    await until(() => !!busy.find("question"));
    const s = await d.open();
    await until(() => !!s.find("commands"));
    await d.fake("/__break", { directory: d.project });
    await s.prompt("hi");
    await until(() => abortNotices(s).some((n) => /reloads the folder when the turn running in it ends/.test(n.text)));
    await d.fake("/__heal", { directory: d.project });
    await d.ok({ type: "session.interrupt", sessionId: busy.id });
    await until(() => abortNotices(s).some((n) => /work again\. Send the prompt again/.test(n.text)), 10_000);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });
});

describe("OpenCode model list: provider reads are never cut off and a broken provider state is repaired (GH-679)", { timeout: 40_000 }, () => {
  const models = (d: Boot, cwd?: string) => d.request({ type: "models.list", engine: "opencode", ...(cwd && { cwd }) });
  const values = (r: Awaited<ReturnType<typeof models>>) => (r.type === "reply" ? (r.result.models as { value: string; group?: string }[]) : []);
  const providerReads = (d: Boot) => d.requests("GET", "/config/providers");
  /** The fake's start markers: one per OpenCode process. */
  const starts = (d: Boot) => d.log().filter((l) => l.type === "start").length;

  it("models.list waits for a slow provider load (4 s): nothing is cut off, later reads answer and no instance is disposed", async () => {
    const d = await boot({ env: { FAKE_OPENCODE_PROVIDERS_MS: "4000" } });
    const r = await models(d);
    expect(values(r).map((m) => m.value)).toEqual(expect.arrayContaining(["default", "opencode/big-pickle", "acme/x/y"]));
    expect(values(await models(d)).length).toBeGreaterThan(2);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  it("models.list reads the given folder's OpenCode instance; a folder outside the roots is refused", async () => {
    const d = await boot();
    const local = join(d.root, "with-local-provider");
    mkdirSync(local);
    const r = await models(d, realpathSync(local));
    expect(values(r).find((m) => m.value === "local/m")).toMatchObject({ group: "Local" });
    expect(providerReads(d).at(-1)!.query.directory).toBe(realpathSync(local));
    expect(await models(d, join(tmpdir(), "elsewhere-gh679"))).toMatchObject({ type: "error", code: "cwd_not_allowed" });
  });

  it("a folder whose provider state is broken is reloaded once and the list comes back", async () => {
    const d = await boot();
    await models(d); // starts the fake OpenCode
    await d.fake("/__break_providers", { directory: d.project });
    expect(values(await models(d, d.project)).map((m) => m.value)).toContain("opencode/big-pickle");
    expect(d.requests("POST", "/instance/dispose").map((r) => r.query.directory)).toEqual([d.project]);
    await models(d, d.project);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(1);
  });

  it("a broken folder with a running OpenCode turn is not disposed: models.list fails with the error and keeps the turn", async () => {
    const d = await boot({ script: ["question"] });
    const s = await d.open();
    await s.prompt("ask");
    await until(() => !!s.find("question"));
    await d.fake("/__break_providers", { directory: d.project });
    expect(await models(d, d.project)).toMatchObject({ type: "error", code: "models_failed", message: expect.stringMatching(/provider list is broken.*no OpenCode turn runs/) });
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
    expect(s.states().at(-1)).not.toBe("idle");
  });

  it("a server-wide broken provider state restarts OpenCode's server when no OpenCode session is busy; the list comes back", async () => {
    const d = await boot();
    await models(d);
    await d.fake("/__break_providers", { global: true });
    expect(starts(d)).toBe(1);
    expect(values(await models(d, d.project)).map((m) => m.value)).toContain("opencode/big-pickle");
    expect(starts(d)).toBe(2);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(1);
  });

  it("a server-wide broken provider state with a busy OpenCode session does not restart the server", async () => {
    const d = await boot({ script: ["question"] });
    const s = await d.open();
    await s.prompt("ask");
    await until(() => !!s.find("question"));
    await d.fake("/__break_providers", { global: true });
    const r = await models(d);
    expect(r).toMatchObject({ type: "error", code: "models_failed", message: expect.stringMatching(/provider list is broken.*no OpenCode turn runs/) });
    expect(starts(d)).toBe(1);
  });

  it("after a login the list is read again for every folder", async () => {
    const d = await boot();
    const other = join(d.root, "other");
    mkdirSync(other);
    await models(d, d.project);
    await models(d, realpathSync(other));
    await models(d, d.project);
    expect(providerReads(d)).toHaveLength(2);
    await d.ok({ type: "opencode.login", provider: "groq", method: 0, key: "k" });
    await until(() => d.inbox.some((m) => m.type === "opencode.providersChanged"));
    await models(d, d.project);
    await models(d, realpathSync(other));
    expect(providerReads(d)).toHaveLength(4);
  });

  it("context usage after a slow provider load (4 s): the context_usage part arrives and the folder is not broken", async () => {
    const d = await boot({ script: ["text"], env: { FAKE_OPENCODE_PROVIDERS_MS: "4000" } });
    const s = await d.open();
    await s.prompt("hi");
    await until(() => !!s.find("context_usage"), 12_000);
    expect(providerReads(d).at(-1)!.query.directory).toBe(d.project);
    expect(values(await models(d, d.project)).length).toBeGreaterThan(2);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });
});
