// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionStatus, TerminalMessage, connect } from "./client.ts";
import { TerminalPanel } from "./terminal-panel.tsx";
import { TERMINAL_FONT, resetTerminalFont } from "./terminal-font.ts";
import { MAX_TERMINAL_INPUT_BYTES } from "@claude-ui/protocol";
import { bind, resetAll } from "./keymap.ts";
import { terminalTheme } from "./themes.ts";

// xterm draws on a canvas jsdom lacks; the stub records what the panel does with it.
const xterm = vi.hoisted(() => ({ all: [] as FakeTerm[] }));
type FakeTerm = {
  written: string[];
  resets: number;
  cols: number;
  rows: number;
  selection: string;
  /** End of the selection in buffer coordinates (xterm: 0-based). */
  selEnd?: { x: number; y: number };
  viewportY: number;
  mouse: string;
  pasted: string[];
  onSel?: () => void;
  data?: (d: string) => void;
  resize?: (s: { cols: number; rows: number }) => void;
  key?: (e: KeyboardEvent) => boolean;
  disposed: boolean;
  parent?: HTMLElement;
  focused: number;
  options?: { fontFamily?: string; theme?: Record<string, string> };
  /** Every fontFamily set after construction, in order. */
  fontSets: string[];
  fits: number;
};
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    t: FakeTerm = { written: [], resets: 0, cols: 80, rows: 24, selection: "", viewportY: 0, mouse: "none", pasted: [], disposed: false, focused: 0, fontSets: [], fits: 0 };
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
      // The element xterm draws in; the menu anchors to its rect.
      if (!parent.querySelector(".xterm-screen")) parent.append(Object.assign(document.createElement("div"), { className: "xterm-screen" }));
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
    get buffer() {
      return { active: { viewportY: this.t.viewportY, cursorX: 2, cursorY: 1, baseY: 0 } };
    }
    get modes() {
      return { mouseTrackingMode: this.t.mouse };
    }
    getSelectionPosition() {
      return this.t.selection ? { start: { x: 0, y: 0 }, end: this.t.selEnd ?? { x: 5, y: 3 } } : undefined;
    }
    onSelectionChange(f: () => void) {
      this.t.onSel = f;
    }
    onScroll() {}
    paste(s: string) {
      this.t.pasted.push(s);
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

// jsdom has no layout: an element is on screen unless it or an ancestor has the class "hidden" (display: none).
Object.defineProperty(HTMLElement.prototype, "offsetParent", { get: function (this: HTMLElement) { return this.closest(".hidden") ? null : document.body; } });
// jsdom has no layout: a box is 100x100 unless the test sets `size.w` to 0.
const size = { w: 100 };
Object.defineProperty(HTMLElement.prototype, "clientWidth", { get: () => size.w });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { get: () => 100 });
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(async () => {
  await act(async () => root.render(null));
  xterm.all = [];
  fitted.n = 0;
  size.w = 100;
  Reflect.deleteProperty(document, "fonts");
  resetTerminalFont();
});

/** Fake daemon: `terminals` per cwd, `buffers` replayed on attach. */
/** `createError`: terminal.create fails with it, like the daemon's too_many_terminals. */
function fakeClient(running: { id: string; title: string; cwd?: string }[] = [], createError?: string) {
  let n = running.length;
  const terminals = running.map((t) => ({ cwd: "/p", ...t }));
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
const render = (client: ReturnType<typeof fakeClient>, status: ConnectionStatus = "connected", onEmpty = () => {}, extra: { ensure?: boolean; onEnsured?: () => void; onTerminals?: (n: number) => void } = {}) =>
  act(async () => root.render(<TerminalPanel client={client} status={status} cwd="/p" onEmpty={onEmpty} {...extra} />));

it("opens Terminal 1 in the project when none runs and an open is requested (ensure), streams its output and sends typed input", async () => {
  const client = fakeClient();
  const onEnsured = vi.fn();
  await render(client, "connected", () => {}, { ensure: true, onEnsured });
  await flush();
  expect(onEnsured).toHaveBeenCalled();
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
  await render(client, "connected", () => {}, { ensure: true });
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
  await render(client, "connected", () => {}, { ensure: true });
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

const KEY = "claude-ui.terminalActive";
const selected = (panel: Element) => [...panel.querySelectorAll("[role=tab]")].filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent);
const twoFolders = [
  { id: "a1", title: "A1", cwd: "/p/a" },
  { id: "a2", title: "A2", cwd: "/p/a" },
  { id: "b1", title: "B1", cwd: "/p/b" },
  { id: "b2", title: "B2", cwd: "/p/b" },
];
const renderBoth = (client: ReturnType<typeof fakeClient>) =>
  act(async () =>
    root.render(
      <>
        <section id="a"><TerminalPanel client={client} status="connected" cwd="/p/a" onEmpty={() => {}} /></section>
        <section id="b"><TerminalPanel client={client} status="connected" cwd="/p/b" onEmpty={() => {}} /></section>
      </>,
    ),
  );

it("after a reload, each project folder selects its own terminal again", async () => {
  localStorage.clear();
  await renderBoth(fakeClient(twoFolders));
  await flush();
  for (const id of ["a", "b"]) await act(async () => el.querySelectorAll<HTMLButtonElement>(`#${id} [role=tab]`)[1]!.click());
  await act(async () => root.render(null));
  await renderBoth(fakeClient(twoFolders));
  await flush();
  expect(selected(el.querySelector("#a")!)).toEqual(["A2"]);
  expect(selected(el.querySelector("#b")!)).toEqual(["B2"]);
});

it("a project switch does not store the previous folder's terminal for the new folder", async () => {
  localStorage.clear();
  const client = fakeClient(twoFolders);
  const at = (cwd: string) => act(async () => root.render(<TerminalPanel client={client} status="connected" cwd={cwd} onEmpty={() => {}} />));
  await at("/p/a");
  await flush();
  await act(async () => el.querySelectorAll<HTMLButtonElement>("[role=tab]")[1]!.click());
  await at("/p/b");
  await flush();
  await act(async () => root.render(null));
  await at("/p/b");
  await flush();
  expect(selected(el)).toEqual(["B1"]);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ "/p/a": "a2", "/p/b": "b1" });
});

it("a legacy plain-id value selects the first terminal", async () => {
  localStorage.setItem(KEY, "t2");
  await render(fakeClient([{ id: "t1", title: "Terminal 1" }, { id: "t2", title: "Terminal 2" }]));
  await flush();
  expect(selected(el)).toEqual(["Terminal 1"]);
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

it("the New terminal button shows its key hint", async () => {
  await render(fakeClient([{ id: "t1", title: "Terminal 1" }]), "connected", vi.fn());
  await flush();
  expect(el.querySelector("[data-testid=terminal-new]")!.getAttribute("aria-label")).toBe("New terminal (Ctrl+Shift+`)");
});

it("with its binding removed the New terminal button has no empty key hint", async () => {
  bind("terminal.new", null);
  try {
    await render(fakeClient([{ id: "t1", title: "Terminal 1" }]), "connected", vi.fn());
    await flush();
    expect(el.querySelector("[data-testid=terminal-new]")!.getAttribute("aria-label")).toBe("New terminal");
  } finally {
    resetAll();
  }
});

it("showing a panel that stayed mounted hidden gives its shell the focus (Ctrl+`, the terminal tab)", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  const draw = (shown: boolean) => act(async () => root.render(<TerminalPanel client={client} status="connected" cwd="/p" onEmpty={() => {}} shown={shown} />));
  await draw(true);
  await flush();
  await draw(false);
  const before = xterm.all[0]!.focused;
  await draw(false);
  expect(xterm.all[0]!.focused).toBe(before);
  await draw(true);
  expect(xterm.all[0]!.focused).toBe(before + 1);
});

it("AC9: without ensure an empty list spawns no shell; ensure after the empty list spawns one; a folder with shells just settles the request", async () => {
  const client = fakeClient();
  const onTerminals = vi.fn();
  await render(client, "connected", () => {}, { onTerminals });
  await flush();
  expect(client.sent().filter((m) => m.type === "terminal.create")).toEqual([]);
  expect(tabs()).toEqual([]);
  expect(onTerminals).toHaveBeenLastCalledWith(0);
  const onEnsured = vi.fn();
  await render(client, "connected", () => {}, { ensure: true, onEnsured, onTerminals });
  await flush();
  expect(client.sent().filter((m) => m.type === "terminal.create")).toHaveLength(1);
  expect(onEnsured).toHaveBeenCalledTimes(1);
  expect(onTerminals).toHaveBeenLastCalledWith(1);
  // Shells exist: ensure starts nothing more.
  await render(client, "connected", () => {}, { ensure: false });
  await render(client, "connected", () => {}, { ensure: true, onEnsured });
  await flush();
  expect(client.sent().filter((m) => m.type === "terminal.create")).toHaveLength(1);
});

it("GH-468: the terminal colors follow the colour theme: ANSI colors for Catppuccin, none for Default", async () => {
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  document.documentElement.removeAttribute("data-theme");
  await render(client);
  await flush();
  expect(xterm.all[0]!.options!.theme).not.toHaveProperty("red");
  await act(async () => void document.documentElement.setAttribute("data-theme", "catppuccin"));
  expect(xterm.all[0]!.options!.theme).toEqual(terminalTheme("catppuccin", "light"));
  await act(async () => void document.documentElement.setAttribute("data-theme", "default"));
  expect(xterm.all[0]!.options!.theme).not.toHaveProperty("red");
  document.documentElement.removeAttribute("data-theme");
});

it("GH-501 a visible box of zero size is not opened or fitted; it fits once it has a size", async () => {
  const cbs: ResizeObserverCallback[] = [];
  const RO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(cb: ResizeObserverCallback) { cbs.push(cb); } observe() {} unobserve() {} disconnect() {} } as never;
  try {
    size.w = 0;
    const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
    await render(client);
    await flush();
    expect(xterm.all[0]!.parent).toBeUndefined();
    expect(fitted.n).toBe(0);
    expect(client.sent().some((m) => m.type === "terminal.resize")).toBe(false);
    size.w = 100;
    await act(async () => cbs.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(xterm.all[0]!.parent).toBeDefined();
    expect(fitted.n).toBeGreaterThan(0);
  } finally {
    globalThis.ResizeObserver = RO;
  }
});

// GH-710: selected output goes to the chat.
const SCREEN = { left: 10, top: 20, width: 800, height: 480, right: 810, bottom: 500, x: 10, y: 20, toJSON() {} } as DOMRect;
const withSelectionApi = () => {
  // jsdom has no layout: the xterm screen element is where the menu anchors.
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value: () => SCREEN });
};
const select = async (t: (typeof xterm.all)[number], text: string, end?: { x: number; y: number }) => {
  t.selection = text;
  t.selEnd = end;
  await act(async () => t.onSel!());
};
const later = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const sending = async (onSend?: (s: string) => void) => {
  withSelectionApi();
  const client = fakeClient([{ id: "t1", title: "Terminal 1" }]);
  await act(async () => root.render(<TerminalPanel client={client} status="connected" cwd="/p" onEmpty={() => {}} onSend={onSend} />));
  await flush();
  return xterm.all[0]!;
};
const ctx = (target: Element, init: MouseEventInit = {}) => act(async () => void target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 40, ...init })));
const byId = (id: string) => document.body.querySelector(`[data-testid=${id}]`) as HTMLElement | null;
const disabled = (id: string) => byId(id)!.hasAttribute("data-disabled") || byId(id)!.getAttribute("aria-disabled") === "true";

it("GH-710 a selection shows Add to chat after 150 ms; it sends the snippet with the terminal title and folder", async () => {
  const onSend = vi.fn();
  const t = await sending(onSend);
  await select(t, "\x1b[31mred-710\x1b[0m");
  expect(byId("terminal-selection")).toBeNull();
  await later(200);
  expect(byId("terminal-selection")).not.toBeNull();
  await act(async () => byId("terminal-selection-add")!.click());
  expect(onSend).toHaveBeenCalledWith('Output of terminal "Terminal 1" in `/p`:\n```text\nred-710\n```\n');
  expect(byId("terminal-selection")).toBeNull();
});

it("GH-710 no selection shows no floating menu; a cleared selection hides it", async () => {
  const t = await sending(vi.fn());
  await select(t, "");
  await later(200);
  expect(byId("terminal-selection")).toBeNull();
  await select(t, "x");
  await later(200);
  expect(byId("terminal-selection")).not.toBeNull();
  await select(t, "");
  await later(10);
  expect(byId("terminal-selection")).toBeNull();
});

it("GH-710 a selection end row scrolled out of the screen hides the menu", async () => {
  const t = await sending(vi.fn());
  t.viewportY = 100;
  await select(t, "x", { x: 5, y: 3 });
  await later(200);
  expect(byId("terminal-selection")).toBeNull();
});

it("GH-710 without onSend there is no floating menu and the context menu has no Add to chat", async () => {
  const t = await sending();
  await select(t, "x");
  await later(200);
  expect(byId("terminal-selection")).toBeNull();
  await ctx(el.querySelector("[data-testid=terminal-view]")!);
  expect(byId("terminal-menu")).not.toBeNull();
  expect(byId("terminal-menu-copy")).not.toBeNull();
  expect(byId("terminal-menu-add")).toBeNull();
});

it("GH-710 the context menu: Add to chat and Copy are disabled without a selection, Add to chat has its reason", async () => {
  const onSend = vi.fn();
  await sending(onSend);
  await ctx(el.querySelector("[data-testid=terminal-view]")!);
  expect(byId("terminal-menu")).not.toBeNull();
  expect(disabled("terminal-menu-add")).toBe(true);
  expect(disabled("terminal-menu-copy")).toBe(true);
  expect(byId("terminal-menu-add")!.title).toBe("Select text in the terminal first.");
  await act(async () => byId("terminal-menu-add")!.click());
  expect(onSend).not.toHaveBeenCalled();
});

it("GH-710 the context menu with a selection: Add to chat sends, Copy writes the clipboard, Paste pastes the clipboard text", async () => {
  const writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText, readText: vi.fn(async () => "pasted") } });
  const onSend = vi.fn();
  const t = await sending(onSend);
  t.selection = "out";
  const view = el.querySelector("[data-testid=terminal-view]")!;
  await ctx(view);
  expect(disabled("terminal-menu-add")).toBe(false);
  await act(async () => byId("terminal-menu-copy")!.click());
  expect(writeText).toHaveBeenCalledWith("out");
  await ctx(view);
  await act(async () => byId("terminal-menu-paste")!.click());
  await flush();
  expect(t.pasted).toEqual(["pasted"]);
  await ctx(view);
  await act(async () => byId("terminal-menu-add")!.click());
  expect(onSend).toHaveBeenCalledWith('Output of terminal "Terminal 1" in `/p`:\n```text\nout\n```\n');
});

it("GH-710 Paste is disabled with a hint where the clipboard cannot be read", async () => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  await sending(vi.fn());
  await ctx(el.querySelector("[data-testid=terminal-view]")!);
  expect(disabled("terminal-menu-paste")).toBe(true);
  expect(byId("terminal-menu-paste")!.title).toBe("Use Ctrl+V to paste here.");
});

it("GH-710 an app tracking the mouse, or Shift, keeps the right click: no context menu", async () => {
  const t = await sending(vi.fn());
  const view = el.querySelector("[data-testid=terminal-view]")!;
  t.mouse = "any";
  await ctx(view);
  expect(byId("terminal-menu")).toBeNull();
  t.mouse = "none";
  await ctx(view, { shiftKey: true });
  expect(byId("terminal-menu")).toBeNull();
});

it("GH-710 the ContextMenu key opens the menu and is not sent to the shell", async () => {
  const t = await sending(vi.fn());
  expect(t.key!(new KeyboardEvent("keydown", { key: "ContextMenu", cancelable: true }))).toBe(false);
  await later(50);
  expect(byId("terminal-menu")).not.toBeNull();
});

it("GH-710 the shell gets the focus back when the context menu closes, but not after Add to chat", async () => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}), readText: vi.fn(async () => "") } });
  const t = await sending(vi.fn());
  t.selection = "out";
  const view = el.querySelector("[data-testid=terminal-view]")!;
  await ctx(view);
  const before = t.focused;
  // Closed with Escape (no item that focuses by itself): the shell still gets the focus.
  await act(async () => void byId("terminal-menu")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await later(50);
  expect(byId("terminal-menu")).toBeNull();
  expect(t.focused).toBeGreaterThan(before);
  await ctx(view);
  const mid = t.focused;
  await act(async () => byId("terminal-menu-add")!.click());
  await later(50);
  expect(t.focused).toBe(mid);
});
