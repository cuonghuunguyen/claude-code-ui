// @vitest-environment jsdom
import type { Part } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPane } from "./App.tsx";
import { applyEvent, emptySession, type SessionView } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const noop = () => {};
const call = (id: string, tool: string, input: unknown, status: "running" | "done" = "done"): Part => ({
  type: "tool_call",
  id,
  toolUseId: id,
  tool,
  input,
  status,
});
const view = (parts: Part[]): SessionView =>
  parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s1", seq: i + 1, part }), emptySession());

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

const render = (v: SessionView) =>
  act(async () =>
    root.render(
      <SessionPane
        scrollKey={0}
        onInserted={noop}
        connected
        session={{ id: "s1", cwd: "/tmp", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [] }}
        view={v}
        models={[]}
        onModel={noop}
        onMode={noop}
        onEffort={noop}
        onUpload={async () => ""}
        onPrompt={async () => {}}
        onSearch={async () => []}
        onInterrupt={noop}
        onRewindPreview={async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false })}
        onRewind={async () => {}}
        onRespond={noop}
        onAnswer={noop}
      />,
    ),
  );

const turnResult = (id = "r1"): Part => ({ type: "turn_result", id, durationMs: 1000, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, isError: false });
const text = (id: string, t: string, streaming = false): Part => ({ type: "assistant_text", id, text: t, streaming });
const copies = () => [...el.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "Copy response");

it("a finished turn has one Copy response action that copies its assistant text only, blocks joined by a blank line (GH-151)", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await render(
    view([
      { type: "user_text", id: "u1", text: "go", images: [] },
      text("m1:0", "First **block**"),
      { type: "thinking", id: "k1", text: "secret", streaming: false },
      call("b1", "Bash", { command: "ls" }),
      { type: "tool_result", id: "b1:result", toolUseId: "b1", output: "tool output", isError: false },
      text("m2:0", "```ts\nlet x = 1;\n```"),
      turnResult(),
      { type: "user_text", id: "u2", text: "again", images: [] },
      text("m3:0", "other turn"),
      turnResult("r2"),
    ]),
  );
  expect(copies()).toHaveLength(2);
  const b = copies()[0]!;
  expect(b.className).toContain("pointer-coarse:size-11");
  expect(b.className).toContain("max-md:size-11");
  expect(b.disabled).toBe(false);
  await act(async () => b.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith("First **block**\n\n```ts\nlet x = 1;\n```");
  expect(b.querySelector("svg.lucide-check")).not.toBeNull();
  await act(async () => copies()[1]!.click());
  expect(writeText).toHaveBeenLastCalledWith("other turn");
});

it("a turn that is still running has no Copy response yet; a turn without text has none (GH-151)", async () => {
  await render(view([{ type: "user_text", id: "u1", text: "go", images: [] }, text("m1:0", "partial", true)]));
  expect(copies()).toHaveLength(0);
  await render(view([{ type: "user_text", id: "u1", text: "go", images: [] }, call("b1", "Bash", { command: "ls" }), turnResult()]));
  expect(copies()).toHaveLength(0);
});

it("a restored turn (no turn_result, so no usage footer) still has Copy response; the last turn too, unless running (GH-151)", async () => {
  const parts: Part[] = [
    { type: "user_text", id: "u1", text: "go", images: [] },
    text("m1:0", "old answer"),
    { type: "user_text", id: "u2", text: "again", images: [] },
    text("m2:0", "new answer"),
  ];
  await render(view(parts));
  expect(copies()).toHaveLength(2);
  await render(view([...parts, { type: "session_state", id: "st", state: "running" }]));
  expect(copies()).toHaveLength(1);
});

it("no Copy while a terminal-CLI turn runs (externalTurn); a bash card ends the previous turn; subagent text and steered prompts (GH-151)", async () => {
  const done: Part[] = [{ type: "user_text", id: "u1", text: "go", images: [] }, text("m1:0", "answer")];
  await render(view([...done, { type: "external_turn", id: "external_turn", running: true }]));
  expect(copies()).toHaveLength(0);
  const bash: Part = { type: "bash", id: "sh1", command: "ls", stdout: "", stderr: "", status: "running" };
  await render(view([...done, bash]));
  expect(copies()).toHaveLength(1);
  await act(async () => (Object.defineProperty(navigator, "clipboard", { value: { writeText: (globalThis as { w?: unknown }).w = vi.fn(async () => {}) }, configurable: true }), copies()[0]!.click()));
  expect((globalThis as { w?: ReturnType<typeof vi.fn> }).w).toHaveBeenCalledWith("answer");
  // Subagent text is not the turn's text; a prompt steered mid-turn splits it in two.
  await render(
    view([
      ...done,
      { type: "subagent", id: "t1", toolUseId: "t1", description: "d", status: "done", startedAt: 0 },
      { ...text("s1:0", "child text"), parentId: "t1" } as Part,
      { type: "user_text", id: "u2", text: "steer", images: [] },
      text("m2:0", "after steer"),
    ]),
  );
  expect(copies()).toHaveLength(2);
  await act(async () => copies()[0]!.click());
  expect((globalThis as { w?: ReturnType<typeof vi.fn> }).w).toHaveBeenLastCalledWith("answer");
});
