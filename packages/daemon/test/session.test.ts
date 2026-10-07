import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Event } from "@claude-ui/protocol";
import { CLI_TURN_WAIT_MS, EXTERNAL_TURN_QUIET_MS, queuedQuery, Session, THROWAWAY_TIMEOUT_MS } from "../src/session.ts";
import { createUpdater, RESTART_CODE } from "../src/update.ts";
import { aborts, askInput, bashSuggestion, calls, checkpointFiles, clearQuery, closed, controlCalls, fakeCommands, fakeQuery, fakeUsage, usageCalls, firstTurnLastAssistant, history, inputs, interruptQuery, interrupts, permissionQuery, permissionResults, questionQuery, rewinds, setModelCalls, stopped } from "./fake-query.ts";

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
    expect(late[0]!.seq).toBeGreaterThan(3);
    expect(late.every((e, i) => i === 0 || e.seq > late[i - 1]!.seq)).toBe(true);
    expect(late.at(-1)).toBe(all.at(-1));
    expect(late.every((e) => all.includes(e))).toBe(true);
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

  it("forwards subagent text and enables TodoWrite and Artifact unless the user env says otherwise", () => {
    vi.stubEnv("CLAUDE_CODE_ENABLE_TASKS", "1");
    started({ query: fakeQuery as never });
    vi.unstubAllEnvs();
    const opts = calls.at(-1)!;
    expect(opts.forwardSubagentText).toBe(true);
    expect(opts.env).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_ENABLE_TASKS: "1", CLAUDE_CODE_ARTIFACT: "1" });
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

  it("a restored session pages like the live one: restore from the recorded fixture, page through, nothing duplicated or missing at boundaries", () => {
    const many = Array.from({ length: 15 }, () => history).flat().map((m, i) => ({ ...(m as object), uuid: `m${i}-${(m as { uuid?: string }).uuid ?? ""}` }));
    const s = Session.restore(randomUUID(), "/tmp", many as never, { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    const ids: string[] = [];
    for (const { part } of events) if (!["session_state", "commands", "context_usage", "todo_update", "external_turn"].includes(part.type) && !ids.includes(part.id)) ids.push(part.id);
    const { snapshot } = s.snapshot();
    let pages = [snapshot.page.parts.map((p) => p.id)];
    for (let older = snapshot.page.older; older; ) {
      const page = s.page(older.before)!;
      pages = [page.parts.map((p) => p.id), ...pages];
      older = page.older;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(ids);
  });

  it("emit sets pos on an update of an existing part", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hi");
    await until(events, (e) => e.part.type === "turn_result");
    const user = events.find((e) => e.part.type === "user_text")!;
    expect(user).not.toHaveProperty("pos");
    const updates = events.filter((e) => e.pos !== undefined);
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u.pos).toBe(events.find((e) => e.part.id === u.part.id)!.seq);
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

  it("releaseQuery drops an idle live query; the next prompt resumes it with the session's model, mode and effort", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hi");
    await until(events, (e) => e.part.type === "turn_result");
    await s.setModel("sonnet");
    await s.setPermissionMode("acceptEdits");
    const before = closed;
    expect(s.releaseQuery()).toBe(true);
    expect(closed).toBe(before + 1);
    expect(s.liveQuery()).toBeUndefined();
    expect(s.info().state).toBe("idle");
    s.prompt("again");
    expect(calls.at(-1)).toMatchObject({ resume: s.id, model: "sonnet", permissionMode: "acceptEdits" });
  });

  it("releaseQuery without a live query is false", () => {
    expect(new Session("/tmp", { query: fakeQuery as never }).releaseQuery()).toBe(false);
    expect(Session.restore(randomUUID(), "/tmp", history, { query: fakeQuery as never }).releaseQuery()).toBe(false);
  });

  it("releaseQuery refuses while a turn runs or input is pending", async () => {
    const s = new Session("/tmp", { query: permissionQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("run");
    await until(events, (e) => e.part.type === "permission_request");
    const before = closed;
    expect(s.releaseQuery()).toBe(false);
    expect(closed).toBe(before);
  });

  it("session-scoped grants are re-applied when the query resumes; saved rules are not", async () => {
    const s = new Session("/tmp", { query: permissionQuery as never, uploadDir: "/tmp/up" });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    const suggestions = [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls (a):*" }, { toolName: "Read" }], behavior: "allow", destination: "session" },
      { type: "addDirectories", directories: ["/tmp/x"], destination: "session" },
      bashSuggestion,
    ];
    s.prompt(JSON.stringify({ suggestions }));
    await until(events, (e) => e.part.type === "permission_request");
    const req = events.find((e) => e.part.type === "permission_request")!.part as Extract<Event["part"], { type: "permission_request" }>;
    s.respond(req.requestId, { decision: "allow_always" });
    await until(events, (e) => e.part.type === "turn_result");
    expect(s.releaseQuery()).toBe(true);
    s.prompt("again");
    expect(calls.at(-1)).toMatchObject({ allowedTools: ["Bash(ls \\(a\\):*)", "Read"], additionalDirectories: ["/tmp/up", "/tmp/x"] });
  });

  it("a query without session grants starts without allowedTools", () => {
    new Session("/tmp", { query: fakeQuery as never }).prompt("hi");
    expect(calls.at(-1)).not.toHaveProperty("allowedTools");
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

describe("coordinator settle", () => {
  const cwd = mkdtempSync(join(tmpdir(), "coord-settle-"));
  /** A pending request for `tool` with `input` (JSON prompt of permissionQuery) and its canUseTool options. */
  const ask = async (tool: string, input: object, extra: object = {}) => {
    const s = new Session(cwd, { query: permissionQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt(JSON.stringify({ tool, input, ...extra }));
    await until(events, (e) => e.part.type === "permission_request");
    const req = events.find((e) => e.part.type === "permission_request")!.part as Extract<Event["part"], { type: "permission_request" }>;
    const results = permissionResults.length;
    const answered = () => until(events, () => permissionResults.length > results).then(() => permissionResults.at(-1)!);
    return { s, events, req, answered };
  };
  const edit = { file_path: "src/a.ts", old_string: "a", new_string: "b" };

  it("a coordinator allow on a low request settles once with by, its reason and the original input, without updatedPermissions", async () => {
    const { s, events, req, answered } = await ask("Edit", edit);
    expect(req.suggestions).toEqual([bashSuggestion]);
    expect(s.permissionTier(req.requestId)).toBe("low");
    expect(s.respond(req.requestId, { decision: "allow", message: "r" }, "coordinator")).toBe(true);
    const r = await answered();
    expect(r).toEqual({ behavior: "allow", updatedInput: edit });
    expect(r).not.toHaveProperty("updatedPermissions");
    expect(lastPart(events, req.id)).toMatchObject({ settled: true, decision: "allow", by: "coordinator", message: "r" });
    expect(lastPart(events, req.toolUseId)).toMatchObject({ type: "tool_call", coordinator: { decision: "allow", reason: "r" } });
    expect(s.respond(req.requestId, { decision: "deny" })).toBe(false);
  });

  it("a coordinator deny sends its reason in coordinator wording, does not interrupt, and marks the tool card", async () => {
    const { s, events, req, answered } = await ask("Edit", edit);
    expect(s.respond(req.requestId, { decision: "deny", message: "  wrong file  " }, "coordinator")).toBe(true);
    const r = await answered();
    expect(r).toEqual({ behavior: "deny", message: "The coordinator session denied this tool use; it was not run. Its reason:\nwrong file" });
    expect(lastPart(events, req.id)).toMatchObject({ settled: true, decision: "deny", by: "coordinator", message: "wrong file" });
    expect(lastPart(events, req.toolUseId)).toMatchObject({ type: "tool_call", status: "denied", coordinator: { decision: "deny", reason: "wrong file" } });
  });

  it("a coordinator cannot settle a high, flagged, escalated, allow_always, edited, ruled or reasonless request; it stays pending", async () => {
    const tries: [string, object, object, object][] = [
      ["Bash", { command: "npm test" }, {}, { decision: "allow", message: "r" }],
      ["Edit", { file_path: "../x" }, {}, { decision: "allow", message: "r" }],
      ["Edit", edit, { blockedPath: join(cwd, "src/a.ts") }, { decision: "allow", message: "r" }],
      ["Edit", edit, { defaultToNo: true }, { decision: "deny", message: "r" }],
      ["Edit", edit, { requiresUserInteraction: true }, { decision: "allow", message: "r" }],
      ["Edit", edit, {}, { decision: "allow_always", message: "r" }],
      ["Edit", edit, {}, { decision: "allow", message: "r", updatedInput: { file_path: "src/b.ts" } }],
      ["Edit", edit, {}, { decision: "allow", message: "r", ruleIndex: 0 }],
      ["Edit", edit, {}, { decision: "allow", message: "  " }],
      ["Edit", edit, {}, { decision: "deny" }],
    ];
    for (const [tool, input, extra, answer] of tries) {
      const { s, req, answered } = await ask(tool, input, extra);
      expect(s.respond(req.requestId, answer as never, "coordinator")).toBe(false);
      expect(s.info().state).toBe("needs_input");
      expect(s.respond(req.requestId, { decision: "allow" })).toBe(true);
      expect(await answered()).toMatchObject({ behavior: "allow" });
    }
    const { s, req } = await ask("Edit", edit);
    s.escalate(req.requestId, "blocking");
    expect(s.respond(req.requestId, { decision: "allow", message: "r" }, "coordinator")).toBe(false);
    expect(s.respond(req.requestId, { decision: "deny", message: "no" })).toBe(true);
  });
});

describe("Session /clear", () => {
  it("hands the live query to a new session under the CLI's next session ID; the old one keeps its history and resumes its own transcript", async () => {
    const heirs: Session[] = [];
    const s = new Session("/repo", { query: clearQuery as never, onCleared: (h) => heirs.push(h) });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hi");
    await until(events, (e) => e.part.type === "turn_result");
    const queries = calls.length;
    s.prompt("/clear");
    await until(events, (e) => e.part.type === "session_cleared");
    const heir = heirs[0]!;
    const clear = events.find((e) => e.part.type === "user_text" && e.part.text === "/clear")!.part.id;
    // The CLI's new transcript is named by the session_id of its messages after the reset, not by new_conversation_id.
    expect(heir.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(heir.id).not.toBe(s.id);
    expect(events.find((e) => e.part.type === "session_cleared")!.part).toEqual({ type: "session_cleared", id: expect.any(String), sessionId: heir.id });
    // The old transcript does not record the /clear: dropped from the old timeline too.
    expect(events.some((e) => e.part.type === "rewind" && e.part.userMessageId === clear)).toBe(true);
    expect(s.info().state).toBe("idle");
    expect(events.some((e) => e.part.type === "raw")).toBe(false);

    const next: Event[] = [];
    heir.subscribe(0, (e) => next.push(e));
    await until(next, (e) => e.part.type === "session_state" && e.part.state === "idle");
    // An empty timeline: no /clear prompt, no footer for its empty result; the command list for the / menu; the context of the new conversation.
    expect(next.filter((e) => ["user_text", "turn_result", "raw"].includes(e.part.type))).toEqual([]);
    expect(next.some((e) => e.part.type === "commands")).toBe(true);
    await until(next, (e) => e.part.type === "context_usage");

    // The next prompt runs in the same CLI, now in the new conversation.
    heir.prompt("after");
    await until(next, (e) => e.part.type === "turn_result");
    expect(calls.length).toBe(queries);
    expect(next.find((e) => e.part.type === "user_text")!.part).toMatchObject({ text: "after" });
    expect(heir.info()).toMatchObject({ id: heir.id, state: "idle" });

    // Closing the old session does not end the new one's CLI; its next prompt resumes the old transcript in a CLI of its own.
    await s.close();
    s.prompt("old again");
    expect(calls.at(-1)).toMatchObject({ resume: s.id });
    expect(calls.length).toBe(queries + 1);
    const later = next.length;
    heir.prompt("still live");
    await until(next, (e) => e.seq > later && e.part.type === "turn_result");
  });

  it("a background call running at /clear moves to the new session: stopped in the old one, Stop agent works in the new one", async () => {
    const heirs: Session[] = [];
    const s = new Session("/repo", { query: clearQuery as never, onCleared: (h) => heirs.push(h) });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("bg");
    await until(events, (e) => e.part.type === "session_state" && e.part.state === "idle");
    expect(lastPart(events, "bg")).toMatchObject({ status: "running" });
    s.prompt("/clear");
    await until(events, (e) => e.part.type === "session_cleared");
    const heir = heirs[0]!;
    // The old session no longer runs it, as after a restore of its transcript.
    expect(lastPart(events, "bg")).toMatchObject({ status: "stopped" });
    expect(await s.stopSubagent("bg")).toBe(false);
    expect(stopped).not.toContain("bg-task");

    // The new session owns it: its shells list shows it, Stop agent stops it, its notification ends the call there.
    const next: Event[] = [];
    heir.subscribe(0, (e) => next.push(e));
    expect(lastPart(next, "bg")).toMatchObject({ type: "tool_call", status: "running" });
    expect(await heir.stopSubagent("bg")).toBe(true);
    expect(stopped.at(-1)).toBe("bg-task");
    await until(next, (e) => e.part.id === "bg" && "status" in e.part && e.part.status === "stopped");
    await until(next, (e) => e.part.type === "session_state" && e.part.state === "idle" && e.seq > 1);
    expect(events.filter((e) => e.part.id === "bg").at(-1)!.part).toMatchObject({ status: "stopped" });
  });

  it("permission requests of the handed-over query go to the new session", async () => {
    const heirs: Session[] = [];
    const s = new Session("/repo", { query: clearQuery as never, onCleared: (h) => heirs.push(h) });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("/clear");
    await until(events, (e) => e.part.type === "session_cleared");
    const next: Event[] = [];
    heirs[0]!.subscribe(0, (e) => next.push(e));
    await until(next, (e) => e.part.type === "session_state" && e.part.state === "idle");
    heirs[0]!.prompt("ask");
    await until(next, (e) => e.part.type === "permission_request");
    expect(heirs[0]!.info().state).toBe("needs_input");
    expect(events.some((e) => e.part.type === "permission_request")).toBe(false);
    heirs[0]!.respond(lastPart(next, next.find((e) => e.part.type === "permission_request")!.part.id).id, { decision: "allow" });
    await until(next, (e) => e.part.type === "turn_result");
  });

  it("the new session saves the old one's model, mode and effort under its own ID", async () => {
    const saved: [string, object][] = [];
    const heirs: Session[] = [];
    const opts = { query: clearQuery as never, model: "haiku", effort: "high" as const, onCleared: (h: Session) => heirs.push(h), onSettings: (st: object, id: string) => void saved.push([id, st]) };
    const s = new Session("/repo", opts);
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("/clear");
    await until(events, (e) => e.part.type === "session_cleared");
    expect(heirs[0]!.info()).toMatchObject({ model: "haiku", effort: "high", permissionMode: "default" });
    expect(saved.at(-1)).toEqual([heirs[0]!.id, { model: "haiku", effort: "high", permissionMode: "default" }]);
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

  it("escalate() marks a pending question once; a coordinator's answer is then refused, the user's settles it without by", async () => {
    const { s, events, q } = await ask();
    expect(s.escalate(q.requestId, "scope")).toBe(true);
    expect(s.escalate(q.requestId, "again")).toBe(false);
    expect(s.escalate("unknown", "x")).toBe(false);
    expect(lastPart(events, q.id)).toMatchObject({ settled: false, escalated: true, reason: "scope" });
    expect(s.answer(q.requestId, { "Which package manager?": "pnpm" }, "coordinator")).toBe(false);
    expect(s.answer(q.requestId, { "Which package manager?": "npm" })).toBe(true);
    expect(lastPart(events, q.id)).toMatchObject({ settled: true, escalated: true });
    expect(lastPart(events, q.id)).not.toHaveProperty("by");
  });

  it("answer() with by coordinator marks the settled part", async () => {
    const { s, events, q } = await ask();
    expect(s.answer(q.requestId, { "Which package manager?": "pnpm" }, "coordinator")).toBe(true);
    expect(lastPart(events, q.id)).toMatchObject({ settled: true, by: "coordinator" });
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

  it("a conversation rewind while a background subagent run runs ends the run as stopped: the closed query no longer runs it", async () => {
    // development-docs/GH-36/probe/rewind-probe.mts: the first turn starts a background run that is still running when it ends.
    const result = (uuid: string) => ({ type: "result", subtype: "success", uuid, session_id: "x", is_error: false, duration_ms: 1, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
    let turn = 0;
    const query = ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const gen = (async function* () {
        for await (const _ of prompt) {
          if (++turn === 1) {
            yield { type: "assistant", uuid: "a1", session_id: "x", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "tool_use", id: "bg-1", name: "Agent", input: { description: "Background sweep", run_in_background: true } }] } };
            yield { type: "system", subtype: "task_started", uuid: "t1", session_id: "x", task_id: "task-1", tool_use_id: "bg-1", description: "Background sweep" };
            yield { type: "user", uuid: "r1", session_id: "x", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bg-1", content: "Async agent launched successfully.\nagentId: task-1 (internal)" }] } };
          } else yield { type: "assistant", uuid: "a2", session_id: "x", parent_tool_use_id: null, message: { id: "m2", content: [{ type: "text", text: "ok" }] } };
          yield result(`res${turn}`);
        }
      })();
      return Object.assign(gen, { supportedCommands: async () => [], close: () => void gen.return(undefined), getContextUsage: async () => fakeUsage, stopTask: async () => {} });
    };
    const s = new Session("/tmp", { query: query as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("first");
    await until(events, (e) => e.part.type === "turn_result");
    s.prompt("second");
    await until(events, () => events.filter((e) => e.part.type === "turn_result").length === 2);
    await until(events, () => s.info().state === "idle");
    expect(lastPart(events, "bg-1")).toMatchObject({ type: "subagent", status: "running" });
    const second = events.filter((e) => e.part.type === "user_text").at(-1)!.part.id;
    await s.rewind(second, "conversation");
    expect(lastPart(events, "bg-1")).toMatchObject({ type: "subagent", status: "stopped", endedAt: expect.any(Number) });
    expect(await s.stopSubagent("bg-1")).toBe(false);
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
    // The usage throwaway and the commands throwaway.
    await vi.waitFor(() => expect(closed).toBe(closedBefore + 2));
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
    // One throwaway for the usage and one for the commands (this fake has none: its failure is logged) per session.
    expect(closes).toBe(10);
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

  it("a terminal CLI turn silent past the quiet time stays running while the CLI process reports the session busy; ends once it does not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let busy = true;
    const prompt = { type: "user", uuid: "cli-p", session_id: "x", message: { role: "user", content: "from the terminal" }, parent_tool_use_id: null, parent_agent_id: null };
    try {
      const s = Session.restore(randomUUID(), "/tmp", history, { query: fakeQuery as never, readTranscript: async () => ({ main: [...history, prompt] as never, runs: [] }), cliTurnRunning: () => busy });
      await s.sync();
      expect(s.externalTurnRunning()).toBe(true);
      await vi.advanceTimersByTimeAsync(EXTERNAL_TURN_QUIET_MS * 3);
      expect(s.externalTurnRunning()).toBe(true);
      busy = false;
      await vi.advanceTimersByTimeAsync(EXTERNAL_TURN_QUIET_MS);
      expect(s.externalTurnRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

describe("Session subagent runs", () => {
  // Shapes of getSessionMessages() + getSubagentMessages() for a background run whose CLI exited mid-run (no <task-notification>; SDK 0.3.285).
  const at = (s: number) => new Date(Date.UTC(2026, 8, 17, 10, 0, 0) + s * 1000).toISOString();
  const msg = (type: string, s: number, content: unknown, parent: string | null = null) =>
    ({ type, uuid: `u${s}${type}`, session_id: "x", parent_tool_use_id: parent, parent_agent_id: null, timestamp: at(s), message: { id: `m${s}`, role: type, content } }) as never;
  const orphan = [
    msg("user", 0, "sweep in the background"),
    msg("assistant", 1, [{ type: "tool_use", id: "toolu_sweep", name: "Agent", input: { description: "Second widgets feature sweep", run_in_background: true } }]),
    msg("user", 2, [
      { type: "tool_result", tool_use_id: "toolu_sweep", content: [{ type: "text", text: "Async agent launched successfully. (This tool result is internal metadata.)\nagentId: a94a5abed25d4dbd3 (internal ID - do not mention to user.)\nThe agent is working in the background." }] },
    ]),
    msg("user", 3, "Sweep the widgets", "toolu_sweep"),
    msg("assistant", 40, [{ type: "text", text: "Looking at widgets" }], "toolu_sweep"),
    msg("assistant", 41, [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "rowHeight" } }], "toolu_sweep"),
  ];
  const run = (events: Event[]) => lastPart(events, "toolu_sweep") as Extract<Event["part"], { type: "subagent" }>;

  it("a restored run without a task notification ends stopped at its last transcript entry, with its open calls; nothing to stop", async () => {
    const s = Session.restore(randomUUID(), "/tmp", orphan, { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    expect(run(events)).toMatchObject({ status: "stopped", startedAt: Date.parse(at(1)), endedAt: Date.parse(at(41)) });
    // Its call without a result does not spin either.
    expect(lastPart(events, "toolu_grep")).toMatchObject({ type: "tool_call", status: "stopped" });
    expect(await s.stopSubagent("toolu_sweep")).toBe(false);
  });

  it("a live task notification after a resume reaches a restored run (one adapter for history and live)", async () => {
    let send!: (m: unknown) => void;
    const query = () =>
      Object.assign(
        (async function* () {
          for (;;) yield await new Promise((r) => (send = r));
        })(),
        { supportedCommands: async () => [], close() {} },
      );
    const s = Session.restore(randomUUID(), "/tmp", orphan, { query: query as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("go on");
    await until(events, () => !!send);
    send({ type: "system", subtype: "task_notification", uuid: randomUUID(), session_id: "x", task_id: "a94a5abed25d4dbd3", status: "completed", output_file: "", summary: "" });
    await until(events, (e) => e.part.id === "toolu_sweep" && (e.part as { status?: string }).status === "done");
  });

  it("a run the live query still runs when the CLI exits ends stopped; Stop agent has nothing to stop", async () => {
    let exit!: () => void;
    const query = () =>
      Object.assign(
        (async function* () {
          yield { type: "assistant", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { id: "msg_a", content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { description: "Run tests" } }] } };
          yield { type: "system", subtype: "task_started", uuid: randomUUID(), session_id: "x", task_id: "task-1", tool_use_id: "agent-1", description: "Run tests" };
          await new Promise<void>((r) => (exit = r));
        })(),
        { supportedCommands: async () => [], stopTask: async () => {}, close() {} },
      );
    const s = started({ query: query as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await until(events, () => !!exit);
    expect(run2(events).status).toBe("running");
    exit();
    await until(events, (e) => e.part.id === "agent-1" && (e.part as { status?: string }).status === "stopped");
    expect(await s.stopSubagent("agent-1")).toBe(false);
  });
  const run2 = (events: Event[]) => lastPart(events, "agent-1") as Extract<Event["part"], { type: "subagent" }>;

  it("Stop agent stops a run SendMessage resumed: its task_started names the SendMessage call (GH-112)", async () => {
    const stops: string[] = [];
    let step!: () => void;
    const sys = (subtype: string, toolUseId: string, extra = {}) => ({ type: "system", subtype, uuid: randomUUID(), session_id: "x", task_id: "a55f", tool_use_id: toolUseId, ...extra });
    const query = () =>
      Object.assign(
        (async function* () {
          yield { type: "assistant", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { id: "msg_a", content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { description: "Say hi", run_in_background: true } }] } };
          yield sys("task_started", "agent-1", { description: "Say hi", is_backgrounded: true });
          yield { type: "user", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "agent-1", content: "Async agent launched successfully.\nagentId: a55f (internal ID)" }] } };
          yield sys("task_notification", "agent-1", { status: "completed", output_file: "", summary: "hi" });
          yield { type: "assistant", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { id: "msg_b", content: [{ type: "tool_use", id: "send-1", name: "SendMessage", input: { to: "a55f", message: "bye" } }] } };
          yield sys("task_started", "send-1", { description: "Say hi", is_backgrounded: true });
          yield { type: "user", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "send-1", content: '{"success":true,"message":"Resuming agent a55f","resumedAgentId":"a55f"}' }] } };
          await new Promise<void>((r) => (step = r));
          yield sys("task_notification", "send-1", { status: "stopped", output_file: "", summary: "" });
          await new Promise(() => {});
        })(),
        { supportedCommands: async () => [], stopTask: async (id: string) => void stops.push(id), close() {} },
      );
    const s = started({ query: query as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await until(events, () => !!step);
    expect(run2(events)).toMatchObject({ status: "running" });
    expect(run2(events).endedAt).toBeUndefined();
    expect(lastPart(events, "send-1")).toMatchObject({ type: "tool_call", status: "done" });
    expect(await s.stopSubagent("agent-1")).toBe(true);
    expect(stops).toEqual(["a55f"]);
    step();
    await until(events, (e) => e.part.id === "agent-1" && (e.part as { status?: string }).status === "stopped");
    expect(await s.stopSubagent("agent-1")).toBe(false);
  });
});

describe("Session commands of a restored session", () => {
  const id = "0b5f1d5e-8a8e-4c9b-9f5e-3c1f2a4b5c6d";
  it("loads once on the first tab subscribe through a throwaway query, not for the daemon's own observer", async () => {
    const before = calls.length;
    const s = Session.restore(id, "/tmp", history, { query: fakeQuery as never });
    s.subscribe(Infinity, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.slice(before).filter((c) => (c as { persistSession?: boolean }).persistSession === false && !("resume" in c))).toEqual([]);
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.subscribe(0, () => {});
    await until(events, (e) => e.part.type === "commands");
    expect(lastPart(events, "commands")).toMatchObject({ commands: fakeCommands });
    expect(calls.slice(before).filter((c) => (c as { persistSession?: boolean }).persistSession === false && (c as { cwd?: string }).cwd === "/tmp" && !("resume" in c))).toHaveLength(1);
  });

  it("after a failed load no new throwaway starts for 60 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let asked = 0;
      const failing = ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
        Object.assign((async function* () { for await (const _ of prompt); })(), {
          supportedCommands: async () => (asked++, Promise.reject(new Error("no CLI"))),
          getContextUsage: async () => fakeUsage,
          close: () => {},
        });
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      const s = Session.restore(randomUUID(), "/tmp", history, { query: failing as never });
      const settle = () => new Promise((r) => setTimeout(r, 30));
      s.subscribe(0, () => {});
      await vi.waitFor(() => expect(asked).toBe(1));
      await settle();
      s.subscribe(0, () => {});
      await settle();
      expect(asked).toBe(1);
      vi.setSystemTime(Date.now() + 61_000);
      s.subscribe(0, () => {});
      await vi.waitFor(() => expect(asked).toBe(2));
      quiet.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("update restart and a real session", () => {
  it("a turn the CLI starts by itself on a task notification keeps the restart waiting; it exits 5 s after that turn's result", async () => {
    let send!: (m: unknown) => void;
    const query = () =>
      Object.assign(
        (async function* () {
          for (;;) yield await new Promise((r) => (send = r));
        })(),
        { supportedCommands: async () => [], close() {} },
      );
    const s = started({ query: query as never });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // One message per pull of the query: the next send waits for the next pull.
    const push = async (m: unknown) => (send(m), await wait(15));
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    const result = () => ({ type: "result", subtype: "success", uuid: randomUUID(), session_id: "x", is_error: false, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
    await until(events, () => !!send);
    await push({ type: "system", subtype: "task_started", uuid: randomUUID(), session_id: "x", task_id: "bg-task", tool_use_id: "toolu_bg", description: "sleep 60" });
    await push(result());
    await until(events, (e) => e.part.type === "session_state" && (e.part as { state: string }).state === "idle");
    expect(s.working()).toBe(true);

    // Only Date is faked: the updater's 5 ms poll and this test's waits run on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const exit = vi.fn();
      const fetch = (async () => ({ ok: true, json: async () => ({ version: "0.2.1" }) })) as never;
      // A fake npm that lays out the package the way npm does.
      const run = async (_cmd: string, args: string[]) => {
        const pkg = join(args[args.indexOf("--prefix") + 1]!, "node_modules", "claude-code-ui");
        mkdirSync(join(pkg, "dist"), { recursive: true });
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.2.1" }));
        writeFileSync(join(pkg, "dist", "cli.js"), "");
        return { code: 0, output: "" };
      };
      const dir = mkdtempSync(join(tmpdir(), "cu-versions-"));
      const u = createUpdater({ current: "0.2.0", dir, fetch, run, busy: () => ({ sessions: s.working() ? 1 : 0, terminals: 0 }), exit, broadcast: () => {}, pollMs: 5 });
      await u.check();
      await u.install();
      expect(u.restart()).toBe(1);
      await push({ type: "system", subtype: "task_notification", uuid: randomUUID(), session_id: "x", task_id: "bg-task", tool_use_id: "toolu_bg", status: "completed", output_file: "", summary: "" });
      await wait(30);
      // Claude's own turn on the notification runs longer than the grace period: no exit.
      vi.setSystemTime(Date.now() + 60_000);
      await wait(30);
      expect(exit).not.toHaveBeenCalled();
      expect(s.working()).toBe(true);
      await push(result());
      vi.setSystemTime(Date.now() + 4900);
      await wait(30);
      expect(exit).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 200);
      await wait(30);
      expect(exit).toHaveBeenCalledWith(RESTART_CODE);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("self-started turn and sync", () => {
  it("a turn the CLI starts by itself on a task notification defers the transcript sync to its result", async () => {
    let send!: (m: unknown) => void;
    const query = () =>
      Object.assign(
        (async function* () {
          for (;;) yield await new Promise((r) => (send = r));
        })(),
        { supportedCommands: async () => [], close() {} },
      );
    const reads = vi.fn(async () => ({ main: [], runs: [] }));
    const s = started({ query: query as never, readTranscript: reads as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const push = async (m: unknown) => (send(m), await wait(15));
    const result = () => ({ type: "result", subtype: "success", uuid: randomUUID(), session_id: "x", is_error: false, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [] });
    await until(events, () => !!send);
    await push({ type: "system", subtype: "task_started", uuid: randomUUID(), session_id: "x", task_id: "bg", tool_use_id: "toolu_bg", description: "sleep" });
    await push(result());
    await push({ type: "system", subtype: "task_notification", uuid: randomUUID(), session_id: "x", task_id: "bg", tool_use_id: "toolu_bg", status: "completed", output_file: "", summary: "" });
    // State is idle, but the CLI's own turn runs: no transcript read now.
    await s.sync();
    expect(reads).not.toHaveBeenCalled();
    await push(result());
    await wait(15);
    expect(reads).toHaveBeenCalled();
  });
});

describe("Session event log (GH-139)", () => {
  const N = 1000;
  const make = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const query = ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
      const base = { parent_tool_use_id: null, session_id: "x" };
      const delta = (index: number, d: object) => ({ type: "stream_event", ...base, uuid: randomUUID(), event: { type: "content_block_delta", index, delta: d } });
      const q = (async function* () {
        for await (const _ of prompt) {
          yield { type: "stream_event", ...base, uuid: randomUUID(), event: { type: "message_start", message: { id: "msg_long" } } } as never;
          for (let i = 0; i < N; i++) yield delta(0, { type: "thinking_delta", thinking: "t".repeat(20) }) as never;
          for (let i = 0; i < N; i++) yield delta(1, { type: "text_delta", text: "x".repeat(20) }) as never;
          await gate;
          yield { type: "assistant", uuid: randomUUID(), ...base, message: { id: "msg_long", content: [{ type: "thinking", thinking: "t".repeat(20 * N) }, { type: "text", text: "x".repeat(20 * N) }] } } as never;
          yield { type: "result", subtype: "success", uuid: randomUUID(), session_id: "x", is_error: false, duration_ms: 1, total_cost_usd: 0, result: "", usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] } as never;
        }
      })();
      return Object.assign(q, { supportedCommands: async () => [], getContextUsage: async () => fakeUsage, close: () => {} });
    };
    const s = new Session("/tmp", { query: query as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    const replay = (since = 0) => {
      const r: Event[] = [];
      s.subscribe(since, (e) => r.push(e))();
      return r;
    };
    return { s, events, replay, release };
  };
  const ofId = (events: Event[], id: string) => events.filter((e) => e.part.id === id);

  it("a streamed reply still running replays as its latest partial text, one anchor and one latest event per block", async () => {
    const { s, events, replay } = make();
    s.prompt("go");
    await until(events, (e) => e.part.type === "assistant_text" && e.part.text.length === 20 * N);
    const r = replay();
    for (const [id, ch] of [["msg_long:1", "x"], ["msg_long:0", "t"]] as const) {
      const ev = ofId(r, id);
      expect(ev.length).toBe(2);
      expect(ev.at(-1)!.part).toMatchObject({ streaming: true });
      expect((ev.at(-1)!.part as { text?: string; thinking?: string }).text ?? (ev.at(-1)!.part as { thinking?: string }).thinking).toBe(ch.repeat(20 * N));
    }
    expect(r.every((e, i) => i === 0 || e.seq > r[i - 1]!.seq)).toBe(true);
    expect(events.filter((e) => e.part.type === "assistant_text" || e.part.type === "thinking").length).toBe(2 * N);
  });

  it("after the turn the log holds O(reply length) text, and a reconnect inside a replaced range gets the final part", async () => {
    const { s, events, replay, release } = make();
    s.prompt("go");
    await until(events, (e) => e.part.type === "assistant_text" && e.part.text.length === 20 * N);
    const since = events.filter((e) => e.part.type === "assistant_text")[499]!.seq;
    release();
    await until(events, (e) => e.part.type === "session_state" && e.part.state === "idle");
    const r = replay();
    const ev = ofId(r, "msg_long:1");
    expect(ev.length).toBe(2);
    expect(ev.at(-1)!.part).toMatchObject({ streaming: false, text: "x".repeat(20 * N) });
    // The thinking block's latest event is not the log tail (text events follow): the replaced one must be found by identity.
    expect(ofId(r, "msg_long:0").length).toBe(2);
    expect(ofId(r, "msg_long:0").at(-1)!.part).toMatchObject({ streaming: false });
    const size = r.reduce((n, e) => n + (e.part.type === "assistant_text" ? e.part.text.length : e.part.type === "thinking" ? e.part.text.length : 0), 0);
    expect(size).toBeLessThanOrEqual(2 * 20 * N * 1.1);
    expect(s.seq()).toBe(events.at(-1)!.seq);
    expect(r.at(-1)!.seq).toBe(s.seq());
    expect(ofId(replay(since), "msg_long:1")[0]!.part).toMatchObject({ streaming: false, text: "x".repeat(20 * N) });
  });
});

describe("Session bash mode", () => {
  type Run = { done: Promise<{ stdout: string; stderr: string; exitCode?: number; stopped: boolean }>; kill: () => void };
  /** A runBash fake whose command ends when the test says so (or when it is killed). */
  const fakeRun = () => {
    const ctl = { killed: 0, output: (_o: string, _e: string) => {}, finish: (_r: { stdout: string; stderr: string; exitCode?: number; stopped?: boolean }) => {} };
    const runBash = (_cmd: string, _cwd: string, onOutput: (o: string, e: string) => void): Run => {
      ctl.output = onOutput;
      let resolve!: (r: { stdout: string; stderr: string; exitCode?: number; stopped: boolean }) => void;
      const done = new Promise<{ stdout: string; stderr: string; exitCode?: number; stopped: boolean }>((r) => (resolve = r));
      ctl.finish = (r) => resolve({ stopped: false, ...r });
      return { done, kill: () => (ctl.killed++, resolve({ stdout: "partial", stderr: "", stopped: true })) };
    };
    return { ctl, runBash: runBash as never };
  };
  const setup = () => {
    const { ctl, runBash } = fakeRun();
    const s = new Session("/tmp", { query: fakeQuery as never, runBash });
    const events: Event[] = [];
    const states: string[] = [];
    s.subscribe(0, (e) => (events.push(e), states.push(s.info().state)));
    return { s, ctl, events, states };
  };
  const bashInputs = () => inputs.slice(-3);

  it("the log keeps a running bash part's first and last update only", async () => {
    const { s, ctl, events } = setup();
    s.bash("ls");
    ctl.output("a\n", "");
    await until(events, (e) => e.part.type === "bash" && e.part.stdout === "a\n");
    ctl.output("a\nb\n", "");
    await until(events, (e) => e.part.type === "bash" && e.part.stdout === "a\nb\n");
    ctl.finish({ stdout: "a\nb\n", stderr: "", exitCode: 0 });
    await until(events, (e) => e.part.type === "bash" && e.part.status === "done");
    const r: Event[] = [];
    s.subscribe(0, (e) => r.push(e))();
    const bash = r.filter((e) => e.part.type === "bash").map((e) => e.part);
    expect(bash).toMatchObject([{ status: "running", stdout: "" }, { status: "done", stdout: "a\nb\n" }]);
    expect(events.filter((e) => e.part.type === "bash").length).toBe(4);
  });

  it("logs a running bash part, streams output, then done with the exit code", async () => {
    const { s, ctl, events } = setup();
    s.bash("ls");
    expect(lastPart(events, events.find((e) => e.part.type === "bash")!.part.id)).toMatchObject({ type: "bash", command: "ls", status: "running", stdout: "" });
    expect(s.working()).toBe(true);
    ctl.output("a\n", "");
    ctl.finish({ stdout: "a\nb\n", stderr: "w", exitCode: 3 });
    await until(events, (e) => e.part.type === "bash" && e.part.status === "error");
    expect(events.filter((e) => e.part.type === "bash").at(-1)!.part).toMatchObject({ stdout: "a\nb\n", stderr: "w", exitCode: 3, status: "error" });
    expect(s.working()).toBe(false);
  });

  it("appends the CLI's two records with shouldQuery false, then the next prompt follows; no turn starts, no footer", async () => {
    const { s, ctl, events, states } = setup();
    s.bash("echo <hi>");
    ctl.finish({ stdout: "<hi>\n", stderr: "", exitCode: 0 });
    await until(events, (e) => e.part.type === "bash" && e.part.status === "done");
    await until(events, () => inputs.some((m) => m.shouldQuery === false && String(m.message.content).startsWith("<bash-stdout>")));
    // The append's init, replay echo and empty result: no running state (GH-110: not a CLI turn), no turn_result.
    await new Promise((r) => setTimeout(r, 50));
    expect(states).not.toContain("running");
    expect(s.info().state).toBe("idle");
    expect(events.some((e) => e.part.type === "turn_result" || e.part.type === "user_text")).toBe(false);
    s.prompt("what did it show?");
    await until(events, () => inputs.at(-1)?.message.content === "what did it show?");
    const [a, b, c] = bashInputs();
    expect([a!.shouldQuery, a!.message.content, a!.uuid]).toEqual([false, "<bash-input>echo <hi></bash-input>", events.find((e) => e.part.type === "bash")!.part.id]);
    expect([b!.shouldQuery, b!.message.content]).toEqual([false, "<bash-stdout>&lt;hi&gt;\n</bash-stdout><bash-stderr></bash-stderr>"]);
    expect([c!.shouldQuery, c!.message.content]).toEqual([undefined, "what did it show?"]);
    await until(events, (e) => e.part.type === "turn_result");
  });

  it("starts the CLI of a new session on the first append (sessionId) and resumes a restored one", async () => {
    const a = setup();
    a.s.bash("x");
    a.ctl.finish({ stdout: "", stderr: "", exitCode: 0 });
    await until(a.events, (e) => e.part.type === "bash" && e.part.status === "done");
    expect(calls.at(-1)).toMatchObject({ sessionId: a.s.id });
    const { ctl, runBash } = fakeRun();
    const id = randomUUID();
    const r = Session.restore(id, "/tmp", history, { query: fakeQuery as never, runBash });
    const events: Event[] = [];
    r.subscribe(0, (e) => events.push(e));
    r.bash("y");
    ctl.finish({ stdout: "", stderr: "", exitCode: 0 });
    await until(events, (e) => e.part.type === "bash" && e.part.status === "done");
    expect(calls.at(-1)).toMatchObject({ resume: id });
  });

  it("rejects bash while a turn runs or another command runs, and a prompt while a command runs", async () => {
    const { s, ctl, events } = setup();
    s.prompt("hi");
    expect(() => s.bash("x")).toThrow(/busy/);
    await until(events, (e) => e.part.type === "turn_result");
    await until(events, () => s.info().state === "idle");
    s.bash("x");
    expect(() => s.bash("y")).toThrow(/already running/);
    expect(() => s.prompt("p")).toThrow(/shell command is running/);
    ctl.finish({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("interrupt() kills a running command: status stopped, records still appended", async () => {
    const { s, ctl, events } = setup();
    s.bash("sleep 30");
    await s.interrupt();
    expect(ctl.killed).toBe(1);
    await until(events, (e) => e.part.type === "bash" && e.part.status === "stopped");
    await until(events, () => inputs.some((m) => m.shouldQuery === false && String(m.message.content).includes("partial")));
  });

  it("the next prompt's rewind fork point is the bash output record", async () => {
    const { s, ctl, events } = setup();
    s.bash("ls");
    ctl.finish({ stdout: "a", stderr: "", exitCode: 0 });
    await until(events, (e) => e.part.type === "bash" && e.part.status === "done");
    await until(events, () => inputs.some((m) => m.shouldQuery === false && String(m.message.content).startsWith("<bash-stdout>")));
    const outId = inputs.filter((m) => m.shouldQuery === false).at(-1)!.uuid;
    s.prompt("q");
    const prompt = events.filter((e) => e.part.type === "user_text").at(-1)!.part.id;
    await until(events, (e) => e.part.type === "turn_result");
    await until(events, () => s.info().state === "idle");
    await s.rewind(prompt, "conversation");
    s.prompt("again");
    expect(calls.at(-1)).toMatchObject({ resume: s.id, resumeSessionAt: outId });
  });

  it("a transcript ending in a terminal-CLI bash record is no open external turn", async () => {
    const rec = (uuid: string, content: string) => ({ type: "user", uuid, session_id: "x", message: { role: "user", content }, parent_tool_use_id: null, parent_agent_id: null });
    const main = [...history, rec("bi", "<bash-input>ls</bash-input>"), rec("bo", "<bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>")];
    const s = Session.restore(randomUUID(), "/tmp", history, { query: fakeQuery as never, readTranscript: async () => ({ main: main as never, runs: [] }) });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await s.sync();
    expect(s.externalTurnRunning()).toBe(false);
    expect(events.filter((e) => e.part.type === "bash").map((e) => e.part.id)).toEqual(["bi", "bi"]);
  });

  it("throttles running updates to 500 ms with a trailing update, and emits nothing for unchanged output", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { s, ctl, events } = setup();
      s.bash("x");
      const count = () => events.filter((e) => e.part.type === "bash").length;
      expect(count()).toBe(1);
      ctl.output("a", "");
      ctl.output("ab", "");
      await vi.advanceTimersByTimeAsync(600);
      expect(lastPart(events, events[0]!.part.id)).toMatchObject({ stdout: "ab" });
      expect(count()).toBe(2);
      ctl.output("ab", "");
      await vi.advanceTimersByTimeAsync(1200);
      expect(count()).toBe(2);
      ctl.finish({ stdout: "ab", stderr: "", exitCode: 0 });
      await vi.advanceTimersByTimeAsync(10);
      expect(count()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a rewind while a command runs and bash while a terminal CLI turn runs", async () => {
    const { s, ctl, events } = setup();
    s.prompt("hi");
    await until(events, (e) => e.part.type === "turn_result");
    await until(events, () => s.info().state === "idle");
    const prompt = events.find((e) => e.part.type === "user_text")!.part.id;
    s.bash("x");
    await expect(s.rewind(prompt, "conversation")).rejects.toThrow(/shell command is running/);
    ctl.finish({ stdout: "", stderr: "", exitCode: 0 });
    const cli = { type: "user", uuid: "cli-p", session_id: "x", message: { role: "user", content: "from the terminal" }, parent_tool_use_id: null, parent_agent_id: null };
    const { runBash } = fakeRun();
    const r = Session.restore(randomUUID(), "/tmp", history, { query: fakeQuery as never, runBash, readTranscript: async () => ({ main: [...history, cli] as never, runs: [] }) });
    await r.sync();
    expect(r.externalTurnRunning()).toBe(true);
    expect(() => r.bash("x")).toThrow(/busy/);
  });
});

describe("Session background work", () => {
  const result = () => ({ type: "result", subtype: "success", uuid: randomUUID(), session_id: "x", is_error: false, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] });
  const call = (id: string, name: string, input: unknown) => ({ type: "assistant", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { id: `msg_${id}`, content: [{ type: "tool_use", id, name, input }] } });
  const say = () => ({ type: "assistant", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, content: [{ type: "text", text: "Sweep done." }] } });
  const task = (subtype: string, task_id: string, tool_use_id: string, extra = {}) => ({ type: "system", subtype, uuid: randomUUID(), session_id: "x", task_id, tool_use_id, ...extra });
  const done = (task_id: string, tool_use_id: string, status = "completed") => task("task_notification", task_id, tool_use_id, { status, output_file: "", summary: "" });
  /** The session_state log as "idle", "idle+working", "running". */
  const log = (events: Event[]) => events.filter((e) => e.part.type === "session_state").map((e) => { const p = e.part as { state: string; working?: true }; return p.working ? `${p.state}+working` : p.state; });

  /** A prompted session whose query yields what the test sends; `send` waits until `expected` states are logged. */
  async function setup() {
    let next!: (m: unknown) => void;
    const query = () => Object.assign((async function* () { for (;;) yield await new Promise((r) => (next = r)); })(), { supportedCommands: async () => [], stopTask: async () => {}, close() {} });
    const s = started({ query: query as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await until(events, () => !!next);
    /** Sends `m`, waits until the drive loop asks for the next message (this one is handled), then checks the state log. */
    const send = async (m: unknown, expected: string[]) => {
      const was = next;
      was(m);
      await new Promise<void>((r) => { const t = setInterval(() => next !== was && (clearInterval(t), r()), 2); });
      expect(log(events)).toEqual(expected);
    };
    return { s, events, send };
  }
  const bg = async (send: Awaited<ReturnType<typeof setup>>["send"]) => {
    await send(call("agent-bg", "Agent", { description: "Sweep", run_in_background: true }), ["running"]);
    await send(task("task_started", "t1", "agent-bg", { is_backgrounded: true }), ["running"]);
  };

  it("a turn that ends while a background run works logs idle with working; the notification and the CLI turn run, then idle without working", async () => {
    const { send } = await setup();
    await bg(send);
    await send(result(), ["running", "idle+working"]);
    await send(done("t1", "agent-bg"), ["running", "idle+working", "idle+working"]);
    await send(say(), ["running", "idle+working", "idle+working", "running"]);
    await send(result(), ["running", "idle+working", "idle+working", "running", "idle"]);
  });

  it("with two background tasks the first CLI turn ends idle with working, the last without", async () => {
    const { send } = await setup();
    await bg(send);
    await send(call("sh-bg", "Bash", { command: "sleep 9", run_in_background: true }), ["running"]);
    await send(task("task_started", "t2", "sh-bg", { is_backgrounded: true }), ["running"]);
    await send(result(), ["running", "idle+working"]);
    await send(done("t1", "agent-bg"), ["running", "idle+working", "idle+working"]);
    await send(say(), ["running", "idle+working", "idle+working", "running"]);
    await send(result(), ["running", "idle+working", "idle+working", "running", "idle+working"]);
    await send(done("t2", "sh-bg"), ["running", "idle+working", "idle+working", "running", "idle+working", "idle+working"]);
    await send(say(), ["running", "idle+working", "idle+working", "running", "idle+working", "idle+working", "running"]);
    await send(result(), ["running", "idle+working", "idle+working", "running", "idle+working", "idle+working", "running", "idle"]);
  });

  it("a plugins restart that drops running background tasks logs idle without working", async () => {
    const { s, events, send } = await setup();
    await bg(send);
    await send(result(), ["running", "idle+working"]);
    s.restartQuery();
    await until(events, () => log(events).at(-1) === "idle");
  });

  it("releaseQuery refuses while a background task runs", async () => {
    const { s, send } = await setup();
    await bg(send);
    await send(result(), ["running", "idle+working"]);
    expect(s.releaseQuery()).toBe(false);
    expect(s.liveQuery()).toBeDefined();
  });

  it("a notification during a running turn keeps it running; the CLI's own turn after the result runs again", async () => {
    const { send } = await setup();
    await send(call("agent-fg", "Agent", { description: "Sweep" }), ["running"]);
    await send(task("task_started", "t1", "agent-fg", { is_backgrounded: false }), ["running"]);
    await send(done("t1", "agent-fg"), ["running"]);
    await send(result(), ["running", "idle"]);
    await send(say(), ["running", "idle", "running"]);
    await send(result(), ["running", "idle", "running", "idle"]);
  });

  const stream = () => ({ type: "stream_event", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_s", role: "assistant", content: [] } } });

  it("the CLI turn's first stream event sets running; the wait timer does not end a running turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { events, send } = await setup();
      await bg(send);
      await send(result(), ["running", "idle+working"]);
      await send(done("t1", "agent-bg"), ["running", "idle+working", "idle+working"]);
      await send(stream(), ["running", "idle+working", "idle+working", "running"]);
      vi.advanceTimersByTime(CLI_TURN_WAIT_MS * 2);
      expect(log(events).at(-1)).toBe("running");
      await send(say(), ["running", "idle+working", "idle+working", "running"]);
      await send(result(), ["running", "idle+working", "idle+working", "running", "idle"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stopped notification that gets no CLI turn leaves the session idle; working clears after the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { events, send } = await setup();
      await bg(send);
      await send(result(), ["running", "idle+working"]);
      await send(done("t1", "agent-bg", "stopped"), ["running", "idle+working", "idle+working"]);
      vi.advanceTimersByTime(CLI_TURN_WAIT_MS);
      expect(log(events).at(-1)).toBe("idle");
      expect(log(events)).not.toContain("running+working");
    } finally {
      vi.useRealTimers();
    }
  });
});
