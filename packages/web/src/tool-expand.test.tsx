// @vitest-environment jsdom
import type { Part } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
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
const permission = (toolUseId: string, settled = false): Part => ({
  type: "permission_request",
  id: `p-${toolUseId}`,
  requestId: `p-${toolUseId}`,
  toolUseId,
  tool: "Bash",
  input: { command: "rm x" },
  suggestions: [],
  settled,
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
        session={{ id: "s1", cwd: "/tmp", state: "idle", model: "default" }}
        view={v}
        models={[]}
        onModel={noop}
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
const cards = () => [...el.querySelectorAll<HTMLElement>('[data-testid="tool-card"]')];
const expanded = (card: HTMLElement) => card.querySelector("button")!.getAttribute("aria-expanded") === "true";
const toggle = (card: HTMLElement) => act(async () => card.querySelector("button")!.click());

it("a restored transcript renders every tool card collapsed", async () => {
  await render(
    view([
      call("b1", "Bash", { command: "ls" }),
      call("e1", "Edit", { file_path: "/p/a.ts", old_string: "x", new_string: "y" }),
      call("w1", "Write", { file_path: "/p/n.txt", content: "hi" }),
    ]),
  );
  expect(cards()).toHaveLength(3);
  expect(cards().map(expanded)).toEqual([false, false, false]);
});

it("expand state is per card and survives re-renders while streaming", async () => {
  const parts = [call("b2", "Bash", { command: "ls" }, "running"), call("b3", "Bash", { command: "pwd" }, "running")];
  await render(view(parts));
  await toggle(cards()[0]!);
  expect(cards().map(expanded)).toEqual([true, false]);
  // The call finishes and a new one streams in.
  await render(view([...parts, call("b2", "Bash", { command: "ls" }), call("b4", "Bash", { command: "id" }, "running")]));
  expect(cards().map(expanded)).toEqual([true, false, false]);
});

it("an expanded Read keeps its state when a second Read merges it into a context group", async () => {
  const read = call("r1", "Read", { file_path: "/p/a.ts" });
  await render(view([read]));
  await toggle(cards()[0]!);
  await render(view([read, call("r2", "Read", { file_path: "/p/b.ts" })]));
  const group = el.querySelector<HTMLElement>('[data-testid="context-group"]')!;
  await toggle(group);
  expect(cards().map(expanded)).toEqual([true, false]);
});

it("a card with a pending permission request is expanded, and collapses again once answered", async () => {
  const bash = call("b5", "Bash", { command: "rm x" }, "running");
  await render(view([bash, permission("b5")]));
  expect(expanded(cards()[0]!)).toBe(true);
  await render(view([bash, permission("b5"), permission("b5", true)]));
  expect(expanded(cards()[0]!)).toBe(false);
});

it("reasoning text is hidden; a Thinking row shows only while the turn runs", async () => {
  const parts: Part[] = [
    { type: "thinking", id: "k1", text: "secret plan", streaming: true },
    { type: "session_state", id: "st", state: "running" },
  ];
  await render(view(parts));
  expect(el.textContent).not.toContain("secret plan");
  expect(el.querySelector('[data-testid="thinking"]')?.textContent).toBe("Thinking");
  await render(view([...parts, { type: "session_state", id: "st", state: "idle" }]));
  expect(el.querySelector('[data-testid="thinking"]')).toBeNull();
});

it("a user message has Copy and Rewind actions", async () => {
  await render(view([{ type: "user_text", id: "u1", text: "hello", images: [] }]));
  const labels = [...el.querySelectorAll('[data-testid="user-message"] button')].map((b) => b.textContent);
  expect(labels).toEqual(["Copy message", "Rewind to before this message"]);
});

it("a subagent is expanded while a child call waits for permission (daemon sends no parentId)", async () => {
  await render(
    view([
      { type: "subagent", id: "t1", toolUseId: "t1", description: "Run tests", status: "running" },
      { ...call("b6", "Bash", { command: "npm test" }, "running"), parentId: "t1" },
      permission("b6"),
    ]),
  );
  expect(el.querySelector('[data-testid="subagent"] button')?.getAttribute("aria-expanded")).toBe("true");
});

it("Copy on a non-secure origin (no navigator.clipboard) does not throw", async () => {
  await render(view([{ type: "user_text", id: "u2", text: "hello", images: [] }]));
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => (errors.push(e.error), e.preventDefault());
  window.addEventListener("error", onError);
  await act(async () => el.querySelector<HTMLElement>('[data-testid="user-message"] button')!.click());
  window.removeEventListener("error", onError);
  expect(errors).toEqual([]);
});

it("the Explored row has a chevron like every other row", async () => {
  await render(view([call("r3", "Read", { file_path: "/p/a.ts" }), call("r4", "Read", { file_path: "/p/b.ts" })]));
  expect(el.querySelector('[data-testid="context-group"] button svg.lucide-chevron-down')).not.toBeNull();
});
