import { describe, expect, it } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { applyEvent, emptySession, timeline } from "./store.ts";
import { toolSummary } from "./tools.ts";

const call = (id: string, tool: string, input: unknown = {}): Part => ({
  type: "tool_call",
  id,
  toolUseId: id,
  tool,
  input,
  status: "done",
});
const result = (id: string): Part => ({ type: "tool_result", id: `${id}:result`, toolUseId: id, output: "ok", isError: false });
const text = (id: string): Part => ({ type: "assistant_text", id, text: id, streaming: false });

const view = (parts: Part[]) => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());
const shape = (parts: Part[]) =>
  timeline(view(parts)).map((it) => (it.kind === "context" ? `context(${it.calls.map((c) => c.id).join(",")})` : it.part.id));

describe("timeline", () => {
  it("merges consecutive Read/Grep/Glob calls into one context group, skipping their results", () => {
    expect(shape([call("a", "Read"), call("b", "Grep"), result("a"), call("c", "Glob"), result("b"), result("c")])).toEqual([
      "context(a,b,c)",
    ]);
  });

  it("keeps a single context call and non-context calls as plain tool cards", () => {
    expect(shape([call("a", "Read"), result("a"), call("b", "Bash"), result("b"), call("c", "Read")])).toEqual(["a", "b", "c"]);
  });

  it("a non-context part ends the group", () => {
    expect(shape([call("a", "Read"), call("b", "Read"), text("t"), call("c", "Read"), call("d", "Glob")])).toEqual([
      "context(a,b)",
      "t",
      "context(c,d)",
    ]);
  });

  it("uses the tool_call replaced by a later status update", () => {
    const [item] = timeline(view([call("a", "Read"), call("b", "Read"), { ...(call("a", "Read") as object), status: "error" } as Part]));
    expect(item!.kind === "context" && item!.calls[0]!.status).toBe("error");
  });
});

describe("toolSummary", () => {
  it("picks the most telling input field as one line", () => {
    expect(toolSummary({ file_path: "/a/b.ts", limit: 3 })).toBe("/a/b.ts");
    expect(toolSummary({ description: "List files", command: "ls -la\nwc -l" })).toBe("ls -la");
    expect(toolSummary({ pattern: "foo", path: "src" })).toBe("foo");
    expect(toolSummary({ other: 1, name: "x" })).toBe("x");
    expect(toolSummary({})).toBe("");
    expect(toolSummary("raw")).toBe("");
  });
});
