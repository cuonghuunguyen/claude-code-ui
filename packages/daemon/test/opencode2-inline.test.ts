// OpenCode 2 inline task (GH-734, docs/spec.md "Inline tasks"): OpenCode2Session.inlineTask against a scripted `@opencode/client` and event stream, no process.
import { describe, expect, it } from "vitest";
import type { Part } from "@claude-ui/protocol";
import type { InlineSpec } from "../src/inline-types.ts";
import { INLINE_SYSTEM } from "../src/opencode-inline.ts";
import { createOpenCode2Engine } from "../src/opencode2-engine.ts";
import type { OpenCodeServer } from "../src/opencode-server.ts";
import type { Session, SessionOpts } from "../src/session.ts";
import type { Reply } from "../src/engine.ts";

type Json = Record<string, any>;
const INPUT = { prompt: "find foo", tools: ["Grep"] };
const spec = (o: Partial<InlineSpec> = {}): InlineSpec => ({ text: "find foo", title: "find foo", tools: ["Grep"], mcp: [], maxTurns: 10, ...o });
const BUILD = [{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "*.env", effect: "ask" }];
const tokens = { input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 1 } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(o: { script?: (emit: (type: string, d?: Json) => void) => void; stored?: Json[]; model?: string; /** The build agent's rules (default BUILD). */ agentRules?: Json[]; /** The permission requests OpenCode lists. */ pending?: Json[]; /** The sessions OpenCode runs (a function: read at each call). */ active?: Json | (() => Json) } = {}) {
  const calls: { name: string; input: Json }[] = [];
  const handlers = new Set<{ event: (dir: string | undefined, p: { type: string; properties: Json }) => void; resync: () => void }>();
  const emit = (type: string, d: Json) => handlers.forEach((h) => h.event("/p", { type, properties: d }));
  const child = (type: string, d: Json = {}) => emit(type, { sessionID: "ses_child", ...d });
  const rec =
    (name: string, f: (i: Json) => unknown = () => undefined) =>
    async (input: Json) => (calls.push({ name, input }), f(input));
  const client = {
    agent: { list: rec("agent.list", () => ({ data: [{ id: "build", mode: "primary", hidden: false, permissions: o.agentRules ?? BUILD }] })) },
    config: { get: rec("config.get", () => []) },
    command: { list: rec("command.list", () => ({ data: [] })) },
    session: {
      create: rec("session.create", () => ({ id: "ses_child" })),
      prompt: rec("session.prompt", () => void queueMicrotask(() => o.script?.(child))),
      interrupt: rec("session.interrupt", () => ({ interrupted: true })),
      remove: rec("session.remove"),
      update: rec("session.update"),
      active: rec("session.active", () => (typeof o.active === "function" ? o.active() : o.active ?? {})),
      get: rec("session.get", () => ({ id: "ses_parent", permissions: [] })),
    },
    form: { list: rec("form.list", () => ({ data: [] })) },
    permission: { reply: rec("permission.reply"), request: { list: rec("permission.request.list", () => ({ data: o.pending ?? [] })) } },
    experimental: { session: { instructions: { entry: { put: rec("instructions.put") } } } },
    message: { list: rec("message.list", () => ({ data: o.stored ?? [], cursor: {} })) },
  };
  const server = { client: async () => client, events: (h: never) => (handlers.add(h), () => handlers.delete(h)), streamReady: async () => {}, running: () => true } as unknown as OpenCodeServer;
  const emitted: Part[] = [];
  const asks: { part: Json; reply: (r: Reply) => void }[] = [];
  const session = {
    id: "ses_parent",
    cwd: "/p",
    emit: (p: Part) => emitted.push(p),
    currentState: () => "running",
    setState: () => {},
    request: (r: { part: Json; reply: (r: Reply) => void }) => asks.push(r),
    pendingRequest: (id: string) => asks.find((a) => a.part.id === id),
    cancel: () => {},
  } as unknown as Session;
  const links: [string, { sessionId: string; callId: string }][] = [];
  const run = createOpenCode2Engine(server, { onInline: (id, l) => links.push([id, l]), inlinesOf: () => links.map(([inlineId, l]) => ({ inlineId, callId: l.callId })) }).open(session, { permissionMode: "default", model: o.model ?? "fake/m" } as SessionOpts);
  run.begin();
  /** The running inline_task call of the parent, as OpenCode reports it. */
  const callRunning = (id = "call_1", input: Json = INPUT) => {
    emit("session.tool.input.started", { sessionID: "ses_parent", assistantMessageID: "msg_p", id, name: "claude-ui-parentxxxx_inline_task" });
    emit("session.tool.called", { sessionID: "ses_parent", assistantMessageID: "msg_p", id, input });
  };
  const called = (name: string) => calls.filter((c) => c.name === name).map((c) => c.input);
  /** The event stream reconnected (events may have been lost). */
  const reconnect = () => handlers.forEach((h) => h.resync());
  return { run, emit, child, emitted, asks, callRunning, called, reconnect, links };
}
const hooks = (signal = new AbortController().signal, settings?: { openCodeModel?: string }) => ({ signal, input: INPUT, ...(settings && { settings }) });

describe("OpenCode 2 inline task", () => {
  it("runs in a session of its own with only the granted tools under the parent's rules and the system text; its steps show under the call; the result counts its steps; the session is deleted at the end", async () => {
    const r = rig({
      script: (child) => {
        child("session.execution.started");
        child("session.step.started", { model: { providerID: "fake", id: "small" }, assistantMessageID: "msg_a1" });
        child("session.tool.input.started", { assistantMessageID: "msg_a1", id: "c1", name: "edit" });
        child("session.tool.called", { assistantMessageID: "msg_a1", id: "c1", input: { path: "/p/a.txt", oldString: "a", newString: "b" } });
        child("session.tool.success", { assistantMessageID: "msg_a1", id: "c1", content: [{ type: "text", text: "ok" }] });
        child("session.step.ended", { assistantMessageID: "msg_a1", finish: "tool-calls", tokens, cost: 0.001 });
        child("session.step.started", { model: { providerID: "fake", id: "small" }, assistantMessageID: "msg_a2" });
        child("session.text.ended", { assistantMessageID: "msg_a2", ordinal: 0, text: "foo is in a.txt" });
        child("session.step.ended", { assistantMessageID: "msg_a2", finish: "stop", tokens, cost: 0.001 });
        child("session.execution.succeeded");
      },
    });
    r.callRunning();
    const res = await r.run.inlineTask(spec({ tools: ["Read", "Bash", "Edit"] }), hooks());
    expect(res).toMatchObject({ status: "done", text: "foo is in a.txt", model: "fake/small", turns: 2, tokens: { input: 200, output: 20, cacheRead: 10, cacheWrite: 2 }, costUsd: 0.002, filesChanged: ["/p/a.txt"] });
    // No parentID: OpenCode 2 would report a child's end to the parent's inbox and start a turn there.
    const [created] = r.called("session.create");
    expect(created).not.toHaveProperty("parentID");
    expect(created).toMatchObject({ location: { directory: "/p" }, title: "Inline: find foo", agent: "build", model: { providerID: "fake", id: "m" }, metadata: { "claude-ui.inlineOf": "ses_parent" } });
    // Everything denied, then the granted actions with the agent's and the mode's rules for them (last match wins): `read *.env` still asks, the shell asks.
    expect(created!.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
    ]);
    expect(r.called("instructions.put")).toEqual([{ sessionID: "ses_child", key: "claude-ui-inline", value: INLINE_SYSTEM }]);
    expect(r.called("session.prompt")).toEqual([{ id: expect.any(String), sessionID: "ses_child", text: "find foo" }]);
    const steps = r.emitted.filter((p) => p.parentId === "call_1");
    expect(steps.map((p) => `${p.type}:${p.id}`)).toEqual(expect.arrayContaining(["tool_call:c1", "tool_result:c1:result", "assistant_text:msg_a2:text:0"]));
    await sleep(0);
    // A run with a call keeps its session (hidden) and saves the link: its steps show again after a reload.
    expect(r.called("session.remove")).toEqual([]);
    expect(r.links).toEqual([["ses_child", { sessionId: "ses_parent", callId: "call_1" }]]);
    expect(r.called("session.interrupt")).toEqual([]);
  });

  it("a permission ask of the inline session shows in the parent and is answered under the inline session's id; a denied call shows denied under the call", async () => {
    let child!: (type: string, d?: Json) => void;
    const r = rig({ script: (c) => ((child = c), c("session.execution.started"), c("session.tool.input.started", { assistantMessageID: "msg_a1", id: "c1", name: "shell" }), c("session.tool.called", { assistantMessageID: "msg_a1", id: "c1", input: { command: "rm x" } }), c("permission.asked", { id: "per_1", action: "shell", resources: ["rm x"], source: { type: "tool", messageID: "msg_a1", id: "c1" } })) });
    r.callRunning();
    const done = r.run.inlineTask(spec({ tools: ["Bash"] }), hooks());
    for (let i = 0; i < 40 && !r.asks.length; i++) await sleep(25);
    expect(r.asks[0]!.part).toMatchObject({ type: "permission_request", id: "per_1", tool: "Bash", input: { command: "rm x" } });
    r.asks[0]!.reply({ kind: "deny", message: "no" });
    await sleep(0);
    expect(r.called("permission.reply")).toEqual([{ sessionID: "ses_child", requestID: "per_1", decision: "reject", message: "no" }]);
    expect(r.emitted.filter((p) => p.id === "c1").at(-1)).toMatchObject({ type: "tool_call", status: "denied", parentId: "call_1" });
    child("session.execution.succeeded");
    // Done with no answer after a denial: the run could not do its task.
    expect(await done).toMatchObject({ status: "denied", denied: ["Bash: rm x"], error: "The user denied Bash: rm x." });
  });

  it("the turn cap interrupts it with limit turns; Stop from the card and the abort signal end it as stopped; a failed execution is an error", async () => {
    const step = (c: (type: string, d?: Json) => void, n: number) => (c("session.step.started", { assistantMessageID: `msg_${n}` }), c("session.step.ended", { assistantMessageID: `msg_${n}`, finish: "tool-calls", tokens }));
    const capped = rig({ script: (c) => [1, 2].forEach((n) => step(c, n)) });
    expect(await capped.run.inlineTask(spec({ maxTurns: 2 }), hooks())).toMatchObject({ status: "limit", limit: "turns", turns: 2 });
    expect(capped.called("session.interrupt")).toEqual([{ sessionID: "ses_child" }]);

    const card = rig({ script: (c) => c("session.execution.started") });
    card.callRunning();
    const running = card.run.inlineTask(spec(), hooks());
    for (let i = 0; i < 40 && !card.called("session.prompt").length; i++) await sleep(25);
    expect(await card.run.stopSubagent("call_1")).toBe(true);
    expect(await running).toMatchObject({ status: "stopped" });
    expect(card.called("session.interrupt")).toEqual([{ sessionID: "ses_child" }]);
    expect(await card.run.stopSubagent("call_1")).toBe(false);

    const ac = new AbortController();
    const aborted = rig({ script: () => ac.abort() });
    expect(await aborted.run.inlineTask(spec(), hooks(ac.signal))).toMatchObject({ status: "stopped" });

    const failing = rig({ script: (c) => c("session.execution.failed", { error: { type: "provider", message: "rate limited\nstack" } }) });
    expect(await failing.run.inlineTask(spec(), hooks())).toMatchObject({ status: "error", error: "rate limited" });

  });

  it("an MCP grant gives the inline session that server's tools, or the one tool, under the parent's rules; no other MCP tool", async () => {
    const r = rig({ script: (c) => c("session.execution.succeeded") });
    expect(await r.run.inlineTask(spec({ tools: ["Read"], mcp: ["jira", "mcp__git hub__get_issue"] }), hooks())).toMatchObject({ status: "done" });
    const rules = r.called("session.create")[0]!.permissions;
    expect(rules.slice(0, 3)).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "jira_*", resource: "*", effect: "allow" },
      { action: "git_hub_get_issue", resource: "*", effect: "allow" },
    ]);
    // The agent's `* allow` applies to each grant; nothing of the parent's daemon MCP servers is granted.
    expect(rules).toContainEqual({ action: "jira_*", resource: "*", effect: "allow" });
    expect(rules.filter((x: Json) => x.action.startsWith("claude-ui-") || x.action.startsWith("orchestration-"))).toEqual([]);
  });

  it("the parent's rules for part of a granted server, or for the whole server of a granted tool, hold in the inline session", async () => {
    const parentRules = [
      { action: "jira_create_issue", resource: "*", effect: "ask" },
      { action: "gh_*", resource: "*", effect: "deny" },
      { action: "other_*", resource: "*", effect: "deny" },
      { action: "lin*", resource: "*", effect: "allow" },
    ];
    const r = rig({ script: (c) => c("session.execution.succeeded"), agentRules: [...BUILD, ...parentRules] });
    await r.run.inlineTask(spec({ tools: [], mcp: ["jira", "mcp__gh__get_issue", "mcp__linear__get_issue"] }), hooks());
    const rules = r.called("session.create")[0]!.permissions as Json[];
    const at = (action: string, effect: string) => rules.findIndex((x) => x.action === action && x.effect === effect);
    expect(at("jira_create_issue", "ask")).toBeGreaterThan(at("jira_*", "allow"));
    // A wider rule applies to the granted tool only: a wider allow gives no other tool of the server.
    expect(at("gh_get_issue", "deny")).toBeGreaterThan(at("gh_get_issue", "allow"));
    expect(at("gh_*", "deny")).toBe(-1);
    expect(at("linear_get_issue", "allow")).toBeGreaterThan(-1);
    expect(rules.some((x) => x.action === "lin*")).toBe(false);
    expect(at("other_*", "deny")).toBe(-1);
  });

  it("model: the input's, else the setting openCodeModel, else the parent's; none when the parent runs OpenCode's default", async () => {
    const model = async (o: { spec?: string; setting?: string; parent?: string }) => {
      const r = rig({ model: o.parent, script: (c) => c("session.execution.succeeded") });
      await r.run.inlineTask(spec({ ...(o.spec && { model: o.spec }) }), hooks(undefined, { openCodeModel: o.setting ?? "" }));
      return r.called("session.create")[0]!.model;
    };
    expect(await model({ spec: "acme/x", setting: "acme/y" })).toEqual({ providerID: "acme", id: "x" });
    expect(await model({ setting: "acme/y" })).toEqual({ providerID: "acme", id: "y" });
    expect(await model({})).toEqual({ providerID: "fake", id: "m" });
    expect(await model({ parent: "default" })).toBeUndefined();
  });

  it("a run interrupted in OpenCode itself ends as stopped; a run whose end was lost with a stream drop ends at the reconnect as OpenCode stored it: its answer, its error or stopped", async () => {
    const elsewhere = rig({ script: (c) => (c("session.execution.started"), c("session.execution.interrupted", { reason: "shutdown" })) });
    expect(await elsewhere.run.inlineTask(spec(), hooks())).toMatchObject({ status: "stopped" });

    const lostEnd = async (stored: Json[]) => {
      const lost = rig({ stored, script: (c) => c("session.execution.started") });
      const running = lost.run.inlineTask(spec(), hooks());
      for (let i = 0; i < 40 && !lost.called("session.prompt").length; i++) await sleep(25);
      await sleep(0);
      lost.reconnect();
      return running;
    };
    const answer = { id: "msg_a1", type: "assistant", content: [{ type: "text", text: "stored answer" }] };
    expect(await lostEnd([answer])).toMatchObject({ status: "done", text: "stored answer" });
    expect(await lostEnd([answer, { id: "msg_i1", type: "idle", outcome: "succeeded" }])).toMatchObject({ status: "done", text: "stored answer" });
    // The newest end row counts (stored newest first, as read).
    expect(await lostEnd([{ id: "msg_i2", type: "idle", outcome: "failed" }, { id: "msg_a2", type: "assistant", content: [], error: { type: "provider", message: "rate limited\nstack" } }, { id: "msg_i1", type: "idle", outcome: "succeeded" }])).toMatchObject({ status: "error", error: "rate limited" });
    expect(await lostEnd([{ id: "msg_i1", type: "idle", outcome: "interrupted" }])).toMatchObject({ status: "stopped" });
  });

  it("a run OpenCode lists as active only after its prompt request answered is not ended by a reconnect in that gap", async () => {
    // Its prompt is stored (the user message) but nothing ran yet and OpenCode does not list the session: the run is starting, not ended.
    let listed = false;
    const r = rig({ stored: [{ id: "msg_u1", type: "user", text: "find foo" }], active: () => (listed ? { ses_child: {} } : {}) });
    let end: unknown;
    const running = r.run.inlineTask(spec(), hooks()).then((x) => (end = x));
    for (let i = 0; i < 40 && !r.called("session.prompt").length; i++) await sleep(25);
    await sleep(0);
    r.reconnect();
    await sleep(50);
    expect(end).toBeUndefined();
    listed = true;
    r.child("session.execution.started");
    r.child("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "foo is in a.txt" });
    r.child("session.execution.succeeded");
    expect(await running).toMatchObject({ status: "done", text: "foo is in a.txt" });
  });

  it("an ask of the run first seen at a reconnect (its event lost) keeps the run's call data: tool and input, and its denied card under the inline call", async () => {
    const ask = { id: "per_1", sessionID: "ses_child", action: "shell", resources: ["rm x"], source: { type: "tool", messageID: "msg_a1", id: "c1" } };
    let child!: (type: string, d?: Json) => void;
    const pending: Json[] = [];
    const r = rig({ pending, active: { ses_child: { type: "running" } }, script: (c) => ((child = c), c("session.execution.started"), c("session.tool.input.started", { assistantMessageID: "msg_a1", id: "c1", name: "shell" }), c("session.tool.called", { assistantMessageID: "msg_a1", id: "c1", input: { command: "rm x", description: "remove x" } })) });
    r.callRunning();
    const done = r.run.inlineTask(spec({ tools: ["Bash"] }), hooks());
    for (let i = 0; i < 40 && !r.called("session.prompt").length; i++) await sleep(25);
    await sleep(0);
    pending.push(ask);
    r.reconnect();
    for (let i = 0; i < 40 && !r.asks.length; i++) await sleep(25);
    expect(r.asks[0]!.part).toMatchObject({ type: "permission_request", id: "per_1", tool: "Bash", input: { command: "rm x", description: "remove x" } });
    r.asks[0]!.reply({ kind: "deny", message: "no" });
    await sleep(0);
    expect(r.emitted.filter((p) => p.id === "c1").at(-1)).toMatchObject({ type: "tool_call", status: "denied", parentId: "call_1" });
    child("session.execution.succeeded");
    expect(await done).toMatchObject({ status: "denied", denied: ["Bash: rm x"] });
  });

  it("a denial the run worked around stays done with the denied list; a rule denial (permission.rejected) is listed once and its card is denied under the call", async () => {
    const r = rig({
      script: (c) => {
        c("session.tool.input.started", { assistantMessageID: "msg_a1", id: "c1", name: "shell" });
        c("session.tool.called", { assistantMessageID: "msg_a1", id: "c1", input: { command: "rm x" } });
        c("session.tool.failed", { assistantMessageID: "msg_a1", id: "c1", error: { type: "permission.rejected" } });
        c("session.tool.failed", { assistantMessageID: "msg_a1", id: "c1", error: { type: "permission.rejected" } });
        c("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "could not remove it" });
        c("session.execution.succeeded");
      },
    });
    r.callRunning();
    expect(await r.run.inlineTask(spec({ tools: ["Bash"] }), hooks())).toMatchObject({ status: "done", text: "could not remove it", denied: ["Bash: rm x"] });
    expect(r.emitted.filter((p) => p.id === "c1").at(-1)).toMatchObject({ type: "tool_call", status: "denied", parentId: "call_1" });
  });

  it("a call that matches no running call by input still takes the only running inline_task call; a call that comes after the run started takes the steps seen before it", async () => {
    const steps = (c: (type: string, d?: Json) => void) => (c("session.tool.input.started", { assistantMessageID: "msg_a1", id: "c1", name: "grep" }), c("session.tool.called", { assistantMessageID: "msg_a1", id: "c1", input: { pattern: "foo" } }), c("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "ok" }));
    const script = (c: (type: string, d?: Json) => void) => (steps(c), c("session.execution.succeeded"));
    // The model's call carries a key the tool's schema dropped and an empty one.
    const r = rig({ script });
    r.callRunning("call_1", { ...INPUT, extra: "x", files: [] });
    await r.run.inlineTask(spec(), hooks());
    expect(r.emitted.some((p) => p.id === "c1" && p.parentId === "call_1")).toBe(true);
    expect(r.links).toEqual([["ses_child", { sessionId: "ses_parent", callId: "call_1" }]]);
    // The call's event comes while the run already works: its steps wait for it.
    const late = rig({ script: steps });
    const done = late.run.inlineTask(spec(), hooks());
    // The run looks for its call for a second first.
    for (let i = 0; i < 200 && !late.called("session.prompt").length; i++) await sleep(20);
    await sleep(20);
    expect(late.emitted.filter((p) => p.parentId)).toEqual([]);
    late.callRunning();
    expect(late.emitted.some((p) => p.id === "c1" && p.parentId === "call_1")).toBe(true);
    late.child("session.execution.succeeded");
    await done;
    expect(late.links).toEqual([["ses_child", { sessionId: "ses_parent", callId: "call_1" }]]);
  });

  it("a live run still ends after a stream reconnect once its link is saved (the saved link does not make its session a restored child)", async () => {
    const stored = [{ id: "msg_p", type: "assistant", content: [{ type: "tool", id: "call_1", name: "claude-ui-parentxxxx_inline_task", state: { status: "running", input: INPUT } }] }];
    const r = rig({ stored, active: { ses_child: {} } });
    r.callRunning();
    const running = r.run.inlineTask(spec(), hooks());
    for (let i = 0; i < 40 && !r.called("session.prompt").length; i++) await sleep(25);
    await sleep(0);
    expect(r.links.length).toBe(1);
    r.reconnect();
    await sleep(100);
    r.child("session.execution.started");
    r.child("session.text.ended", { assistantMessageID: "msg_a1", ordinal: 0, text: "foo is in a.txt" });
    r.child("session.execution.succeeded");
    expect(await running).toMatchObject({ status: "done", text: "foo is in a.txt" });
  });

  it("a Deny in OpenCode 2's real event order (reply reject, tool aborted, step failed, execution interrupted) ends denied with the turn counted, not stopped; the denied call ids are saved with the link", async () => {
    let child!: (type: string, d?: Json) => void;
    const r = rig({ script: (c) => ((child = c), c("session.execution.started"), c("session.step.started", { model: { providerID: "fake", id: "small" }, assistantMessageID: "msg_a1" }), c("session.tool.input.started", { assistantMessageID: "msg_a1", id: "c1", name: "shell" }), c("session.tool.called", { assistantMessageID: "msg_a1", id: "c1", input: { command: "echo blocked" } }), c("permission.asked", { id: "per_1", action: "shell", resources: ["echo blocked"], source: { type: "tool", messageID: "msg_a1", id: "c1" } })) });
    r.callRunning();
    const done = r.run.inlineTask(spec({ tools: ["Bash"] }), hooks());
    for (let i = 0; i < 200 && !r.asks.length; i++) await sleep(20);
    r.asks[0]!.reply({ kind: "deny" });
    child("permission.replied", { requestID: "per_1", reply: "reject" });
    child("session.tool.failed", { assistantMessageID: "msg_a1", id: "c1", error: { type: "aborted" } });
    child("session.step.failed", { assistantMessageID: "msg_a1", error: { type: "aborted" } });
    child("session.execution.interrupted", { reason: "shutdown" });
    expect(await done).toMatchObject({ status: "denied", turns: 1, denied: ["Bash: echo blocked"], error: "The user denied Bash: echo blocked." });
    expect(r.links.at(-1)).toEqual(["ses_child", { sessionId: "ses_parent", callId: "call_1", denied: ["c1"] }]);
  });
});
