// Shared setup of the app-terminal-lazy*.test.tsx files: the App over a fake client and a fake xterm, to test the code-split terminal panel.
// Each test file stays its own module graph, so the panel is not loaded yet when it moves a pane. Import this module first: the mocks here
// are registered before App is imported. A test file that gates the panel (vi.mock of ./terminal-panel.tsx) declares that mock itself.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";

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

export const ID = "11111111-2222-3333-4444-555555555555";
const session: SessionListItem = { id: ID, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"], title: "Demo", lastActivity: 0, archived: false, transcript: true };
const replies: Record<string, unknown> = {
  "session.list": { sessions: [session], projects: ["/p/demo"] },
  "session.subscribe": { logEpoch: "e1", session },
  "models.list": { models: [] },
  "fs.list": { entries: [] },
  "terminal.list": { terminals: [{ id: "t1", title: "Terminal 1" }] },
  "terminal.attach": { buffer: "" },
};
/** How often the fake xterm was focused. */
export const term = { focused: 0 };
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {
      term.focused++;
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

export let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => (act(() => root.unmount()), el.remove(), localStorage.clear()));

export const TERM = `terminal:${ID}`;
export async function start(layout: unknown) {
  localStorage.setItem("claude-ui.layout", JSON.stringify(layout));
  location.hash = `#${ID}`;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
}
export const press = (init: KeyboardEventInit) => act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
export const tab = (area: string, p: string) => el.querySelector<HTMLElement>(`[data-testid="${area}"] [data-pane-tab="${p}"]`)!;
export const moveByContextMenu = async (t: HTMLElement) => {
  await act(async () => void t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  await act(async () => document.querySelector<HTMLElement>('[data-testid="pane-move"]')!.click());
};
