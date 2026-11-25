import { describe, expect, it } from "vitest";
import type { OpenCodeMessage } from "./opencode-parts.ts";
import type { OpenCode2Message } from "./opencode2-parts.ts";
import { oc1DigestEvents, oc2DigestEvents } from "./quick-compact-opencode.ts";

const m1 = (id: string, role: "user" | "assistant", parts: OpenCodeMessage["parts"]): OpenCodeMessage => ({ info: { id, role }, parts });

describe("quick compact, OpenCode", () => {
  it("OpenCode 1: digests from the last compaction, tool parts with input and output", () => {
    const messages = [
      m1("m1", "user", [{ id: "p1", type: "text", text: "BEFORE" }]),
      m1("m2", "user", [{ id: "p2", type: "compaction" }]),
      m1("m3", "assistant", [{ id: "p3", type: "text", text: "SUMMARY" }]),
      m1("m4", "user", [{ id: "p4", type: "text", text: "run it" }, { id: "p5", type: "text", text: "hidden", synthetic: true }]),
      m1("m5", "assistant", [
        { id: "p6", type: "reasoning", text: "thinking" },
        { id: "p7", type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "ls" }, output: "a\nb" } },
        { id: "p8", type: "tool", tool: "read", callID: "c2", state: { status: "error", input: { filePath: "/x" }, error: "nope" } },
        { id: "p9", type: "tool", tool: "grep", callID: "c3", state: { status: "running", input: { pattern: "x" } } },
        { id: "p10", type: "text", text: "done" },
      ]),
    ];
    const { earlier, events } = oc1DigestEvents(messages);
    expect(earlier).toBe("SUMMARY");
    expect(events).toEqual([
      { kind: "user", text: "run it" },
      { kind: "tool", name: "bash", input: { command: "ls" }, out: "a\nb", err: false },
      { kind: "tool", name: "read", input: { filePath: "/x" }, out: "nope", err: true },
      { kind: "tool", name: "grep", input: { pattern: "x" } },
      { kind: "assistant", text: "done" },
    ]);
  });

  it("OpenCode 2: digests from the last compaction, shell as bash, an earlier digest as earlier", () => {
    const messages = [
      { id: "a", type: "user", text: "OLD" },
      { id: "b", type: "synthetic", text: "[claude-ui quick compact] source=ses_old\nDIGEST", metadata: { source: "quick-compact" } },
      { id: "c", type: "synthetic", text: "<shell>x</shell>", metadata: { source: "shell" } },
      { id: "d", type: "user", text: "next" },
      { id: "e", type: "shell", shellID: "sh_1", command: "pwd", status: "exited", exit: 0, output: { output: "/p" } },
      { id: "f", type: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool", id: "t1", name: "read", state: { status: "completed", input: { path: "/a" }, content: [{ type: "text", text: "body" }] } }] },
    ] as OpenCode2Message[];
    const { earlier, events } = oc2DigestEvents(messages);
    expect(earlier).toContain("DIGEST");
    expect(events).toEqual([
      { kind: "user", text: "next" },
      { kind: "tool", name: "bash", input: { command: "pwd" }, out: "/p", err: false },
      { kind: "assistant", text: "ok" },
      { kind: "tool", name: "read", input: { path: "/a" }, out: "body", err: false },
    ]);
    const compacted = oc2DigestEvents([{ id: "z", type: "user", text: "gone" }, { id: "y", type: "compaction", summary: "S2", status: "done" }, { id: "x", type: "user", text: "kept" }] as OpenCode2Message[]);
    expect(compacted).toEqual({ earlier: "S2", events: [{ kind: "user", text: "kept" }] });
  });
});
