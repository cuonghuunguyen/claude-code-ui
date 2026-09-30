import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAdapter, imageBlock, type Part } from "../src/index.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function run(messages: unknown[]): Part[] {
  const adapter = createAdapter();
  return messages.flatMap((m) => adapter.convert(m as never));
}

describe("adapter on recorded two-turn session", () => {
  const messages = fixture("two-turn-text.jsonl");
  const parts = run(messages);
  const texts = parts.filter((p) => p.type === "assistant_text");

  it("streams assistant_text under one stable id per text block", () => {
    const ids = [...new Set(texts.map((p) => p.id))];
    expect(ids).toHaveLength(2);
    expect(texts.filter((p) => p.id === ids[0]).length).toBeGreaterThan(10);
  });

  it("each update carries the full accumulated text, growing monotonically", () => {
    for (const id of new Set(texts.map((p) => p.id))) {
      const updates = texts.filter((p) => p.id === id);
      for (let i = 1; i < updates.length; i++) expect(updates[i]!.text.startsWith(updates[i - 1]!.text)).toBe(true);
    }
  });

  it("final update per block is not streaming and equals the complete assistant message text", () => {
    const finals = messages
      .filter((m) => m.type === "assistant")
      .flatMap((m) => m.message.content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text));
    const lastById = new Map(texts.map((p) => [p.id, p]));
    expect([...lastById.values()].map((p) => p.text)).toEqual(finals);
    for (const p of lastById.values()) expect(p.streaming).toBe(false);
  });

  it("emits one turn_result per turn with duration, tokens and cost", () => {
    const results = parts.filter((p) => p.type === "turn_result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ type: "turn_result", isError: false, durationMs: 7131 });
    expect(results[0]!.type === "turn_result" && results[0]!.costUsd).toBeCloseTo(0.121987);
    expect(results[0]!.type === "turn_result" && results[0]!.usage.outputTokens).toBe(301);
  });

  it("gives each turn its own cost: the SDK's total_cost_usd is cumulative per query", () => {
    const costs = parts.flatMap((p) => (p.type === "turn_result" ? [p.costUsd] : []));
    expect(costs[1]).toBeCloseTo(0.1482896 - 0.121987);
  });

  it("gives the same final parts when replayed without stream events (history)", () => {
    const history = run(messages.filter((m) => m.type !== "stream_event")).filter((p) => p.type === "assistant_text");
    const live = [...new Map(texts.map((p) => [p.id, p])).values()];
    expect(history).toEqual(live);
  });
});

describe("adapter on user messages", () => {
  it("converts a user text message to user_text keyed by uuid", () => {
    const parts = run([{ type: "user", uuid: "u1", message: { role: "user", content: "hi" }, parent_tool_use_id: null }]);
    expect(parts).toEqual([{ type: "user_text", id: "u1", text: "hi", images: [] }]);
  });

  it("converts a user message with image blocks to user_text with data URL images", () => {
    const content = [
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ];
    const parts = run([{ type: "user", uuid: "u2", message: { role: "user", content }, parent_tool_use_id: null }]);
    expect(parts).toEqual([
      { type: "user_text", id: "u2", text: "what is this?", images: ["data:image/png;base64,iVBORw0KGgo="] },
    ]);
  });
});

describe("imageBlock", () => {
  it("turns an image data URL into a base64 image content block", () => {
    expect(imageBlock("data:image/jpeg;base64,/9j/4A==")).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "/9j/4A==" },
    });
  });

  it("rejects non-image, unsupported or non-base64 data URLs", () => {
    for (const bad of ["data:text/plain;base64,aGk=", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png,raw", "http://x/a.png", 42])
      expect(imageBlock(bad)).toBeUndefined();
  });
});

// Recorded: parallel Reads (ok, ok, missing file), a Bash call denied without canUseTool, summarized thinking.
describe("adapter on recorded tool session", () => {
  const messages = fixture("tools-thinking-denied.jsonl");
  const parts = run(messages);
  const last = <T extends Part["type"]>(type: T) =>
    [...new Map(parts.filter((p) => p.type === type).map((p) => [p.id, p])).values()] as Extract<Part, { type: T }>[];

  it("streams thinking under one stable id per block, ending with the complete text", () => {
    const thinking = parts.filter((p) => p.type === "thinking");
    const finals = last("thinking");
    expect(finals).toHaveLength(2);
    expect(thinking.filter((p) => p.id === finals[0]!.id).length).toBeGreaterThan(2);
    expect(finals[0]).toMatchObject({ streaming: false, text: expect.stringContaining("parallel") });
  });

  it("tool_call goes pending -> running -> final status, keyed by toolUseId", () => {
    const calls = parts.filter((p) => p.type === "tool_call");
    const first = calls.filter((p) => p.toolUseId === calls[0]!.toolUseId).map((p) => p.status);
    expect(first).toEqual(["pending", "running", "done"]);
    expect(last("tool_call").map((p) => [p.tool, p.status])).toEqual([
      ["Read", "done"],
      ["Read", "done"],
      ["Read", "error"],
      ["Bash", "denied"],
    ]);
    for (const p of last("tool_call")) expect(p.id).toBe(p.toolUseId);
    expect(last("tool_call")[3]!.input).toMatchObject({ command: "touch /tmp/claude-ui-gh3-probe" });
  });

  it("emits one tool_result per call with output and isError", () => {
    const results = last("tool_result");
    expect(results.map((p) => p.isError)).toEqual([false, false, true, true]);
    expect(results[2]!.output).toMatch(/File does not exist/);
    expect(new Set(results.map((p) => p.toolUseId))).toEqual(new Set(last("tool_call").map((p) => p.toolUseId)));
  });

  it("gives the same final thinking, tool and result parts when replayed without stream events (history)", () => {
    // Order may differ: live, a tool_call appears at its stream start, before earlier results.
    const final = (ps: Part[]) =>
      [...new Map(ps.filter((p) => ["thinking", "tool_call", "tool_result"].includes(p.type)).map((p) => [p.id, p])).values()]
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(final(run(messages.filter((m) => m.type !== "stream_event")))).toEqual(final(parts));
  });

  it("drops known noise (init, status, thinking tokens, rate limits) instead of emitting raw parts", () => {
    expect(parts.filter((p) => p.type === "raw")).toEqual([]);
  });
});

describe("adapter on interrupts", () => {
  // Recorded with SDK 0.3.285 (development-docs/GH-5/probe2.log): after interrupt() the CLI sends this user text, then an aborted result.
  const marker = (uuid: string, text: string) => ({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null });
  const aborted = { type: "result", uuid: "r1", subtype: "error_during_execution", terminal_reason: "aborted_tools", duration_ms: 1, total_cost_usd: 0, usage: {}, is_error: true, permission_denials: [] };

  it("turns the CLI's interrupt marker into turn_interrupted, with or without 'for tool use'", () => {
    expect(run([marker("u1", "[Request interrupted by user]"), marker("u2", "[Request interrupted by user for tool use]")])).toEqual([
      { type: "turn_interrupted", id: "u1" },
      { type: "turn_interrupted", id: "u2" },
    ]);
  });

  it("logs no turn_result for an aborted turn, but still marks denied calls", () => {
    const parts = run([
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { ...aborted, permission_denials: [{ tool_use_id: "t1" }] },
      { ...aborted, terminal_reason: "aborted_streaming" },
    ]);
    expect(parts.map((p) => p.type)).toEqual(["tool_call", "tool_call"]);
    expect(parts.at(-1)).toMatchObject({ status: "denied" });
  });
});

describe("adapter turn cost", () => {
  const result = (uuid: string, total: number, terminal_reason = "completed") =>
    ({ type: "result", uuid, terminal_reason, duration_ms: 1, total_cost_usd: total, usage: {}, is_error: false, permission_denials: [] });
  const costs = (parts: Part[]) => parts.flatMap((p) => (p.type === "turn_result" ? [p.costUsd] : []));

  it("counts an aborted turn's spend in the base, not in the next turn", () => {
    expect(costs(run([result("r1", 0.1), result("r2", 0.15, "aborted_streaming"), result("r3", 0.2)]))).toEqual([0.1, expect.closeTo(0.05)]);
  });

  it("takes a lower total as a reset (a query resumed without a saved total, /clear)", () => {
    expect(costs(run([result("r1", 0.3), result("r2", 0.02)]))).toEqual([0.3, 0.02]);
  });

  it("has no cost for the first turn of a resumed session: its total includes turns of an earlier query", () => {
    const adapter = createAdapter({ resumed: true });
    expect(costs([result("r1", 0.5), result("r2", 0.6)].flatMap((m) => adapter.convert(m as never)))).toEqual([undefined, expect.closeTo(0.1)]);
  });
});

describe("adapter on known SDK noise", () => {
  it("drops hook, task lifecycle and tool progress messages instead of emitting raw parts", () => {
    const noise = [
      { type: "system", subtype: "hook_started", uuid: "h1", hook_id: "k", hook_name: "SessionStart:startup", hook_event: "SessionStart" },
      { type: "system", subtype: "hook_progress", uuid: "h2", hook_id: "k", hook_name: "SessionStart:startup", hook_event: "SessionStart", stdout: "", stderr: "", output: "" },
      { type: "system", subtype: "hook_response", uuid: "h3", hook_id: "k", hook_name: "SessionStart:startup", hook_event: "SessionStart", output: "hook stdout", stdout: "hook stdout", stderr: "", outcome: "success" },
      { type: "system", subtype: "task_started", uuid: "t1", task_id: "b1", description: "sleep 1" },
      { type: "system", subtype: "task_notification", uuid: "t2", task_id: "b1", status: "completed", output_file: "", summary: "" },
      { type: "tool_progress", uuid: "p1", tool_use_id: "x", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 3 },
    ];
    expect(run(noise)).toEqual([]);
  });

  it("drops the CLI's echo of a model switch; the session_model part shows it", () => {
    const echo = { type: "user", uuid: "e1", message: { role: "user", content: "<local-command-stdout>Set model to `sonnet (claude-sonnet-5-5)`</local-command-stdout>" }, parent_tool_use_id: null };
    // In a transcript the switch is also recorded as the /model command.
    const command = { ...echo, uuid: "e2", message: { role: "user", content: "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>" } };
    expect(run([echo, command])).toEqual([]);
  });
});

describe("adapter on CLI markup in a transcript (getSessionMessages, SDK 0.3.285)", () => {
  const user = (uuid: string, content: string) => ({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null });
  const texts = (parts: Part[]) => parts.map((p) => (p.type === "user_text" ? p.text : p.type));

  it("shows a slash command record as the prompt the user typed, as live", () => {
    const skill = user("c1", "<command-message>tester-hi</command-message>\n<command-name>/tester-hi</command-name>\n<command-args>Alice</command-args>");
    const noArgs = user("c2", "<command-message>tester-skill</command-message>\n<command-name>/tester-skill</command-name>");
    const local = user("c3", "<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>");
    expect(texts(run([skill, noArgs, local]))).toEqual(["/tester-hi Alice", "/tester-skill", "/context"]);
  });

  it("drops local command output and background task notifications, which live are no user message", () => {
    const stdout = user("s1", "<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>");
    const stderr = user("s2", "<local-command-stderr>Error: nope</local-command-stderr>");
    const notification = user("n1", "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>");
    expect(run([stdout, stderr, notification])).toEqual([]);
  });

  it("keeps a prompt that only mentions the markup", () => {
    expect(texts(run([user("p1", "what does <command-name> mean?")]))).toEqual(["what does <command-name> mean?"]);
  });
});

describe("adapter on unknown messages", () => {
  it("wraps an unknown SDK message in a raw part keyed by uuid", () => {
    const m = { type: "system", subtype: "compact_boundary", uuid: "c1", compact_metadata: { trigger: "auto" } };
    expect(run([m])).toEqual([{ type: "raw", id: "c1", message: m }]);
  });

  it("marks a call denied from result.permission_denials", () => {
    const parts = run([
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] } },
      { type: "result", uuid: "r1", duration_ms: 1, total_cost_usd: 0, usage: {}, is_error: false, permission_denials: [{ tool_use_id: "t1" }] },
    ]);
    expect(parts.filter((p) => p.type === "tool_call").map((p) => p.status)).toEqual(["running", "denied"]);
  });
});

describe("adapter commands", () => {
  const cmd = (name: string, argumentHint = "") => ({ name, description: `${name} desc`, argumentHint });
  const init = (terminal?: string[]) => ({ type: "system", subtype: "init", terminal_slash_commands: terminal }) as never;
  const changed = (names: string[]) => ({ type: "system", subtype: "commands_changed", commands: names.map((n) => cmd(n)) }) as never;
  const names = (parts: Part[]) => parts.flatMap((p) => (p.type === "commands" ? [p.commands.map((c) => c.name)] : []));

  it("turns the supportedCommands() list into a commands part with name, description, argument hint, aliases", () => {
    const parts = createAdapter().commands([{ ...cmd("review", "<pr>"), builtin: true, aliases: ["r"] }]);
    expect(parts).toEqual([{ type: "commands", id: "commands", commands: [{ ...cmd("review", "<pr>"), aliases: ["r"] }] }]);
  });

  it("keeps one row per name, the builtin one, when rows share a name", () => {
    const parts = createAdapter().commands([cmd("init"), { ...cmd("init", "<builtin>"), builtin: true }, cmd("x")]);
    expect(parts[0]!.type === "commands" && parts[0]!.commands).toEqual([cmd("init", "<builtin>"), cmd("x")]);
  });

  it("replaces the list on system/commands_changed", () => {
    const a = createAdapter();
    a.commands([cmd("a")]);
    expect(names(a.convert(changed(["b", "c"])))).toEqual([["b", "c"]]);
  });

  it("hides known terminal-only commands before system/init arrives (it comes only after the first prompt)", () => {
    const a = createAdapter();
    const list = ["doctor", "color", "focus", "reload-plugins", "review"].map((n) => cmd(n));
    expect(names(a.commands(list))).toEqual([["review"]]);
  });

  it("system/init replaces the fallback terminal-only set, re-emitting the known list", () => {
    const a = createAdapter();
    expect(names(a.commands([cmd("doctor"), cmd("review"), cmd("x-term")]))).toEqual([["review", "x-term"]]);
    expect(names(a.convert(init(["x-term", "focus"])))).toEqual([["doctor", "review"]]);
    expect(names(a.convert(changed(["focus", "skill-x"])))).toEqual([["skill-x"]]);
  });

  it("emits nothing on system/init before any list is known", () => {
    expect(createAdapter().convert(init(["doctor"]))).toEqual([]);
  });
});

// Recorded with forwardSubagentText and TodoWrite enabled: TodoWrite, a foreground Agent that Reads a file, Edit, Write.
describe("adapter on recorded edit/todo/subagent session", () => {
  const messages = fixture("edit-todo-subagent.jsonl");
  const parts = run(messages);
  const agentId = messages.find((m) => m.type === "system" && m.subtype === "task_started").tool_use_id as string;

  it("turns each top-level TodoWrite into a todo_update with the full item list", () => {
    const todos = parts.filter((p) => p.type === "todo_update");
    expect(todos.map((p) => p.items.map((i) => i.status))).toEqual([
      ["in_progress", "pending"],
      ["completed", "in_progress"],
      ["completed", "completed"],
    ]);
    expect(todos[0]!.items[0]).toEqual({ content: "Inspect value.ts", status: "in_progress", activeForm: "Inspecting value.ts" });
  });

  it("turns the Agent call into a subagent part (no tool_call) that ends done", () => {
    const subs = parts.filter((p) => p.type === "subagent");
    expect(parts.some((p) => p.type === "tool_call" && p.id === agentId)).toBe(false);
    expect(subs.map((p) => p.status)).toEqual(["pending", "running", "done"]);
    expect(subs.at(-1)).toMatchObject({ id: agentId, toolUseId: agentId, description: "Inspect value.ts" });
  });

  it("tags the subagent's own messages with parentId, and nothing else", () => {
    const children = parts.filter((p) => p.parentId === agentId);
    expect(new Set(children.map((p) => p.type))).toEqual(
      new Set(["user_text", "tool_call", "tool_result", "thinking", "assistant_text"]),
    );
    expect(children.filter((p) => p.type === "tool_call").at(-1)).toMatchObject({ tool: "Read", status: "done" });
    expect(parts.filter((p) => p.parentId && p.parentId !== agentId)).toEqual([]);
    expect(parts.find((p) => p.type === "tool_result" && p.toolUseId === agentId)?.parentId).toBeUndefined();
  });

  it("keeps Edit and Write inputs on their tool_call for the diff", () => {
    const calls = new Map(parts.flatMap((p) => (p.type === "tool_call" ? [[p.tool, p] as const] : [])));
    expect(calls.get("Edit")!.input).toMatchObject({ old_string: "const b = 2;", new_string: "const b = 3;" });
    expect(calls.get("Write")!.input).toMatchObject({ content: "hello\nworld\n" });
  });

  it("drops task lifecycle messages instead of emitting raw parts", () => {
    expect(parts.filter((p) => p.type === "raw")).toEqual([]);
  });
});

describe("adapter on a background subagent", () => {
  const agent = { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "Scan" } }] } };
  const started = { type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "a1", description: "Scan", is_backgrounded: true };
  const result = { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "running in the background" }] } };
  const status = (parts: Part[]) => parts.flatMap((p) => (p.type === "subagent" ? [p.status] : []));

  it("stays running after its placeholder tool_result, ends with task_notification", () => {
    const done = { type: "system", subtype: "task_notification", task_id: "k1", tool_use_id: "a1", status: "completed" };
    expect(status(run([agent, started, result, done]))).toEqual(["running", "done"]);
    expect(status(run([agent, started, result, { ...done, status: "failed" }]))).toEqual(["running", "error"]);
  });

  it("a restored history (no task messages) ends done on the tool_result", () => {
    expect(status(run([agent, result]))).toEqual(["running", "done"]);
  });
});
