// OpenCode 2 Fork run (GH-885, docs/spec.md "Fork runs"): OpenCode2Session.forkRun against a scripted `@opencode/client` and event stream, no process.
import { describe, expect, it } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { FORK_PREAMBLE } from "../src/opencode-fork.ts";
import { createOpenCode2Engine } from "../src/opencode2-engine.ts";
import type { OpenCodeServer } from "../src/opencode-server.ts";
import type { Session, SessionOpts } from "../src/session.ts";
import type { Reply } from "../src/engine.ts";

type Json = Record<string, any>;
const INPUT = { description: "probe fork", prompt: "count the files" };
const SPEC = { description: "probe fork", prompt: "count the files" };
const BUILD = [{ action: "*", resource: "*", effect: "allow" }, { action: "browser", resource: "*", effect: "deny" }];
/** The parent's messages: the running assistant step (no `completed`) holds the fork call. */
const PARENT = [{ id: "msg_u1", type: "user", text: "hello" }, { id: "msg_a1", type: "assistant", time: { completed: 1 }, content: [] }, { id: "msg_u2", type: "user", text: "do it" }, { id: "msg_a2", type: "assistant", content: [] }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(o: { script?: (emit: (type: string, d?: Json) => void) => void; parent?: Json[]; copied?: Json[]; stored?: Json[]; model?: string; failFork?: boolean } = {}) {
  const calls: { name: string; input: Json }[] = [];
  const handlers = new Set<{ event: (dir: string | undefined, p: { type: string; properties: Json }) => void; resync: () => void }>();
  const emit = (type: string, d: Json) => handlers.forEach((h) => h.event("/p", { type, properties: d }));
  const fork = (type: string, d: Json = {}) => emit(type, { sessionID: "ses_fork", ...d });
  const links: Json[] = [];
  const rec =
    (name: string, f: (i: Json) => unknown = () => undefined) =>
    async (input: Json) => (calls.push({ name, input }), f(input));
  const parent = o.parent ?? PARENT;
  const client = {
    agent: { list: rec("agent.list", () => ({ data: [{ id: "build", mode: "primary", hidden: false, permissions: BUILD }] })) },
    config: { get: rec("config.get", () => []) },
    command: { list: rec("command.list", () => ({ data: [] })) },
    session: {
      fork: rec("session.fork", () => (o.failFork ? Promise.reject(new Error("fork refused")) : { id: "ses_fork" })),
      update: rec("session.update"),
      switchAgent: rec("session.switchAgent"),
      switchModel: rec("session.switchModel"),
      prompt: rec("session.prompt", () => void queueMicrotask(() => o.script?.(fork))),
      interrupt: rec("session.interrupt", () => ({ interrupted: true })),
      remove: rec("session.remove"),
      active: rec("session.active", () => ({})),
      get: rec("session.get", () => ({ id: "ses_parent", permissions: [] })),
    },
    form: { list: rec("form.list", () => ({ data: [] })) },
    permission: { reply: rec("permission.reply"), request: { list: rec("permission.request.list", () => ({ data: [] })) } },
    message: {
      list: rec("message.list", (i) => {
        if (i.sessionID === "ses_fork") return { data: o.stored ?? o.copied ?? [{ id: "msg_c_1", type: "user" }, { id: "msg_c_2", type: "assistant" }, { id: "msg_c_3", type: "idle" }], cursor: {} };
        // The fork point is read first (oldest, then newest), the history of a parent later.
        return { data: i.order === "desc" ? [...parent].reverse() : i.limit === 1 ? parent.slice(0, 1) : parent, cursor: {} };
      }),
    },
  };
  const server = { client: async () => client, events: (h: never) => (handlers.add(h), () => handlers.delete(h)), streamReady: async () => {}, running: () => true } as unknown as OpenCodeServer;
  const emitted: Part[] = [];
  const asks: { part: Json; reply: (r: Reply) => void }[] = [];
  const cancelled: string[] = [];
  const session = {
    id: "ses_parent",
    cwd: "/p",
    emit: (p: Part) => emitted.push(p),
    currentState: () => "running",
    setState: () => {},
    request: (r: { part: Json; reply: (r: Reply) => void }) => asks.push(r),
    pendingRequest: (id: string) => asks.find((a) => a.part.id === id),
    cancel: (id: string, message: string) => (cancelled.push(id), asks.find((a) => a.part.id === id)?.reply({ kind: "cancel", message } as Reply)),
  } as unknown as Session;
  const run = createOpenCode2Engine(server, { onFork: (forkId, link) => links.push({ forkId, ...link }) }).open(session, { permissionMode: "default", model: o.model ?? "fake/m" } as SessionOpts);
  run.begin();
  /** The running `fork` call of the parent, as OpenCode reports it. */
  const callRunning = (id = "call_1", input: Json = INPUT) => {
    emit("session.tool.input.started", { sessionID: "ses_parent", assistantMessageID: "msg_a2", id, name: "claude-ui-parentxxxx_fork" });
    emit("session.tool.called", { sessionID: "ses_parent", assistantMessageID: "msg_a2", id, input });
  };
  const called = (name: string) => calls.filter((c) => c.name === name).map((c) => c.input);
  return { run, emit, fork, emitted, asks, cancelled, links, callRunning, called, calls };
}
const hooks = (signal = new AbortController().signal) => ({ signal, input: INPUT });
const waitPrompt = async (r: ReturnType<typeof rig>) => {
  for (let i = 0; i < 40 && !r.called("session.prompt").length; i++) await sleep(25);
  await sleep(0);
};
const answer = (c: (type: string, d?: Json) => void) => (c("session.execution.started"), c("session.step.started", { assistantMessageID: "msg_f1" }), c("session.text.ended", { assistantMessageID: "msg_f1", ordinal: 0, text: "fork answer" }), c("session.step.ended", { assistantMessageID: "msg_f1", finish: "stop" }), c("session.execution.succeeded"));

describe("OpenCode 2 Fork run", () => {
  it("forks before the running step, titles and marks the fork, denies subagent and the claude-ui and orchestration tools, runs it on the parent's agent and model; the result is its last reply", async () => {
    const r = rig({ script: answer });
    r.callRunning();
    const res = await r.run.forkRun(SPEC, hooks());
    expect(res).toMatchObject({ status: "done", text: "fork answer" });
    expect(r.called("session.fork")).toEqual([{ sessionID: "ses_parent", before: "msg_a2" }]);
    const [update] = r.called("session.update");
    expect(update).toMatchObject({ sessionID: "ses_fork", title: "Fork: probe fork", metadata: { "claude-ui.forkOf": "ses_parent" } });
    const rules = update!.permissions as Json[];
    const at = (action: string, effect: string) => rules.findIndex((x) => x.action === action && x.effect === effect);
    // The parent's mode (the shell asks) and the agent's denials, then nothing of the daemon's servers is allowed, and no `subagent`.
    expect(at("shell", "ask")).toBeGreaterThan(-1);
    expect(at("browser", "deny")).toBeGreaterThan(-1);
    expect(at("claude-ui-*", "deny")).toBeGreaterThan(-1);
    expect(at("orchestration-*", "deny")).toBeGreaterThan(-1);
    expect(rules.filter((x) => x.action.startsWith("claude-ui-") || x.action.startsWith("orchestration-")).every((x) => x.effect === "deny")).toBe(true);
    expect(rules.at(-1)).toEqual({ action: "subagent", resource: "*", effect: "deny" });
    expect(r.called("session.switchAgent")).toEqual([{ sessionID: "ses_fork", agent: "build" }]);
    expect(r.called("session.switchModel")).toEqual([{ sessionID: "ses_fork", model: { providerID: "fake", id: "m" } }]);
    const [prompt] = r.called("session.prompt");
    expect(prompt).toMatchObject({ sessionID: "ses_fork" });
    expect(prompt!.text).toBe(`${FORK_PREAMBLE}\n\ncount the files`);
    // Linked: the fork stays for the card's restore and is deleted with its parent, not at the end of the run.
    await sleep(0);
    expect(r.called("session.remove")).toEqual([]);
    expect(r.called("session.interrupt")).toEqual([]);
  });

  it("saves the fork's link before the prompt: the parent, the call and the number of copied messages", async () => {
    const r = rig({ script: answer, copied: [{ id: "msg_c_1", type: "user" }, { id: "msg_c_2", type: "assistant" }] });
    r.callRunning();
    await r.run.forkRun(SPEC, hooks());
    expect(r.links).toEqual([{ forkId: "ses_fork", sessionId: "ses_parent", callId: "call_1", prefix: 2 }]);
    // The count is read before the fork's own messages exist (OpenCode adds its notice at the first prompt).
    const names = r.calls.map((c) => c.name);
    expect(names.lastIndexOf("message.list")).toBeGreaterThan(-1);
    expect(names.indexOf("session.update")).toBeLessThan(names.indexOf("session.prompt"));
  });

  it("the fork's steps show under the call, its prompt is not echoed, the fork call shows as a Fork run card", async () => {
    const r = rig({
      script: (c) => {
        c("session.execution.started");
        c("session.inbox.enqueued", { inboxID: "msg_p", item: { type: "user", payload: { text: "echo of the prompt" } } });
        c("session.step.started", { assistantMessageID: "msg_f1" });
        c("session.tool.input.started", { assistantMessageID: "msg_f1", id: "c1", name: "glob" });
        c("session.tool.called", { assistantMessageID: "msg_f1", id: "c1", input: { pattern: "*" } });
        c("session.tool.success", { assistantMessageID: "msg_f1", id: "c1", content: [{ type: "text", text: "a.txt" }] });
        c("session.step.ended", { assistantMessageID: "msg_f1", finish: "tool-calls" });
        c("session.step.started", { assistantMessageID: "msg_f2" });
        c("session.text.ended", { assistantMessageID: "msg_f2", ordinal: 0, text: "1 file" });
        c("session.step.ended", { assistantMessageID: "msg_f2", finish: "stop" });
        c("session.execution.succeeded");
      },
    });
    r.callRunning();
    expect(await r.run.forkRun(SPEC, hooks())).toMatchObject({ status: "done", text: "1 file" });
    expect(r.emitted.filter((p) => p.id === "call_1").at(-1)).toMatchObject({ type: "subagent", agentType: "fork", description: "probe fork", status: "running" });
    const steps = r.emitted.filter((p) => p.parentId === "call_1");
    expect(steps.map((p) => `${p.type}:${p.id}`)).toEqual(expect.arrayContaining(["tool_call:c1", "tool_result:c1:result", "assistant_text:msg_f2:text:0"]));
    expect(steps.some((p) => p.type === "user_text")).toBe(false);
  });

  it("a permission ask of the fork shows in the parent and is answered under the fork's id", async () => {
    let fork!: (type: string, d?: Json) => void;
    const r = rig({ script: (c) => ((fork = c), c("session.execution.started"), c("session.tool.input.started", { assistantMessageID: "msg_f1", id: "c1", name: "shell" }), c("session.tool.called", { assistantMessageID: "msg_f1", id: "c1", input: { command: "echo forked" } }), c("permission.asked", { id: "per_1", action: "shell", resources: ["echo forked"], source: { type: "tool", messageID: "msg_f1", id: "c1" } })) });
    r.callRunning();
    const done = r.run.forkRun(SPEC, hooks());
    for (let i = 0; i < 40 && !r.asks.length; i++) await sleep(25);
    expect(r.asks[0]!.part).toMatchObject({ type: "permission_request", id: "per_1", tool: "Bash", input: { command: "echo forked" } });
    r.asks[0]!.reply({ kind: "allow", decision: "allow" } as Reply);
    await sleep(0);
    expect(r.called("permission.reply")).toEqual([{ sessionID: "ses_fork", requestID: "per_1", decision: "once" }]);
    fork("session.execution.succeeded");
    expect(await done).toMatchObject({ status: "done" });
  });

  it("Stop agent on the card and the abort signal interrupt the fork and end it as stopped, an ask of it is cancelled; a failed execution is an error", async () => {
    const card = rig({ script: (c) => (c("session.execution.started"), c("permission.asked", { id: "per_1", action: "shell", resources: ["x"], source: { type: "tool", messageID: "msg_f1", id: "c1" } })) });
    card.callRunning();
    const running = card.run.forkRun(SPEC, hooks());
    await waitPrompt(card);
    for (let i = 0; i < 40 && !card.asks.length; i++) await sleep(25);
    expect(await card.run.stopSubagent("call_1")).toBe(true);
    expect(await running).toMatchObject({ status: "stopped" });
    expect(card.called("session.interrupt")).toEqual([{ sessionID: "ses_fork" }]);
    expect(card.cancelled).toEqual(["per_1"]);
    // OpenCode dropped the ask with the interrupt: no reject goes to it (it would fail as "not found" and show a notice).
    expect(card.called("permission.reply")).toEqual([]);
    expect(await card.run.stopSubagent("call_1")).toBe(false);

    const ac = new AbortController();
    const aborted = rig({ script: () => ac.abort() });
    expect(await aborted.run.forkRun(SPEC, hooks(ac.signal))).toMatchObject({ status: "stopped" });
    expect(aborted.called("session.interrupt")).toEqual([{ sessionID: "ses_fork" }]);

    const failing = rig({ script: (c) => c("session.execution.failed", { error: { type: "provider", message: "rate limited\nstack" } }) });
    expect(await failing.run.forkRun(SPEC, hooks())).toMatchObject({ status: "error", error: "rate limited" });
  });

  it("without a matching running call nothing shows under a card, no link is saved and the fork is removed at the end", async () => {
    const r = rig({ script: answer });
    expect(await r.run.forkRun(SPEC, hooks())).toMatchObject({ status: "done", text: "fork answer" });
    expect(r.links).toEqual([]);
    expect(r.emitted.filter((p) => p.parentId)).toEqual([]);
    await sleep(0);
    expect(r.called("session.remove")).toEqual([{ sessionID: "ses_fork" }]);
  }, 10_000);

  it("a parent without messages forks nothing and says why; a refused fork is an error", async () => {
    const empty = rig({ parent: [] });
    expect(await empty.run.forkRun(SPEC, hooks())).toMatchObject({ status: "error", error: "A fork needs a message in this session first" });
    expect(empty.called("session.fork")).toEqual([]);
    const refused = rig({ failFork: true });
    refused.callRunning();
    expect(await refused.run.forkRun(SPEC, hooks())).toMatchObject({ status: "error", error: "fork refused" });
    expect(refused.called("session.prompt")).toEqual([]);
  });
});
