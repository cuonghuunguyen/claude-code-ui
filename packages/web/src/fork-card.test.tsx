// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Part } from "@claude-ui/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ForkCard, StopRunContext } from "./run-card.tsx";

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));
// The expand state outlives a remount (useExpanded): one id per test.
let n = 0;
beforeEach(() => n++);

type Sub = Extract<Part, { type: "subagent" }>;
const sub = (status: Sub["status"], over: Partial<Sub> = {}): Sub => ({ type: "subagent", id: `toolu_${n}`, toolUseId: `toolu_${n}`, description: "count txt files", status, startedAt: 1_000, agentType: "fork", ...(status !== "running" && status !== "pending" && { endedAt: 4_500 }), ...over });
const run = { steps: <div data-testid="step">Read a.txt</div>, stepCount: 3, hasParts: true };
const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (node: Element | null) => act(async () => (node as HTMLElement).click());

it("a fork run is a run card labelled Fork with the task as summary and its status", async () => {
  await act(async () => root.render(<ForkCard part={sub("running")} run={run} />));
  const card = q("run-card")!;
  expect(card.getAttribute("data-status")).toBe("running");
  expect(card.textContent).toContain("Fork");
  expect(card.textContent).toContain("count txt files");
  expect(q("subagent")).toBeNull();
});

it("done: steps stay collapsed behind a step count, the result shows once, the meta is the duration", async () => {
  await act(async () => root.render(<ForkCard part={sub("done")} run={run} text="**2** files" />));
  await click(q("run-card")!.querySelector("button"));
  expect(q("run-steps-toggle")!.textContent).toContain("3 steps");
  expect(q("step")).toBeNull();
  expect(q("run-result")!.textContent).toContain("2 files");
  expect(el.querySelectorAll('[data-testid="run-result"]')).toHaveLength(1);
  expect(q("run-meta")!.textContent).toBe("3s");
  await click(q("run-steps-toggle"));
  expect(q("step")!.textContent).toBe("Read a.txt");
});

it("running: no result block, a Stop button that stops the run by its call id", async () => {
  const stop = vi.fn(async () => {});
  await act(async () => root.render(<StopRunContext value={stop}><ForkCard part={sub("running")} run={run} text="partial" /></StopRunContext>));
  expect(q("run-result")).toBeNull();
  await click(q("run-stop"));
  expect(stop).toHaveBeenCalledWith(`toolu_${n}`);
});

it("a restored run with no child parts says the steps are not kept; an open handler adds the Open button", async () => {
  const open = vi.fn();
  await act(async () => root.render(<ForkCard part={sub("done")} run={{ steps: null, stepCount: 0, hasParts: false }} onOpen={open} />));
  await click(q("run-card")!.querySelector("button"));
  expect(q("run-steps-note")).not.toBeNull();
  await click(q("run-open"));
  expect(open).toHaveBeenCalledTimes(1);
});

it("a stopped fork shows as stopped", async () => {
  await act(async () => root.render(<ForkCard part={sub("stopped")} run={run} />));
  expect(q("run-card")!.getAttribute("data-status")).toBe("stopped");
});
