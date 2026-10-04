// @vitest-environment jsdom
// Tab switch cost (GH-51): a switch or another session's event re-renders no hidden session tab, and a tab that did not re-render
// still acts on the latest App state.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";

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

const A = "11111111-2222-3333-4444-555555555555";
const B = "66666666-7777-8888-9999-000000000000";
const item = (id: string, cwd: string): SessionListItem => ({ id, cwd, state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"], title: id === A ? "Alpha" : "Beta", lastActivity: 0, archived: false, transcript: true });
const sessions = [item(A, "/p/a"), item(B, "/p/b")];
const sent: { type: string; sessionId?: string; cwd?: string }[] = [];
let emit: (e: unknown) => void = () => {};
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void }) => {
    emit = opts.onEvent;
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    const reply = (m: { type: string; sessionId?: string }) =>
      m.type === "session.list"
        ? { sessions, projects: ["/p/a", "/p/b"] }
        : m.type === "session.subscribe"
          ? { logEpoch: "e1", session: sessions.find((s) => s.id === m.sessionId) }
          : m.type === "models.list"
            ? { models: [] }
            : m.type === "mcp.list"
              ? { servers: [] }
              : m.type === "fs.list"
                ? { entries: [] }
                : {};
    return { request: async (m: { type: string }) => (sent.push(m), reply(m)), onFsChanged: () => () => {}, onTerminal: () => () => {}, close() {} };
  },
}));
// One status bar per rendered session pane: counts the panes' renders.
const renders: string[] = [];
vi.mock("./status-bar.tsx", async (orig) => {
  const m = await orig<typeof import("./status-bar.tsx")>();
  return { ...m, StatusBar: (p: Parameters<typeof m.StatusBar>[0]) => (renders.push(p.view.state), <m.StatusBar {...p} />) };
});
const { App } = await import("./App.tsx");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  localStorage.setItem("claude-ui.tabs", JSON.stringify([A, B]));
  location.hash = `#${A}`;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  // Visit B once, then back to A: both tabs mounted.
  await select(B);
  await select(A);
  renders.length = 0;
  sent.length = 0;
});
afterEach(() => (act(() => root.unmount()), el.remove(), localStorage.clear()));

const select = (id: string) => act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${id}"] [role="tab"]`)!.click());
const shownPrompt = () => [...el.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')].find((t) => !t.closest("[hidden], [style*='display: none']"))!;

it("switching between visited session tabs re-renders neither session pane", async () => {
  await select(B);
  await select(A);
  await select(B);
  expect(renders).toEqual([]);
});

it("an event of one session re-renders only that session's tab, also while it is hidden", async () => {
  await act(async () => emit({ type: "event", sessionId: B, seq: 1, part: { type: "session_state", id: "session_state", state: "running" } }));
  expect(renders).toEqual(["running"]);
});

it("a tab shown again without a re-render sends to its own session and opens dialogs on its own project", async () => {
  await select(B);
  const prompt = shownPrompt();
  const type = (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, text);
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const enter = () => act(async () => void prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await type("hello");
  await enter();
  expect(sent).toContainEqual(expect.objectContaining({ type: "session.prompt", sessionId: B, text: "hello" }));
  await type("/mcp");
  await enter();
  await act(async () => {});
  expect(sent).toContainEqual(expect.objectContaining({ type: "mcp.list", cwd: "/p/b" }));
});
