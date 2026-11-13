// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunCard, type RunCardProps } from "./run-card.tsx";

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

// The expand state outlives a remount (useExpanded), so each test gets its own id.
let n = 0;
beforeEach(() => n++);
const props = (over: Partial<RunCardProps> = {}): RunCardProps => ({
  id: `run-${n}`,
  label: "Inline task",
  summary: "Find the callers of foo",
  status: "done",
  model: "haiku",
  usage: { input: 1200, output: 300, cacheRead: 500, cacheWrite: 0 },
  turns: { used: 3, max: 10 },
  filesChanged: [],
  stepCount: 2,
  steps: <div data-testid="step">a step</div>,
  ...over,
});
const render = (p: RunCardProps, wrap?: (n: ReactNode) => ReactNode) => act(async () => root.render(wrap ? wrap(<RunCard {...p} />) : <RunCard {...p} />));
const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (node: Element | null) => act(async () => (node as HTMLElement).click());
const header = () => el.querySelector<HTMLElement>('[data-testid="run-card"] button')!;

it("header shows label, summary, status and the model, turns, tokens meta", async () => {
  await render(props());
  const card = q("run-card")!;
  expect(card.getAttribute("data-status")).toBe("done");
  expect(card.textContent).toContain("Inline task");
  expect(card.textContent).toContain("Find the callers of foo");
  expect(q("run-meta")!.textContent).toBe("haiku · 3/10 turns · 2.0k tokens");
  expect(q("run-meta")!.className).toContain("tabular-nums");
  expect(q("run-meta")!.className).toContain("text-muted-foreground");
});

it("meta leaves out what is unknown (a running call has no usage yet)", async () => {
  await render(props({ status: "running", usage: undefined, turns: undefined, model: undefined }));
  expect(q("run-meta")).toBeNull();
  await render(props({ status: "running", usage: undefined, turns: undefined, model: "sonnet" }));
  expect(q("run-meta")!.textContent).toBe("sonnet");
  await render(props({ turns: { used: 1 }, model: undefined, usage: undefined }));
  expect(q("run-meta")!.textContent).toBe("1 turn");
});

it("body is collapsed by default; opening the card shows the steps disclosure, collapsed too; its click shows the steps", async () => {
  await render(props());
  expect(q("run-steps")).toBeNull();
  expect(q("step")).toBeNull();
  await click(header());
  const toggle = q("run-steps-toggle")!;
  expect(toggle.textContent).toContain("2 steps");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(q("step")).toBeNull();
  await click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(q("step")!.textContent).toBe("a step");
});

it("a single step reads singular", async () => {
  await render(props({ stepCount: 1 }));
  await click(header());
  expect(q("run-steps-toggle")!.textContent).toContain("1 step");
  expect(q("run-steps-toggle")!.textContent).not.toContain("1 steps");
});

it("awaiting a permission holds the card and its steps open", async () => {
  await render(props({ status: "running", awaiting: true }));
  expect(q("step")).not.toBeNull();
});

it("shows the result and the changed files when open", async () => {
  await render(props({ result: <p data-testid="result">foo is called by bar</p>, filesChanged: ["src/a.ts", "src/b.ts"] }));
  await click(header());
  expect(q("result")!.textContent).toBe("foo is called by bar");
  expect(q("run-files")!.textContent).toContain("src/a.ts");
  expect(q("run-files")!.textContent).toContain("src/b.ts");
});

it("Stop shows only while running and calls onCancel", async () => {
  const onCancel = vi.fn(async () => {});
  await render(props({ status: "done", onCancel }));
  expect(q("run-stop")).toBeNull();
  await render(props({ status: "running", onCancel }));
  const stop = q("run-stop")!;
  expect(stop.getAttribute("aria-label")).toBe("Stop Inline task Find the callers of foo");
  await click(stop);
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it("a failed Stop request shows its error next to the card", async () => {
  const onCancel = vi.fn(async () => {
    throw new Error("unknown_subagent");
  });
  await render(props({ status: "running", onCancel }));
  await click(q("run-stop"));
  expect(q("run-stop-error")!.textContent).toContain("unknown_subagent");
});

it("a restored run without step parts says that steps are not kept", async () => {
  await render(props({ stepCount: 0, stepsKept: false, steps: null }));
  await click(header());
  expect(q("run-steps-note")!.textContent).toBe("Steps are not kept after the daemon restarts.");
  expect(q("run-steps-toggle")).toBeNull();
});

it("a live run with no step yet does not show the restart note", async () => {
  await render(props({ status: "running", stepCount: 0, steps: null, awaiting: true }));
  expect(q("run-steps-note")).toBeNull();
});

it("at 390px nothing is fixed wide: no px widths, min-w-0 and wrapping on every text container", async () => {
  await render(props({ result: <p>text</p>, filesChanged: ["a/very/long/path/to/a/file-with-a-long-name.ts"], awaiting: true }));
  await click(header());
  const html = el.innerHTML;
  expect(html).not.toMatch(/(?:^|[\s:"])(?:min-|max-)?w-\[\d+px\]/);
  expect(html).not.toMatch(/\bw-(?:64|72|80|96)\b/);
  const card = q("run-card")!;
  expect(card.className).toContain("min-w-0");
  expect(q("run-meta-compact")!.className).toMatch(/flex-wrap/);
  expect(q("run-files")!.className).toMatch(/\[overflow-wrap:anywhere\]|break-all|break-words/);
  expect(q("run-meta")!.className).toContain("max-md:hidden");
  expect(q("run-meta-compact")!.className).toContain("md:hidden");
});

it("touch targets: the Stop button and the steps disclosure are 44px on coarse pointers, both have a focus ring", async () => {
  await render(props({ status: "running", onCancel: async () => {}, awaiting: true }));
  for (const node of [q("run-stop")!, q("run-steps-toggle")!]) {
    expect(node.className).toContain("pointer-coarse:");
    expect(node.className).toContain("focus-visible:outline-2");
  }
  expect(q("run-stop")!.className).toContain("pointer-coarse:size-11");
  expect(q("run-steps-toggle")!.className).toContain("pointer-coarse:min-h-11");
});
