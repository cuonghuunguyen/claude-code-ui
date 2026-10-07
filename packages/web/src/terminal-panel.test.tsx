// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionStatus, TerminalMessage, connect } from "./client.ts";
import { TerminalPanel } from "./terminal-panel.tsx";
import { TERMINAL_FONT, resetTerminalFont } from "./terminal-font.ts";
import { MAX_TERMINAL_INPUT_BYTES } from "@claude-ui/protocol";

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
  parent?: HTMLElement;
  focused: number;
  options?: { fontFamily?: string };
  /** Every fontFamily set after construction, in order. */
  fontSets: string[];
  fits: number;
};
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    t: FakeTerm = { written: [], resets: 0, cols: 80, rows: 24, selection: "", disposed: false, focused: 0, fontSets: [], fits: 0 };
    options: { fontFamily?: string };
    constructor(options: { fontFamily?: string } = {}) {
      this.t.options = options;
      const t = this.t;
      this.options = new Proxy(options, { set: (o, k, v) => (k === "fontFamily" && t.fontSets.push(v), Reflect.set(o, k, v)) });
      xterm.all.push(this.t);
    }
    get cols() {
      return this.t.cols;
    }
    get rows() {
      return this.t.rows;
    }
    get element() {
      return this.t.parent;
    }
    loadAddon() {}
    open(parent: HTMLElement) {
      this.t.parent = parent;
    }
    focus() {
      // xterm 6: focus() before open() does nothing (no textarea yet).
      if (this.t.parent) this.t.focused++;
    }
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
const fitted = vi.hoisted(() => ({ n: 0 }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() { fitted.n++; } } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
// jsdom has no layout: an element is on screen unless it or an ancestor has the class "hidden" (display: none).
Object.defineProperty(HTMLElement.prototype, "offsetParent", { get: function (this: HTMLElement) { return this.closest(".hidden") ? null : document.body; } });
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(async () => {
  await act(async () => root.render(null));
  xterm.all = [];
  fitted.n = 0;
  Reflect.deleteProperty(document, "fonts");
  resetTerminalFont();
});

/** Fake daemon: `terminals` per cwd, `buffers` replayed on attach. */
/** `createError`: terminal.create fails with it, like the daemon's too_many_terminals. */
function fakeClient(running: { id: string; title: string }[] = [], createError?: string) {
  let n = running.length;
  const terminals = running.map((t) => ({ ...t, cwd: "/p" }));
  const buffers: Record<string, string> = {};
  /** Set: terminal.input fails with it, like the daemon's input_backlog. */
  const inputError: { message?: string } = {};
  const request = vi.fn(async (m: { type: string; terminalId?: string; cwd?: string }) => {
    if (m.type === "terminal.list") return { terminals: terminals.filter((t) => t.cwd === m.cwd).map(({ id, title }) => ({ id, title })) };
    if (m.type === "terminal.create") {
      if (createError) throw new Error(createError);
      const t = { id: `t${++n}`, title: `Terminal ${n}` };
      terminals.push({ ...t, cwd: m.cwd! });
      return { terminal: t };
    }
    if (m.type === "terminal.input" && inputError.message) throw Object.assign(new Error(inputError.message), { code: "input_backlog" });
    if (m.type === "terminal.attach") return { buffer: buffers[m.terminalId!] ?? "" };
    if (m.type === "terminal.close") terminals.splice(terminals.findIndex((t) => t.id === m.terminalId), 1);
    return {};
  });
  const listeners = new Set<(m: TerminalMessage) => void>();
  const onTerminal = (l: (m: TerminalMessage) => void) => (listeners.add(l), () => void listeners.delete(l));
  const emit = (m: TerminalMessage) => listeners.forEach((l) => l(m));
  return Object.assign({ request, onTerminal } as unknown as ReturnType<typeof connect>, { emit, buffers, inputError, sent: () => request.mock.calls.map((c) => c[0]) });
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
  // Ctrl+Shift+C without a selection: not sent to the shell, the clipboard keeps its text.
  writeText.mockClear();
  t.selection = "";
  expect(key("C", { shiftKey: true })).toBe(false);
  expect(writeText).not.toHaveBeenCalled();
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

it("tabs: role=tab on the named, focusable button with roving tabindex; arrows move the selection and the focus", async () => {
  const client = fakeClient([
    { id: "t1", title: "Terminal 1" },
    { id: "t2", title: "Terminal 2" },
  ]);
  await render(client);
  await flush();
  const tab = () => [...el.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  expect(tab().map((t) => [t.tagName, t.textContent, t.getAttribute("aria-selected"), t.tabIndex])).toEqual([
    ["BUTTON", "Terminal 1", "true", 0],
    ["BUTTON", "Terminal 2", "false", -1],
  ]);
  tab()[0]!.focus();
  await act(async () => tab()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(tab().map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  expect(document.activeElement).toBe(tab()[1]);
  // Not taken by the newly shown shell.
  expect(xterm.all[1]!.focused).toBe(0);
  await act(async () => tab()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(document.activeElement).toBe(tab()[0]);
  await act(async () => tab()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(tab()[1]);
  // The tab button fills the tab (24px+ target, 44px on narrow screens).
  expect(tab()[0]!.className).toMatch(/\bh-full\b/);
  // A click on a tab gives its shell the focus, also while the focus is on a tab.
  const before = xterm.all[0]!.focused;
  await act(async () => tab()[0]!.click());
  expect(xterm.all[0]!.focused).toBe(before + 1);
});

it("opens xterm into an unpadded box: FitAddon measures the parent, so padding there would add a cut-off column", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  await render(client);
  await flush();
  const target = xterm.all[0]!.parent!;
  expect(target.className).not.toMatch(/\bp[xytrbl]?-/);
  expect(target.parentElement!.className).toMatch(/\bpx-3\.5\b/);
});

it("switching to another project shows its terminals but spawns no shell; + does; a reconnect to an empty list spawns none", async () => {
  const client = fakeClient();
  await render(client);
  await flush();
  expect(client.sent().filter((m) => m.type === "terminal.create")).toHaveLength(1);
  await act(async () => root.render(<TerminalPanel client={client} status="connected" cwd="/q" onEmpty={() => {}} />));
  await flush();
  expect(client.sent().filter((m) => m.type === "terminal.create")).toHaveLength(1);
  expect(client.sent()).toContainEqual(expect.objectContaining({ type: "terminal.list", cwd: "/q" }));
  await act(async () => root.render(<TerminalPanel client={client} status="reconnecting" cwd="/q" onEmpty={() => {}} />));
  await act(async () => root.render(<TerminalPanel client={client} status="connected" cwd="/q" onEmpty={() => {}} />));
  await flush();
  expect(client.sent().filter((m) => m.type === "terminal.create")).toHaveLength(1);
  await act(async () => (el.querySelector("[data-testid=terminal-new]") as HTMLButtonElement).click());
  await flush();
  expect(client.sent().filter((m) => m.type === "terminal.create").at(-1)).toMatchObject({ cwd: "/q" });
});

it("shows the daemon's too_many_terminals error", async () => {
  const client = fakeClient([], "at most 8 terminals per browser tab; close one");
  await render(client);
  await flush();
  expect(el.querySelector("[role=alert]")?.textContent).toBe("at most 8 terminals per browser tab; close one");
});

it("shows the daemon's input_backlog error until an input is accepted again", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  await render(client);
  await flush();
  const message = "the shell has not read the earlier input yet; send again later";
  client.inputError.message = message;
  await act(async () => xterm.all[0]!.data!("x"));
  await flush();
  expect(el.querySelector("[role=alert]")?.textContent).toBe(message);
  client.inputError.message = undefined;
  await act(async () => xterm.all[0]!.data!("y"));
  await flush();
  expect(el.querySelector("[role=alert]")).toBeNull();
});

it("sends a paste above MAX_TERMINAL_INPUT_BYTES in parts, each within the limit, without splitting a surrogate pair", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  await render(client);
  await flush();
  const big = "a".repeat(Math.floor(MAX_TERMINAL_INPUT_BYTES / 3) - 1) + "😀" + "é".repeat(70_000);
  await act(async () => xterm.all[0]!.data!(big));
  const parts = client.sent().filter((m) => m.type === "terminal.input").map((m) => (m as unknown as { data: string }).data);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.join("")).toBe(big);
  for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(MAX_TERMINAL_INPUT_BYTES);
  expect(parts[0]!.at(-1)).toBe("a");
});

it("a click on the already selected tab gives its shell the focus", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  await render(client);
  await flush();
  const before = xterm.all[0]!.focused;
  await act(async () => el.querySelector<HTMLButtonElement>("[role=tab]")!.click());
  expect(xterm.all[0]!.focused).toBe(before + 1);
});


it("after a reload, every terminal streams and the selected one is selected again", async () => {
  localStorage.clear();
  const running = [
    { id: "t1", title: "Terminal 1" },
    { id: "t2", title: "Terminal 2" },
  ];
  let client = fakeClient(running);
  await render(client);
  await flush();
  await act(async () => el.querySelectorAll<HTMLButtonElement>("[role=tab]")[1]!.click());
  // Reload: a new page, a new connection, new views.
  await act(async () => root.render(null));
  xterm.all = [];
  client = fakeClient(running);
  await render(client);
  await flush();
  expect([...el.querySelectorAll("[role=tab]")].map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  expect(client.sent().filter((m) => m.type === "terminal.attach").map((m) => m.terminalId)).toEqual(["t1", "t2"]);
  await act(async () => (client.emit({ type: "terminal.output", terminalId: "t1", data: "one" }), client.emit({ type: "terminal.output", terminalId: "t2", data: "two" })));
  expect(xterm.all.map((t) => t.written)).toEqual([["one"], ["two"]]);
  // xterm opens only on screen: opened in the hidden box, it measured no cell size and its viewport froze above the newest rows.
  expect(xterm.all.map((t) => !!t.parent)).toEqual([false, true]);
  await act(async () => el.querySelectorAll<HTMLButtonElement>("[role=tab]")[0]!.click());
  expect(xterm.all.map((t) => !!t.parent)).toEqual([true, true]);
});

it("creates the terminal with the Nerd Font stack", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  await render(client);
  await flush();
  expect(xterm.all[0]!.options!.fontFamily).toBe(TERMINAL_FONT);
});

it("opens the terminal only once the icon font is loaded, with the scrollback written meanwhile kept", async () => {
  let loaded!: () => void;
  Object.defineProperty(document, "fonts", { value: { load: () => new Promise<void>((r) => (loaded = r)) }, configurable: true });
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  client.buffers.t1 = " master";
  await render(client);
  await flush();
  expect(xterm.all[0]!.parent).toBeUndefined();
  expect(xterm.all[0]!.written).toEqual([" master"]);
  const fitsBefore = fitted.n;
  await act(async () => loaded());
  await flush();
  expect(xterm.all[0]!.parent).toBeDefined();
  expect(fitted.n).toBeGreaterThan(fitsBefore);
  expect(xterm.all[0]!.written).toEqual([" master"]);
});

it("re-measures and refits when the font arrives after the wait timed out", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let loaded!: () => void;
    Object.defineProperty(document, "fonts", { value: { load: () => new Promise<void>((r) => (loaded = r)) }, configurable: true });
    const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
    await render(client);
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    const t = xterm.all[0]!;
    // Opened without the font after the cap.
    expect(t.parent).toBeDefined();
    expect(t.fontSets).toEqual([]);
    const fits = fitted.n;
    await act(async () => void loaded());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    // Set to another value and back: xterm measures again only when the option changes.
    expect(t.fontSets.length).toBe(2);
    expect(t.fontSets.at(-1)).toBe(TERMINAL_FONT);
    expect(t.fontSets[0]).not.toBe(TERMINAL_FONT);
    expect(fitted.n).toBeGreaterThan(fits);
    expect(t.options!.fontFamily).toBe(TERMINAL_FONT);
  } finally {
    vi.useRealTimers();
  }
});

it("gives the shell the keyboard focus when the terminal opens after the icon font loaded", async () => {
  let loaded!: () => void;
  Object.defineProperty(document, "fonts", { value: { load: () => new Promise<void>((r) => (loaded = r)) }, configurable: true });
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  await render(client);
  await flush();
  expect(xterm.all[0]!.focused).toBe(0);
  await act(async () => loaded());
  await flush();
  expect(xterm.all[0]!.parent).toBeDefined();
  expect(xterm.all[0]!.focused).toBeGreaterThan(0);
});
