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

it("an Edit/Write card with a pending permission stays collapsed (the panel shows the diff), a click still expands it", async () => {
  for (const [id, tool, input] of [
    ["e5", "Edit", { file_path: "/p/a.ts", old_string: "x", new_string: "y" }],
    ["w5", "Write", { file_path: "/p/n.txt", content: "hi" }],
  ] as const) {
    const edit = call(id, tool, input, "running");
    const ask = { ...permission(id), tool, input } as Part;
    await render(view([edit, ask]));
    expect(expanded(cards()[0]!)).toBe(false);
    expect(cards()[0]!.textContent).toContain("Awaiting approval");
    // One diff on screen: the permission panel's.
    expect(el.querySelectorAll('[data-testid="edit-diff"]')).toHaveLength(1);
    await toggle(cards()[0]!);
    expect(expanded(cards()[0]!)).toBe(true);
    await toggle(cards()[0]!);
    // Answered: normal behaviour, collapsed by default.
    await render(view([edit, ask, { ...ask, settled: true, decision: "allow" } as Part, call(id, tool, input)]));
    expect(expanded(cards()[0]!)).toBe(false);
  }
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
      { type: "subagent", id: "t1", toolUseId: "t1", description: "Run tests", status: "running", startedAt: 0 },
      { ...call("b6", "Bash", { command: "npm test" }, "running"), parentId: "t1" },
      permission("b6"),
    ]),
  );
  expect(el.querySelector('[data-testid="subagent"] button')?.getAttribute("aria-expanded")).toBe("true");
});

it("a multi-line user prompt keeps its line breaks as markdown and still wraps long words (GH-126)", async () => {
  await render(view([{ type: "user_text", id: "u3", text: "line one\nline two\n\nline four", images: [] }]));
  const content = el.querySelector<HTMLElement>('[data-testid="user-message"] .bg-secondary, [data-testid="user-message"] [class*="bg-secondary"]')!;
  // Markdown: a single newline is a <br>, a blank line starts a new paragraph.
  expect(content.querySelectorAll("p")).toHaveLength(2);
  expect(content.querySelectorAll("br")).toHaveLength(1);
  expect(content.textContent).toContain("line one\nline two");
  expect(content.textContent).toContain("line four");
  expect(content.className).toContain("[overflow-wrap:anywhere]");
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

it("timeline rhythm like OpenCode: 12px between tool rows, text 24px further down, 24px between turns", async () => {
  await render(
    view([
      { type: "user_text", id: "u1", text: "go", images: [] },
      call("b7", "Bash", { command: "ls" }),
      call("b8", "Bash", { command: "pwd" }),
      { type: "assistant_text", id: "a1", text: "done", streaming: false },
      { type: "user_text", id: "u2", text: "again", images: [] },
    ]),
  );
  // 12px between all rows: each timeline item but the first has pt-3 inside its measured box; tool rows add no margin.
  expect(cards().map((c) => c.parentElement!.className.match(/\bpt-3\b/)?.[0])).toEqual(["pt-3", "pt-3"]);
  expect(el.querySelector('[data-testid="user-message"]')!.parentElement!.className).not.toMatch(/\bpt-3\b/);
  expect(cards()[1]!.className).not.toMatch(/\bmt-/);
  // Text part: 12px gap + 24px margin (message-part.css text part margin-top).
  expect(el.querySelector('[data-testid="assistant-text"]')!.className).toMatch(/\bmt-6\b/);
  // Turn gap: 12px gap + 12px margin = 24px (TurnGap h-6); the first prompt has no top margin.
  const users = [...el.querySelectorAll<HTMLElement>('[data-testid="user-message"]')];
  expect(users.map((u) => u.className.match(/\S*mt-3\b/)?.[0])).toEqual([undefined, "mt-3"]);
});

it("TodoWrite: the timeline card stays collapsed, the dock above the prompt shows the latest list while the turn runs", async () => {
  const todos = (id: string, done: boolean): Part[] => {
    const items = [
      { content: "Inspect", status: "completed" as const },
      { content: "Test", status: done ? ("completed" as const) : ("in_progress" as const), activeForm: "Testing" },
    ];
    return [call(id, "TodoWrite", { todos: items }), { type: "todo_update", id: `${id}:todos`, items }];
  };
  const running: Part = { type: "session_state", id: "st", state: "running" };
  const dock = () => el.querySelector<HTMLElement>('[data-testid="todo-dock"]');
  await render(view([running, ...todos("t1", false)]));
  expect(cards().map(expanded)).toEqual([false]);
  expect(dock()?.textContent).toContain("1 of 2 todos completed");
  // Directly above the prompt box, which covers its bottom 36px (OpenCode prompt lift).
  // The lift sits on the prompt box, so an image strip or send error between them stays outside the dock.
  expect(dock()?.nextElementSibling?.querySelector("textarea")).not.toBeNull();
  expect(dock()!.className).toContain("pb-9");
  expect(dock()!.className).not.toContain("-mb-");
  expect(el.querySelector('[data-testid="prompt-box"]')!.className).toContain("-mt-11");
  // A permission panel replaces the prompt box: the dock hides with it (OpenCode showComposer).
  await render(view([running, ...todos("t1", false), permission("t9")]));
  expect(el.querySelector('[data-testid="permission-panel"]')).not.toBeNull();
  expect(dock()).toBeNull();
  // A second TodoWrite replaces the list: all done hides the dock; its card is collapsed too.
  await render(view([running, ...todos("t1", false), ...todos("t2", true)]));
  expect(cards().map(expanded)).toEqual([false, false]);
  expect(dock()).toBeNull();
  // Idle with open items: hidden (OpenCode shows the dock only while live).
  await render(view([running, ...todos("t1", false), { type: "session_state", id: "st", state: "idle" }]));
  expect(dock()).toBeNull();
  // The next turn calls no TodoWrite: the old list stays gone (OpenCode todoState "clear").
  await render(view([running, ...todos("t1", false), { type: "session_state", id: "st", state: "idle" }, running]));
  expect(dock()).toBeNull();
});
