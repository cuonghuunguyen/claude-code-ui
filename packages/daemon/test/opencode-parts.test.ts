import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openCodeParts, type OpenCodeMessage } from "../src/opencode-parts.ts";
import { olderThan, parseVersion } from "../src/opencode-server.ts";

const history = JSON.parse(readFileSync(new URL("./fixtures/opencode/history.json", import.meta.url), "utf8")) as OpenCodeMessage[];

describe("openCodeParts", () => {
  it("maps text, reasoning and tool parts in order and skips the other part types", () => {
    expect(openCodeParts(history)).toEqual([
      { type: "user_text", id: "prt_u1", text: "list the files", images: [] },
      { type: "thinking", id: "prt_a1", text: "I should run ls", streaming: false },
      { type: "tool_call", id: "call_1", toolUseId: "call_1", tool: "bash", input: { command: "ls" }, status: "done" },
      { type: "tool_result", id: "call_1:result", toolUseId: "call_1", output: "a.txt\nb.txt", isError: false },
      { type: "tool_call", id: "call_2", toolUseId: "call_2", tool: "read", input: { filePath: "/nope" }, status: "error" },
      { type: "tool_result", id: "call_2:result", toolUseId: "call_2", output: "file not found", isError: true },
      { type: "tool_call", id: "call_3", toolUseId: "call_3", tool: "bash", input: { command: "sleep 9" }, status: "running" },
      { type: "assistant_text", id: "prt_a6", text: "There are two files.", streaming: false },
    ]);
  });
});

describe("version compare", () => {
  it("reads x.y.z from any text and compares numbers, not strings", () => {
    expect(parseVersion("opencode 1.18.34\n")).toEqual([1, 18, 34]);
    expect(parseVersion("dev")).toBeUndefined();
    expect(olderThan([1, 9, 0], [1, 18, 0])).toBe(true);
    expect(olderThan([1, 18, 0], [1, 18, 0])).toBe(false);
    expect(olderThan([2, 0, 0], [1, 18, 0])).toBe(false);
  });
});
