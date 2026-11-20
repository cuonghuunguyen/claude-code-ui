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

function rig(o: { script?: (emit: (type: string, d?: Json) => void) => void; stored?: Json[]; model?: string } = {}) {
  const calls: { name: string; input: Json }[] = [];
  const handlers = new Set<{ event: (dir: string | undefined, p: { type: string; properties: Json }) => void }>();
  const emit = (type: string, d: Json) => handlers.forEach((h) => h.event("/p", { type, properties: d }));
  const child = (type: string, d: Json = {}) => emit(type, { sessionID: "ses_child", ...d });
  const rec =
    (name: string, f: (i: Json) => unknown = () => undefined) =>
    async (input: Json) => (calls.push({ name, input }), f(input));
  const client = {
    agent: { list: rec("agent.list", () => ({ data: [{ id: "build", mode: "primary", hidden: false, permissions: BUILD }] })) },
    config: { get: rec("config.get", () => []) },
    command: { list: rec("command.list", () => ({ data: [] })) },
    session: {
      create: rec("session.create", () => ({ id: "ses_child" })),
      prompt: rec("session.prompt", () => void queueMicrotask(() => o.script?.(child))),
      interrupt: rec("session.interrupt", () => ({ interrupted: true })),
      remove: rec("session.remove"),
      update: rec("session.update"),
    },
    permission: { reply: rec("permission.reply") },
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
  const run = createOpenCode2Engine(server).open(session, { permissionMode: "default", model: o.model ?? "fake/m" } as SessionOpts);
  run.begin();
  /** The running inline_task call of the parent, as OpenCode reports it. */
  const callRunning = (id = "call_1", input: Json = INPUT) => {
    emit("session.tool.input.started", { sessionID: "ses_parent", assistantMessageID: "msg_p", id, name: "claude-ui-parentxxxx_inline_task" });
    emit("session.tool.called", { sessionID: "ses_parent", assistantMessageID: "msg_p", id, input });
  };
  const called = (name: string) => calls.filter((c) => c.name === name).map((c) => c.input);
  return { run, emit, child, emitted, asks, callRunning, called };
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
    expect(r.called("session.prompt")).toEqual([{ sessionID: "ses_child", text: "find foo" }]);
    const steps = r.emitted.filter((p) => p.parentId === "call_1");
    expect(steps.map((p) => `${p.type}:${p.id}`)).toEqual(expect.arrayContaining(["tool_call:c1", "tool_result:c1:result", "assistant_text:msg_a2:text:0"]));
    await sleep(0);
    expect(r.called("session.remove")).toEqual([{ sessionID: "ses_child" }]);
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
    expect(await done).toMatchObject({ status: "done" });
  });

  it("the turn cap interrupts it with limit turns; Stop from the card and the abort signal end it as stopped; a failed execution is an error; an MCP grant is refused", async () => {
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

    const mcp = rig();
    expect(await mcp.run.inlineTask(spec({ mcp: ["jira"] }), hooks())).toMatchObject({ status: "error", error: expect.stringMatching(/does not support MCP tools in an inline task/) });
    expect(mcp.called("session.create")).toEqual([]);
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
});
