// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ToolCall } from "./store.ts";
import { StopRunContext } from "./run-card.tsx";
import { ToolCard } from "./tool-card.tsx";

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));
// The expand state outlives a remount (useExpanded): one id per test.
let n = 0;
beforeEach(() => n++);

const TOOL = "mcp__claude-ui__inline_task";
const call = (status: ToolCall["status"], input: unknown = { prompt: "Find callers of foo\nsecond line", maxTurns: 10 }): ToolCall => ({ type: "tool_call", id: `toolu_${n}`, toolUseId: `toolu_${n}`, tool: TOOL, input, status });
const result = (output: unknown, isError = false) => ({ type: "tool_result" as const, id: `toolu_${n}:result`, toolUseId: `toolu_${n}`, output, isError });
const json = (over: object = {}) => JSON.stringify({ status: "done", text: "foo is called by **bar**", model: "claude-haiku-4-5", turns: 3, tokens: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 0 }, filesChanged: ["src/a.ts"], durationMs: 900, ...over });
const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (node: Element | null) => act(async () => (node as HTMLElement).click());
const steps = <div data-testid="step">Grep foo</div>;

it("the inline_task tool renders the run card, not the plain tool card", async () => {
  await act(async () => root.render(<ToolCard call={call("running")} />));
  expect(q("run-card")).not.toBeNull();
  expect(q("tool-card")).toBeNull();
  expect(q("run-card")!.textContent).toContain("Inline task");
  expect(q("run-card")!.textContent).toContain("Find callers of foo");
  expect(q("run-card")!.textContent).not.toContain("second line");
  expect(q("run-card")!.getAttribute("data-status")).toBe("running");
});

it("other claude-ui tools keep the plain tool card", async () => {
  await act(async () => root.render(<ToolCard call={{ ...call("done"), tool: "mcp__claude-ui__terminal_list" }} />));
  expect(q("run-card")).toBeNull();
  expect(q("tool-card")).not.toBeNull();
});

it("live: shows the model of the input; no tokens or turns yet", async () => {
  await act(async () => root.render(<ToolCard call={call("running", { prompt: "x", model: "sonnet" })} />));
  expect(q("run-meta")!.textContent).toBe("sonnet");
});

it("done: meta from the result (model, turns of max, tokens); body shows the markdown result and the files", async () => {
  await act(async () => root.render(<ToolCard call={call("done")} result={result(json())} run={{ steps, stepCount: 1, hasParts: true }} />));
  expect(q("run-meta")!.textContent).toBe("claude-haiku-4-5 · 3/10 turns · 2.0k tokens");
  await click(q("run-card")!.querySelector("button"));
  expect(q("run-result")!.textContent).toContain("foo is called by");
  expect(q("run-files")!.textContent).toContain("src/a.ts");
  expect(q("run-steps-toggle")!.textContent).toContain("1 step");
  expect(q("step")).toBeNull();
  await click(q("run-steps-toggle"));
  expect(q("step")!.textContent).toBe("Grep foo");
});

it("a run that hit a limit shows a note about the partial result", async () => {
  await act(async () => root.render(<ToolCard call={call("done")} result={result(json({ status: "limit", limit: "turns" }))} awaiting />));
  expect(q("run-note")!.textContent).toBe("Stopped at the turn limit. The result is partial.");
  expect(q("run-card")!.getAttribute("data-status")).toBe("done");
});

it("a stopped run shows status stopped; an errored run shows its error", async () => {
  await act(async () => root.render(<ToolCard call={call("done")} result={result(json({ status: "stopped" }))} awaiting />));
  expect(q("run-card")!.getAttribute("data-status")).toBe("stopped");
  expect(q("run-note")!.textContent).toBe("Stopped. The result is partial.");
  await act(async () => root.render(<ToolCard call={call("done")} result={result(json({ status: "error", error: "CLI exited" }))} awaiting />));
  expect(q("run-card")!.getAttribute("data-status")).toBe("error");
  expect(q("run-note")!.textContent).toBe("The run failed: CLI exited");
});

it("a tool error text (not the result JSON) shows as an alert", async () => {
  await act(async () => root.render(<ToolCard call={call("error")} result={result("Inline task files must be inside the project", true)} awaiting />));
  expect(q("run-error")!.textContent).toContain("Inline task files must be inside the project");
});

it("Stop calls the session stop request with the tool call id", async () => {
  const stop = vi.fn(async () => ({}));
  await act(async () => root.render(<StopRunContext value={stop}><ToolCard call={call("running")} /></StopRunContext>));
  await click(q("run-stop"));
  expect(stop).toHaveBeenCalledWith(`toolu_${n}`);
});

it("no Stop button without a stop handler or after the run ended", async () => {
  await act(async () => root.render(<ToolCard call={call("running")} />));
  expect(q("run-stop")).toBeNull();
  await act(async () => root.render(<StopRunContext value={async () => {}}><ToolCard call={call("done")} result={result(json())} /></StopRunContext>));
  expect(q("run-stop")).toBeNull();
});

it("a finished call without child parts (restored session) says that steps are not kept", async () => {
  await act(async () => root.render(<ToolCard call={call("done")} result={result(json())} run={{ steps: null, stepCount: 0, hasParts: false }} />));
  await click(q("run-card")!.querySelector("button"));
  expect(q("run-steps-note")!.textContent).toBe("Steps are not kept after the daemon restarts.");
});

it("a running call without child parts yet does not", async () => {
  await act(async () => root.render(<ToolCard call={call("running")} run={{ steps: null, stepCount: 0, hasParts: false }} />));
  await click(q("run-card")!.querySelector("button"));
  expect(q("run-steps-note")).toBeNull();
});

it("a pending permission inside opens the card and its steps", async () => {
  await act(async () => root.render(<ToolCard call={call("running")} awaiting run={{ steps, stepCount: 1, hasParts: true }} />));
  expect(q("step")).not.toBeNull();
});
