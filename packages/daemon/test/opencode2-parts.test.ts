// The OpenCode 2 part mapper: a turn read live and the same turn read from storage give the same part ids (a restore replaces the live parts instead of adding to them).
import { expect, it } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { OpenCode2Mapper, type OpenCode2Message } from "../src/opencode2-parts.ts";

const A = "msg_a1";
const base = { sessionID: "ses_1", assistantMessageID: A };

it("a turn has the same part ids live and from storage: reasoning, text and tool call with its result, per kind ordinals", () => {
  const live = new OpenCode2Mapper();
  const events: [string, Record<string, any>][] = [
    ["session.reasoning.started", { ...base, ordinal: 0 }],
    ["session.reasoning.delta", { ...base, ordinal: 0, delta: "hm" }],
    ["session.reasoning.ended", { ...base, ordinal: 0, text: "hm" }],
    ["session.tool.input.started", { ...base, id: "call_1", name: "read" }],
    ["session.tool.called", { ...base, id: "call_1", input: { path: "a.txt" } }],
    ["session.tool.success", { ...base, id: "call_1", content: [{ type: "text", text: "A" }], metadata: {} }],
    ["session.text.started", { ...base, ordinal: 0 }],
    ["session.text.delta", { ...base, ordinal: 0, delta: "ok" }],
    ["session.text.ended", { ...base, ordinal: 0, text: "ok" }],
  ];
  const liveParts = events.flatMap(([t, d]) => live.event(t, d));
  const stored: OpenCode2Message = {
    id: A,
    type: "assistant",
    content: [
      { type: "reasoning", text: "hm" },
      { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { path: "a.txt" }, content: [{ type: "text", text: "A" }] }, time: { created: 1 } },
      { type: "text", text: "ok" },
    ],
  };
  const stored2 = new OpenCode2Mapper().history([stored]);
  const ids = (parts: Part[]) => [...new Set(parts.map((p) => p.id))].sort();
  expect(ids(stored2)).toEqual(ids(liveParts));
  expect(ids(stored2)).toEqual(["call_1", "call_1:result", `${A}:reasoning:0`, `${A}:text:0`]);
  // The Claude card shape of OpenCode 2's `read` (`path` is `file_path`).
  expect(stored2.find((p) => p.id === "call_1")).toMatchObject({ tool: "Read", input: { file_path: "a.txt" }, status: "done" });
  expect([...liveParts].reverse().find((p) => p.id === "call_1")).toMatchObject({ tool: "Read", input: { file_path: "a.txt" }, status: "done" });
});

it("a turn's tokens are the sum of its steps and a new turn starts from zero", () => {
  const m = new OpenCode2Mapper();
  m.step("m1", { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } }, 0.5);
  m.step("m2", { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 3 } }, 0.25);
  expect(m.turn()).toEqual({ usage: { inputTokens: 30, outputTokens: 17, cacheReadTokens: 1, cacheCreationTokens: 3 }, cost: 0.75 });
  m.resetTurn();
  expect(m.turn().usage.inputTokens).toBe(0);
});
