import { describe, expect, it } from "vitest";
import type { Part, ToolStatus } from "@claude-ui/protocol";
import { applyEvent, emptySession, type SessionView } from "./store.ts";
import { baseline, callStats, fileStats, sessionChanges } from "./changes.ts";

function view(parts: Part[]): SessionView {
  return parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());
}
const call = (id: string, tool: string, input: object, status: ToolStatus = "done", parentId?: string): Part => ({
  type: "tool_call",
  id,
  toolUseId: id,
  tool,
  input,
  status,
  ...(parentId ? { parentId } : {}),
});
const result = (id: string, output: string, original?: string | null): Part => ({
  type: "tool_result",
  id: `${id}:result`,
  toolUseId: id,
  output,
  isError: false,
  ...(original !== undefined ? { original } : {}),
});
const edit = (file_path: string, old_string: string, new_string: string, replace_all?: boolean) => ({ file_path, old_string, new_string, replace_all });

describe("sessionChanges", () => {
  it("lists files of successful Edit/Write calls in first-change order, subagent calls included", () => {
    const s = view([
      call("e1", "Edit", edit("/p/b.ts", "x", "y")),
      call("r1", "Read", { file_path: "/p/c.ts" }),
      call("w1", "Write", { file_path: "/p/a.ts", content: "a\n" }, "done", "agent1"),
      call("e2", "Edit", edit("/p/b.ts", "y", "z")),
      call("e3", "Edit", edit("/p/d.ts", "x", "y"), "error"),
      call("e4", "Edit", edit("/p/e.ts", "x", "y"), "denied"),
      call("e5", "Edit", edit("/p/f.ts", "x", "y"), "running"),
    ]);
    expect(sessionChanges(s).map((c) => [c.path, c.calls.map((x) => x.id)])).toEqual([
      ["/p/b.ts", ["e1", "e2"]],
      ["/p/a.ts", ["w1"]],
    ]);
  });

  it("takes the original file from the daemon's tool_result", () => {
    const s = view([call("e1", "Edit", edit("/p/b.ts", "x", "y")), result("e1", "ok", "x\n"), call("w1", "Write", { file_path: "/p/n.ts", content: "" }), result("w1", "ok", null)]);
    expect(sessionChanges(s).map((c) => c.original)).toEqual(["x\n", null]);
  });

  it("ignores a later call's original: after a daemon restart the first new edit's original is the file after the earlier edits", () => {
    // e1 restored from the transcript (no original), e2 live after the restart: its original already contains e1.
    const c = sessionChanges(view([call("e1", "Edit", edit("/f", "a = 1", "a = 2")), call("e2", "Edit", edit("/f", "b = 1", "b = 2")), result("e2", "ok", "a = 2\nb = 1\n")]))[0]!;
    expect(c.original).toBeUndefined();
    const before = baseline("a = 2\nb = 2\n", c)!;
    expect(before).toBe("a = 1\nb = 1\n");
    expect(fileStats(before, "a = 2\nb = 2\n", "f")).toEqual({ added: 2, removed: 2 });
  });
});

describe("baseline", () => {
  const changes = (parts: Part[]) => sessionChanges(view(parts))[0]!;

  it("is the daemon's original when known; null (created) is empty", () => {
    expect(baseline("y\n", changes([call("e1", "Edit", edit("/f", "x", "y")), result("e1", "ok", "x\n")]))).toBe("x\n");
    expect(baseline("new\n", changes([call("w1", "Write", { file_path: "/f", content: "new\n" }), result("w1", "ok", null)]))).toBe("");
  });

  it("undoes the edits backwards from the disk content without an original", () => {
    const c = changes([call("e1", "Edit", edit("/f", "b = 2", "b = 3")), call("e2", "Edit", edit("/f", "a = 1", "a = $&")), call("e3", "Edit", edit("/f", "q", "r", false))]);
    expect(baseline("a = $&\nb = 3\nr\n", c)).toBe("a = 1\nb = 2\nq\n");
  });

  it("is empty for a created file, undefined when undoing is ambiguous", () => {
    expect(baseline("n\n", changes([call("w1", "Write", { file_path: "/f", content: "n\n" }), result("w1", "File created successfully at: /f")]))).toBe("");
    expect(baseline("n\n", changes([call("w1", "Write", { file_path: "/f", content: "n\n" }), result("w1", "The file /f has been updated successfully.")]))).toBeUndefined();
    expect(baseline("y y\n", changes([call("e1", "Edit", edit("/f", "x", "y"))]))).toBeUndefined();
    expect(baseline("a\n", changes([call("e1", "Edit", edit("/f", "gone\n", ""))]))).toBeUndefined();
    expect(baseline("edited elsewhere\n", changes([call("e1", "Edit", edit("/f", "x", "y"))]))).toBeUndefined();
    // Overlapping matches: "ab" with b → aa is "aaa"; "aa" sits at 0 and 1, undoing at 0 would give "ba".
    expect(baseline("aaa", changes([call("e1", "Edit", edit("/f", "b", "aa"))]))).toBeUndefined();
    // A Write after the first call: the file before it is unknown.
    expect(baseline("n\n", changes([call("e1", "Edit", edit("/f", "x", "y")), call("w1", "Write", { file_path: "/f", content: "n\n" }), result("w1", "File created successfully at: /f")]))).toBeUndefined();
  });

  it("is undefined for a replace_all edit: the disk cannot tell the replaced text from the same text that was there before", () => {
    // File "y\nx\n", Edit x → y replace_all, disk "y\ny\n": undoing every y would give "x\nx\n", not the true "y\nx\n".
    expect(baseline("y\ny\n", changes([call("e1", "Edit", edit("/f", "x", "y", true))]))).toBeUndefined();
  });
});

describe("stats", () => {
  it("counts added and removed lines of the whole-file diff, or of the calls", () => {
    expect(fileStats("a\nb\n", "a\nc\nd\n", "f")).toEqual({ added: 2, removed: 1 });
    const c = sessionChanges(view([call("e1", "Edit", edit("/f", "x", "y\nz")), call("w1", "Write", { file_path: "/f", content: "1\n2\n" })]))[0]!;
    expect(callStats(c)).toEqual({ added: 4, removed: 1 });
  });
});
