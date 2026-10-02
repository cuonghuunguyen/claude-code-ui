// @vitest-environment jsdom
// Agents button, agent map and subagent view (GH-36), with a fake daemon connection.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Part, SessionListItem } from "@claude-ui/protocol";
import { duration } from "./agents.tsx";

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
const replies: Record<string, unknown> = {
  "session.list": { sessions: [session], projects: ["/p/demo"] },
  "session.subscribe": { logEpoch: "e1", session },
  "models.list": { models: [] },
  "fs.list": { entries: [] },
  "fs.search": { paths: [] },
};
let emit: (e: unknown) => void = () => {};
const sent: { type: string; [k: string]: unknown }[] = [];
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void }) => {
    emit = opts.onEvent;
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return { request: async (m: { type: string }) => (sent.push(m), replies[m.type] ?? {}), onFsChanged: () => () => {}, onTerminal: () => () => {}, close() {} };
  },
}));
const { App } = await import("./App.tsx");

let seq = 0;
const send = (part: Part) => act(async () => emit({ type: "event", sessionId: ID, seq: ++seq, part }));
const run = (id: string, description: string, status: "running" | "done" | "error", parentId?: string): Part => ({
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
});
afterEach(() => {
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
