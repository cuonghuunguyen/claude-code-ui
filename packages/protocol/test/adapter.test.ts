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
