import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAdapter, type Part } from "../src/index.ts";

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
});
