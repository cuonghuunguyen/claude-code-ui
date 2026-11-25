import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeDigestEvents, syntheticTranscript } from "./quick-compact-claude.ts";

const row = (type: "user" | "assistant", content: unknown, more: object = {}) => ({ type, uuid: "u", session_id: "s", parent_tool_use_id: null, parent_agent_id: null, message: { role: type, content }, ...more }) as unknown as SessionMessage;

describe("quick compact, Claude", () => {
  it("digests the SDK main chain: summary as earlier, no meta, no subagent rows", () => {
    const main = [
      row("user", "SUMMARY TEXT", { isCompactSummary: true }),
      row("user", "<system-reminder>x</system-reminder>meta", { is_meta: true }),
      row("user", "do it"),
      row("assistant", [{ type: "text", text: "sure" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }]),
      row("assistant", [{ type: "text", text: "SUBAGENT" }], { parent_tool_use_id: "t9" }),
      row("user", [{ type: "tool_result", tool_use_id: "t1", content: "hi", is_error: false }]),
    ];
    const { earlier, events } = claudeDigestEvents(main);
    expect(earlier).toBe("SUMMARY TEXT");
    expect(events).toEqual([{ kind: "user", text: "do it" }, { kind: "assistant", text: "sure" }, { kind: "tool", name: "Bash", input: { command: "echo hi" }, out: "hi", err: false }]);
  });

  it("writes a transcript the CLI resumes: digest row and a synthetic ack", () => {
    let n = 0;
    const lines = syntheticTranscript({ id: "new", cwd: "/p", digest: "DIGEST", now: new Date(0), uuid: () => `id-${++n}` }).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "user", parentUuid: null, sessionId: "new", cwd: "/p", message: { role: "user", content: "DIGEST" } });
    expect(lines[1]).toMatchObject({ type: "assistant", parentUuid: lines[0].uuid, sessionId: "new", message: { model: "<synthetic>" } });
  });
});
