import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Event } from "@claude-ui/protocol";
import { Session } from "../src/session.ts";
import { aborts, bashSuggestion, calls, checkpointFiles, closed, fakeCommands, fakeQuery, firstTurnLastAssistant, history, inputs, permissionQuery, permissionResults, rewinds, setModelCalls } from "./fake-query.ts";

const until = (events: Event[], pred: (e: Event) => boolean) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => events.some(pred) && (clearInterval(t), resolve()), 5);
  });

const lastPart = (events: Event[], id: string) => events.filter((e) => e.part.id === id).at(-1)!.part;

describe("Session", () => {
  it("has a UUID before the first prompt and passes it to the SDK as sessionId", () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.at(-1)).toMatchObject({ sessionId: s.id, cwd: "/tmp", includePartialMessages: true });
  });

  it("logs user_text, running, streamed parts, turn_result, idle with increasing seq", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hello");
    await until(events, (e) => e.part.type === "session_state" && e.part.state === "idle");

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.sessionId === s.id)).toBe(true);
    const types = events.map((e) => e.part.type);
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
    new Session("/tmp", { query: fakeQuery as never });
    vi.unstubAllEnvs();
    const env = calls.at(-1)!.env!;
    expect(env.PATH).toBe(process.env.PATH);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("rejects a prompt once the query failed, and logs the failure reason", async () => {
    const failing = () =>
      Object.assign((async function* () { throw new Error("login expired"); })(), {
        supportedCommands: () => Promise.reject(new Error("login expired")),
      });
    const s = new Session("/tmp", { query: failing as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await until(events, (e) => e.part.type === "session_state" && e.part.state === "error");
    expect(events.some((e) => e.part.type === "raw" && JSON.stringify(e.part.message).includes("login expired"))).toBe(true);
    expect(() => s.prompt("hello")).toThrow(/not live/);
    expect(s.info().state).toBe("error");
  });

  it("rebuilds history from the transcript and resumes with the same ID on the first prompt", async () => {
    const id = "0b5f1d5e-8a8e-4c9b-9f5e-3c1f2a4b5c6d";
    const before = calls.length;
    const s = Session.restore(id, "/tmp", history, { query: fakeQuery as never });
    expect(calls.length).toBe(before); // no query until a prompt
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
  });

  it("passes the chosen model to the SDK; 'default' means no model option", () => {
    const s = new Session("/tmp", { model: "haiku", query: fakeQuery as never });
    expect(calls.at(-1)!.model).toBe("haiku");
    expect(s.info().model).toBe("haiku");
    const d = new Session("/tmp", { model: "default", query: fakeQuery as never });
    expect(calls.at(-1)!.model).toBeUndefined();
    expect(d.info().model).toBe("default");
    expect(new Session("/tmp", { query: fakeQuery as never }).info().model).toBe("default");
  });

  it("setModel switches the live query and logs a session_model part", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await s.setModel("haiku");
    expect(setModelCalls.at(-1)).toBe("haiku");
    expect(s.info().model).toBe("haiku");
    expect(events.at(-1)!.part).toEqual({ type: "session_model", id: "session_model", model: "haiku" });
  });

  it("setModel on a restored session before its first prompt applies when the query resumes", async () => {
    const s = Session.restore(randomUUID(), "/tmp", [], { query: fakeQuery as never });
    const before = setModelCalls.length;
    await s.setModel("haiku");
    expect(setModelCalls.length).toBe(before);
    s.prompt("hi");
    expect(calls.at(-1)).toMatchObject({ resume: s.id, model: "haiku" });
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

  it("loads user and project commands and skills (settingSources)", () => {
    new Session("/tmp", { query: fakeQuery as never });
    expect(calls.at(-1)).toMatchObject({ settingSources: ["user", "project"] });
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

describe("Session rewind", () => {
  const id = "0b5f1d5e-8a8e-4c9b-9f5e-3c1f2a4b5c6d";
  const restored = () => {
    const s = Session.restore(id, "/tmp", history, { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    return { s, events };
  };

  it("runs the SDK with file checkpointing and replayed user message UUIDs", () => {
    new Session("/tmp", { query: fakeQuery as never });
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
});
