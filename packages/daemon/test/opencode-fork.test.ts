// OpenCode Fork run (docs/spec.md "Fork runs"): OpenCodeSession.forkRun against a scripted OpenCode server (request + event stream), no process.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { createOpenCodeEngine } from "../src/opencode-engine.ts";
import type { Session, SessionOpts } from "../src/session.ts";
import type { OpenCodeServer } from "../src/opencode-server.ts";

type Payload = { type: string; properties: Record<string, any> };
type Call = { method: string; path: string; body?: any };
const TOOL = "claude-ui-parentxxxx_fork";
const INPUT = { description: "map the modules", prompt: "list the modules" };
const msg = (id: string, role: "user" | "assistant", completed = true) => ({ info: { id, role, ...(completed && { time: { completed: 1 } }) }, parts: [] });

function rig(o: { stored?: ReturnType<typeof msg>[]; revert?: string; failPatch?: boolean; script?: (path: string, body: any, emit: (p: Payload) => void) => void } = {}) {
  const calls: Call[] = [];
  const links: { id: string; link: unknown }[] = [];
  let abortHook: (() => void) | undefined;
  const handlers = new Set<{ event: (d: string | undefined, p: Payload) => void; resync: () => void }>();
  const emit = (p: Payload) => handlers.forEach((h) => h.event("/p", p));
  const stored = o.stored ?? [msg("msg_u1", "user"), msg("msg_a1", "assistant"), msg("msg_u2", "user"), msg("msg_a2", "assistant", false)];
  const server = {
    request: vi.fn(async (path: string, r: { method?: string; body?: any } = {}) => {
      const method = r.method ?? "GET";
      calls.push({ method, path, body: r.body });
      if (method === "GET" && path === "/session/ses_parent/message") return stored;
      if (method === "GET" && path === "/session/ses_parent") return o.revert ? { revert: { messageID: o.revert } } : {};
      if (method === "POST" && path === "/session/ses_parent/fork") return { id: "ses_fork" };
      if (method === "PATCH" && o.failPatch) throw new Error("patch failed");
      if (method === "POST" && path.endsWith("/abort")) return abortHook?.(), true;
      if (method === "POST" && path.endsWith("/prompt_async")) return o.script?.(path, r.body, emit), undefined;
      if (path === "/agent") return [{ name: "build", permission: [] }];
      if (path === "/command") return [];
      if (path.endsWith("/message")) return [];
      return undefined;
    }),
    events: (h: never) => (handlers.add(h), () => handlers.delete(h)),
    streamReady: async () => {},
  } as unknown as OpenCodeServer;
  const emitted: Part[] = [];
  const session = { id: "ses_parent", cwd: "/p", emit: (p: Part) => emitted.push(p), currentState: () => "running", setState: () => {}, request: () => {}, pendingRequest: () => undefined, cancel: () => {} } as unknown as Session;
  const run = createOpenCodeEngine(server, { onFork: (id, link) => links.push({ id, link }) }).open(session, { permissionMode: "default", model: "acme/big" } as SessionOpts);
  run.begin();
  /** The running fork call of the parent, as OpenCode reports it. */
  const callRunning = (id = "call_1", input: Record<string, unknown> = INPUT) =>
    emit({ type: "message.part.updated", properties: { part: { id: `prt_${id}`, type: "tool", sessionID: "ses_parent", messageID: "msg_p", callID: id, tool: TOOL, state: { status: "running", input, time: { start: 1 } } } } });
  return { run, calls, emit, emitted, links, callRunning, onAbort: (f: () => void) => (abortHook = f), sent: (method: string, path: string | RegExp) => calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))) };
}
const asst = (emit: (p: Payload) => void, id = "msg_f1") => emit({ type: "message.updated", properties: { info: { id, sessionID: "ses_fork", role: "assistant", providerID: "acme", modelID: "big" } } });
const part = (emit: (p: Payload) => void, p: object) => emit({ type: "message.part.updated", properties: { part: p } });
const text = (id: string, t: string) => ({ id, type: "text", sessionID: "ses_fork", messageID: "msg_f1", text: t, time: { start: 1, end: 2 } });
const idle = (emit: (p: Payload) => void) => emit({ type: "session.idle", properties: { sessionID: "ses_fork" } });
const hooks = (signal = new AbortController().signal) => ({ signal, input: INPUT });
const spec = INPUT;

afterEach(() => vi.useRealTimers());

describe("OpenCode Fork run", () => {
  it("forks before the running step, titles it, denies task and the claude-ui tools, then prompts the fork with the parent's model; the result is its last reply", async () => {
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => (asst(emit), part(emit, text("prt_t", "three modules")), idle(emit))) });
    r.callRunning();
    const res = await r.run.forkRun!(spec, hooks());
    // the running assistant message (the one that holds this call) is not copied: the fork starts at the step before it
    expect(r.sent("POST", "/session/ses_parent/fork")[0]!.body).toEqual({ messageID: "msg_a2" });
    const patch = r.sent("PATCH", "/session/ses_fork")[0]!.body;
    expect(patch.title).toBe("Fork: map the modules");
    expect(patch.permission).toContainEqual({ permission: "task", pattern: "*", action: "deny" });
    // denied after every rule of the parent (an "always" rule must not allow them again)
    expect(patch.permission.slice(-3)).toEqual([{ permission: "task", pattern: "*", action: "deny" }, { permission: "claude-ui-*", pattern: "*", action: "deny" }, { permission: "orchestration-*", pattern: "*", action: "deny" }]);
    const prompt = r.sent("POST", "/session/ses_fork/prompt_async")[0]!.body;
    expect(prompt).toMatchObject({ agent: "build", model: { providerID: "acme", modelID: "big" } });
    expect(prompt.tools).toBeUndefined();
    expect(prompt.system).toBeUndefined();
    expect(prompt.parts[0].text).toMatch(/^You are a fork[\s\S]*\n\nlist the modules$/);
    expect(res).toMatchObject({ status: "done", text: "three modules" });
  });

  it("saves the fork's link before the prompt: the call, the parent and the copied messages (2 before msg_a2)", async () => {
    const order: string[] = [];
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => (order.push("prompt"), asst(emit), part(emit, text("prt_t", "x")), idle(emit))) });
    r.callRunning();
    const done = r.run.forkRun!(spec, hooks());
    await done;
    expect(r.links).toEqual([{ id: "ses_fork", link: { sessionId: "ses_parent", callId: "call_1", prefix: 3 } }]);
    // order of requests: fork, then the PATCH, then the prompt
    const paths = r.calls.map((c) => `${c.method} ${c.path}`);
    expect(paths.indexOf("POST /session/ses_parent/fork")).toBeLessThan(paths.indexOf("PATCH /session/ses_fork"));
    expect(paths.indexOf("PATCH /session/ses_fork")).toBeLessThan(paths.indexOf("POST /session/ses_fork/prompt_async"));
  });

  it("a PATCH that fails deletes the fork (no link, no rules) and reports the error", async () => {
    const r = rig({ failPatch: true });
    r.callRunning();
    expect(await r.run.forkRun!(spec, hooks())).toMatchObject({ status: "error", error: "patch failed" });
    expect(r.sent("DELETE", "/session/ses_fork")).toHaveLength(1);
    expect(r.links).toEqual([]);
    expect(r.sent("POST", "/session/ses_fork/prompt_async")).toHaveLength(0);
  });

  it("a signal aborted before the fork is made sends no prompt", async () => {
    const r = rig();
    r.callRunning();
    const ctl = new AbortController();
    ctl.abort();
    expect(await r.run.forkRun!(spec, hooks(ctl.signal))).toMatchObject({ status: "stopped" });
    expect(r.sent("POST", "/session/ses_fork/prompt_async")).toHaveLength(0);
    expect(r.sent("POST", "/session/ses_fork/abort")).toHaveLength(1);
  });

  it("the fork's steps reach the parent with parentId = the call, as a Fork run card; its prompt echo is hidden", async () => {
    const r = rig({
      script: (_p, b, emit) =>
        queueMicrotask(() => {
          emit({ type: "message.updated", properties: { info: { id: b.messageID, sessionID: "ses_fork", role: "user" } } });
          part(emit, { id: "prt_u", type: "text", sessionID: "ses_fork", messageID: b.messageID, text: "x" });
          asst(emit);
          part(emit, { id: "prt_g", type: "tool", sessionID: "ses_fork", messageID: "msg_f1", callID: "c_g", tool: "grep", state: { status: "completed", input: { pattern: "foo" }, output: "ok", time: { start: 1, end: 2 } } });
          part(emit, text("prt_t", "done"));
          idle(emit);
        }),
    });
    r.callRunning();
    await r.run.forkRun!(spec, hooks());
    expect(r.emitted.find((p) => p.type === "subagent")).toMatchObject({ id: "call_1", agentType: "fork", description: "map the modules", status: "running" });
    expect(r.emitted.filter((p) => p.parentId === "call_1").map((p) => p.type)).toEqual(["tool_call", "tool_result", "assistant_text"]);
    expect(r.emitted.some((p) => p.type === "user_text")).toBe(false);
  });

  it("a signal abort (the parent's Stop) aborts the fork and ends as stopped", async () => {
    const r = rig();
    r.callRunning();
    const ctl = new AbortController();
    const done = r.run.forkRun!(spec, hooks(ctl.signal));
    await vi.waitFor(() => expect(r.sent("POST", "/session/ses_fork/prompt_async")).toHaveLength(1));
    ctl.abort();
    expect(await done).toMatchObject({ status: "stopped" });
    expect(r.sent("POST", "/session/ses_fork/abort")).toHaveLength(1);
  });

  it("Stop agent on the card aborts the fork", async () => {
    const r = rig();
    r.callRunning();
    const done = r.run.forkRun!(spec, hooks());
    await vi.waitFor(() => expect(r.sent("POST", "/session/ses_fork/prompt_async")).toHaveLength(1));
    expect(await r.run.stopSubagent("call_1")).toBe(true);
    expect(await done).toMatchObject({ status: "stopped" });
    expect(r.sent("POST", "/session/ses_fork/abort")).toHaveLength(1);
  });

  it("an error of the fork session ends the run as error with its text", async () => {
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => emit({ type: "session.error", properties: { sessionID: "ses_fork", error: { name: "UnknownError", data: { message: "boom" } } } })) });
    r.callRunning();
    expect(await r.run.forkRun!(spec, hooks())).toMatchObject({ status: "error", error: expect.stringContaining("boom") });
  });

  it("a parent without messages forks nothing and reports why", async () => {
    const r = rig({ stored: [] });
    r.callRunning();
    expect(await r.run.forkRun!(spec, hooks())).toMatchObject({ status: "error", error: "A fork needs a message in this session first" });
    expect(r.sent("POST", "/session/ses_parent/fork")).toHaveLength(0);
  });

  it("without a matching running call the fork shows nothing, saves no link and is deleted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => (asst(emit), part(emit, text("prt_t", "ok")), idle(emit))) });
    const done = r.run.forkRun!(spec, hooks());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await done).toMatchObject({ status: "done", text: "ok" });
    expect(r.links).toEqual([]);
    expect(r.emitted.filter((p) => p.parentId)).toEqual([]);
    expect(r.sent("DELETE", "/session/ses_fork")).toHaveLength(1);
  });
});
