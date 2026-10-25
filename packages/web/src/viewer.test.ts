import { readFileSync } from "node:fs";
import { createAdapter, type Part } from "@claude-ui/protocol";
import { expect, it } from "vitest";
import { applyEvent, emptySession, type ToolCall } from "./store.ts";
import { cardTarget, isFileTarget, latestPlan, latestPlanCall, planWaiting } from "./viewer.ts";

const call = (tool: string, input: unknown, id = tool): ToolCall => ({ type: "tool_call", id, toolUseId: id, tool, input, status: "done" });
const view = (parts: Part[]) => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s1", seq: i + 1, part }), emptySession());

it("cardTarget: a Read opens its file at its offset", () => {
  expect(cardTarget(call("Read", { file_path: "/w/a.ts", offset: 40, limit: 10 }))).toEqual({ kind: "file", path: "/w/a.ts", line: 40 });
  expect(cardTarget(call("Read", { file_path: "/w/a.ts" }))).toEqual({ kind: "file", path: "/w/a.ts", line: undefined });
  expect(cardTarget(call("Read", { file_path: "/w/a.ts", offset: 1 }))).toEqual({ kind: "file", path: "/w/a.ts", line: undefined });
});

it("cardTarget: an Edit or Write with a complete input opens its diff; a streaming one opens nothing", () => {
  const edit = call("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" });
  expect(cardTarget(edit)).toEqual({ kind: "diff", call: edit });
  const write = call("Write", { file_path: "/w/a.ts", content: "x" });
  expect(cardTarget(write)).toEqual({ kind: "diff", call: write });
  expect(cardTarget(call("Edit", { file_path: "/w/a.ts" }))).toBeUndefined();
});

it("cardTarget: ExitPlanMode opens its plan; Bash, TodoWrite and an empty plan open nothing", () => {
  expect(cardTarget(call("ExitPlanMode", { plan: "# P" }))).toEqual({ kind: "plan", plan: "# P" });
  expect(cardTarget(call("ExitPlanMode", { plan: "" }))).toBeUndefined();
  expect(cardTarget(call("Bash", { command: "ls" }))).toBeUndefined();
  expect(cardTarget(call("TodoWrite", { todos: [] }))).toBeUndefined();
});

it("latestPlan returns the newest ExitPlanMode plan, undefined without one", () => {
  expect(latestPlan(view([call("ExitPlanMode", { plan: "old" }, "a"), call("ExitPlanMode", { plan: "new" }, "b")]))).toBe("new");
  expect(latestPlan(view([call("Bash", { command: "ls" })]))).toBeUndefined();
});

it("isFileTarget: only a file target opens the file dialog; diff, plan and changes stay in the popup", () => {
  expect(isFileTarget({ kind: "file", path: "/w/a.ts" })).toBe(true);
  expect(isFileTarget({ kind: "plan", plan: "p" })).toBe(false);
  expect(isFileTarget({ kind: "changes" })).toBe(false);
  expect(isFileTarget(cardTarget(call("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" }))!)).toBe(false);
});

it("latestPlanCall returns the newest plan call from aux when the page has none", () => {
  const v = view([call("Bash", { command: "ls" })]);
  expect(latestPlanCall(v)).toBeUndefined();
  const aux = { ...v, aux: [{ part: call("ExitPlanMode", { plan: "from aux" }, "p"), pos: 1 }] };
  expect(latestPlanCall(aux)?.id).toBe("p");
  expect(latestPlan(aux)).toBe("from aux");
  expect(latestPlanCall(view([call("ExitPlanMode", { plan: "old" }, "a"), call("ExitPlanMode", { plan: "new" }, "b")]))?.id).toBe("b");
});

it("planWaiting is true only for an unsettled ExitPlanMode permission request", () => {
  const perm = (tool: string, settled: boolean): Part => ({ type: "permission_request", id: `perm-${tool}-${settled}`, requestId: "r", toolUseId: "t", tool, input: {}, settled }) as Part;
  expect(planWaiting(view([perm("ExitPlanMode", false)]))).toBe(true);
  expect(planWaiting(view([perm("ExitPlanMode", true)]))).toBe(false);
  expect(planWaiting(view([perm("Bash", false)]))).toBe(false);
  expect(planWaiting(view([]))).toBe(false);
});


{
  const recorded = () => {
    const adapter = createAdapter();
    const lines = readFileSync(new URL("../../protocol/test/fixtures/plan-file-exit.jsonl", import.meta.url), "utf8").trim().split("\n");
    return lines.flatMap((l) => adapter.convert(JSON.parse(l) as never));
  };
  it("latestPlan reads the plan file the model wrote when ExitPlanMode came with an empty input (recorded Claude Code 2.1.294 shape)", () => {
    const v = view(recorded());
    expect(latestPlan(v)).toContain("1. Create hello.txt with the content hi.");
    expect(latestPlanCall(v)?.tool).toBe("ExitPlanMode");
    expect(planWaiting(v)).toBe(false);
  });
  it("latestPlan falls back to the approval request's plan when the call has none and no plan file was written", () => {
    const parts = recorded().filter((p) => !(p.type === "tool_call" && p.tool === "Write"));
    const req = { type: "permission_request", id: "perm", requestId: "r", toolUseId: "toolu_plan_exit", tool: "ExitPlanMode", input: { plan: "# From the request" }, suggestions: [], settled: false } as Part;
    expect(latestPlan(view(parts))).toBeUndefined();
    expect(latestPlan(view([...parts, req]))).toBe("# From the request");
  });
}
