import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alwaysOf, modeBlock, modeOf, splitLabels } from "../src/opencode-engine.ts";
import { mapTool, OpenCodeMapper, openCodeParts, type OpenCodeMessage } from "../src/opencode-parts.ts";
import { olderThan, parseVersion } from "../src/opencode-server.ts";

const history = JSON.parse(readFileSync(new URL("./fixtures/opencode/history.json", import.meta.url), "utf8")) as OpenCodeMessage[];

describe("openCodeParts", () => {
  it("maps a user message to one user_text with the message id, text, reasoning and tool parts with Claude card names; skips the other part types", () => {
    expect(openCodeParts(history)).toEqual([
      { type: "user_text", id: "msg_u1", text: "list the files", images: [] },
      { type: "thinking", id: "prt_a1", text: "I should run ls", streaming: false },
      { type: "tool_call", id: "call_1", toolUseId: "call_1", tool: "Bash", input: { command: "ls" }, status: "done", startedAt: 1, endedAt: 2 },
      { type: "tool_result", id: "call_1:result", toolUseId: "call_1", output: "a.txt\nb.txt", isError: false },
      { type: "tool_call", id: "call_2", toolUseId: "call_2", tool: "Read", input: { file_path: "/nope" }, status: "error", startedAt: 1, endedAt: 2 },
      { type: "tool_result", id: "call_2:result", toolUseId: "call_2", output: "file not found", isError: true },
      { type: "tool_call", id: "call_3", toolUseId: "call_3", tool: "Bash", input: { command: "sleep 9" }, status: "running", startedAt: 1 },
      { type: "assistant_text", id: "prt_a6", text: "There are two files.", streaming: false },
    ]);
  });
});

describe("mapTool", () => {
  it("renames the tools and their inputs to the Claude cards; other tools stay as sent", () => {
    expect(mapTool("edit", { filePath: "/a", oldString: "x", newString: "y", replaceAll: true })).toEqual({ tool: "Edit", input: { file_path: "/a", old_string: "x", new_string: "y", replace_all: true } });
    expect(mapTool("grep", { pattern: "p", include: "*.ts" })).toEqual({ tool: "Grep", input: { pattern: "p", glob: "*.ts" } });
    expect(mapTool("question", { questions: [{ question: "q", multiple: true }, { question: "r" }] }).input).toEqual({ questions: [{ question: "q", multiSelect: true }, { question: "r", multiSelect: false }] });
    expect(mapTool("apply_patch", { patchText: "x" })).toEqual({ tool: "apply_patch", input: { patchText: "x" } });
  });
});

describe("OpenCodeMapper (live)", () => {
  const tool = (state: object, extra = {}) => ({ id: "prt_t", messageID: "msg_a", sessionID: "ses_1", type: "tool", tool: "bash", callID: "call_x", state, ...extra }) as never;
  const ready = () => {
    const m = new OpenCodeMapper();
    m.message({ id: "msg_a", role: "assistant" });
    return m;
  };

  it("a text part streams: deltas extend it, its end time finishes it", () => {
    const m = ready();
    expect(m.part({ id: "prt_x", messageID: "msg_a", type: "text", text: "", time: { start: 1 } })).toEqual([{ type: "assistant_text", id: "prt_x", text: "", streaming: true }]);
    expect(m.delta("prt_x", "Hel")).toEqual([{ type: "assistant_text", id: "prt_x", text: "Hel", streaming: true }]);
    expect(m.part({ id: "prt_x", messageID: "msg_a", type: "text", text: "Hello", time: { start: 1, end: 2 } })).toEqual([{ type: "assistant_text", id: "prt_x", text: "Hello", streaming: false }]);
    expect(m.delta("prt_unknown", "x")).toEqual([]);
  });

  it("a denied call stays denied when its error update comes", () => {
    const m = ready();
    m.part(tool({ status: "running", input: { command: "pwd" } }));
    expect(m.deny("call_x")).toMatchObject({ tool: "Bash", status: "denied" });
    expect(m.part(tool({ status: "error", input: { command: "pwd" }, error: "rejected" }))).toEqual([
      expect.objectContaining({ type: "tool_call", status: "denied" }),
      { type: "tool_result", id: "call_x:result", toolUseId: "call_x", output: "rejected", isError: true },
    ]);
  });

  it("a task call is a subagent part; the parts of its child session carry its call id; todo status cancelled counts as completed", () => {
    const m = ready();
    const [sub] = m.part(tool({ status: "running", input: { description: "dig" }, metadata: { sessionId: "ses_kid" }, time: { start: 7 } }, { tool: "task", callID: "call_task" }));
    expect(sub).toEqual({ type: "subagent", id: "call_task", toolUseId: "call_task", description: "dig", status: "running", startedAt: 7 });
    m.message({ id: "msg_k", role: "assistant" });
    expect(m.part({ id: "prt_k", messageID: "msg_k", sessionID: "ses_kid", type: "text", text: "hi", time: { start: 1, end: 2 } })).toEqual([{ type: "assistant_text", id: "prt_k", text: "hi", streaming: false, parentId: "call_task" }]);
    expect(m.todos("ses_1", [{ content: "a", status: "cancelled" }, { content: "b", status: "in_progress" }])).toEqual({ type: "todo_update", id: "ses_1:todos", items: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }] });
  });

  it("the echo of an own user message adds nothing; a user message of OpenCode's own UI is one user_text with its text and images; synthetic parts are left out", () => {
    const m = new OpenCodeMapper();
    m.own.add("msg_own");
    m.message({ id: "msg_own", role: "user" });
    expect(m.part({ id: "prt_1", messageID: "msg_own", type: "text", text: "mine" })).toEqual([]);
    // A part may come before its message.updated: it waits.
    expect(m.part({ id: "prt_2", messageID: "msg_tui", type: "text", text: "from tui" })).toEqual([]);
    expect(m.message({ id: "msg_tui", role: "user" })).toEqual([{ type: "user_text", id: "msg_tui", text: "from tui", images: [] }]);
    expect(m.part({ id: "prt_3", messageID: "msg_tui", type: "file", mime: "image/png", url: "data:image/png;base64,AA" })).toEqual([{ type: "user_text", id: "msg_tui", text: "from tui", images: ["data:image/png;base64,AA"] }]);
    expect(m.part({ id: "prt_4", messageID: "msg_tui", type: "text", text: "hidden", synthetic: true })).toEqual([{ type: "user_text", id: "msg_tui", text: "from tui", images: ["data:image/png;base64,AA"] }]);
  });

  it("a compaction marker of a user message is a compaction part (manual or auto), also when it comes before its message", () => {
    const m = new OpenCodeMapper();
    m.message({ id: "msg_c1", role: "user" });
    expect(m.part({ id: "prt_c1", messageID: "msg_c1", type: "compaction", auto: false })).toEqual([{ type: "compaction", id: "prt_c1", trigger: "manual" }]);
    expect(m.part({ id: "prt_c2", messageID: "msg_c2", type: "compaction", auto: true })).toEqual([]);
    expect(m.message({ id: "msg_c2", role: "user" })).toEqual([{ type: "compaction", id: "prt_c2", trigger: "auto" }]);
  });

  it("step-finish tokens and cost are summed per turn", () => {
    const m = ready();
    m.part({ id: "prt_s1", messageID: "msg_a", type: "step-finish", tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 3 } }, cost: 0.5 });
    m.part({ id: "prt_s2", messageID: "msg_a", type: "step-finish", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }, cost: 0.25 });
    m.part({ id: "prt_s2", messageID: "msg_a", type: "step-finish", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }, cost: 0.25 });
    expect(m.turn()).toEqual({ usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 5, cacheCreationTokens: 3 }, cost: 0.75 });
    m.resetTurn();
    expect(m.turn().cost).toBe(0);
    // Stored history is not part of the running turn.
    m.part({ id: "prt_old", messageID: "msg_a", type: "step-finish", tokens: { input: 99 }, cost: 9 }, false);
    expect(m.turn().cost).toBe(0);
  });
});

describe("permission blocks", () => {
  const rule = (permission: string, pattern: string, action = "allow") => ({ permission, pattern, action }) as never;
  it("a block carries its mode and always marker; alwaysOf and modeOf read the last ones back", () => {
    const block = modeBlock("acceptEdits", [rule("bash", "ls *")], []);
    expect(block[0]).toEqual(rule("claude-ui", "mode:acceptEdits"));
    expect(block).toContainEqual(rule("edit", "*"));
    const rules = [rule("bash", "old *"), ...block, ...modeBlock("default", [rule("bash", "ls *"), rule("bash", "cat *")], [])];
    expect(modeOf(rules)).toBe("default");
    expect(alwaysOf(rules)).toEqual([rule("bash", "ls *"), rule("bash", "cat *")]);
    expect(modeOf([rule("bash", "x")])).toBeUndefined();
    // bypass also allows outside-folder access and repeated calls; other modes do not.
    expect(modeBlock("bypassPermissions", [], [])).toEqual(expect.arrayContaining([rule("external_directory", "*"), rule("doom_loop", "*")]));
    expect(modeBlock("default", [], []).filter((r) => ["external_directory", "doom_loop"].includes(r.permission))).toEqual([]);
    expect(alwaysOf([rule("bash", "x")])).toEqual([]);
    // readOnly: the edit deny comes after the mode's edit rule and before the always marker.
    const ro = modeBlock("bypassPermissions", [], [], { readOnly: true });
    expect(ro.slice(-2)).toEqual([rule("edit", "*", "deny"), rule("claude-ui", "always")]);
  });

  it("orchestration rules: every block hides all orchestration servers; an attached one allows its own tools and asks for worker_start except in bypass", () => {
    expect(modeBlock("default", [], [])).toContainEqual(rule("orchestration-*", "*", "deny"));
    expect(modeBlock("default", [], [], { mcp: "orchestration-abcdefghij" }).slice(-4, -1)).toEqual([rule("orchestration-*", "*", "deny"), rule("orchestration-abcdefghij_*", "*"), rule("orchestration-abcdefghij_worker_start", "*", "ask")]);
    expect(modeBlock("bypassPermissions", [], [], { mcp: "orchestration-abcdefghij" }).slice(-3, -1)).toEqual([rule("orchestration-*", "*", "deny"), rule("orchestration-abcdefghij_*", "*")]);
    expect(mapTool("orchestration-abcdefghij_worker_list", { tree: true })).toEqual({ tool: "mcp__orchestration__worker_list", input: { tree: true } });
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

describe("splitLabels", () => {
  it("cuts a multi-select answer at the option labels, keeps a label with a comma whole and the rest as one text", () => {
    expect(splitLabels("Red, Blue", ["Red", "Blue"])).toEqual(["Red", "Blue"]);
    expect(splitLabels("Yes, always, Blue", ["Yes", "Yes, always", "Blue"])).toEqual(["Yes, always", "Blue"]);
    expect(splitLabels("Red, my own idea", ["Red", "Blue"])).toEqual(["Red", "my own idea"]);
    expect(splitLabels("", ["Red"])).toEqual([]);
  });
});
