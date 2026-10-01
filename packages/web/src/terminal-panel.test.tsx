// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionStatus, TerminalMessage, connect } from "./client.ts";
import { TerminalPanel } from "./terminal-panel.tsx";

// xterm draws on a canvas jsdom lacks; the stub records what the panel does with it.
const xterm = vi.hoisted(() => ({ all: [] as FakeTerm[] }));
type FakeTerm = {
  written: string[];
  resets: number;
  cols: number;
  rows: number;
  selection: string;
  data?: (d: string) => void;
  resize?: (s: { cols: number; rows: number }) => void;
  key?: (e: KeyboardEvent) => boolean;
  disposed: boolean;
};
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    t: FakeTerm = { written: [], resets: 0, cols: 80, rows: 24, selection: "", disposed: false };
    options = {};
    constructor() {
      xterm.all.push(this.t);
    }
    get cols() {
      return this.t.cols;
    }
    get rows() {
      return this.t.rows;
    }
    loadAddon() {}
    open() {}
    focus() {}
    write(d: string) {
      this.t.written.push(d);
    }
    reset() {
      this.t.resets++;
      this.t.written = [];
    }
    getSelection() {
      return this.t.selection;
    }
    hasSelection() {
      return this.t.selection !== "";
    }
    onData(f: (d: string) => void) {
      this.t.data = f;
    }
    onResize(f: (s: { cols: number; rows: number }) => void) {
      this.t.resize = f;
    }
    attachCustomKeyEventHandler(f: (e: KeyboardEvent) => boolean) {
      this.t.key = f;
    }
    dispose() {
      this.t.disposed = true;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(async () => {
  await act(async () => root.render(null));
  xterm.all = [];
});

/** Fake daemon: `terminals` per cwd, `buffers` replayed on attach. */
function fakeClient(terminals: { id: string; title: string }[] = []) {
  let n = terminals.length;
  const buffers: Record<string, string> = {};
  const request = vi.fn(async (m: { type: string; terminalId?: string }) => {
    if (m.type === "terminal.list") return { terminals: [...terminals] };
    if (m.type === "terminal.create") {
      const t = { id: `t${++n}`, title: `Terminal ${n}` };
      terminals.push(t);
      return { terminal: t };
    }
    if (m.type === "terminal.attach") return { buffer: buffers[m.terminalId!] ?? "" };
    if (m.type === "terminal.close") terminals.splice(terminals.findIndex((t) => t.id === m.terminalId), 1);
    return {};
  });
  const listeners = new Set<(m: TerminalMessage) => void>();
  const onTerminal = (l: (m: TerminalMessage) => void) => (listeners.add(l), () => void listeners.delete(l));
  const emit = (m: TerminalMessage) => listeners.forEach((l) => l(m));
  return Object.assign({ request, onTerminal } as unknown as ReturnType<typeof connect>, { emit, buffers, sent: () => request.mock.calls.map((c) => c[0]) });
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const tabs = () => [...el.querySelectorAll("[data-testid=terminal-tab]")].map((t) => t.textContent);
const render = (client: ReturnType<typeof fakeClient>, status: ConnectionStatus = "connected", onEmpty = () => {}) =>
  act(async () => root.render(<TerminalPanel client={client} status={status} cwd="/p" onEmpty={onEmpty} />));

it("opens Terminal 1 in the project when none runs, streams its output and sends typed input", async () => {
  const client = fakeClient();
  await render(client);
  await flush();
  expect(client.sent()).toContainEqual(expect.objectContaining({ type: "terminal.create", cwd: "/p", cols: 80, rows: 24 }));
  expect(tabs()).toEqual(["Terminal 1"]);
  await act(async () => client.emit({ type: "terminal.output", terminalId: "t1", data: "$ " }));
  await act(async () => client.emit({ type: "terminal.output", terminalId: "other", data: "x" }));
  expect(xterm.all[0]!.written).toEqual(["$ "]);
  await act(async () => xterm.all[0]!.data!("ls\r"));
  expect(client.sent()).toContainEqual({ type: "terminal.input", terminalId: "t1", data: "ls\r" });
  await act(async () => xterm.all[0]!.resize!({ cols: 100, rows: 30 }));
  expect(client.sent()).toContainEqual({ type: "terminal.resize", terminalId: "t1", cols: 100, rows: 30 });
});

it("shows the terminals already running, a + opens another, closing the last one calls onEmpty", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  const onEmpty = vi.fn();
  await render(client, "connected", onEmpty);
  await flush();
  expect(client.sent().filter((m) => m.type === "terminal.create")).toEqual([]);
  await act(async () => (el.querySelector("[data-testid=terminal-new]") as HTMLButtonElement).click());
  await flush();
  expect(tabs()).toEqual(["Terminal 1", "Terminal 2"]);
  await act(async () => (el.querySelector("[aria-label='Close Terminal 2']") as HTMLButtonElement).click());
  // The shell exiting removes its tab too.
  await act(async () => client.emit({ type: "terminal.exit", terminalId: "t1", exitCode: 0 }));
  expect(tabs()).toEqual([]);
  expect(onEmpty).toHaveBeenCalled();
});

it("after a reconnect re-attaches and redraws from the daemon's scrollback; input is dropped while offline", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  client.buffers.t1 = "old";
  await render(client);
  await flush();
  expect(xterm.all[0]!.written).toEqual(["old"]);
  await render(client, "reconnecting");
  await act(async () => xterm.all[0]!.data!("lost"));
  expect(client.sent()).not.toContainEqual(expect.objectContaining({ type: "terminal.input" }));
  client.buffers.t1 = "old+new";
  await render(client, "connected");
  await flush();
  // Same xterm instance, redrawn from the scrollback, not appended to.
  expect(xterm.all).toHaveLength(1);
  expect(xterm.all[0]!.written).toEqual(["old+new"]);
});

it("copies the selection with Ctrl+C (Ctrl+C without a selection goes to the shell) and leaves Ctrl+V to the browser's paste", async () => {
  const writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  await render(client);
  await flush();
  const t = xterm.all[0]!;
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => t.key!(new KeyboardEvent("keydown", { key: k, ctrlKey: true, ...mods }));
  expect(key("c")).toBe(true);
  t.selection = "hello";
  expect(key("c")).toBe(false);
  expect(key("C", { shiftKey: true })).toBe(false);
  expect(writeText).toHaveBeenCalledWith("hello");
  expect(key("v")).toBe(false);
  // Ctrl+` toggles the panel (App), not a NUL for the shell.
  expect(key("`")).toBe(false);
});

it("detaches from the daemon when unmounted", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  await render(client);
  await flush();
  await act(async () => root.render(null));
  expect(client.sent()).toContainEqual({ type: "terminal.detach", terminalId: "t1" });
  expect(xterm.all[0]!.disposed).toBe(true);
});
