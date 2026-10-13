// @vitest-environment jsdom
// Agents button, agent map and subagent view (GH-36), with a fake daemon connection.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Part, SessionListItem } from "@claude-ui/protocol";
import { duration, runOf, runsOf } from "./agents.tsx";
import { emptySession, type SessionView } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};
window.matchMedia = ((query: string) => ({
  matches: /min-width: (\d+)px/.test(query) ? 1440 >= +/min-width: (\d+)px/.exec(query)![1]! : false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as never;

const ID = "11111111-2222-3333-4444-555555555555";
const session: SessionListItem = { id: ID, cwd: "/p/demo", state: "running", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"], title: "Demo", lastActivity: 0, archived: false, transcript: true };
const W1 = "22222222-2222-3333-4444-555555555551";
const W2 = "22222222-2222-3333-4444-555555555552";
const W3 = "22222222-2222-3333-4444-555555555553";
const defaultList = { sessions: [session], projects: ["/p/demo"] };
const replies: Record<string, unknown> = {
  "session.list": defaultList,
  "session.subscribe": (m: { sessionId: string }) => ({ logEpoch: "e1", session: (replies["session.list"] as typeof defaultList).sessions.find((s) => s.id === m.sessionId) ?? session }),
  "models.list": { models: [] },
  "fs.list": { entries: [] },
  "fs.search": { paths: [] },
};
let emit: (e: unknown) => void = () => {};
let changed: (m: unknown) => void = () => {};
const sent: { type: string; [k: string]: unknown }[] = [];
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onSessionsChanged?: (m: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void }) => {
    emit = opts.onEvent;
    changed = opts.onSessionsChanged ?? (() => {});
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return { request: async (m: { type: string }) => {
        sent.push(m);
        const r = replies[m.type];
        return typeof r === "function" ? r(m) : (r ?? {});
      }, onFsChanged: () => () => {}, onTerminal: () => () => {}, close() {} };
  },
}));
const { App } = await import("./App.tsx");

let seq = 0;
const send = (part: Part) => act(async () => emit({ type: "event", sessionId: ID, seq: ++seq, part }));
const run = (id: string, description: string, status: "running" | "done" | "error" | "stopped", parentId?: string): Part => ({
  type: "subagent",
  id,
  toolUseId: id,
  description,
  status,
  startedAt: Date.now() - 65_000,
  ...(status === "running" ? {} : { endedAt: Date.now() }),
  ...(parentId ? { parentId } : {}),
});

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot> | undefined;
async function mount(hash = `#${ID}`) {
  location.hash = hash;
  el = document.createElement("div");
  document.body.append(el);
  const r = (root = createRoot(el));
  await act(async () => r.render(<App />));
  await act(async () => {});
}
beforeEach(() => {
  seq = 0;
  sent.length = 0;
  // A frozen clock: durations (startedAt = now - 65 s) do not tick over a second boundary between the event and the render.
  vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
});
afterEach(() => {
  replies["session.list"] = defaultList;
  // Open tabs are restored from here: a test's tabs must not open in the next one.
  localStorage.clear();
  vi.useRealTimers();
  if (root) act(() => root!.unmount()), el.remove();
  root = undefined;
});

const $ = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const $$ = (testId: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
const click = (e: HTMLElement) => act(async () => e.click());
const key = (target: Element, k: string) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
const nodes = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];

/** a1 "Outer" (running) starts a2 "Inner" (done); a3 "Other" is done. */
async function threeRuns() {
  await send({ type: "user_text", id: "u1", text: "go", images: [] });
  await send(run("a1", "Outer", "running"));
  await send({ type: "assistant_text", id: "t1", text: "outer text", streaming: false, parentId: "a1" });
  await send(run("a2", "Inner", "done", "a1"));
  await send({ type: "assistant_text", id: "t2", text: "inner text", streaming: false, parentId: "a2" });
  await send(run("a3", "Other", "done"));
}

it("formats durations: 12s, 1m 05s, 1h 02m", () => {
  expect([duration(12_400), duration(65_000), duration(3_725_000)]).toEqual(["12s", "1m 05s", "1h 02m"]);
});

it("shows the Agents button only with a subagent run, with the number of running runs", async () => {
  await mount();
  await send({ type: "user_text", id: "u1", text: "go", images: [] });
  expect($("agents-button")).toBeNull();
  await send(run("a1", "Outer", "running"));
  expect($("agents-button")!.getAttribute("aria-label")).toBe("Agents, 1 running");
  expect($("agents-running")!.textContent).toBe("1");
  await send(run("a1", "Outer", "done"));
  expect($("agents-button")!.getAttribute("aria-label")).toBe("Agents");
  expect($("agents-running")).toBeNull();
});

it("the agent map is a tree: session root, nested runs under their parent, status and duration in each name, updated live", async () => {
  await mount();
  await threeRuns();
  await click($("agents-button")!);
  expect(document.querySelector('[role="tree"]')).not.toBeNull();
  expect(nodes().map((n) => [n.getAttribute("aria-level"), n.getAttribute("aria-label")])).toEqual([
    ["1", "Session"],
    ["2", "Outer, Running, 1m 05s"],
    ["3", "Inner, Done, 1m 05s"],
    ["2", "Other, Done, 1m 05s"],
  ]);
  await send(run("a1", "Outer", "error"));
  expect(nodes()[1]!.getAttribute("aria-label")).toMatch(/^Outer, Failed/);
});

it("keyboard: arrows move between nodes, Enter opens that run's view and closes the map; Esc closes the map without stopping the turn", async () => {
  await mount();
  await threeRuns();
  await click($("agents-button")!);
  expect(document.activeElement).toBe(nodes()[0]);
  await key(document.activeElement!, "ArrowDown");
  await key(document.activeElement!, "ArrowDown");
  expect(document.activeElement).toBe(nodes()[2]);
  await key(document.activeElement!, "ArrowLeft");
  expect(document.activeElement).toBe(nodes()[1]);
  await key(document.activeElement!, "Escape");
  expect($("agent-map")?.hasAttribute("data-open") ?? false).toBe(false);
  expect(sent.some((m) => m.type === "session.interrupt")).toBe(false);

  await click($("agents-button")!);
  await key(document.activeElement!, "End");
  await key(document.activeElement!, "Enter");
  expect($("subagent-title")!.textContent).toBe("Other");
  expect(location.hash).toBe(`#${ID}/agent/a3`);
  expect($("agent-map")?.hasAttribute("data-open") ?? false).toBe(false);
});

it("subagent view: the run's timeline, top bar, Back to the parent, Children dropdown, the root node returns to the session", async () => {
  await mount();
  await threeRuns();
  await click($("agents-button")!);
  await click(nodes()[1]!);
  const timeline = () => document.querySelector(".timeline")!.textContent;
  expect($("subagent-title")!.textContent).toBe("Outer");
  expect($("subagent-status")!.textContent).toMatch(/Running/);
  expect(timeline()).toContain("outer text");
  expect(timeline()).not.toContain("go");
  // Its own run shows inline as a group.
  expect($$("subagent").length).toBe(1);

  await click($("subagent-children")!);
  expect($$("subagent-child").map((c) => c.textContent)).toEqual([expect.stringContaining("Inner")]);
  await click($$("subagent-child")[0]!);
  expect($("subagent-title")!.textContent).toBe("Inner");
  expect(timeline()).toContain("inner text");
  expect($("subagent-children")).toBeNull();

  expect($("subagent-back")!.getAttribute("aria-label")).toBe("Back to Outer");
  await click($("subagent-back")!);
  expect($("subagent-title")!.textContent).toBe("Outer");
  await click($("subagent-back")!);
  expect($("subagent-bar")).toBeNull();
  expect(location.hash).toBe(`#${ID}`);

  await click($$("subagent-open")[0]!);
  expect($("subagent-title")!.textContent).toBe("Outer");
  await click($("agents-button")!);
  await click(nodes()[0]!);
  expect($("subagent-bar")).toBeNull();
  expect($("prompt-box")).not.toBeNull();
});

it("the inline group keeps its nested timeline and gets an Open icon into the subagent view", async () => {
  await mount();
  await threeRuns();
  expect($$("subagent").length).toBe(2);
  await click($$("subagent-open")[1]!);
  expect($("subagent-title")!.textContent).toBe("Other");
});

it("deep link: a reload of a subagent view URL shows that view; browser Back returns to the session view", async () => {
  await mount(`#${ID}/agent/a2`);
  await threeRuns();
  expect($("subagent-title")!.textContent).toBe("Inner");
  history.replaceState(null, "", `#${ID}`);
  await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
  expect($("subagent-bar")).toBeNull();
  history.replaceState(null, "", `#${ID}/agent/a1`);
  await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
  expect($("subagent-title")!.textContent).toBe("Outer");
});

it("a URL of a run that does not exist shows the session view", async () => {
  await mount(`#${ID}/agent/gone`);
  await threeRuns();
  expect($("subagent-bar")).toBeNull();
  expect($("prompt-box")).not.toBeNull();
});

it("the prompt box is replaced by the not-promptable notice; Stop agent stops that run only and hides once it ended", async () => {
  await mount(`#${ID}/agent/a1`);
  await threeRuns();
  expect($("prompt-box")).toBeNull();
  expect($("not-promptable")!.textContent).toContain("Subagent runs cannot be prompted.");
  await click($("stop-agent")!);
  expect(sent.filter((m) => m.type === "session.stopSubagent")).toEqual([expect.objectContaining({ sessionId: ID, subagentId: "a1" })]);
  expect(sent.some((m) => m.type === "session.interrupt")).toBe(false);
  await send(run("a1", "Outer", "error"));
  expect($("stop-agent")).toBeNull();
  await click($("not-promptable-back")!);
  expect($("prompt-box")).not.toBeNull();
});

it("a permission request inside a run shows in its subagent view and in the session view; one answer settles it", async () => {
  await mount(`#${ID}/agent/a1`);
  await threeRuns();
  await send({ type: "tool_call", id: "b1", toolUseId: "b1", tool: "Bash", input: { command: "npm test" }, status: "running", parentId: "a2" });
  const request: Part = { type: "permission_request", id: "r1", requestId: "r1", toolUseId: "b1", tool: "Bash", input: { command: "npm test" }, suggestions: [], settled: false };
  await send(request);
  expect($("permission-panel")).not.toBeNull();
  expect($("not-promptable")).toBeNull();
  await click($("not-promptable-back") ?? $("subagent-back")!);
  expect($("permission-panel")).not.toBeNull();
  // Another run's view does not take it over.
  history.replaceState(null, "", `#${ID}/agent/a3`);
  await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
  expect($("permission-panel")).toBeNull();
  expect($("not-promptable")).not.toBeNull();
  history.replaceState(null, "", `#${ID}/agent/a2`);
  await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
  await click([...document.querySelectorAll<HTMLElement>('[data-testid="permission-panel"] button')].find((b) => b.textContent === "Allow once")!);
  expect(sent.filter((m) => m.type === "permission.respond")).toEqual([expect.objectContaining({ requestId: "r1", decision: "allow" })]);
  await send({ ...request, settled: true, decision: "allow" } as Part);
  expect($("permission-panel")).toBeNull();
  expect($("not-promptable")).not.toBeNull();
});

it("Esc in a subagent view stops only that run; Esc in the session view stops the turn", async () => {
  await mount(`#${ID}/agent/a1`);
  await threeRuns();
  await send({ type: "session_state", id: "session_state", state: "running" });
  await key(document.body, "Escape");
  expect(sent.filter((m) => m.type === "session.stopSubagent")).toEqual([expect.objectContaining({ sessionId: ID, subagentId: "a1" })]);
  expect(sent.some((m) => m.type === "session.interrupt")).toBe(false);
  // An ended run has nothing to stop; Esc does not stop the turn either.
  await send(run("a1", "Outer", "stopped"));
  await key(document.body, "Escape");
  expect(sent.filter((m) => m.type === "session.stopSubagent" || m.type === "session.interrupt")).toHaveLength(1);
  await click($("not-promptable-back")!);
  await key(document.body, "Escape");
  expect(sent.filter((m) => m.type === "session.interrupt")).toHaveLength(1);
});

it("a stopped run reads Stopped in the map, the top bar and the inline group", async () => {
  await mount(`#${ID}/agent/a1`);
  await threeRuns();
  await send(run("a1", "Outer", "stopped"));
  expect($("subagent-status")!.textContent).toMatch(/^Stopped/);
  await click($("agents-button")!);
  expect(nodes()[1]!.getAttribute("aria-label")).toMatch(/^Outer, Stopped/);
  await click(nodes()[0]!);
  expect($$("subagent")[0]!.textContent).toContain("Stopped");
});

it("tree items carry aria-expanded, aria-posinset and aria-setsize; truncated names have a tooltip", async () => {
  await mount();
  await threeRuns();
  await click($("agents-button")!);
  expect(nodes().map((n) => [n.getAttribute("aria-expanded"), n.getAttribute("aria-posinset"), n.getAttribute("aria-setsize")])).toEqual([
    ["true", "1", "1"],
    ["true", "1", "2"],
    [null, "1", "1"],
    [null, "2", "2"],
  ]);
  expect(nodes()[1]!.querySelector("[title]")!.getAttribute("title")).toBe("Outer");
});

it("Stop agent shows its pending state and its error next to the button", async () => {
  await mount(`#${ID}/agent/a1`);
  let fail!: (e: Error) => void;
  replies["session.stopSubagent"] = new Promise((_, r) => (fail = r));
  try {
    await threeRuns();
    await click($("stop-agent")!);
    expect($("stop-agent")!.hasAttribute("disabled")).toBe(true);
    await act(async () => fail(new Error("no running subagent run with that ID")));
    expect($("stop-agent")!.hasAttribute("disabled")).toBe(false);
    expect($("not-promptable")!.querySelector('[role="alert"]')!.textContent).toBe("no running subagent run with that ID");
  } finally {
    delete replies["session.stopSubagent"];
  }
});

it("the agent map lists a run that is only in aux (unloaded page)", () => {
  const run: Part = { type: "subagent", id: "old", toolUseId: "old", description: "old run", status: "done", startedAt: 1 };
  const view: SessionView = { ...emptySession(), older: { before: "u5", pos: 50 }, aux: [{ part: run, pos: 10 }] };
  expect(runsOf(view).map((r) => r.id)).toEqual(["old"]);
  expect(runOf(view, "old")?.description).toBe("old run");
});

const worker = (id: string, name: string, over: Partial<SessionListItem> = {}): SessionListItem => ({ ...session, id, title: `T ${name}`, state: "idle", coordinatorId: ID, workerName: name, ...over });
const coordinatorItem: SessionListItem = { ...session, state: "idle", coordinator: true };
const listOf = (...sessions: SessionListItem[]) => ({ sessions, projects: ["/p/demo"] });
/** The coordinator with alpha (running), beta (idle) and gamma (idle, no CLI process). */
const withWorkers = () => (replies["session.list"] = listOf(coordinatorItem, worker(W1, "alpha", { state: "running" }), worker(W2, "beta"), worker(W3, "gamma", { live: false })));
const sendTo = (sessionId: string, part: Part) => act(async () => emit({ type: "event", sessionId, seq: ++seq, part }));
/** Mounts with the workers listed; a subscribed running worker replays its session_state, as the daemon does. */
async function mountWorkers(hash = `#${ID}`) {
  withWorkers();
  await mount(hash);
  await sendTo(W1, { type: "session_state", id: "session_state", state: "running" });
}
/** The Agents button of the tab in front (hidden tabs keep their pane). */
const shownButton = () => $$("agents-button").find((b) => !b.closest('[hidden], [style*="display: none"]'))!;
const workerRows = () => $$("agent-worker").map((w) => w.getAttribute("aria-label"));

it("a coordinator without subagent runs shows the Agents button; running workers count in the badge", async () => {
  await mountWorkers();
  expect($("agents-button")!.getAttribute("aria-label")).toBe("Agents, 1 running");
  expect($("agents-running")!.textContent).toBe("1");
  await send(run("a1", "Outer", "running"));
  expect($("agents-button")!.getAttribute("aria-label")).toBe("Agents, 2 running");
});

it("the agent map lists workers after the runs under Workers with name and state; a running worker shows a spinner", async () => {
  await mountWorkers();
  await send(run("a1", "Outer", "running"));
  await click($("agents-button")!);
  expect(nodes().map((n) => n.getAttribute("aria-label"))).toEqual(["Session", "Outer, Running, 1m 05s", "Workers", "alpha, worker, Running", "beta, worker, Idle", "Closed (1)"]);
  expect($$("agent-worker").map((w) => w.getAttribute("data-state"))).toEqual(["running", "idle"]);
  expect($$("agent-worker")[0]!.querySelector(".animate-spin")).not.toBeNull();
  expect($$("agent-worker")[1]!.querySelector(".animate-spin")).toBeNull();
  expect($$("agent-worker")[0]!.querySelector("[title]")!.getAttribute("title")).toBe("T alpha");
  // Existing subagent tests count `agent-node`: only session and run rows carry it.
  expect($$("agent-node")).toHaveLength(2);
});

it("worker state changes update the map without reload", async () => {
  await mountWorkers();
  await click($("agents-button")!);
  await sendTo(W1, { type: "session_state", id: "session_state", state: "needs_input" });
  expect(workerRows()[0]).toBe("alpha, worker, Needs input");
  await sendTo(W1, { type: "session_state", id: "session_state", state: "idle" });
  expect(workerRows()[0]).toBe("alpha, worker, Idle");
  expect($("agents-running")).toBeNull();
  replies["session.list"] = listOf(coordinatorItem, worker(W1, "alpha", { live: false }), worker(W2, "beta"), worker(W3, "gamma", { live: false }));
  await act(async () => changed({ type: "sessions.changed" }));
  expect(workerRows()).toEqual(["beta, worker, Idle"]);
  expect($("agent-closed")!.textContent).toContain("Closed (2)");
});

it("Closed (n) is collapsed; click, Enter and the arrow keys expand and collapse it; closed workers are muted", async () => {
  await mountWorkers();
  await click($("agents-button")!);
  expect($$("agent-worker")).toHaveLength(2);
  expect($("agent-closed")!.getAttribute("aria-expanded")).toBe("false");
  await click($("agent-closed")!);
  expect($("agent-closed")!.getAttribute("aria-expanded")).toBe("true");
  expect(workerRows()).toEqual(["alpha, worker, Running", "beta, worker, Idle", "gamma, worker, Closed"]);
  expect($$("agent-worker")[2]!.getAttribute("data-state")).toBe("closed");
  expect($$("agent-worker")[2]!.querySelector("span.text-muted-foreground")!.textContent).toBe("gamma");
  await click($("agent-closed")!);
  expect($$("agent-worker")).toHaveLength(2);
  await act(async () => $("agent-closed")!.focus());
  await key(document.activeElement!, "ArrowRight");
  expect($("agent-closed")!.getAttribute("aria-expanded")).toBe("true");
  await key(document.activeElement!, "ArrowRight");
  expect(document.activeElement).toBe($$("agent-worker")[2]);
  await key(document.activeElement!, "ArrowLeft");
  expect(document.activeElement).toBe($("agent-closed"));
  await key(document.activeElement!, "ArrowLeft");
  expect($("agent-closed")!.getAttribute("aria-expanded")).toBe("false");
  await key(document.activeElement!, "Enter");
  expect($("agent-closed")!.getAttribute("aria-expanded")).toBe("true");
});

it("clicking a worker row opens its session tab and closes the map; Enter on a focused worker row does the same; an open tab is reused", async () => {
  await mountWorkers();
  await click($("agents-button")!);
  await click($$("agent-worker")[1]!);
  expect(location.hash).toBe(`#${W2}`);
  expect(sent.some((m) => m.type === "session.subscribe" && m.sessionId === W2 && !m.background)).toBe(true);
  expect($("agent-map")?.hasAttribute("data-open") ?? false).toBe(false);
  const tabs = () => document.querySelectorAll('[data-testid="tab-strip"] [role="tab"]').length;
  const count = tabs();
  // Back to the coordinator through the worker's map, then to the same worker again.
  await click(shownButton());
  await click($("agent-coordinator")!);
  expect(location.hash).toBe(`#${ID}`);
  await click(shownButton());
  await act(async () => $$("agent-worker")[1]!.focus());
  await key(document.activeElement!, "Enter");
  expect(location.hash).toBe(`#${W2}`);
  expect(tabs()).toBe(count);
});

it("arrow keys move across runs, the Workers node and worker rows; ArrowLeft on a worker goes to Workers", async () => {
  await mountWorkers();
  await send(run("a1", "Outer", "running"));
  await click($("agents-button")!);
  expect(document.activeElement).toBe(nodes()[0]);
  await key(document.activeElement!, "ArrowDown");
  await key(document.activeElement!, "ArrowDown");
  expect(document.activeElement).toBe($("agent-workers"));
  await key(document.activeElement!, "ArrowDown");
  expect(document.activeElement).toBe($$("agent-worker")[0]);
  await key(document.activeElement!, "ArrowLeft");
  expect(document.activeElement).toBe($("agent-workers"));
  await key(document.activeElement!, "ArrowRight");
  expect(document.activeElement).toBe($$("agent-worker")[0]);
  await key(document.activeElement!, "End");
  expect(document.activeElement).toBe($("agent-closed"));
  await key(document.activeElement!, "Home");
  expect(document.activeElement).toBe(nodes()[0]);
});

it("a worker's map starts with Coordinator: <title>; clicking it opens the coordinator's tab", async () => {
  await mountWorkers(`#${W1}`);
  expect($("agents-button")).not.toBeNull();
  await click($("agents-button")!);
  expect(nodes()[0]!.textContent).toContain("Coordinator: Demo");
  expect(nodes()[0]!.getAttribute("aria-label")).toBe("Coordinator: Demo");
  await click(nodes()[0]!);
  expect(location.hash).toBe(`#${ID}`);
});

it("a removed worker leaves the map", async () => {
  await mountWorkers();
  await click($("agents-button")!);
  expect(workerRows()).toHaveLength(2);
  replies["session.list"] = listOf(coordinatorItem, worker(W1, "alpha", { state: "running" }), worker(W3, "gamma", { live: false }));
  await act(async () => changed({ type: "sessions.changed", deleted: W2 }));
  expect(workerRows()).toEqual(["alpha, worker, Running"]);
});

it("worker rows are 44px targets on touch", async () => {
  await mountWorkers();
  await click($("agents-button")!);
  await click($("agent-closed")!);
  for (const row of [...$$("agent-worker"), $("agent-closed")!, $("agent-workers")!]) expect(row.className).toContain("pointer-coarse:min-h-11");
});

it("keyboard focus: a focused worker that moves into the collapsed Closed group leaves focus on the Closed header, arrow keys keep working", async () => {
  await mountWorkers();
  await click($("agents-button")!);
  await act(async () => $$("agent-worker")[0]!.focus());
  replies["session.list"] = listOf(coordinatorItem, worker(W1, "alpha", { live: false }), worker(W2, "beta"), worker(W3, "gamma", { live: false }));
  await sendTo(W1, { type: "session_state", id: "session_state", state: "idle" });
  await act(async () => changed({ type: "sessions.changed" }));
  expect(workerRows()).toEqual(["beta, worker, Idle"]);
  expect(document.activeElement).toBe($("agent-closed"));
  await key(document.activeElement!, "ArrowUp");
  expect(document.activeElement).toBe($$("agent-worker")[0]);
});

it("sidebar worker rows say closed for a worker without a CLI process, as the map does", async () => {
  await mountWorkers();
  const row = (name: string) => document.querySelector<HTMLElement>(`[aria-label^="${name}, worker"]`)?.getAttribute("aria-label");
  expect(row("gamma")).toMatch(/^gamma, worker, closed/);
  expect(row("beta")).toMatch(/^beta, worker, idle/);
  expect(row("alpha")).toMatch(/^alpha, worker, running/);
});

it("reopening the map before a worker row's close animation ended does not open that worker on the next close", async () => {
  await mountWorkers();
  await click($("agents-button")!);
  // A running close animation: Base UI waits for `finished` before it reports the map closed.
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const proto = Element.prototype as { getAnimations?: () => unknown[] };
  const before = proto.getAnimations;
  proto.getAnimations = function (this: Element) {
    return this.getAttribute("data-testid") === "agent-map" && this.hasAttribute("data-closed") ? [{ finished: gate }] : [];
  };
  try {
    await click($$("agent-worker")[1]!);
    expect(location.hash).toBe(`#${ID}`);
    await click(shownButton());
    finish();
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(location.hash).toBe(`#${ID}`);
    await key(document.activeElement ?? document.body, "Escape");
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(location.hash).toBe(`#${ID}`);
  } finally {
    proto.getAnimations = before;
  }
});
