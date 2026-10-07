import { describe, expect, it } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { applyEvent, emptySession, timeline } from "./store.ts";
import { artifactSummary, claudeUrl, editFiles, filePath, isClaudeUrl, toolSummary } from "./tools.ts";

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

describe("timeline with subagents", () => {
  const sub: Part = { type: "subagent", id: "s", toolUseId: "s", description: "Scan", status: "running", startedAt: 0 };
  const child = (p: Part): Part => ({ ...p, parentId: "s" });
  const parts = [sub, child(call("a", "Read")), child(call("b", "Read")), text("t"), child(text("u"))];

  it("top level leaves out child parts; a subagent's timeline has only its children, grouped the same way", () => {
    expect(shape(parts)).toEqual(["s", "t"]);
    expect(timeline(view(parts), "s").map((it) => (it.kind === "context" ? `context(${it.calls.length})` : it.part.id))).toEqual([
      "context(2)",
      "u",
    ]);
  });
});

describe("timeline hidden parts", () => {
  const thinking: Part = { type: "thinking", id: "k1", text: "plan", streaming: false };
  const permission: Part = { type: "permission_request", id: "p1", requestId: "p1", toolUseId: "r2", tool: "Read", input: {}, suggestions: [], settled: true };

  it("skips thinking and permission requests, so reads around them still form one context group", () => {
    expect(shape([call("r1", "Read"), thinking, permission, call("r2", "Read")])).toEqual(["context(r1,r2)"]);
  });
});

describe("editFiles", () => {
  it("Edit: old_string -> new_string as whole lines, named by file path", () => {
    expect(editFiles("Edit", { file_path: "/p/a.ts", old_string: "b = 2", new_string: "b = 3" })).toEqual({
      oldFile: { name: "/p/a.ts", contents: "b = 2\n" },
      newFile: { name: "/p/a.ts", contents: "b = 3\n" },
    });
  });

  it("Edit deleting text keeps the new side empty", () => {
    expect(editFiles("Edit", { file_path: "/p/a.ts", old_string: "x", new_string: "" })?.newFile.contents).toBe("");
  });

  it("Write: empty -> content", () => {
    expect(editFiles("Write", { file_path: "/p/n.txt", content: "hi\n" })).toEqual({
      oldFile: { name: "/p/n.txt", contents: "" },
      newFile: { name: "/p/n.txt", contents: "hi\n" },
    });
  });

  it("undefined for other tools and for incomplete input (still streaming)", () => {
    expect(editFiles("Bash", { command: "ls" })).toBeUndefined();
    expect(editFiles("Edit", {})).toBeUndefined();
    expect(editFiles("Write", { file_path: "/p" })).toBeUndefined();
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

describe("filePath", () => {
  it("splits a path inside cwd into file name and relative directory", () => {
    expect(filePath("/w/src/lib/a.ts", "/w")).toEqual({ name: "a.ts", dir: "src/lib" });
    expect(filePath("/w/a.ts", "/w/")).toEqual({ name: "a.ts", dir: "" });
  });

  it("keeps the absolute directory for a path outside cwd, or without cwd", () => {
    expect(filePath("/etc/hosts", "/w")).toEqual({ name: "hosts", dir: "/etc" });
    expect(filePath("/wx/a.ts", "/w")).toEqual({ name: "a.ts", dir: "/wx" });
    expect(filePath("/a.ts", "")).toEqual({ name: "a.ts", dir: "/" });
  });

  it("a Windows path splits on either separator and matches cwd without case", () => {
    expect(filePath("C:\\w\\src\\lib\\a.ts", "C:\\w")).toEqual({ name: "a.ts", dir: "src\\lib" });
    expect(filePath("c:/w/src/a.ts", "C:\\w")).toEqual({ name: "a.ts", dir: "src" });
    expect(filePath("D:\\x\\a.ts", "C:\\w")).toEqual({ name: "a.ts", dir: "D:\\x" });
  });
});

describe("artifact tools", () => {
  const URL = "https://claude.ai/artifact/PoBGcADWcBidR9fyEttcXn";
  it("claudeUrl takes the first claude.ai artifact URL of a text, nothing else", () => {
    expect(claudeUrl(`Published ${URL}.`)).toBe(URL);
    expect(claudeUrl("see https://claude.ai/code/artifact/0a1b-2c")).toBe("https://claude.ai/code/artifact/0a1b-2c");
    expect(claudeUrl("https://evil.example/artifact/x javascript:alert(1)")).toBeUndefined();
    expect(claudeUrl("https://claude.ai.evil.com/artifact/x")).toBeUndefined();
    expect(claudeUrl(undefined)).toBeUndefined();
  });
  it("summary of a publish is the title, else the file name, never the directory", () => {
    expect(artifactSummary("Artifact", { file_path: "/tmp/s/scratch/a.html", title: "Hello" })).toBe("Hello");
    expect(artifactSummary("Artifact", { action: "publish", file_path: "C:\\tmp\\s\\a.html" })).toBe("a.html");
    expect(artifactSummary("Artifact", {})).toBe("");
  });
  it("summary of the other Artifact actions names the action and its target", () => {
    expect(artifactSummary("Artifact", { action: "read", url: URL })).toBe(`Read ${URL}`);
    expect(artifactSummary("Artifact", { action: "list" })).toBe("List");
    expect(artifactSummary("Artifact", { action: "quickstart", intent: "other" })).toBe("Quickstart: other");
  });
  it("summary of comments and data calls", () => {
    expect(artifactSummary("ArtifactComments", { action: "resolve", url: URL, thread_id: "t9" })).toBe(`Resolve ${URL}`);
    expect(artifactSummary("ArtifactData", { action: "get", collection: "votes", doc_id: "d1" })).toBe("Get votes/d1");
    expect(artifactSummary("ArtifactData", { action: "list", collection: "votes" })).toBe("List votes");
    expect(artifactSummary("ArtifactData", { action: "batch" })).toBe("Batch");
    expect(artifactSummary("ArtifactData", undefined)).toBe("");
  });
});

describe("artifact tool edge cases", () => {
  it.each([
    "https://claude.ai@evil.com/artifact/x",
    "https://evil.com@claude.ai/artifact/x",
    "HTTPS://claude.ai/artifact/x",
    "data:text/html,https://claude.ai/artifact/x",
    "https://claude.ai:443/artifact/x",
    "https://claude.ai/artifact/x\n",
    "https://claude.ai/artifact/x/",
    "https://claude.ai/artifact/x?a=1",
    "https://claude.ai/artifact/x#f",
    "javascript:alert(1)",
  ])("isClaudeUrl rejects %j", (u) => expect(isClaudeUrl(u)).toBe(false));
  it("isClaudeUrl accepts both artifact URL forms", () => {
    expect(isClaudeUrl("https://claude.ai/artifact/abc_-1")).toBe(true);
    expect(isClaudeUrl("https://claude.ai/code/artifact/0a1b-2c")).toBe(true);
  });
  it("a publish without title and file_path still gets a label", () => {
    expect(artifactSummary("Artifact", { file_paths: ["a.png", "b.png"], asset: true, url: "u" })).toBe("Artifact upload (2 files)");
    expect(artifactSummary("Artifact", { from_url: "u", asset_ids: ["x"] })).toBe("Artifact copy");
    expect(artifactSummary("Artifact", { type_url: "t" })).toBe("Artifact from type");
  });
  it("action names read as words", () => {
    expect(artifactSummary("ArtifactData", { action: "str_replace", collection: "c", doc_id: "d" })).toBe("Str replace c/d");
  });
});
