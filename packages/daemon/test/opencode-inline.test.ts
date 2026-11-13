// OpenCode inline task (GH-734, docs/spec.md "Inline tasks"): OpenCodeSession.inlineTask against a scripted OpenCode server (request + event stream), no process.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { createOpenCodeEngine } from "../src/opencode-engine.ts";
import type { InlineSpec } from "../src/inline-types.ts";
import type { Session, SessionOpts } from "../src/session.ts";
import type { OpenCodeServer } from "../src/opencode-server.ts";

type Payload = { type: string; properties: Record<string, any> };
type Call = { method: string; path: string; body?: any };
const TOOL = "claude-ui-parentxxxx_inline_task";
const INPUT = { prompt: "find foo", tools: ["Grep"] };
const spec = (o: Partial<InlineSpec> = {}): InlineSpec => ({ text: "find foo", title: "find foo", tools: ["Grep"], mcp: [], maxTurns: 10, ...o });

const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "step-finish", sessionID: "ses_child", messageID: "msg_a1", reason: "tool-calls", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 5, write: 1 } }, cost: 0.001, ...extra });
const text = (id: string, t: string, messageID = "msg_a1") => ({ id, type: "text", sessionID: "ses_child", messageID, text: t, time: { start: 1, end: 2 } });
const toolPart = (id: string, tool: string, input: Record<string, unknown>) => ({ id, type: "tool", sessionID: "ses_child", messageID: "msg_a1", callID: `c_${id}`, tool, state: { status: "completed", input, output: "ok", time: { start: 1, end: 2 } } });

function rig(o: { smallModel?: string; script?: (path: string, body: any, emit: (p: Payload) => void) => void } = {}) {
  const calls: Call[] = [];
  const handlers = new Set<{ event: (d: string | undefined, p: Payload) => void; resync: () => void }>();
  const emit = (p: Payload) => handlers.forEach((h) => h.event("/p", p));
  const server = {
    request: vi.fn(async (path: string, r: { method?: string; body?: any } = {}) => {
      const method = r.method ?? "GET";
      calls.push({ method, path, body: r.body });
      if (method === "POST" && path === "/session") return { id: "ses_child" };
      if (method === "POST" && path.endsWith("/prompt_async")) return o.script?.(path, r.body, emit), undefined;
      if (path === "/config") return o.smallModel ? { small_model: o.smallModel } : {};
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
  const run = createOpenCodeEngine(server).open(session, { permissionMode: "default" } as SessionOpts);
  run.begin();
  /** The running inline_task call of the parent, as OpenCode reports it. */
  const callRunning = (id = "call_1", input: Record<string, unknown> = INPUT) =>
    emit({ type: "message.part.updated", properties: { part: { id: `prt_${id}`, type: "tool", sessionID: "ses_parent", messageID: "msg_p", callID: id, tool: TOOL, state: { status: "running", input, time: { start: 1 } } } } });
  return { run, calls, emit, emitted, callRunning, sent: (suffix: string) => calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix)) };
}
const asst = (emit: (p: Payload) => void, id = "msg_a1", extra: Record<string, unknown> = {}) => emit({ type: "message.updated", properties: { info: { id, sessionID: "ses_child", role: "assistant", providerID: "acme", modelID: "small", ...extra } } });
const part = (emit: (p: Payload) => void, p: object) => emit({ type: "message.part.updated", properties: { part: p } });
const idle = (emit: (p: Payload) => void) => emit({ type: "session.idle", properties: { sessionID: "ses_child" } });
const hooks = (signal = new AbortController().signal) => ({ signal, input: INPUT });

afterEach(() => vi.useRealTimers());

describe("OpenCode inline task", () => {
  it("creates a child session of the parent and prompts it with model, system, tools map and the text", async () => {
    const r = rig({
      smallModel: "acme/small",
      script: (_p, _b, emit) => queueMicrotask(() => (asst(emit), part(emit, text("prt_t", "found it")), part(emit, step("prt_s1", { reason: "stop" })), idle(emit))),
    });
    r.callRunning();
    const res = await r.run.inlineTask!(spec({ tools: ["Grep", "Read"], mcp: ["playwright", "mcp__docs__search"] }), hooks());
    const create = r.sent("/session").find((c) => c.path === "/session")!;
    expect(create.body).toMatchObject({ parentID: "ses_parent", title: "Inline: find foo" });
    expect(create.body.permission.length).toBeGreaterThan(0);
    const prompt = r.sent("/prompt_async")[0]!;
    expect(prompt.path).toBe("/session/ses_child/prompt_async");
    expect(prompt.body.model).toEqual({ providerID: "acme", modelID: "small" });
    expect(prompt.body.parts).toEqual([{ id: expect.stringMatching(/^prt_/), type: "text", text: "find foo" }]);
    expect(prompt.body.system).toEqual(expect.any(String));
    expect(prompt.body.tools).toEqual({ "*": false, grep: true, read: true, "playwright_*": true, docs_search: true });
    expect(res).toMatchObject({ status: "done", text: "found it", model: "acme/small", turns: 1, tokens: { input: 100, output: 10, cacheRead: 5, cacheWrite: 1 }, filesChanged: [] });
    expect(res.costUsd).toBeCloseTo(0.001);
  });

  it("model: explicit input wins, then the openCodeModel hook, then small_model, then the parent's model (none when default)", async () => {
    const finish = (_p: string, _b: unknown, emit: (p: Payload) => void) => queueMicrotask(() => (part(emit, text("prt_t", "x")), idle(emit)));
    const modelOf = async (smallModel: string | undefined, s: Partial<InlineSpec>, openCodeModel?: string) => {
      const r = rig({ smallModel, script: finish });
      r.callRunning();
      await r.run.inlineTask!(spec(s), { ...hooks(), ...(openCodeModel !== undefined && { openCodeModel }) });
      return r.sent("/prompt_async")[0]!.body.model;
    };
    expect(await modelOf("acme/small", { model: "x/y" }, "h/m")).toEqual({ providerID: "x", modelID: "y" });
    expect(await modelOf("acme/small", {}, "h/m")).toEqual({ providerID: "h", modelID: "m" });
    expect(await modelOf("acme/small", {}, "")).toEqual({ providerID: "acme", modelID: "small" });
    expect(await modelOf("acme/small", {})).toEqual({ providerID: "acme", modelID: "small" });
    expect(await modelOf(undefined, {})).toBeUndefined();
  });

  it("child parts reach the parent as steps with parentId = the call; the prompt echo is hidden", async () => {
    const r = rig({
      script: (_p, b, emit) =>
        queueMicrotask(() => {
          emit({ type: "message.updated", properties: { info: { id: b.messageID, sessionID: "ses_child", role: "user" } } });
          part(emit, { id: "prt_u", type: "text", sessionID: "ses_child", messageID: b.messageID, text: "find foo" });
          asst(emit);
          part(emit, toolPart("prt_g", "grep", { pattern: "foo" }));
          part(emit, text("prt_t", "done"));
          idle(emit);
        }),
    });
    r.callRunning();
    await r.run.inlineTask!(spec(), hooks());
    const steps = r.emitted.filter((p) => p.parentId === "call_1");
    expect(steps.map((p) => p.type)).toEqual(["tool_call", "tool_result", "assistant_text"]);
    expect(steps[0]).toMatchObject({ tool: "Grep", input: { pattern: "foo" } });
    expect(r.emitted.some((p) => p.type === "user_text")).toBe(false);
  });

  it("without a matching running call it runs with no steps in the parent; a claimed call is not used twice", async () => {
    const script = (_p: string, _b: unknown, emit: (p: Payload) => void) => queueMicrotask(() => (asst(emit), part(emit, toolPart("prt_g", "grep", {})), part(emit, text("prt_t", "ok")), idle(emit)));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig({ script });
    const none = r.run.inlineTask!(spec(), hooks());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await none).toMatchObject({ status: "done", text: "ok" });
    expect(r.emitted.filter((p) => p.parentId)).toEqual([]);
    // two calls with equal input: runs take them newest first, one each
    const r2 = rig({ script });
    r2.callRunning("old");
    r2.callRunning("new");
    await r2.run.inlineTask!(spec(), hooks());
    await r2.run.inlineTask!(spec(), hooks());
    expect(new Set(r2.emitted.filter((p) => p.parentId).map((p) => p.parentId))).toEqual(new Set(["new", "old"]));
  });

  it("filesChanged: edit and write inputs of the child, once each", async () => {
    const r = rig({
      script: (_p, _b, emit) =>
        queueMicrotask(() => {
          asst(emit);
          part(emit, toolPart("prt_1", "edit", { filePath: "/p/a.ts", oldString: "a", newString: "b" }));
          part(emit, toolPart("prt_2", "write", { filePath: "/p/b.ts", content: "x" }));
          part(emit, toolPart("prt_3", "edit", { filePath: "/p/a.ts" }));
          part(emit, toolPart("prt_4", "read", { filePath: "/p/c.ts" }));
          part(emit, text("prt_t", "ok"));
          idle(emit);
        }),
    });
    r.callRunning();
    expect((await r.run.inlineTask!(spec({ tools: ["Edit", "Write"] }), hooks())).filesChanged).toEqual(["/p/a.ts", "/p/b.ts"]);
  });

  it("text is the last assistant text, not the prompt echo", async () => {
    const r = rig({
      script: (_p, _b, emit) =>
        queueMicrotask(() => {
          asst(emit, "msg_a1");
          part(emit, text("prt_1", "thinking out loud", "msg_a1"));
          asst(emit, "msg_a2");
          part(emit, text("prt_2", "the answer", "msg_a2"));
          idle(emit);
        }),
    });
    r.callRunning();
    expect((await r.run.inlineTask!(spec(), hooks())).text).toBe("the answer");
  });

  it("turn cap: at maxTurns steps that did not stop the model, aborts the child and returns a partial result", async () => {
    const r = rig({
      script: (_p, _b, emit) => queueMicrotask(() => (asst(emit), part(emit, text("prt_t", "partial")), part(emit, step("prt_s1")), part(emit, step("prt_s2")))),
    });
    r.callRunning();
    const res = await r.run.inlineTask!(spec({ maxTurns: 2 }), hooks());
    expect(r.sent("/abort").map((c) => c.path)).toEqual(["/session/ses_child/abort"]);
    expect(res).toMatchObject({ status: "limit", limit: "turns", turns: 2, text: "partial" });
  });

  it("a final step that stopped the model at maxTurns is done, not a limit", async () => {
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => (asst(emit), part(emit, text("prt_t", "all done")), part(emit, step("prt_s1")), part(emit, step("prt_s2", { reason: "stop" })), idle(emit))) });
    r.callRunning();
    expect(await r.run.inlineTask!(spec({ maxTurns: 2 }), hooks())).toMatchObject({ status: "done", turns: 2 });
    expect(r.sent("/abort")).toEqual([]);
  });

  it("token cap: output tokens over the cap abort the child with limit tokens", async () => {
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => (asst(emit), part(emit, text("prt_t", "p")), part(emit, step("prt_s1", { tokens: { input: 1, output: 9000, reasoning: 8000, cache: { read: 0, write: 0 } } })))) });
    r.callRunning();
    const res = await r.run.inlineTask!(spec(), hooks());
    expect(r.sent("/abort")).toHaveLength(1);
    expect(res).toMatchObject({ status: "limit", limit: "tokens", tokens: { output: 17000 } });
  });

  it("timeout: aborts the child with limit time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => (asst(emit), part(emit, text("prt_t", "so far")))) });
    r.callRunning();
    const p = r.run.inlineTask!(spec(), hooks());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await p).toMatchObject({ status: "limit", limit: "time", text: "so far" });
    expect(r.sent("/abort")).toHaveLength(1);
  });

  it("abort signal: aborts the child and returns status stopped", async () => {
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => (asst(emit), part(emit, text("prt_t", "half")))) });
    r.callRunning();
    const ac = new AbortController();
    const p = r.run.inlineTask!(spec(), hooks(ac.signal));
    await new Promise((x) => setTimeout(x, 20));
    ac.abort();
    expect(await p).toMatchObject({ status: "stopped", text: "half" });
    expect(r.sent("/abort")).toHaveLength(1);
  });

  it("a session error of the child is status error with its text", async () => {
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => emit({ type: "session.error", properties: { sessionID: "ses_child", error: { name: "APIError", data: { message: "boom" } } } })) });
    r.callRunning();
    const res = await r.run.inlineTask!(spec(), hooks());
    expect(res.status).toBe("error");
    expect(res.error).toContain("boom");
  });

  it("a failing prompt request is status error", async () => {
    const r = rig();
    r.callRunning();
    (r.run as any).server.request.mockImplementation(async (path: string, o: any) => {
      if (path === "/session") return { id: "ses_child" };
      if (path.endsWith("/prompt_async")) throw new Error("down");
      return o?.method ? undefined : path === "/agent" ? [] : {};
    });
    expect(await r.run.inlineTask!(spec(), hooks())).toMatchObject({ status: "error", error: expect.stringContaining("down") });
  });

  it("text over 16,000 chars keeps the tail and sets truncated", async () => {
    const long = "a".repeat(10_000) + "b".repeat(10_000);
    const r = rig({ script: (_p, _b, emit) => queueMicrotask(() => (asst(emit), part(emit, text("prt_t", long)), idle(emit))) });
    r.callRunning();
    const res = await r.run.inlineTask!(spec(), hooks());
    expect(res.text).toHaveLength(16_000);
    expect(res.text.endsWith("b".repeat(100))).toBe(true);
    expect(res.truncated).toBe(true);
  });
});
