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

it("a bash mode command and a compaction show the same parts live and from storage (shapes of OpenCode 2.3.0)", () => {
  const live = new OpenCode2Mapper();
  const compaction = [
    ...live.event("session.compaction.started", { sessionID: "ses_1", reason: "manual", inputID: "msg_c1" }),
    ...live.event("session.compaction.ended", { sessionID: "ses_1", reason: "manual", text: "## Objective\n- x" }),
  ];
  const failed = [
    ...live.event("session.compaction.started", { sessionID: "ses_1", reason: "manual", inputID: "msg_c2" }),
    ...live.event("session.compaction.failed", { sessionID: "ses_1", reason: "manual", error: { type: "compaction.unavailable", message: "Nothing to compact yet" } }),
  ];
  const stored = new OpenCode2Mapper().history([
    { id: "msg_s1", type: "shell", shellID: "sh_1", command: "echo hi; exit 4", status: "exited", exit: 4, output: { output: "hi\n" } },
    { id: "msg_s2", type: "shell", shellID: "sh_2", command: "sleep 30", status: "killed", output: { output: "Shell command output is no longer available." } },
    { id: "msg_c1", type: "compaction", status: "completed", reason: "manual", summary: "## Objective\n- x" },
    { id: "msg_c2", type: "compaction", status: "failed", reason: "manual", error: { type: "compaction.unavailable", message: "Nothing to compact yet" } },
  ]);
  expect(stored.slice(0, 2)).toEqual([
    { type: "bash", id: "sh_1", command: "echo hi; exit 4", stdout: "hi\n", stderr: "", status: "error", exitCode: 4 },
    { type: "bash", id: "sh_2", command: "sleep 30", stdout: "Shell command output is no longer available.", stderr: "", status: "stopped" },
  ]);
  expect(stored.slice(2)).toEqual([compaction.at(-1), failed.at(-2), failed.at(-1)]);
  expect(stored.slice(2)).toEqual([
    { type: "compaction", id: "msg_c1", trigger: "manual", summary: "## Objective\n- x" },
    { type: "compaction", id: "msg_c2", trigger: "manual" },
    { type: "notice", id: "error:msg_c2", level: "warning", text: "Nothing to compact yet" },
  ]);
});

it("a Fork card that ends live keeps the start time of its running card (the end event carries only the end time)", async () => {
  const { FORK_TOOL } = await import("../src/opencode-fork.ts");
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  try {
    const m = new OpenCode2Mapper();
    m.event("session.tool.input.started", { ...base, id: "call_f", name: FORK_TOOL });
    const [running] = m.event("session.tool.called", { ...base, id: "call_f", input: { description: "task" } }) as any[];
    vi.advanceTimersByTime(1500);
    const [done] = m.event("session.tool.success", { ...base, id: "call_f", content: [], metadata: {} }) as any[];
    expect(done.startedAt).toBe(running.startedAt);
    expect(done.endedAt - done.startedAt).toBe(1500);
  } finally {
    vi.useRealTimers();
  }
});

const TODOS = [
  { content: "a", status: "pending" },
  { content: "b", status: "in_progress" },
  { content: "c", status: "completed" },
  { content: "d", status: "cancelled" },
  { content: "", status: "pending" },
  { content: "e", status: "weird" },
];
const ITEMS = [
  { content: "a", status: "pending" },
  { content: "b", status: "in_progress" },
  { content: "c", status: "completed" },
  { content: "d", status: "completed" },
  { content: "e", status: "pending" },
];

it("a completed todowrite call of the session is also a todo_update, live; a failed one is not", () => {
  const m = new OpenCode2Mapper({ todos: true });
  const run = (id: string, end: string) => {
    const before = [...m.event("session.tool.input.started", { ...base, id, name: "todowrite" }), ...m.event("session.tool.called", { ...base, id, input: { todos: TODOS } })];
    return { before, after: m.event(end, { ...base, id, content: [], error: { message: "x" }, metadata: {} }) };
  };
  const ok = run("call_t", "session.tool.success");
  expect(ok.before.some((p) => p.type === "todo_update")).toBe(false);
  const card = ok.after.find((p) => p.type === "tool_call") as any;
  expect(card.tool).toBe("TodoWrite");
  expect(card.input.todos).toEqual(ITEMS);
  expect(ok.after.some((p) => p.type === "tool_result")).toBe(true);
  expect(ok.after.find((p) => p.type === "todo_update")).toEqual({ type: "todo_update", id: "call_t:todos", items: ITEMS });
  expect(run("call_u", "session.tool.failed").after.some((p) => p.type === "todo_update")).toBe(false);
});

it("a completed todowrite call in history is a todo_update with the same id", () => {
  const msg: OpenCode2Message = { id: A, type: "assistant", content: [{ type: "tool", id: "call_t", name: "todowrite", state: { status: "completed", input: { todos: TODOS }, content: [] }, time: { created: 1 } }] };
  const parts = new OpenCode2Mapper({ todos: true }).history([msg]);
  expect(parts.find((p) => p.type === "todo_update")).toEqual({ type: "todo_update", id: "call_t:todos", items: ITEMS });
});

it("a mapper without the todos option (inline and Fork runs) emits no todo_update", () => {
  const m = new OpenCode2Mapper();
  m.event("session.tool.input.started", { ...base, id: "call_t", name: "todowrite" });
  m.event("session.tool.called", { ...base, id: "call_t", input: { todos: TODOS } });
  const parts = m.event("session.tool.success", { ...base, id: "call_t", content: [], metadata: {} });
  expect(parts.some((p) => p.type === "todo_update")).toBe(false);
  expect(parts.some((p) => p.type === "tool_call")).toBe(true);
});
