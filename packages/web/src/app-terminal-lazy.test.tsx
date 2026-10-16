// @vitest-environment jsdom
// GH-374: the terminal panel is code split (React.lazy). Its first mount in a page load suspends and commits after the render that
// caused it. This file is its own module graph, so the panel here is not loaded yet when the test moves a pane.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};
window.matchMedia = ((query: string) => ({
  get matches() {
    return /min-width: (\d+)px/.test(query) ? 1440 >= +/min-width: (\d+)px/.exec(query)![1]! : false;
  },
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as never;

const ID = "11111111-2222-3333-4444-555555555555";
const session: SessionListItem = { id: ID, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"], title: "Demo", lastActivity: 0, archived: false, transcript: true };
const replies: Record<string, unknown> = {
  "session.list": { sessions: [session], projects: ["/p/demo"] },
  "session.subscribe": { logEpoch: "e1", session },
  "models.list": { models: [] },
  "fs.list": { entries: [] },
  "terminal.list": { terminals: [{ id: "t1", title: "Terminal 1" }] },
  "terminal.attach": { buffer: "" },
};
let termFocused = 0;
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {
      termFocused++;
    }
    write() {}
    reset() {}
    onData() {}
    onResize() {}
    attachCustomKeyEventHandler() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onOpen?: () => void; onStatus?: (s: string) => void }) => {
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return { request: async (m: { type: string }) => replies[m.type] ?? {}, onFsChanged: () => () => {}, onTerminal: () => () => {}, close() {} };
  },
}));
const { App } = await import("./App.tsx");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => (act(() => root.unmount()), el.remove(), localStorage.clear()));
const tab = (area: string, p: string) => el.querySelector<HTMLElement>(`[data-testid="${area}"] [data-pane-tab="${p}"]`)!;
const moveByContextMenu = async (t: HTMLElement) => {
  await act(async () => void t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  await act(async () => document.querySelector<HTMLElement>('[data-testid="pane-move"]')!.click());
};

it("a terminal that mounts for the first time because a pane moved (lazy panel, late commit) leaves the focus on the moved tab", async () => {
  // Acceptance 6 run 1: after a reload the bottom panel holds the terminal, never shown in this page load.
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph"], bottom: ["terminal"] } }));
  location.hash = `#${ID}`;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  // Files to the bottom panel: it opens with Files shown, the terminal is not mounted.
  await moveByContextMenu(tab("side-panel", "files"));
  await act(async () => new Promise((r) => setTimeout(r, 100)));
  expect(el.querySelector('[data-testid="terminal-panel"]')).toBeNull();
  // Files back: the terminal becomes the bottom panel's shown pane and mounts once its chunk has loaded.
  await moveByContextMenu(tab("bottom-panel", "files"));
  await vi.waitFor(() => expect(el.querySelector('[data-testid="terminal-view"]')).not.toBeNull());
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(document.activeElement).toBe(tab("side-panel", "files"));
  expect(termFocused).toBe(0);
});
