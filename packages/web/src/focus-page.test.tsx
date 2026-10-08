// @vitest-environment jsdom
import type { Part, SessionListItem } from "@claude-ui/protocol";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
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

type State = { list: SessionListItem[]; views: Record<string, SessionView> };
const respond = vi.fn<(id: string, a: PermissionAnswer) => void>();
const answer = vi.fn<(id: string, a: Record<string, string>) => void>();
const open = vi.fn<(id: string) => void>();

/** A Focus page over `state`; `settle` replaces the views like the daemon's settled event does. */
function Harness({ initial, onState }: { initial: State; onState?: (set: (s: State) => void) => void }) {
  const [state, setState] = useState(initial);
  const [selected, setSelected] = useState<string>();
  onState?.(setState);
  const waiting = waitingRequests(state.list, state.views, new Map(), Date.now());
  return <FocusPage list={state.list} views={state.views} worktrees={{}} waiting={waiting} selected={selected} onSelect={setSelected} onRespond={respond} onAnswer={answer} onOpenSession={open} />;
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

it("lists the waiting requests oldest first with their wait time, then the running sessions", async () => {
  await render();
  expect(rows().map((r) => r.querySelector(".font-medium")!.textContent)).toEqual(["Session a", "Session b"]);
  expect(rows()[0]!.textContent).toContain("Bash · npm run test -- auth");
  expect(rows()[1]!.textContent).toContain("Question · Keep the old route?");
  expect(el.querySelectorAll('[data-testid="focus-wait"]')).toHaveLength(2);
  expect(el.querySelector('[data-testid="focus-subtitle"]')!.textContent).toBe("2 sessions need input across 2 projects");
  expect(el.textContent).toContain("Running · 1");
  expect(el.querySelector('[data-testid="focus-running-row"]')!.textContent).toContain("Session c");
  expect(el.querySelector('[data-testid="focus-running-row"]')!.textContent).toContain("Edit");
});

it("the detail shows the selected session, its signal-only context and the request with its wait time", async () => {
  await render();
  expect(el.querySelector('[data-testid="focus-title"]')!.textContent).toBe("Session a");
  expect(el.querySelector('[data-testid="focus-context"]')!.textContent).toContain("run the auth tests");
  expect(el.querySelector('[data-testid="focus-context"]')!.textContent).toContain("2 tool calls · Read 2");
  expect(el.querySelector('[data-testid="focus-waiting"]')!.textContent).toMatch(/^waiting (\d+m )?\d+s · Bash · npm run test -- auth/);
  expect(el.querySelector('[data-testid="permission-panel"]')).not.toBeNull();
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
  expect(el.textContent).toContain("Always allow saves the rule");
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
  expect(el.querySelector('[data-testid="focus-subtitle"]')!.textContent).toBe("1 session needs input across 1 project");
});

it("a question shows its options as choices and has no Dismiss", async () => {
  await render();
  await act(async () => rows()[1]!.click());
  const panel = el.querySelector('[data-testid="question-panel"]')!;
  expect(panel.textContent).toContain("Keep");
  expect(panel.textContent).toContain("Drop");
  expect(button("Dismiss")).toBeUndefined();
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
  expect(el.textContent).toContain("Running · 1");
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
