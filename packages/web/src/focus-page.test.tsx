// @vitest-environment jsdom
import type { Part, SessionListItem } from "@claude-ui/protocol";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { loadDraft, saveDraft } from "./drafts.ts";
import { FocusPage, FocusRow } from "./focus-page.tsx";
import { waitingRequests } from "./focus.ts";
import type { PermissionAnswer } from "./permission.tsx";
import { applyEvent, emptySession, type SessionView } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const item = (id: string, over: Partial<SessionListItem> = {}) => ({ id, cwd: `/work/${id}`, state: "needs_input", title: `Session ${id}`, lastActivity: 0, archived: false, transcript: true, ...over }) as SessionListItem;
const bash = (id: string, command: string, at: number, over: Partial<Extract<Part, { type: "permission_request" }>> = {}): Part => ({ type: "permission_request", id, requestId: id, toolUseId: `tu-${id}`, tool: "Bash", input: { command }, suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run test *" }], behavior: "allow", destination: "localSettings" }], settled: false, at, ...over });
const question = (id: string, at: number): Part => ({ type: "question", id, requestId: id, toolUseId: `tu-${id}`, questions: [{ question: "Keep the old route?", header: "Route", options: [{ label: "Keep", description: "stay" }, { label: "Drop", description: "remove" }], multiSelect: false }], settled: false, at });
const call = (id: string, tool: string, status: "done" | "running" = "done"): Part => ({ type: "tool_call", id, toolUseId: id, tool, input: {}, status });
const view = (parts: Part[]): SessionView => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());

const NOW = Date.now();
let renders = 0;
const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

type State = { list: SessionListItem[]; views: Record<string, SessionView>; unread?: string[]; activity?: Record<string, number> };
const respond = vi.fn<(id: string, a: PermissionAnswer) => void>();
const answer = vi.fn<(id: string, a: Record<string, string>) => void>();
const open = vi.fn<(id: string) => void>();
const cancelContinue = vi.fn<(id: string) => void>();

/** A Focus page over `state`; `settle` replaces the views like the daemon's settled event does. */
function Harness({ initial, onState }: { initial: State; onState?: (set: (s: State) => void) => void }) {
  const [state, setState] = useState(initial);
  const [selected, setSelected] = useState<string>();
  onState?.(setState);
  const waiting = waitingRequests(state.list, state.views, new Map(), Date.now());
  return <FocusPage list={state.list} views={state.views} worktrees={{}} waiting={waiting} selected={selected} onSelect={setSelected} onRespond={respond} onAnswer={answer} onOpenSession={open} unread={new Set(state.unread)} activity={(id) => state.activity?.[id] ?? state.list.find((x) => x.id === id)?.lastActivity ?? 0} onCancelContinue={cancelContinue} />;
}

const base = (): State => ({
  list: [item("a"), item("b"), item("c", { state: "running", lastActivity: 5 })],
  views: {
    a: view([{ type: "user_text", id: "u", text: "run the auth tests", images: [] }, call("t0", "Read"), call("t1", "Read"), bash("ra", "npm run test -- auth", NOW - 90_000)]),
    b: view([question("rb", NOW - 30_000)]),
    c: view([call("c1", "Edit", "running"), { type: "session_state", id: "st", state: "running" }]),
  },
});
const render = (initial = base(), onState?: (set: (s: State) => void) => void) => act(async () => root.render(<Harness key={renders++} initial={initial} onState={onState} />));
const rows = () => [...el.querySelectorAll<HTMLElement>('[data-testid="focus-row"]')];
const button = (name: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name)!;

it("lists the waiting requests oldest first with their wait time, then the working sessions", async () => {
  await render();
  expect(rows().map((r) => r.dataset.kind)).toEqual(["permission", "question"]);
  expect(rows()[0]!.textContent).toContain("Session a");
  expect(rows()[1]!.textContent).toContain("Session b");
  expect(rows()[0]!.textContent).toContain("Allow or deny Bash · npm run test -- auth");
  expect(rows()[1]!.textContent).toContain("Answer: Keep the old route?");
  expect(el.querySelectorAll('[data-testid="focus-wait"]')).toHaveLength(2);
  expect(el.querySelector('[data-testid="focus-subtitle"]')!.textContent).toBe("2 need you · 1 working");
  expect(el.textContent).toContain("Working · 1");
  expect(el.querySelector('[data-testid="focus-running-row"]')!.textContent).toContain("Session c");
  expect(el.querySelector('[data-testid="focus-now"]')!.textContent).toBe("Edit");
});

it("every button is a 44px target on narrow screens and coarse pointers (case 12)", async () => {
  const s = base();
  s.list.push(item("e", { state: "error", lastActivity: NOW }));
  s.views.e = view([{ type: "user_text", id: "u", text: "go", images: [] }, { type: "session_state", id: "st", state: "running" }, { type: "session_state", id: "st", state: "error" }]);
  s.unread = ["e"];
  await render(s);
  expect(el.querySelectorAll('[data-testid="focus-row-action"]').length).toBeGreaterThan(0);
  const buttons = [
    ...el.querySelectorAll<HTMLElement>('[data-testid="focus-next"], [data-testid="focus-back"], [data-testid="focus-open-session"], [data-testid="focus-row-action"]'),
    ...[...el.querySelectorAll<HTMLElement>('[data-testid="permission-panel"] button')].filter((b) => /^(Deny|Allow always|Allow once|Edit content)$/.test(b.textContent!.trim())),
  ];
  expect(buttons.length).toBeGreaterThanOrEqual(5);
  for (const b of buttons) {
    expect(b.className, b.textContent!).toContain("max-md:h-11");
    expect(b.className, b.textContent!).toContain("pointer-coarse:h-11");
  }
});

it("the detail shows the selected session, its signal-only context and the request with its wait time", async () => {
  await render();
  expect(el.querySelector('[data-testid="focus-title"]')!.textContent).toBe("Session a");
  expect(el.querySelector('[data-testid="focus-context"]')!.textContent).toContain("run the auth tests");
  expect(el.querySelector('[data-testid="focus-context"]')!.textContent).toContain("2 tool calls · Read 2");
  expect(el.querySelector('[data-testid="focus-waiting"]')!.textContent).toMatch(/^waiting (\d+m )?\d+s$/);
  expect(el.querySelector('[data-testid="permission-panel"]')).not.toBeNull();
  const detail = el.querySelector('[data-testid="focus-detail"]') ?? el;
  expect(detail.textContent!.split("npm run test -- auth").length - 1).toBe(1);
  await act(async () => button("Open session").click());
  expect(open).toHaveBeenCalledWith("a");
});

it("high tier: the badge and no Always allow; a low tier request shows the rule and Allow always", async () => {
  await render();
  expect(el.textContent).toContain("High tier · always asks");
  expect(button("Allow always")).toBeUndefined();
  const low = base();
  low.views.a = view([bash("ra", "npm run test -- auth", NOW - 90_000, { tier: "low" })]);
  await render(low);
  expect(el.textContent).not.toContain("High tier");
  expect(el.textContent).toContain("Always allow saves:");
  expect(button("Allow always")).toBeDefined();
});

it("Allow answers that request and moves to the next; the answered row shrinks to one line", async () => {
  let set!: (s: State) => void;
  await render(base(), (s) => (set = s));
  await act(async () => button("Allow once").click());
  expect(respond).toHaveBeenCalledWith("ra", { decision: "allow", updatedInput: undefined });
  // The daemon settles it: the request leaves the queue, the question is selected.
  const next = base();
  next.views.a = view([bash("ra", "npm run test -- auth", NOW - 90_000), bash("ra", "npm run test -- auth", NOW - 90_000, { settled: true, decision: "allow" })]);
  await act(async () => set(next));
  expect(el.querySelector('[data-testid="focus-answered"]')!.textContent).toBe("Allowed npm run test -- auth");
  expect(rows().map((r) => r.textContent)).toHaveLength(1);
  expect(el.querySelector('[data-testid="question-panel"]')).not.toBeNull();
  expect(el.querySelector('[data-testid="focus-subtitle"]')!.textContent).toBe("1 needs you · 1 working");
});

it("a question shows its options as choices and has no Dismiss", async () => {
  await render();
  await act(async () => rows()[1]!.click());
  const panel = el.querySelector('[data-testid="question-panel"]')!;
  expect(panel.textContent).toContain("Keep");
  expect(panel.textContent).toContain("Drop");
  expect(button("Dismiss")).toBeUndefined();
  expect(el.querySelector('[data-testid="focus-waiting"]')!.textContent).toMatch(/^waiting (\d+m )?\d+s$/);
  expect(el.querySelector('[data-testid="focus-detail"]')!.textContent!.split("Keep the old route?").length - 1).toBe(1);
  await act(async () => panel.querySelector<HTMLInputElement>("input[type=radio]")!.click());
  await act(async () => button("Submit").click());
  expect(answer).toHaveBeenCalledWith("rb", { "Keep the old route?": "Keep" });
});

it("an answer given elsewhere (the session itself) shrinks the same way", async () => {
  let set!: (s: State) => void;
  await render(base(), (s) => (set = s));
  const next = base();
  next.views.b = view([question("rb", NOW - 30_000), { ...question("rb", NOW - 30_000), settled: true, answers: { "Keep the old route?": "Drop" } } as Part]);
  await act(async () => set(next));
  expect(el.querySelector('[data-testid="focus-answered"]')!.textContent).toBe("Answered: Drop");
});

it("nothing waiting: the empty state and the running list", async () => {
  const s = base();
  s.list = [item("c", { state: "running" })];
  s.views = { c: base().views.c! };
  await render(s);
  expect(el.querySelector('[data-testid="focus-empty"]')!.textContent).toContain("Nothing needs you");
  expect(el.querySelector('[data-testid="focus-next"]')).toBeNull();
  expect(el.textContent).toContain("Working · 1");
  await render({ list: [], views: {} });
  expect(el.textContent).toContain("No session is running.");
});

it("narrow screens: the queue first, a picked row shows its detail with Back to queue", async () => {
  await render();
  const queue = el.querySelector('[data-testid="focus-queue"]')!;
  const detail = el.querySelector('[data-testid="focus-detail"]')!;
  expect(queue.className).not.toContain("max-md:hidden");
  expect(detail.className).toContain("max-md:hidden");
  await act(async () => rows()[1]!.click());
  expect(queue.className).toContain("max-md:hidden");
  expect(detail.className).not.toContain("max-md:hidden");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="focus-back"]')!.click());
  expect(queue.className).not.toContain("max-md:hidden");
});

it("the sidebar row counts the waiting sessions and shows nothing at 0", async () => {
  await act(async () => root.render(<FocusRow count={3} active={false} onOpen={() => {}} />));
  expect(el.textContent).toBe("Focus3 waiting");
  await act(async () => root.render(<FocusRow count={0} active onOpen={() => {}} />));
  expect(el.textContent).toBe("Focus");
});

const done = [{ type: "user_text", id: "u", text: "go", images: [] }, { type: "session_state", id: "st", state: "running" }] as Part[];
const finish = (text: string, extra: Part[] = []) => view([...done, ...extra, { type: "assistant_text", id: "r", text, streaming: false }, { type: "session_state", id: "st", state: "idle" }]);
const todo = (...items: [string, "pending" | "in_progress" | "completed"][]): Part => ({ type: "todo_update", id: "t:todos", items: items.map(([content, status]) => ({ content, status })) });

it("subtitle: need you, to review, working", async () => {
  const s = base();
  s.list.push(item("f", { state: "idle", lastActivity: NOW - 1000 }));
  s.views.f = finish("All done");
  s.unread = ["f"];
  await render(s);
  expect(el.querySelector('[data-testid="focus-subtitle"]')!.textContent).toBe("2 need you · 1 to review · 1 working");
});

it("a working row shows the now line and k of n, and the quiet time above 2 min", async () => {
  const s = base();
  s.views.c = view([...done, todo(["a", "completed"], ["b", "in_progress"], ["c", "pending"]), call("c1", "Edit", "running")]);
  s.activity = { c: Date.now() - 3 * 60_000 - 5000 };
  await render(s);
  const row = el.querySelector('[data-testid="focus-running-row"]')!;
  expect(row.querySelector('[data-testid="focus-now"]')!.textContent).toBe("b");
  expect(row.querySelector('[data-testid="focus-progress"]')!.textContent).toBe("2 of 3");
  expect(row.textContent).toContain("quiet 3m");
});

it("finished section: last line and task summary, 5 rows then +N more, expands", async () => {
  const ids = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
  const s: State = { list: ids.map((id, n) => item(id, { state: "idle", lastActivity: NOW - n * 1000 })), views: Object.fromEntries(ids.map((id) => [id, finish("Wrote it\nAll tests pass", [todo(["Ship", "completed"])])])), unread: ids };
  await render(s);
  const section = () => el.querySelector('[aria-labelledby="focus-finished"]')!;
  expect(section().textContent).toContain("Finished while you were away · 7");
  expect(section().querySelectorAll('[data-testid="focus-row"]')).toHaveLength(5);
  expect(section().textContent).toContain("Review: All tests pass");
  expect(section().textContent).toContain("1 of 1 · Done: Ship");
  expect(section().querySelector('[data-testid="focus-more"]')!.textContent).toBe("+2 more");
  await act(async () => section().querySelector<HTMLElement>('[data-testid="focus-more"]')!.click());
  expect(section().querySelectorAll('[data-testid="focus-row"]')).toHaveLength(7);
  expect(section().querySelector('[data-testid="focus-more"]')!.textContent).toBe("Show less");
});

it("usage-limit row: selecting shows Cancel continue, which calls onCancelContinue", async () => {
  const s: State = { list: [item("l", { state: "idle" })], views: { l: view([{ type: "auto_continue", id: "auto_continue", at: Date.now() + 60_000 }]) } };
  await render(s);
  expect(rows()[0]!.dataset.kind).toBe("limit");
  expect(rows()[0]!.textContent).toContain("continues at");
  await act(async () => rows()[0]!.click());
  expect(el.querySelector('[data-testid="focus-kind-line"]')!.textContent).toContain("Usage limit");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="focus-cancel-continue"]')!.click());
  expect(cancelContinue).toHaveBeenCalledWith("l");
});

it("usage-limit row without a scheduled continue (auto-continue off): Open session, no Cancel continue", async () => {
  const s: State = { list: [item("l", { state: "idle" })], views: { l: view([{ type: "limit_stop", id: "limit_stop", stopped: true, resetsAt: Date.now() + 60_000 }]) } };
  await render(s);
  expect(rows()[0]!.dataset.kind).toBe("limit");
  expect(rows()[0]!.textContent).toContain("resets at");
  expect(el.querySelector('[data-testid="focus-row-action"]')!.textContent).toBe("Open session");
  expect(el.querySelector('[data-testid="focus-cancel-continue"]')).toBeNull();
});

it("the detail shows the task list (done, in progress, next) above the recent context", async () => {
  const s = base();
  s.views.a = view([{ type: "user_text", id: "u", text: "go", images: [] }, todo(["Plan", "completed"], ["Build", "in_progress"], ["Test", "pending"]), bash("ra", "ls", NOW)]);
  await render(s);
  const tasks = el.querySelector('[data-testid="focus-tasks"]')!;
  expect(tasks.textContent).toContain("Tasks · 2 of 3");
  expect(tasks.textContent).toMatch(/Done.*Plan.*In progress.*Build.*Next.*Test/);
  expect(tasks.compareDocumentPosition(el.querySelector('[data-testid="focus-context"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("an error row says what failed and Open session opens it", async () => {
  const raw: Part = { type: "raw", id: "raw", message: { error: "authentication_failed" } };
  const s: State = { list: [item("e", { state: "error", lastActivity: NOW })], views: { e: view([...done, raw, { type: "session_state", id: "st", state: "error" }]) }, unread: ["e"] };
  await render(s);
  expect(rows()[0]!.dataset.kind).toBe("error");
  expect(rows()[0]!.textContent).toContain("Check the error: authentication_failed");
  await act(async () => rows()[0]!.click());
  expect(el.querySelector('[data-testid="focus-title"]')!.textContent).toBe("Session e");
  await act(async () => button("Open session").click());
  expect(open).toHaveBeenCalledWith("e");
});

const three = (): State => ({
  list: [item("a"), item("b"), item("c")],
  views: { a: view([bash("pa", "ls pa", NOW - 600_000)]), b: view([bash("pb", "ls pb", NOW - 300_000, { escalated: true, reason: "risky" })]), c: view([bash("pc", "ls pc", NOW - 60_000)]) },
});
const selectedText = () => rows().find((r) => r.getAttribute("aria-current"))?.textContent ?? "";

it("an escalated row sits above an older permission row; an answered line leads", async () => {
  let set!: (s: State) => void;
  await render(three(), (s) => (set = s));
  expect(rows().map((r) => r.dataset.kind)).toEqual(["escalated", "permission", "permission"]);
  await act(async () => button("Allow once").click());
  const next = three();
  next.views.b = view([bash("pb", "ls pb", NOW - 300_000), bash("pb", "ls pb", NOW - 300_000, { settled: true, decision: "allow" })]);
  await act(async () => set(next));
  const queue = [...el.querySelectorAll<HTMLElement>('[data-testid="focus-answered"], [data-testid="focus-row"]')].map((x) => x.dataset.testid);
  expect(queue).toEqual(["focus-answered", "focus-row", "focus-row"]);
});

it("Next waiting and the selection after an answer follow the displayed order", async () => {
  await render(three());
  expect(rows().map((r) => r.textContent!.match(/ls p./)![0])).toEqual(["ls pb", "ls pa", "ls pc"]);
  expect(selectedText()).toContain("ls pb");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="focus-next"]')!.click());
  expect(selectedText()).toContain("ls pa");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="focus-next"]')!.click());
  expect(selectedText()).toContain("ls pc");
});

it("after Cancel continue removes its row the focus moves to the next row's button, else the previous, else the heading", async () => {
  let set!: (s: State) => void;
  const err = view([...done, { type: "session_state", id: "st", state: "error" } as Part]);
  const limit = (at?: number) => view([{ type: "auto_continue", id: "auto_continue", at: at ?? null } as unknown as Part]);
  const mk = (withLimit: boolean): State => ({
    list: [item("l", { state: "idle", lastActivity: NOW }), item("e", { state: "error", lastActivity: NOW - 5000 })],
    views: { l: withLimit ? limit(Date.now() + 60_000) : limit(), e: err },
    unread: ["e"],
  });
  await render(mk(true), (s) => (set = s));
  const cancel = [...el.querySelectorAll<HTMLButtonElement>('[data-testid="focus-row-action"]')].find((b) => b.textContent === "Cancel continue")!;
  cancel.focus();
  await act(async () => cancel.click());
  await act(async () => set(mk(false)));
  expect(rows().map((r) => r.dataset.kind)).toEqual(["error"]);
  expect(document.activeElement).toBe(rows()[0]);
  // The last row: nothing left, the heading takes the focus.
  const only: State = { list: [item("l", { state: "idle", lastActivity: NOW })], views: { l: limit(Date.now() + 60_000) } };
  await render(only, (s) => (set = s));
  const b = el.querySelector<HTMLButtonElement>('[data-testid="focus-row-action"]')!;
  b.focus();
  await act(async () => b.click());
  await act(async () => set({ list: only.list, views: { l: limit() } }));
  expect(document.activeElement).toBe(el.querySelector("h1"));
});

it("error, quiet, finished and limit rows have one action button beside the row, not inside it", async () => {
  const raw = { type: "session_state", id: "st", state: "error" } as Part;
  const s: State = {
    list: [item("e", { state: "error", lastActivity: NOW }), item("l", { state: "idle", lastActivity: NOW }), item("f", { state: "idle", lastActivity: NOW })],
    views: { e: view([...done, raw]), l: view([{ type: "auto_continue", id: "auto_continue", at: Date.now() + 60_000 }]), f: finish("ok") },
    unread: ["e", "f"],
  };
  await render(s);
  const actions = [...el.querySelectorAll<HTMLButtonElement>('[data-testid="focus-row-action"]')];
  expect(actions.map((b) => b.textContent)).toEqual(["Open session", "Cancel continue", "Open session"]);
  for (const b of actions) {
    expect(b.closest('[data-testid="focus-row"]')).toBeNull();
    expect(b.className).toContain("max-md:h-11");
  }
  open.mockClear();
  await act(async () => actions[0]!.click());
  expect(open).toHaveBeenCalledWith("e");
  await act(async () => actions[1]!.click());
  expect(cancelContinue).toHaveBeenCalledWith("l");
});

it("request rows have no action button", async () => {
  await render();
  expect(el.querySelector('[data-testid="focus-row-action"]')).toBeNull();
});

it("a working row of an idle session with a background task shows k of n", async () => {
  const s: State = { list: [item("a", { state: "idle", lastActivity: NOW })], views: { a: view([...done, todo(["Plan", "completed"], ["Build", "in_progress"]), { type: "session_state", id: "st", state: "idle", working: true } as Part]) } };
  await render(s);
  expect(el.querySelector('[data-testid="focus-running-row"] [data-testid="focus-progress"]')!.textContent).toBe("2 of 2");
});

it("the detail pane shows the last todo list of a finished (idle) session and the live one of a quiet running session", async () => {
  const fin = finish("ok", [todo(["Plan", "completed"], ["Ship", "completed"])]);
  await render({ list: [item("f", { state: "idle", lastActivity: NOW })], views: { f: fin }, unread: ["f"] });
  await act(async () => rows()[0]!.click());
  expect(el.querySelector('[data-testid="focus-tasks"]')!.textContent).toContain("Tasks · 2 of 2");
  const quiet = view([...done, todo(["Plan", "completed"], ["Build", "in_progress"], ["Test", "pending"])]);
  await render({ list: [item("q", { state: "running", lastActivity: 1 })], views: { q: quiet }, activity: { q: NOW - 10 * 60_000 } });
  await act(async () => rows()[0]!.click());
  expect(rows()[0]!.dataset.kind).toBe("stuck");
  expect(el.querySelector('[data-testid="focus-tasks"]')!.textContent).toContain("Tasks · 2 of 3");
});

// ---- GH-305: nested worker rows ----
const nested = (): State => ({
  list: [item("c", { state: "idle", coordinator: true }), item("w1", { coordinatorId: "c", workerName: "one" }), item("w2", { coordinatorId: "c", workerName: "two", state: "closed" })],
  views: { w1: view([bash("r1", "ls", NOW - 5000)]), w2: view([question("r2", NOW - 4000)]) },
});
const group = () => el.querySelector<HTMLElement>('[data-testid="focus-group"]');
const toggle = () => el.querySelector<HTMLButtonElement>('[data-testid="focus-group-toggle"]')!;

it("a worker's row nests under its coordinator's parent row; a closed worker's row is hidden", async () => {
  localStorage.clear();
  await render(nested());
  expect(group()!.querySelectorAll('[data-testid="focus-row"]')).toHaveLength(1);
  expect(group()!.textContent).toContain("Session c");
  expect(group()!.textContent).toContain("1 worker");
  expect(group()!.textContent).toContain("Permission");
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(toggle().className).toContain("max-md:min-h-11");
  expect(el.querySelector('[data-testid="focus-workers"]')!.className).toContain("pl-");
});

it("collapsing the group hides the worker rows, is kept in this browser and restored on remount", async () => {
  localStorage.clear();
  await render(nested());
  await act(async () => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(rows()).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem("claude-ui.focusCollapsed")!)).toEqual(["c"]);
  await render(nested());
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(rows()).toHaveLength(0);
  await act(async () => toggle().click());
  expect(rows()).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem("claude-ui.focusCollapsed")!)).toEqual([]);
});

it("a coordinator with its own row shows it with the chevron beside it, outside the row button", async () => {
  localStorage.clear();
  const s = nested();
  s.list[0]!.state = "needs_input";
  s.views.c = view([question("rc", NOW - 9000)]);
  await render(s);
  expect(rows().map((r) => r.textContent!.includes("Session c"))).toEqual([true, false]);
  expect(toggle().closest('[data-testid="focus-row"]')).toBeNull();
  await act(async () => toggle().click());
  expect(rows()).toHaveLength(1);
  expect(rows()[0]!.textContent).toContain("Session c");
});

// ---- GH-305: Next for you chip ----
const withChip = (): State => ({
  list: [item("f", { state: "idle", lastActivity: NOW })],
  views: { f: view([{ type: "user_text", id: "u", text: "go", images: [] }, { type: "session_state", id: "st", state: "running" }, { type: "assistant_text", id: "r", text: "Done.", streaming: false }, { type: "session_state", id: "st", state: "idle" }, { type: "prompt_suggestion", id: "prompt_suggestion", text: "run the tests" }]) },
  unread: ["f"],
});
const chip = () => el.querySelector<HTMLButtonElement>('[data-testid="focus-suggestion"]');
const draftKey = "claude-ui.draft.f";

it("a finished row shows the Next for you chip; a click saves the suggestion as the draft and opens the session", async () => {
  localStorage.clear();
  open.mockClear();
  await render(withChip());
  expect(chip()!.textContent).toBe("Next for you: run the tests");
  expect(chip()!.title).toBe("run the tests");
  expect(chip()!.closest('[data-testid="focus-row"]')).toBeNull();
  expect(chip()!.className).toContain("max-md:min-h-11");
  await act(async () => chip()!.click());
  expect(localStorage.getItem(draftKey)).toContain("run the tests");
  expect(open).toHaveBeenCalledWith("f");
});

it("with a draft the suggestion is appended after a blank line", async () => {
  localStorage.clear();
  await render(withChip());
  saveDraft("f", "fix the typo");
  await act(async () => chip()!.click());
  expect(loadDraft("f")).toBe("fix the typo\n\nrun the tests");
});

it("no chip without a suggestion", async () => {
  const s = withChip();
  s.views.f = view([{ type: "session_state", id: "st", state: "running" }, { type: "session_state", id: "st", state: "idle" }]);
  await render(s);
  expect(chip()).toBeNull();
});

// ---- GH-305: finished row of a closed session without a view (after a daemon restart) ----
it("a closed unread session without a view shows a Finished row; its detail has the title, project and Open session", async () => {
  open.mockClear();
  await render({ list: [item("z", { state: "closed", lastActivity: NOW })], views: {}, unread: ["z"] });
  expect(rows().map((r) => r.dataset.kind)).toEqual(["finished"]);
  await act(async () => rows()[0]!.click());
  expect(el.querySelector('[data-testid="focus-title"]')!.textContent).toBe("Session z");
  expect(el.querySelector('[data-testid="focus-context"]')).toBeNull();
  await act(async () => button("Open session").click());
  expect(open).toHaveBeenCalledWith("z");
});
