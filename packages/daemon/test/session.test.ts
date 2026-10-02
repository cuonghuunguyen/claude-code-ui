import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Event } from "@claude-ui/protocol";
import { queuedQuery, Session, THROWAWAY_TIMEOUT_MS } from "../src/session.ts";
import { aborts, askInput, bashSuggestion, calls, checkpointFiles, closed, controlCalls, fakeCommands, fakeQuery, fakeUsage, usageCalls, firstTurnLastAssistant, history, inputs, interruptQuery, interrupts, permissionQuery, permissionResults, questionQuery, rewinds, setModelCalls } from "./fake-query.ts";

const until = (events: Event[], pred: (e: Event) => boolean) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => events.some(pred) && (clearInterval(t), resolve()), 5);
  });

/** A new session whose CLI runs: it starts on the first prompt. */
const started = (opts: ConstructorParameters<typeof Session>[1], cwd = "/tmp") => {
  const s = new Session(cwd, opts);
  s.prompt("hi");
  return s;
};

const lastPart = (events: Event[], id: string) => events.filter((e) => e.part.id === id).at(-1)!.part;

describe("Session", () => {
  it("close() resolves once the SDK message loop ended: the CLI writes the transcript until it exits", async () => {
    let exited = false;
    let exit!: () => void;
    const query = () =>
      Object.assign(
        (async function* () {
          await new Promise<void>((r) => (exit = r));
          exited = true;
        })(),
        { supportedCommands: async () => [], close: () => void setTimeout(() => exit(), 30) },
      );
    const s = started({ query: query as never }, "/repo");
    await s.close();
    expect(exited).toBe(true);
    // A new session that never got a prompt has no CLI to wait for.
    await new Session("/repo", { query: query as never }).close();
    // A restored session that never started a query has nothing to wait for.
    await Session.restore(randomUUID(), "/repo", history, { query: query as never }).close();
  });

  it("has a UUID before the first prompt and passes it to the SDK as sessionId", () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    s.prompt("hi");
    expect(calls.at(-1)).toMatchObject({ sessionId: s.id, cwd: "/tmp", includePartialMessages: true });
  });

  it("starts no CLI for a new session before its first prompt: a closed throwaway lists the commands, without hooks", async () => {
    const before = calls.length;
    const closedBefore = closed;
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await until(events, (e) => e.part.type === "commands");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.slice(before)).toEqual([expect.objectContaining({ cwd: "/tmp", persistSession: false, settings: { disableAllHooks: true } })]);
    expect(calls.at(-1)).not.toHaveProperty("sessionId");
    expect(closed).toBe(closedBefore + 1);
    s.prompt("hi");
    expect(calls.length).toBe(before + 2);
    expect(calls.at(-1)).toMatchObject({ sessionId: s.id });
  });

  it("logs user_text, running, streamed parts, turn_result, idle with increasing seq", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hello");
    await until(events, (e) => e.part.type === "session_state" && e.part.state === "idle");

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.sessionId === s.id)).toBe(true);
    // context_usage follows the turn asynchronously (its own describe below).
    const types = events.map((e) => e.part.type).filter((t) => t !== "context_usage");
    expect(types.slice(0, 2)).toEqual(["user_text", "session_state"]);
    expect(types.at(-2)).toBe("turn_result");
    expect(types.filter((t) => t === "assistant_text").length).toBeGreaterThan(10);
    expect(s.info().state).toBe("idle");
  });

  it("replays only events after sinceSeq to a late subscriber", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const all: Event[] = [];
    s.subscribe(0, (e) => all.push(e));
    s.prompt("hello");
    await until(all, (e) => e.part.type === "turn_result");
    const late: Event[] = [];
    s.subscribe(3, (e) => late.push(e));
    expect(late[0]!.seq).toBe(4);
    expect(late.length).toBe(all.length - 3);
  });

  it("strips API key env vars from the SDK env (ADR 0002)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "tok");
    started({ query: fakeQuery as never });
    vi.unstubAllEnvs();
    const env = calls.at(-1)!.env!;
    expect(env.PATH).toBe(process.env.PATH);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("forwards subagent text and enables TodoWrite unless the user env says otherwise", () => {
    vi.stubEnv("CLAUDE_CODE_ENABLE_TASKS", "1");
    started({ query: fakeQuery as never });
    vi.unstubAllEnvs();
    const opts = calls.at(-1)!;
    expect(opts.forwardSubagentText).toBe(true);
    expect(opts.env).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_ENABLE_TASKS: "1" });
  });

  it("rejects a prompt once the query failed, and logs the failure reason", async () => {
    const failing = () =>
      Object.assign((async function* () { throw new Error("login expired"); })(), {
        supportedCommands: () => Promise.reject(new Error("login expired")),
      });
    const s = new Session("/tmp", { query: failing as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hi");
    await until(events, (e) => e.part.type === "session_state" && e.part.state === "error");
    expect(events.some((e) => e.part.type === "raw" && JSON.stringify(e.part.message).includes("login expired"))).toBe(true);
    expect(() => s.prompt("hello")).toThrow(/not live/);
    expect(s.info().state).toBe("error");
  });

  it("rebuilds history from the transcript and resumes with the same ID on the first prompt", async () => {
    const id = "0b5f1d5e-8a8e-4c9b-9f5e-3c1f2a4b5c6d";
    const before = calls.length;
    const s = Session.restore(id, "/tmp", history, { query: fakeQuery as never });
    // No query until a prompt; the queued context usage query is dropped once the prompt starts the real one.
    expect(calls.slice(before)).toEqual([]);
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    const parts = events.map((e) => e.part);
    expect(parts.filter((p) => p.type === "user_text").map((p) => p.type === "user_text" && p.text)).toEqual(["first", "second"]);
    expect(parts.filter((p) => p.type === "assistant_text").length).toBe(2);
    expect(parts.at(-1)).toMatchObject({ type: "session_state", state: "idle" });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    s.prompt("third");
    expect(s.id).toBe(id);
    expect(calls.at(-1)).toMatchObject({ resume: id, cwd: "/tmp" });
    expect(calls.at(-1)).not.toHaveProperty("sessionId");
    await until(events, (e) => e.part.type === "turn_result");
    expect(calls.slice(before)).toHaveLength(1);
    // The resumed query's first total includes turns of the earlier daemon run: no per-turn cost for it.
    expect(events.find((e) => e.part.type === "turn_result")!.part).not.toHaveProperty("costUsd", expect.anything());
  });

  it("gives a turn_result the turn's cost, not the query's cumulative total", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("one");
    await until(events, (e) => e.part.type === "turn_result");
    s.prompt("two");
    await until(events, (e) => events.filter((e) => e.part.type === "turn_result").length === 2);
    const costs = events.flatMap((e) => (e.part.type === "turn_result" ? [e.part.costUsd] : []));
    expect(costs[0]).toBeCloseTo(0.121987);
    expect(costs[1]).toBeCloseTo(0.1482896 - 0.121987);
  });

  it("passes the chosen model to the SDK; 'default' means no model option", () => {
    const s = started({ model: "haiku", query: fakeQuery as never });
    expect(calls.at(-1)!.model).toBe("haiku");
    expect(s.info().model).toBe("haiku");
    const d = started({ model: "default", query: fakeQuery as never });
    expect(calls.at(-1)!.model).toBeUndefined();
    expect(d.info().model).toBe("default");
    expect(new Session("/tmp", { query: fakeQuery as never }).info().model).toBe("default");
  });

  it("setModel switches the live query and logs a session_model part", async () => {
    const s = started({ query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await s.setModel("haiku");
    expect(setModelCalls.at(-1)).toBe("haiku");
    expect(s.info().model).toBe("haiku");
    expect(lastPart(events, "session_model")).toEqual({ type: "session_model", id: "session_model", model: "haiku" });
  });

  it("setModel persists the new model even when the SDK refuses the fallback to default mode", async () => {
    const refuse = async (m: string) => {
      if (m === "default") throw new Error("control failed");
    };
    const failing = (a: Parameters<typeof fakeQuery>[0]) => Object.assign(fakeQuery(a), { setPermissionMode: refuse });
    const saved: unknown[] = [];
    const s = started({ query: failing as never, model: "sonnet", supportsAuto: (m: string) => m === "sonnet", onSettings: (x) => saved.push(x) });
    // The CLI's init message reports its mode; auto is set after it.
    await new Promise((r) => setTimeout(r, 10));
    await s.setPermissionMode("auto");
    await expect(s.setModel("haiku")).rejects.toThrow("control failed");
    expect(saved.at(-1)).toMatchObject({ model: "haiku" });
  });

  it("setModel on a restored session before its first prompt applies when the query resumes", async () => {
    const s = Session.restore(randomUUID(), "/tmp", [], { query: fakeQuery as never });
    const before = setModelCalls.length;
    await s.setModel("haiku");
    expect(setModelCalls.length).toBe(before);
    s.prompt("hi");
    expect(calls.at(-1)).toMatchObject({ resume: s.id, model: "haiku" });
  });

  it("starts in default permission mode and model default effort; bypass only when the daemon enables it", () => {
    const s = started({ query: fakeQuery as never });
    expect(calls.at(-1)).toMatchObject({ permissionMode: "default", allowDangerouslySkipPermissions: false, effort: undefined });
    expect(s.info()).toMatchObject({ permissionMode: "default", effort: "default", permissionModes: ["default", "acceptEdits", "plan", "dontAsk"] });
    started({ allowBypass: true, query: fakeQuery as never });
    expect(calls.at(-1)).toMatchObject({ allowDangerouslySkipPermissions: true });
  });

  it("setPermissionMode and setEffort change the live query and log parts", async () => {
    const s = started({ query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await s.setPermissionMode("plan");
    await s.setEffort("high");
    await s.setEffort("default");
    expect(controlCalls.slice(-3)).toEqual([{ setPermissionMode: "plan" }, { applyFlagSettings: { effortLevel: "high" } }, { applyFlagSettings: { effortLevel: null } }]);
    expect(lastPart(events, "session_permission_mode")).toEqual({ type: "session_permission_mode", id: "session_permission_mode", mode: "plan" });
    expect(lastPart(events, "session_effort")).toEqual({ type: "session_effort", id: "session_effort", effort: "default" });
    expect(s.info()).toMatchObject({ permissionMode: "plan", effort: "default" });
    await expect(s.setPermissionMode("bypassPermissions")).rejects.toThrow("not enabled");
  });

  it("a restored session not yet resumed starts with the chosen mode and effort", async () => {
    const s = Session.restore(randomUUID(), "/tmp", [], { query: fakeQuery as never });
    const before = controlCalls.length;
    await s.setPermissionMode("acceptEdits");
    await s.setEffort("low");
    expect(controlCalls.length).toBe(before);
    s.prompt("hi");
    expect(calls.at(-1)).toMatchObject({ resume: s.id, permissionMode: "acceptEdits", effort: "low" });
  });

  it("follows a permission mode change the CLI reports in system/status (plan approved)", async () => {
    const msgs = [{ type: "system", subtype: "status", status: null, permissionMode: "acceptEdits", uuid: randomUUID(), session_id: "x" }];
    const query = ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
      Object.assign(
        (async function* () {
          for await (const _ of prompt) yield* msgs;
        })(),
        { supportedCommands: async () => [], setPermissionMode: async () => {} },
      );
    const s = new Session("/tmp", { query: query as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await s.setPermissionMode("plan");
    s.prompt("go");
    await until(events, (e) => e.part.type === "session_permission_mode" && e.part.mode === "acceptEdits");
    expect(s.info().permissionMode).toBe("acceptEdits");
  });

  it("sends attached images as image content blocks and shows them in user_text", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    const png = "data:image/png;base64,iVBORw0KGgo=";
    s.prompt("what is this?", [png]);
    await until(events, (e) => e.part.type === "turn_result");
    expect(events[0]!.part).toMatchObject({ type: "user_text", text: "what is this?", images: [png] });
    expect(inputs.at(-1)!.message.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
  });

  it("loads user, project and local settings like Claude Code: commands, skills, saved permission rules", () => {
    started({ query: fakeQuery as never });
    expect(calls.at(-1)).toMatchObject({ settingSources: ["user", "project", "local"] });
  });

  it("logs the supportedCommands() list as a commands part before the first prompt", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await until(events, (e) => e.part.type === "commands");
    expect(events.find((e) => e.part.type === "commands")!.part).toEqual({ type: "commands", id: "commands", commands: fakeCommands });
  });

  describe("permission requests", () => {
    const ask = async () => {
      const s = new Session("/tmp", { query: permissionQuery as never });
      const events: Event[] = [];
      s.subscribe(0, (e) => events.push(e));
      s.prompt("run the tests");
      await until(events, (e) => e.part.type === "permission_request");
      const req = events.find((e) => e.part.type === "permission_request")!.part as Extract<Event["part"], { type: "permission_request" }>;
      const results = permissionResults.length;
      const answered = () => until(events, () => permissionResults.length > results).then(() => permissionResults.at(-1)!);
      return { s, events, req, answered };
    };

    it("logs a permission_request with the SDK suggestions and sets needs_input", async () => {
      const { s, events, req } = await ask();
      expect(req).toMatchObject({
        tool: "Bash",
        input: { command: "npm test" },
        suggestions: [bashSuggestion],
        title: "Claude wants to run npm test",
        settled: false,
      });
      expect(req.id).toBe(req.requestId);
      expect(events.at(-1)!.part).toMatchObject({ type: "session_state", state: "needs_input" });
      expect(s.info().state).toBe("needs_input");
    });

    it("Yes allows once without saving a rule", async () => {
      const { s, events, req, answered } = await ask();
      expect(s.respond(req.requestId, { decision: "allow" })).toBe(true);
      expect(await answered()).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
      expect(events.some((e) => e.part.type === "session_state" && e.part.state === "running" && e.seq > events.find((x) => x.part.id === req.id)!.seq)).toBe(true);
    });

    it("Yes with edited input sends it as updatedInput (full input object)", async () => {
      const { s, req, answered } = await ask();
      s.respond(req.requestId, { decision: "allow", updatedInput: { command: "npm test -- --run" } });
      expect(await answered()).toEqual({ behavior: "allow", updatedInput: { command: "npm test -- --run" } });
    });

    it("an edited accept shows the applied input, marked as the user's edit, on the tool call and the settled request", async () => {
      const { s, events, req } = await ask();
      const applied = { command: "npm test -- --run" };
      s.respond(req.requestId, { decision: "allow", updatedInput: applied });
      expect(lastPart(events, req.toolUseId)).toMatchObject({ type: "tool_call", input: applied, editedByUser: true });
      expect(lastPart(events, req.id)).toMatchObject({ settled: true, decision: "allow", input: applied, editedByUser: true });
      await until(events, (e) => e.part.type === "turn_result");
      // Later status updates keep the applied input.
      expect(lastPart(events, req.toolUseId)).toMatchObject({ input: applied, editedByUser: true });
    });

    it("don't ask again returns the chosen SDK suggestion as updatedPermissions", async () => {
      const { s, events, req, answered } = await ask();
      s.respond(req.requestId, { decision: "allow_always", ruleIndex: 0 });
      expect(await answered()).toEqual({ behavior: "allow", updatedInput: { command: "npm test" }, updatedPermissions: [bashSuggestion] });
      expect(lastPart(events, req.id)).toMatchObject({ settled: true, decision: "allow_always" });
    });

    it("No with text sends the text to Claude and marks the tool call denied", async () => {
      const { s, events, req, answered } = await ask();
      s.respond(req.requestId, { decision: "deny", message: "use pnpm instead" });
      expect(await answered()).toMatchObject({ behavior: "deny", message: expect.stringMatching(/the user said:\nuse pnpm instead$/) });
      expect(permissionResults.at(-1)).not.toHaveProperty("interrupt");
      expect(lastPart(events, req.id)).toMatchObject({ settled: true, decision: "deny", message: "use pnpm instead" });
      expect(lastPart(events, req.toolUseId)).toMatchObject({ type: "tool_call", status: "denied" });
    });

    it("No without text denies and interrupts the turn, like Claude Code", async () => {
      const { s, req, answered } = await ask();
      s.respond(req.requestId, { decision: "deny" });
      expect(await answered()).toMatchObject({ behavior: "deny", interrupt: true });
    });

    it("the first answer wins; later answers are ignored", async () => {
      const { s, events, req, answered } = await ask();
      expect(s.respond(req.requestId, { decision: "deny", message: "no" })).toBe(true);
      expect(s.respond(req.requestId, { decision: "allow" })).toBe(false);
      await answered();
      expect(events.filter((e) => e.part.id === req.id && e.part.type === "permission_request" && e.part.settled)).toHaveLength(1);
      expect(s.respond("unknown", { decision: "allow" })).toBe(false);
    });

    it("waits without timeout and replays the pending request to a late subscriber", async () => {
      const { s, req } = await ask();
      await new Promise((r) => setTimeout(r, 50));
      const late: Event[] = [];
      s.subscribe(0, (e) => late.push(e));
      expect(lastPart(late, req.id)).toMatchObject({ settled: false });
      expect(s.info().state).toBe("needs_input");
    });

    it("settles as cancelled when the SDK aborts the request", async () => {
      const { s, events, req, answered } = await ask();
      aborts.at(-1)!.abort();
      expect(await answered()).toMatchObject({ behavior: "deny" });
      expect(lastPart(events, req.id)).toMatchObject({ settled: true, decision: "cancelled" });
      expect(s.respond(req.requestId, { decision: "allow" })).toBe(false);
    });
  });
});

describe("Session questions", () => {
  const ask = async () => {
    const s = new Session("/tmp", { query: questionQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("set up the project");
    await until(events, (e) => e.part.type === "question");
    const q = events.find((e) => e.part.type === "question")!.part as Extract<Event["part"], { type: "question" }>;
    const results = permissionResults.length;
    const answered = () => until(events, () => permissionResults.length > results).then(() => permissionResults.at(-1)!);
    return { s, events, q, answered };
  };

  it("ExitPlanMode offers Claude Code's 'Yes, and auto-accept edits' as its suggestion", async () => {
    const plan = { plan: "1. edit a.txt" };
    const query = ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { canUseTool: Function } }) =>
      Object.assign(
        (async function* () {
          for await (const _ of prompt) {
            permissionResults.push(await options.canUseTool("ExitPlanMode", plan, { signal: new AbortController().signal, toolUseID: "t1", requestId: "r" }));
            yield* [];
          }
        })(),
        { supportedCommands: async () => [] },
      );
    const s = new Session("/tmp", { query: query as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("go");
    await until(events, (e) => e.part.type === "permission_request");
    const req = events.find((e) => e.part.type === "permission_request")!.part as Extract<Event["part"], { type: "permission_request" }>;
    expect(req).toMatchObject({ tool: "ExitPlanMode", input: plan, suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
    s.respond(req.requestId, { decision: "allow_always" });
    await vi.waitFor(() => expect(permissionResults.at(-1)).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }] }));
  });

  // Review round 2: the CLI restores the mode active before plan mode unless told otherwise, so each answer names its mode.
  describe.each([
    ["the mode menu", ["plan"], []],
    ["Shift+Tab (via acceptEdits)", ["acceptEdits", "plan"], []],
    ["the CLI (system/status)", [], [{ type: "system", subtype: "status", status: null, permissionMode: "plan", uuid: randomUUID(), session_id: "x" }]],
  ] as const)("ExitPlanMode after plan mode entered from %s", (_, modes, msgs) => {
    const planExit = async () => {
      const query = ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { canUseTool: Function } }) =>
        Object.assign(
          (async function* () {
            for await (const _ of prompt) {
              yield* msgs;
              permissionResults.push(await options.canUseTool("ExitPlanMode", { plan: "p" }, { signal: new AbortController().signal, toolUseID: "t1", requestId: "r" }));
            }
          })(),
          { supportedCommands: async () => [], setPermissionMode: async () => {} },
        );
      const s = new Session("/tmp", { query: query as never });
      const events: Event[] = [];
      s.subscribe(0, (e) => events.push(e));
      for (const m of modes) await s.setPermissionMode(m);
      s.prompt("go");
      await until(events, (e) => e.part.type === "permission_request");
      expect(s.info().permissionMode).toBe("plan");
      const req = events.find((e) => e.part.type === "permission_request")!.part as Extract<Event["part"], { type: "permission_request" }>;
      const results = permissionResults.length;
      return { s, req, result: () => vi.waitFor(() => (expect(permissionResults.length).toBeGreaterThan(results), permissionResults.at(-1)!)) };
    };
    const setMode = (mode: string) => ({ updatedPermissions: [{ type: "setMode", mode, destination: "session" }] });

    it("'Yes, manually approve edits' sets default", async () => {
      const { s, req, result } = await planExit();
      s.respond(req.requestId, { decision: "allow" });
      expect(await result()).toMatchObject({ behavior: "allow", ...setMode("default") });
    });
    it("'Yes, and auto-accept edits' sets acceptEdits", async () => {
      const { s, req, result } = await planExit();
      s.respond(req.requestId, { decision: "allow_always" });
      expect(await result()).toMatchObject({ behavior: "allow", ...setMode("acceptEdits") });
    });
    it("'No, keep planning' (with or without feedback) changes no mode", async () => {
      for (const message of [undefined, "smaller steps"]) {
        const { s, req, result } = await planExit();
        s.respond(req.requestId, { decision: "deny", message });
        const r = await result();
        expect(r).toMatchObject({ behavior: "deny" });
        expect(r).not.toHaveProperty("updatedPermissions");
      }
    });
  });

  it("AskUserQuestion through canUseTool logs a question part and sets needs_input", async () => {
    const { s, events, q } = await ask();
    expect(q).toMatchObject({ requestId: q.id, questions: askInput.questions, settled: false });
    expect(q.toolUseId).toBe((events.find((e) => e.part.type === "tool_call")!.part as { toolUseId: string }).toolUseId);
    expect(events.some((e) => e.part.type === "permission_request")).toBe(false);
    expect(s.info().state).toBe("needs_input");
  });

  it("answer() returns the questions and answers via updatedInput and logs the settlement once", async () => {
    const { s, events, q, answered } = await ask();
    const answers = { "Which package manager?": "pnpm" };
    expect(s.answer(q.requestId, answers)).toBe(true);
    expect(s.answer(q.requestId, { "Which package manager?": "npm" })).toBe(false);
    expect(await answered()).toEqual({ behavior: "allow", updatedInput: { ...askInput, answers } });
    expect(lastPart(events, q.id)).toMatchObject({ settled: true, answers });
    expect(events.filter((e) => e.part.id === q.id)).toHaveLength(2);
    expect(s.info().state).not.toBe("needs_input");
  });

  it("a question is not answered by respond() and a permission request not by answer()", async () => {
    const { s, q } = await ask();
    expect(s.respond(q.requestId, { decision: "allow" })).toBe(false);
    expect(s.answer("unknown", {})).toBe(false);
    expect(s.info().state).toBe("needs_input");
  });

  it("settles without answers when the SDK aborts the question", async () => {
    const { s, events, q, answered } = await ask();
    aborts.at(-1)!.abort();
    expect(await answered()).toMatchObject({ behavior: "deny" });
    expect(lastPart(events, q.id)).toEqual({ ...q, settled: true });
    expect(s.answer(q.requestId, {})).toBe(false);
  });
});

describe("Session steering and interrupt", () => {
  const running = async (text = "run it") => {
    const s = new Session("/tmp", { query: interruptQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt(text);
    await until(events, (e) => e.part.type === "tool_call");
    return { s, events };
  };
  const idle = (events: Event[], after: number) => until(events, (e) => e.seq > after && e.part.type === "session_state" && e.part.state === "idle");

  it("a prompt while running is logged and pushed into the live query at once (steering)", async () => {
    const { s, events } = await running();
    const before = inputs.length;
    s.prompt("also say BANANA");
    expect(events.at(-2)!.part).toMatchObject({ type: "user_text", text: "also say BANANA" });
    await until(events, () => inputs.length > before);
    expect(inputs.at(-1)).toMatchObject({ uuid: events.at(-2)!.part.id, message: { content: "also say BANANA" } });
    expect(s.info().state).toBe("running");
  });

  it("interrupt() calls the SDK interrupt, logs turn_interrupted and returns to idle", async () => {
    const { s, events } = await running();
    const n = interrupts.length;
    const seq = events.length;
    await s.interrupt();
    await idle(events, seq);
    expect(interrupts.length).toBe(n + 1);
    const after = events.filter((e) => e.seq > seq).map((e) => e.part.type);
    expect(after).toContain("turn_interrupted");
    expect(after).not.toContain("turn_result");
    expect(s.info().state).toBe("idle");
    expect(s.isLive()).toBe(true);
  });

  it("interrupt() denies a pending permission request and marks its tool call denied", async () => {
    const { s, events } = await running("ask first");
    await until(events, (e) => e.part.type === "permission_request");
    const req = events.find((e) => e.part.type === "permission_request")!.part as Extract<Event["part"], { type: "permission_request" }>;
    const seq = events.length;
    await s.interrupt();
    await idle(events, seq);
    expect(lastPart(events, req.id)).toMatchObject({ settled: true, decision: "deny" });
    expect(lastPart(events, req.toolUseId)).toMatchObject({ status: "denied" });
    expect(permissionResults.at(-1)).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("interrupt() cancels a pending question: settled without answers", async () => {
    const { s, events } = await running("question first");
    await until(events, (e) => e.part.type === "question");
    const q = events.find((e) => e.part.type === "question")!.part as Extract<Event["part"], { type: "question" }>;
    const seq = events.length;
    await s.interrupt();
    await idle(events, seq);
    expect(lastPart(events, q.id)).toEqual({ ...q, settled: true });
    expect(permissionResults.at(-1)).toMatchObject({ behavior: "deny" });
    expect(s.answer(q.requestId, {})).toBe(false);
  });

  it("after an interrupt the same session runs the next prompt", async () => {
    const { s, events } = await running();
    await s.interrupt();
    await idle(events, 0);
    const seq = events.length;
    s.prompt("hi");
    await idle(events, seq);
    expect(events.filter((e) => e.seq > seq).map((e) => e.part.type)).toContain("turn_result");
    expect(calls.filter((c) => c.sessionId === s.id)).toHaveLength(1);
  });

  it("the CLI's replayed model switch echo after a turn is no prompt: the session stays idle", async () => {
    const s = new Session("/tmp", { query: interruptQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hi");
    await idle(events, 0);
    await s.setModel("haiku");
    await new Promise((r) => setTimeout(r, 20));
    expect(s.info().state).toBe("idle");
    expect(events.filter((e) => e.part.type === "user_text")).toHaveLength(1);
  });

  it("interrupt() while idle does nothing", async () => {
    const s = new Session("/tmp", { query: interruptQuery as never });
    const n = interrupts.length;
    await s.interrupt();
    expect(interrupts.length).toBe(n);
  });

  it("a steering message the CLI takes only after the turn ended runs its own turn: running again", async () => {
    const { s, events } = await running();
    s.prompt("late");
    await s.interrupt();
    // The replay echo tells when the CLI took the message; the interrupted turn's result set idle before it.
    await until(events, (e) => e.part.type === "tool_call" && events.filter((x) => x.part.type === "tool_call").length === 2);
    const states = events.filter((e) => e.part.type === "session_state").map((e) => (e.part as { state: string }).state);
    expect(states.slice(-2)).toEqual(["idle", "running"]);
    expect(s.info().state).toBe("running");
  });
});

describe("Session rewind", () => {
  const id = "0b5f1d5e-8a8e-4c9b-9f5e-3c1f2a4b5c6d";
  const restored = () => {
    const s = Session.restore(id, "/tmp", history, { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    return { s, events };
  };

  it("runs the SDK with file checkpointing and replayed user message UUIDs", () => {
    started({ query: fakeQuery as never });
    expect(calls.at(-1)).toMatchObject({ enableFileCheckpointing: true, extraArgs: { "replay-user-messages": null } });
  });

  it("previews a code rewind with a dry run and says whether the conversation can rewind", async () => {
    const { s } = restored();
    rewinds.length = 0;
    expect(await s.previewRewind("u2")).toEqual({ filesChanged: ["/repo/a.ts"], insertions: 1, deletions: 1, conversation: true });
    expect(rewinds).toEqual([{ id: "u2", dryRun: true }]);
    expect(calls.at(-1)).toMatchObject({ resume: id, enableFileCheckpointing: true });
    // First prompt: nothing before it to resume at.
    expect((await s.previewRewind("u1")).conversation).toBe(false);
  });

  it("reports no files when the SDK has no checkpoint for the message", async () => {
    const { s } = restored();
    checkpointFiles.files = [];
    expect((await s.previewRewind("u2")).filesChanged).toEqual([]);
    checkpointFiles.files = ["/repo/a.ts"];
  });

  it("code mode calls rewindFiles and keeps the conversation", async () => {
    const { s, events } = restored();
    rewinds.length = 0;
    await s.rewind("u2", "code");
    expect(rewinds).toEqual([{ id: "u2" }]);
    expect(events.some((e) => e.part.type === "rewind")).toBe(false);
  });

  it("conversation mode logs a rewind part and resumes at the last assistant message before the prompt", async () => {
    const { s, events } = restored();
    rewinds.length = 0;
    await s.rewind("u2", "conversation");
    expect(rewinds).toEqual([]);
    expect(events.find((e) => e.part.type === "rewind")!.part).toMatchObject({ type: "rewind", userMessageId: "u2" });
    s.prompt("second, reworded");
    expect(calls.at(-1)).toMatchObject({ resume: id, resumeSessionAt: firstTurnLastAssistant });
    await until(events, (e) => e.part.type === "turn_result");
    expect(s.info().state).toBe("idle");
    // The rewound prompt is gone; a later prompt no longer truncates.
    await expect(s.rewind("u2", "conversation")).rejects.toThrow(/unknown user message/);
  });

  it("both mode restores code, then conversation, on a live session and closes the old query", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("first");
    await until(events, (e) => e.part.type === "turn_result");
    s.prompt("second");
    const second = events.filter((e) => e.part.type === "user_text").at(-1)!.part.id;
    await until(events, (e) => e.part.type === "turn_result" && events.filter((x) => x.part.type === "turn_result").length === 2);
    await until(events, () => s.info().state === "idle");
    rewinds.length = 0;
    const closedBefore = closed;
    await s.rewind(second, "both");
    expect(rewinds).toEqual([{ id: second }]);
    expect(closed).toBe(closedBefore + 1);
    expect(events.find((e) => e.part.type === "rewind")!.part).toMatchObject({ type: "rewind", userMessageId: second });
    expect(s.info().state).toBe("idle");
    s.prompt("again");
    expect(calls.at(-1)).toMatchObject({ resume: s.id, resumeSessionAt: firstTurnLastAssistant });
  });

  it("rejects a conversation rewind to the first prompt, before touching files", async () => {
    const { s } = restored();
    rewinds.length = 0;
    await expect(s.rewind("u1", "both")).rejects.toThrow(/first prompt/);
    expect(rewinds).toEqual([]);
  });

  it("rejects a prompt or a second rewind while a rewind awaits rewindFiles()", async () => {
    let release!: () => void;
    const slowRewind = (a: never) =>
      Object.assign(fakeQuery(a), {
        rewindFiles: () => new Promise((r) => (release = () => r({ canRewind: true, filesChanged: [] }))),
      });
    const s = Session.restore(id, "/tmp", history, { query: slowRewind as never });
    const p = s.rewind("u2", "both");
    expect(() => s.prompt("from another tab")).toThrow(/rewinding/);
    await expect(s.rewind("u2", "code")).rejects.toThrow(/rewinding/);
    release();
    await p;
    expect(s.info().state).toBe("idle");
    s.prompt("after the rewind");
    expect(s.info().state).toBe("running");
  });

  it("rejects a rewind while a turn runs", async () => {
    const { s } = restored();
    s.prompt("third");
    await expect(s.rewind("u2", "code")).rejects.toThrow(/running/);
  });

  it("rejects a rewind and its preview while a turn waits for a permission answer", async () => {
    const s = new Session("/tmp", { query: interruptQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("ask first");
    await until(events, (e) => e.part.type === "permission_request");
    expect(s.info().state).toBe("needs_input");
    const prompt = events.find((e) => e.part.type === "user_text")!.part.id;
    await expect(s.rewind(prompt, "code")).rejects.toThrow(/running/);
    await expect(s.previewRewind(prompt)).rejects.toThrow(/running/);
  });
});

describe("Session context usage", () => {
  const usagePart = { type: "context_usage", id: "context_usage", usage: { totalTokens: 25815, maxTokens: 1000000, percentage: 3, categories: [
    { name: "System tools", tokens: 5161, kind: "used" },
    { name: "Messages", tokens: 20654, kind: "used" },
    { name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
    { name: "Free space", tokens: 941185, kind: "free" },
  ] } };

  it("logs a context_usage part after each turn, from the live query, without deferred categories", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    usageCalls.length = 0;
    s.prompt("hello");
    await until(events, (e) => e.part.type === "context_usage");
    expect(lastPart(events, "context_usage")).toEqual(usagePart);
    // Summary detail: from the last response's usage, no token-count requests per turn.
    expect(usageCalls).toEqual([{ options: expect.objectContaining({ sessionId: s.id }), opts: { detail: "summary" } }]);
    s.prompt("again");
    await until(events, (e) => events.filter((x) => x.part.type === "context_usage").length === 2);
  });

  it("reports the turn's rate_limit_event and refreshes plan usage on the session's query after each turn", async () => {
    const plan = { refresh: vi.fn(async (_q: unknown) => {}), rateLimit: vi.fn(async (_info: unknown, _q: unknown) => {}) };
    const s = new Session("/tmp", { query: fakeQuery as never, plan: plan as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hello");
    await until(events, (e) => e.part.type === "turn_result");
    expect(plan.rateLimit).toHaveBeenCalledWith(expect.objectContaining({ status: "allowed", rateLimitType: "five_hour" }), expect.objectContaining({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: expect.any(Function) }));
    expect(plan.refresh).toHaveBeenCalledTimes(1);
    expect(plan.refresh.mock.calls[0]![0]).toBe(plan.rateLimit.mock.calls[0]![1]);
  });

  it("refreshes after a compaction boundary, before the turn ends", async () => {
    let release!: () => void;
    const compacting = ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: object }) =>
      Object.assign(
        (async function* () {
          for await (const _ of prompt) {
            yield { type: "system", subtype: "compact_boundary", uuid: randomUUID(), session_id: "x", compact_metadata: { trigger: "auto", pre_tokens: 1 } };
            await new Promise<void>((r) => (release = r));
          }
        })(),
        { supportedCommands: async () => [], getContextUsage: async () => (usageCalls.push({ options }), fakeUsage) },
      );
    const s = new Session("/tmp", { query: compacting as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("long task");
    await until(events, (e) => e.part.type === "context_usage");
    expect(s.info().state).toBe("running");
    release();
  });

  it("a restored session gets its usage before the first prompt from a closed throwaway query on its model that does not write the transcript", async () => {
    const id = randomUUID();
    const closedBefore = closed;
    const s = Session.restore(id, "/tmp", history, { model: "haiku", query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await until(events, (e) => e.part.type === "context_usage");
    expect(lastPart(events, "context_usage")).toEqual(usagePart);
    expect(usageCalls.at(-1)!.options).toMatchObject({ resume: id, cwd: "/tmp", model: "haiku", persistSession: false, settings: { disableAllHooks: true } });
    expect(usageCalls.at(-1)!.options).not.toHaveProperty("canUseTool");
    await vi.waitFor(() => expect(closed).toBe(closedBefore + 1));
  });

  it("restored sessions subscribed at once run their throwaway usage queries one at a time, each closed (FIX-LEAK)", async () => {
    let alive = 0;
    let maxAlive = 0;
    let spawned = 0;
    let closes = 0;
    const slow = ({ prompt }: { prompt: AsyncIterable<unknown> }) => (
      spawned++,
      (maxAlive = Math.max(maxAlive, ++alive)),
      Object.assign((async function* () { for await (const _ of prompt); })(), {
        getContextUsage: () => new Promise((r) => setTimeout(() => r(fakeUsage), 5)),
        close: () => (alive--, closes++),
      })
    );
    const all = Array.from({ length: 5 }, () => Session.restore(randomUUID(), "/tmp", history, { query: slow as never }));
    const got = all.map(() => [] as Event[]);
    all.forEach((s, i) => s.subscribe(0, (e) => got[i]!.push(e)));
    await vi.waitFor(() => expect(got.every((ev) => ev.some((e) => e.part.type === "context_usage"))).toBe(true));
    expect(maxAlive).toBe(1);
    expect(closes).toBe(5);
  });

  it("the plan usage throwaway waits in the same queue as the context usage ones (one CLI at a time)", async () => {
    let alive = 0;
    let maxAlive = 0;
    const slow = ({ prompt }: { prompt: AsyncIterable<unknown> }) => (
      (maxAlive = Math.max(maxAlive, ++alive)),
      Object.assign((async function* () { for await (const _ of prompt); })(), {
        getContextUsage: () => new Promise((r) => setTimeout(() => r(fakeUsage), 5)),
        close: () => void alive--,
      })
    );
    const events: Event[] = [];
    Session.restore(randomUUID(), "/tmp", history, { query: slow as never }).subscribe(0, (e) => events.push(e));
    expect(await queuedQuery(async () => "plan", slow as never)).toBe("plan");
    await until(events, (e) => e.part.type === "context_usage");
    expect(maxAlive).toBe(1);
  });

  it("a queued throwaway usage query is dropped when the session got a real query meanwhile", async () => {
    let spawnedThrowaway = 0;
    let release!: () => void;
    const blocker = ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
      Object.assign((async function* () { for await (const _ of prompt); })(), {
        getContextUsage: () => new Promise((r) => (release = () => r(fakeUsage))),
        close: () => {},
      });
    Session.restore(randomUUID(), "/tmp", history, { query: blocker as never });
    const counting = (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
      if (!args.options?.canUseTool) spawnedThrowaway++;
      return fakeQuery(args);
    };
    const s = Session.restore(randomUUID(), "/tmp", history, { query: counting as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hello");
    await until(events, (e) => e.part.type === "context_usage");
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnedThrowaway).toBe(0);
  });

  it("a conversation rewind refreshes the usage from a throwaway resumed at the fork point", async () => {
    const id = randomUUID();
    const s = Session.restore(id, "/tmp", history, { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await until(events, (e) => e.part.type === "context_usage");
    await s.rewind("u2", "conversation");
    const rewound = events.find((e) => e.part.type === "rewind")!.seq;
    await until(events, (e) => e.part.type === "context_usage" && e.seq > rewound);
    expect(usageCalls.at(-1)!.options).toMatchObject({ resume: id, resumeSessionAt: firstTurnLastAssistant, persistSession: false });
  });

  it("a throwaway CLI that does not answer within the timeout is closed, the failure logged, and the queue moves on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let closes = 0;
    const hung = ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
      Object.assign((async function* () { for await (const _ of prompt); })(), { getContextUsage: () => new Promise(() => {}), close: () => void closes++ });
    try {
      Session.restore(randomUUID(), "/tmp", history, { query: hung as never });
      const next = queuedQuery(async () => "next", fakeQuery as never);
      await vi.advanceTimersByTimeAsync(THROWAWAY_TIMEOUT_MS);
      expect(closes).toBe(1);
      expect(err).toHaveBeenCalledWith(expect.stringContaining("context usage failed"), expect.objectContaining({ message: expect.stringContaining("no answer") }));
      expect(await next).toBe("next");
    } finally {
      vi.useRealTimers();
      err.mockRestore();
    }
  });

  it("refreshes after a model switch: the window size can differ", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await s.setModel("haiku");
    await until(events, (e) => e.part.type === "context_usage");
  });

  it("a usage failure is logged, not fatal", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
      Object.assign((async function* () { for await (const _ of prompt); })(), {
        supportedCommands: async () => [],
        getContextUsage: () => Promise.reject(new Error("no usage")),
        close: () => {},
      });
    const s = Session.restore(randomUUID(), "/tmp", [], { query: failing as never });
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith(expect.stringContaining("context usage"), expect.any(Error)));
    expect(s.info().state).toBe("idle");
    err.mockRestore();
  });
});
