// @vitest-environment jsdom
// App wiring of the shortcut listener and the palette, with a fake daemon connection.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { saveDiffMode } from "./diff-mode.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};
let width = 1440;
window.matchMedia = ((query: string) => ({
  // Live like a real MediaQueryList.
  get matches() {
    return /min-width: (\d+)px/.test(query) ? width >= +/min-width: (\d+)px/.exec(query)![1]! : false;
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
  "fs.search": { paths: [] },
  "fs.read": { content: "x", mtime: 1 },
  "terminal.list": { terminals: [{ id: "t1", title: "Terminal 1" }] },
  "terminal.attach": { buffer: "" },
  "session.rewindPreview": { filesChanged: [], insertions: 0, deletions: 0, conversation: true },
};
// xterm needs a canvas; the panel only has to mount.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {
      (globalThis as { __termFocused?: number }).__termFocused = ((globalThis as { __termFocused?: number }).__termFocused ?? 0) + 1;
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
let emit: (e: unknown) => void = () => {};
let sessionsChanged: (m: unknown) => void = () => {};
let reconnect: () => void = () => {};
let setStatus: (s: string) => void = () => {};
let settingsChanged: (m: unknown) => void = () => {};
const sent: { type: string }[] = [];
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void; onSessionsChanged?: (m: unknown) => void; onSettingsChanged?: (m: unknown) => void }) => {
    emit = opts.onEvent;
    settingsChanged = opts.onSettingsChanged ?? (() => {});
    sessionsChanged = opts.onSessionsChanged ?? (() => {});
    reconnect = opts.onOpen ?? (() => {});
    setStatus = opts.onStatus ?? (() => {});
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return { request: async (m: { type: string }) => (sent.push(m), typeof replies[m.type] === "function" ? (replies[m.type] as (m: unknown) => unknown)(m) : (replies[m.type] ?? {})), search: async () => ({}), onFsChanged: () => () => {}, onTerminal: () => () => {}, close() {} };
  },
}));
const { App } = await import("./App.tsx");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  width = 1440;
  location.hash = `#${ID}`;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
});
afterEach(() => (act(() => root.unmount()), el.remove(), localStorage.clear())); // unmount flushes a draft: drop it before the next test

const press = (init: KeyboardEventInit, target: EventTarget = document.body) =>
  act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
const sideTab = () => el.querySelector('[data-testid="side-panel"] [aria-selected="true"], [data-testid="side-panel"] [aria-pressed="true"]')?.textContent;
const pickSide = (name: RegExp) =>
  act(async () => [...el.querySelectorAll<HTMLElement>('[data-testid="side-panel"] button')].find((b) => name.test(b.textContent ?? ""))!.click());

it("phone: the titlebar keeps the sessions menu, tab switcher with the session name, new tab and plan ring; search and theme move to the drawer", async () => {
  const bar = el.querySelector('[data-testid="titlebar"]')!;
  const phoneHidden = (id: string) => bar.querySelector(`[data-testid="${id}"]`)!.className.includes("max-sm:hidden");
  expect(phoneHidden("quick-open-button")).toBe(true);
  expect(phoneHidden("theme-toggle")).toBe(true);
  expect(phoneHidden("keep-awake")).toBe(true);
  for (const id of ["open-drawer", "tab-switcher", "tab-new", "tab-close-active"]) expect(bar.querySelector(`[data-testid="${id}"]`)!.className).not.toContain("max-sm:hidden");
  expect(bar.querySelector('[data-testid="tab-switcher"]')!.textContent).toContain("Demo");
  // The drawer has the same two tools, for sm and up hidden.
  // The drawer is 85vw wide up to 360px (not the old fixed 288px); md and up use the sidebar width.
  expect(el.querySelector('[data-testid="sidebar"]')!.className).toContain("w-[min(85vw,360px)]");
  const tools = el.querySelector('[data-testid="drawer-tools"]')!;
  expect(tools.className).toContain("sm:hidden");
  expect(tools.querySelector('[data-testid="drawer-theme"]')).not.toBeNull();
  expect(tools.querySelector('[data-testid="drawer-keep-awake"]')).not.toBeNull();
  expect(tools.querySelector('[data-testid="drawer-quick-open"]')).not.toBeNull();
});

it("the sidebar and the drawer have no Notifications checkbox: it lives in Settings (GH-158)", async () => {
  await act(async () => el.querySelector<HTMLElement>('[data-testid="open-drawer"]')!.click());
  expect(document.querySelector('[data-testid="push-toggle"]')).toBeNull();
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
});

it("phone: Search in the drawer closes the drawer and opens quick open", async () => {
  await act(async () => el.querySelector<HTMLElement>('[data-testid="open-drawer"]')!.click());
  await act(async () => el.querySelector<HTMLElement>('[data-testid="drawer-quick-open"]')!.click());
  expect(document.querySelector('[data-testid="quick-open"]')).not.toBeNull();
});

it("Focus prompt (Ctrl+L) on a wide screen keeps the side panel on Changes", async () => {
  await pickSide(/changes/i);
  expect(sideTab()).toMatch(/changes/i);
  await press({ key: "l", code: "KeyL", ctrlKey: true });
  expect(sideTab()).toMatch(/changes/i);
});

it("Rewind from the palette on a wide screen keeps the side panel on Changes", async () => {
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "user_text", id: "u1", text: "hello", images: [] } }));
  await pickSide(/changes/i);
  await press({ key: "k", code: "KeyK", ctrlKey: true });
  const row = (title: string) => [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith(title))!;
  await act(async () => row("Rewind").click());
  await act(async () => row("hello").click());
  expect(el.querySelector('[data-testid="rewind-panel"]')).not.toBeNull();
  expect(sideTab()).toMatch(/changes/i);
});

it("an open dialog owns the keyboard: Ctrl+K does nothing while quick open shows", async () => {
  await press({ key: "p", code: "KeyP", ctrlKey: true });
  expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
  await press({ key: "k", code: "KeyK", ctrlKey: true });
  expect(document.querySelector('[data-testid="palette"]')).toBeNull();
});

it("an open dialog owns the keyboard: Ctrl+K does nothing while the Open project dialog shows", async () => {
  await act(async () => el.querySelector<HTMLElement>('[data-testid="open-project"]')!.click());
  await act(async () => {});
  expect(document.querySelector('[data-testid="open-project-dialog"]')).not.toBeNull();
  await press({ key: "k", code: "KeyK", ctrlKey: true });
  expect(document.querySelector('[data-testid="palette"]')).toBeNull();
});

it("a key the editor already handled (defaultPrevented) runs no shortcut", async () => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "k", code: "KeyK", ctrlKey: true });
  e.preventDefault();
  await act(async () => void document.body.dispatchEvent(e));
  expect(document.querySelector('[data-testid="palette"]')).toBeNull();
});

it("plain typing in the prompt box runs no shortcut", async () => {
  const box = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!;
  await press({ key: "k", code: "KeyK" }, box);
  expect(document.querySelector('[data-testid="palette"]')).toBeNull();
});

it("Ctrl+Shift+S opens the new-session tab; Alt+1 shows the first tab and Alt+9 the last, by physical key", async () => {
  await press({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
  expect(location.hash).toBe("#new");
  await press({ key: "+", code: "Digit1", altKey: true });
  expect(location.hash).toBe(`#${ID}`);
  await press({ key: "9", code: "Digit9", altKey: true });
  expect(location.hash).toBe("#new");
  await press({ key: "2", code: "Digit2", altKey: true });
  expect(location.hash).toBe("#new");
});

it("Alt+Shift+T reopens the tab Ctrl+Alt+W closed, at its place", async () => {
  await press({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
  await press({ key: "1", code: "Digit1", altKey: true });
  await press({ key: "w", code: "KeyW", ctrlKey: true, altKey: true });
  expect(location.hash).toBe("#new");
  await press({ key: "T", code: "KeyT", altKey: true, shiftKey: true });
  expect(location.hash).toBe(`#${ID}`);
  await press({ key: "9", code: "Digit9", altKey: true });
  expect(location.hash).toBe("#new");
});

it("Ctrl+/ opens Keyboard shortcuts; Ctrl+Shift+E, G show Files and Changes", async () => {
  await press({ key: "/", code: "Slash", ctrlKey: true });
  expect(document.querySelector('[data-testid="shortcuts-dialog"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Close dialog"]')!.click());
  await press({ key: "G", code: "KeyG", ctrlKey: true, shiftKey: true });
  expect(sideTab()).toMatch(/changes/i);
  await press({ key: "E", code: "KeyE", ctrlKey: true, shiftKey: true });
  expect(sideTab()).toMatch(/files/i);
});

it("prefix: Alt+A shows the hint, then c opens a new session tab; Esc cancels and nothing else happens", async () => {
  const box = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')!;
  const hint = () => document.querySelector('[data-testid="prefix-hint"]')!.textContent;
  await press({ key: "a", code: "KeyA", altKey: true }, box);
  expect(hint()).toContain("New session");
  await press({ key: "c", code: "KeyC" }, box);
  expect(hint()).toBe("");
  expect(location.hash).toBe("#new");
  await press({ key: "a", code: "KeyA", altKey: true }, document.body);
  const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => void document.body.dispatchEvent(esc));
  expect(esc.defaultPrevented).toBe(true);
  expect(hint()).toBe("");
});

it("the terminal button label follows the binding", async () => {
  expect(el.querySelector('[data-testid="terminal-toggle"]')!.getAttribute("aria-label")).toBe("Toggle terminal (Ctrl+`)");
  const { bind, resetAll } = await import("./keymap.ts");
  await act(async () => bind("terminal.toggle", "mod+alt+j"));
  expect(el.querySelector('[data-testid="terminal-toggle"]')!.getAttribute("aria-label")).toBe("Toggle terminal (Ctrl+Alt+J)");
  await act(async () => resetAll());
});

it("Focus prompt on a narrow screen switches from the files pane back to the session", async () => {
  width = 800;
  await act(async () => el.querySelector<HTMLElement>('[data-testid="pane-files"]')!.click());
  await press({ key: "l", code: "KeyL", ctrlKey: true });
  expect(el.querySelector('[data-testid="pane-session"]')!.getAttribute("aria-selected")).toBe("true");
});

it("a file found by the palette opens in the files panel", async () => {
  replies["fs.search"] = { paths: ["src/app.ts"] };
  await pickSide(/changes/i);
  await press({ key: "k", code: "KeyK", ctrlKey: true });
  const input = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "app");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {}); // the search reply
  await act(async () => document.querySelector<HTMLElement>('[data-id="file:src/app.ts"]')!.click());
  expect(document.querySelector('[data-testid="palette"]')).toBeNull();
  expect(sideTab()).toMatch(/files/i);
  replies["fs.search"] = { paths: [] };
});

it("New session in a project focuses the first prompt, also when the new-session tab is already open", async () => {
  const pencil = () => el.querySelector<HTMLElement>('[data-testid="project-new-session"]')!;
  const prompt = () => el.querySelector<HTMLElement>('[data-testid="new-session-tab"] textarea');
  for (let i = 0; i < 2; i++) {
    pencil().focus();
    await act(async () => pencil().click());
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(document.activeElement).toBe(prompt());
  }
});

it("a replayed session_state lists no sessions; a live one does", async () => {
  const lists = () => sent.filter((m) => m.type === "session.list").length;
  replies["session.subscribe"] = { logEpoch: "e1", seq: 2, session };
  // Reopen: the subscribe reply (seq 2) comes first, then its replay.
  await act(async () => root.unmount());
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  const before = lists();
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "session_state", id: "session_state", state: "running" } }));
  await act(async () => emit({ type: "event", sessionId: ID, seq: 2, part: { type: "session_state", id: "session_state", state: "idle" } }));
  expect(lists()).toBe(before);
  await act(async () => emit({ type: "event", sessionId: ID, seq: 3, part: { type: "session_state", id: "session_state", state: "running" } }));
  expect(lists()).toBe(before + 1);
  replies["session.subscribe"] = { logEpoch: "e1", session };
});

it("a compaction shows a 'Conversation compacted' divider with its summary collapsed, not a user bubble", async () => {
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "compaction", id: "b1", trigger: "manual", summary: "This session is being continued…" } }));
  const c = el.querySelector('[data-testid="compaction"]')!;
  expect(c.textContent).toContain("Conversation compacted");
  expect(c.querySelector<HTMLDetailsElement>('[data-testid="compaction-summary"]')!.open).toBe(false);
  expect(el.querySelector('[data-testid="raw-part"]')).toBeNull();
  expect([...el.querySelectorAll('[data-testid="user-message"]')].length).toBe(0);
});

it("a CLI notice shows as a gray line, a warning notice with a warning icon, not as a raw system message", async () => {
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "notice", id: "i1", level: "notice", text: "Continuing once with that noted" } }));
  await act(async () => emit({ type: "event", sessionId: ID, seq: 2, part: { type: "notice", id: "f1", level: "warning", text: "Opus 4.8 is answering instead" } }));
  const [notice, warning] = [...el.querySelectorAll<HTMLElement>('[data-testid="notice"]')];
  expect(notice!.textContent).toBe("Continuing once with that noted");
  expect(notice!.className).toContain("text-muted-foreground");
  expect(warning!.textContent).toBe("Opus 4.8 is answering instead");
  expect(warning!.className).toContain("text-warning");
  expect(warning!.querySelector("svg")?.getAttribute("aria-label")).toBe("Warning");
  expect(el.querySelector('[data-testid="raw-part"]')).toBeNull();
});

it("/clear: a live session_cleared moves the open tab to the session the CLI goes on in; a replayed one does not", async () => {
  const NEXT = "99999999-2222-3333-4444-555555555555";
  replies["session.subscribe"] = { logEpoch: "e1", seq: 1, session };
  await act(async () => root.unmount());
  localStorage.setItem("claude-ui.pinned-tabs", JSON.stringify([ID]));
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  // Replayed (seq 1 <= the subscribe reply's seq): reopening the old session later must not jump away.
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "session_cleared", id: "c0", sessionId: NEXT } }));
  expect(location.hash).toBe(`#${ID}`);
  sent.length = 0;
  await act(async () => emit({ type: "event", sessionId: ID, seq: 2, part: { type: "session_cleared", id: "c1", sessionId: NEXT } }));
  expect(location.hash).toBe(`#${NEXT}`);
  expect(sent).toContainEqual(expect.objectContaining({ type: "session.subscribe", sessionId: NEXT }));
  const tabs: string[] = JSON.parse(localStorage.getItem("claude-ui.tabs")!);
  expect([tabs.includes(NEXT), tabs.includes(ID)]).toEqual([true, false]);
  // GH-359: the pin goes with the tab.
  await act(async () => {});
  expect(JSON.parse(localStorage.getItem("claude-ui.pinned-tabs")!)).toEqual([NEXT]);
  expect(el.querySelector('[data-testid="raw-part"]')).toBeNull();
  replies["session.subscribe"] = { logEpoch: "e1", session };
});

it("/clear typed in the prompt box: the box of the session the tab follows to has the focus", async () => {
  const NEXT = "99999999-2222-3333-4444-555555555555";
  // jsdom has no layout: only the shown tab's prompt box (not in a hidden Activity) has a layout box.
  const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent")!;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get(this: HTMLElement) { return this.closest('[style*="display: none"]') ? null : document.body; } });
  try {
    replies["session.subscribe"] = (m: { sessionId: string }) => ({ logEpoch: "e1", seq: 0, session: { ...session, id: m.sessionId } });
    el.querySelector<HTMLElement>('textarea[aria-label="Prompt"]')!.focus();
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "session_cleared", id: "c1", sessionId: NEXT } }));
    await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(location.hash).toBe(`#${NEXT}`);
    const box = document.activeElement as HTMLElement;
    expect(box.getAttribute("aria-label")).toBe("Prompt");
    expect(box.offsetParent).not.toBeNull();
  } finally {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
    replies["session.subscribe"] = { logEpoch: "e1", session };
  }
});

const NEXT = "99999999-2222-3333-4444-555555555555";
const promptBox = () => [...el.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Prompt"]')].find((b) => !b.closest('[style*="display: none"]'))!;
const typeInto = (box: HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
const holdNext = () => {
  replies["session.subscribe"] = (m: { sessionId: string }) => (m.sessionId === NEXT ? new Promise(() => {}) : { logEpoch: "e1", seq: 1, session });
};
const restoreSubscribe = () => {
  replies["session.subscribe"] = { logEpoch: "e1", session };
};

it("/clear: the tab keeps its prompt box (same element, same text) and shows the new session before its subscribe reply", async () => {
  holdNext();
  try {
    const box = promptBox();
    await typeInto(box, "draft");
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "session_cleared", id: "c1", sessionId: NEXT } }));
    expect(location.hash).toBe(`#${NEXT}`);
    expect(promptBox()).toBe(box);
    expect(box.value).toBe("draft");
    expect(el.textContent).not.toContain("Open or create a session to start.");
    expect(el.querySelector('[data-testid="session-header"]')).not.toBeNull();
  } finally {
    restoreSubscribe();
  }
});

it("/clear: an attached image and the focus stay in the same prompt box", async () => {
  holdNext();
  try {
    const box = promptBox();
    box.focus();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    await act(async () => {
      box.dispatchEvent(paste);
      await new Promise((r) => setTimeout(r, 50));
    });
    const thumbs = () => promptBox().closest('[data-testid="prompt-box"]')!.parentElement!.querySelectorAll("img").length;
    expect(thumbs()).toBe(1);
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "session_cleared", id: "c1", sessionId: NEXT } }));
    expect(promptBox()).toBe(box);
    expect(thumbs()).toBe(1);
    expect(document.activeElement).toBe(box);
  } finally {
    restoreSubscribe();
  }
});

it("/clear: a prompt sent before the new session's subscribe reply goes to the new session", async () => {
  holdNext();
  try {
    await typeInto(promptBox(), "draft");
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "session_cleared", id: "c1", sessionId: NEXT } }));
    sent.length = 0;
    await press({ key: "Enter" }, promptBox());
    expect(sent).toContainEqual(expect.objectContaining({ type: "session.prompt", sessionId: NEXT, text: "draft" }));
    expect(el.textContent).toContain("draft");
  } finally {
    restoreSubscribe();
  }
});

it("/clear: reopening the old session afterwards opens its own tab with an empty prompt box", async () => {
  holdNext();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await typeInto(promptBox(), "draft");
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "session_cleared", id: "c1", sessionId: NEXT } }));
    await act(async () => {
      location.hash = `#${ID}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await act(async () => {});
    expect(promptBox().value).toBe("");
    expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    await act(async () => {
      location.hash = `#${NEXT}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(promptBox().value).toBe("draft");
  } finally {
    errors.mockRestore();
    restoreSubscribe();
  }
});

it("Enter while /clear runs queues the message: it shows at once and goes to the new session once session_cleared moves the tab", async () => {
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "user_text", id: "u1", text: "/clear", images: [] } }));
  await act(async () => emit({ type: "event", sessionId: ID, seq: 2, part: { type: "session_state", id: "s1", state: "running" } }));
  expect(el.textContent).toContain("Clearing the conversation…");
  await typeInto(promptBox(), "next");
  sent.length = 0;
  await press({ key: "Enter" }, promptBox());
  expect(sent.some((m) => m.type === "session.prompt")).toBe(false);
  expect(promptBox().value).toBe("");
  expect(el.textContent).toContain("next");
  await act(async () => emit({ type: "event", sessionId: ID, seq: 3, part: { type: "rewind", id: "r1", userMessageId: "u1" } }));
  expect(sent.some((m) => m.type === "session.prompt")).toBe(false);
  await act(async () => emit({ type: "event", sessionId: ID, seq: 4, part: { type: "session_cleared", id: "c1", sessionId: NEXT } }));
  expect(sent.filter((m) => m.type === "session.prompt")).toEqual([expect.objectContaining({ sessionId: NEXT, text: "next" })]);
  await act(async () => emit({ type: "event", sessionId: ID, seq: 5, part: { type: "session_state", id: "s2", state: "idle" } }));
  expect(el.textContent).not.toContain("Clearing the conversation…");
  expect(el.textContent).toContain("next");
  expect(sent.filter((m) => m.type === "session.prompt")).toHaveLength(1);
});

it("a /clear that ends without session_cleared sends the queued message to the same session", async () => {
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "user_text", id: "u1", text: "/clear", images: [] } }));
  await act(async () => emit({ type: "event", sessionId: ID, seq: 2, part: { type: "session_state", id: "s1", state: "running" } }));
  await typeInto(promptBox(), "next");
  sent.length = 0;
  await press({ key: "Enter" }, promptBox());
  expect(sent.some((m) => m.type === "session.prompt")).toBe(false);
  await act(async () => emit({ type: "event", sessionId: ID, seq: 3, part: { type: "session_state", id: "s2", state: "idle" } }));
  expect(sent.filter((m) => m.type === "session.prompt")).toEqual([expect.objectContaining({ sessionId: ID, text: "next" })]);
});

it("an SDK message the adapter does not know shows as a short muted line, not as JSON", async () => {
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "raw", id: "r1", message: { type: "system", subtype: "some_future_subtype", secret: "payload" } } }));
  const row = el.querySelector<HTMLElement>('[data-testid="raw-part"]')!;
  expect(row.textContent).toBe("system/some_future_subtype");
  expect(row.className).toContain("text-muted-foreground");
  expect(el.textContent).not.toContain("payload");
});

it("a failed query's error shows as a warning line, not a muted one", async () => {
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "raw", id: "r1", message: { error: "Error: boom" } } }));
  const row = el.querySelector<HTMLElement>('[data-testid="raw-part"]')!;
  expect(row.textContent).toBe("Error: boom");
  expect(row.className).toContain("text-warning");
  expect(row.querySelector('[aria-label="Warning"]')).not.toBeNull();
});

it("a CLI notice shows a run of blank lines as one blank line", async () => {
  // A UserPromptSubmit hook's block reason (development-docs/GH-46/review, screenshot 03).
  await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "notice", id: "h1", level: "warning", text: "Blocked by hook\n\n\n\nOriginal prompt: hi" } }));
  expect(el.querySelector('[data-testid="notice"]')!.textContent).toBe("Blocked by hook\n\nOriginal prompt: hi");
});

it("Remove project asks first; Cancel keeps it, Remove sends project.remove", async () => {
  const removeSent = () => sent.filter((m) => m.type === "project.remove");
  const remove = () => act(async () => el.querySelector<HTMLElement>('[data-testid="project-remove"]')!.click());
  sent.length = 0;
  await remove();
  const dialog = () => document.querySelector('[data-testid="remove-project-dialog"]');
  expect(dialog()?.textContent).toContain("Remove project?");
  expect(dialog()?.textContent).toContain("“demo” leaves the list. Its files and sessions stay on disk; open the folder again to bring it back.");
  await act(async () => document.querySelector<HTMLElement>('[data-testid="remove-project-cancel"]')!.click());
  expect(removeSent()).toEqual([]);
  await remove();
  await act(async () => document.querySelector<HTMLElement>('[data-testid="remove-project-confirm"]')!.click());
  expect(removeSent()).toEqual([{ type: "project.remove", cwd: "/p/demo" }]);
});

const openNewTab = async () => {
  await act(async () => el.querySelector<HTMLElement>('[data-testid="project-new-session"]')!.click());
  await act(async () => new Promise((r) => setTimeout(r, 50)));
};
const newPrompt = () => el.querySelector<HTMLElement>('[data-testid="new-session-tab"] textarea');
const paletteRow = (title: string) => [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith(title));

it("Ctrl+L on the new-session tab focuses its first prompt", async () => {
  await openNewTab();
  (document.activeElement as HTMLElement).blur();
  await press({ key: "l", code: "KeyL", ctrlKey: true });
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(document.activeElement).toBe(newPrompt());
});

it("the palette on the new-session tab changes the draft's permission mode, and offers Bypass when the daemon allows it", async () => {
  replies["session.list"] = { sessions: [session], projects: ["/p/demo"], permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"] };
  try {
    // Mounted again, so the first session.list brings the daemon's modes.
    act(() => root.unmount());
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    await openNewTab();
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(paletteRow("Focus prompt")).toBeDefined();
    // GH-430: the panels show on the new-session tab (wide screens): their commands are listed.
    expect(paletteRow("Toggle side panel")).toBeDefined();
    expect(paletteRow("Toggle terminal")).toBeDefined();
    await act(async () => paletteRow("Change permission mode")!.click());
    expect(paletteRow("Bypass permissions")).toBeDefined();
    await act(async () => paletteRow("Plan mode")!.click());
    expect(el.querySelector('[data-testid="new-session-tab"] [data-testid="mode-select"]')?.textContent).toContain("Plan mode");
  } finally {
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
  }
});

it("after Remove project the focus moves to the next project row, not to the page", async () => {
  const other: SessionListItem = { ...session, id: "22222222-2222-3333-4444-555555555555", cwd: "/p/other", title: "Other" };
  replies["session.list"] = { sessions: [session, other], projects: ["/p/demo", "/p/other"] };
  try {
    act(() => root.unmount());
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    await act(async () => el.querySelector<HTMLElement>('[data-cwd="/p/demo"] [data-testid="project-remove"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="remove-project-confirm"]')!.click());
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(document.activeElement).toBe(el.querySelector('[data-cwd="/p/other"] [data-testid="group-toggle"]'));
  } finally {
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
  }
});

it("Remove project of a middle row focuses the row below it, whether the reply lands before or after the dialog closes", async () => {
  const at = (cwd: string, n: number): SessionListItem => ({ ...session, id: `2222222${n}-2222-3333-4444-555555555555`, cwd, title: cwd });
  replies["session.list"] = { sessions: [session, at("/p/mid", 1), at("/p/low", 2)], projects: ["/p/demo", "/p/mid", "/p/low"] };
  try {
    act(() => root.unmount());
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    const order = [...el.querySelectorAll<HTMLElement>('[data-testid="session-group"]')].map((r) => r.dataset.cwd);
    const [, mid, below] = order;
    // The daemon's list after the remove arrives before the dialog's close finishes.
    replies["session.list"] = { sessions: [session, at("/p/mid", 1), at("/p/low", 2)].filter((s) => s.cwd !== mid), projects: order.filter((c) => c !== mid) as string[] };
    await act(async () => el.querySelector<HTMLElement>(`[data-cwd="${mid}"] [data-testid="project-remove"]`)!.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="remove-project-confirm"]')!.click());
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(el.querySelector(`[data-cwd="${mid}"]`)).toBeNull();
    expect(document.activeElement).toBe(el.querySelector(`[data-cwd="${below}"] [data-testid="group-toggle"]`));
  } finally {
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
  }
});

it("a project removed by another client closes its open session tabs here", async () => {
  const tab = () => el.querySelector(`[data-tab-id="${ID}"]`);
  expect(tab()).not.toBeNull();
  replies["session.list"] = { sessions: [], projects: [] };
  try {
    await act(async () => sessionsChanged({ type: "sessions.changed" }));
    await act(async () => {});
    expect(tab()).toBeNull();
    expect(el.textContent).not.toContain("no longer exists");
  } finally {
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
  }
});

it("xterm is code split: App loads the terminal panel lazily", async () => {
  const { readFileSync } = await import("node:fs");
  const { URL: NodeURL } = await import("node:url");
  const src = readFileSync(new NodeURL("./App.tsx", import.meta.url), "utf8");
  expect(src).not.toMatch(/^import .* from "\.\/terminal-panel\.tsx";/m);
  expect(src).toMatch(/lazy\(\(\) => import\("\.\/terminal-panel\.tsx"\)/);
});

const reload = async () => {
  act(() => root.unmount());
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
};
const panelBtn = () => el.querySelector('[data-testid="panel-toggle"]')!;
const sidePanel = () => el.querySelector('[data-testid="side-panel"]')!;

it("1440: the titlebar Toggle side panel button hides and shows the side panel; aria-expanded follows; kept across a reload", async () => {
  expect(panelBtn().getAttribute("aria-expanded")).toBe("true");
  expect(panelBtn().getAttribute("aria-controls")).toBe("side-panel");
  expect(panelBtn().className).toContain("max-lg:hidden");
  expect(sidePanel().id).toBe("side-panel");
  await act(async () => (panelBtn() as HTMLElement).click());
  expect(panelBtn().getAttribute("aria-expanded")).toBe("false");
  expect(sidePanel().parentElement!.className).toContain("lg:hidden");
  expect(localStorage.getItem("claude-ui.sidePanelHidden")).toBe("1");
  await reload();
  expect(panelBtn().getAttribute("aria-expanded")).toBe("false");
  expect(sidePanel().parentElement!.className).toContain("lg:hidden");
  await press({ key: "R", ctrlKey: true, shiftKey: true });
  expect(panelBtn().getAttribute("aria-expanded")).toBe("true");
  localStorage.clear();
});

it("Ctrl+\\ toggles the file tree, kept across a reload; with the panel hidden or on Changes it shows the panel, Files tab and tree", async () => {
  const tree = () => el.querySelector('[data-testid="file-tree"]');
  expect(tree()).not.toBeNull();
  await press({ key: "\\", ctrlKey: true });
  expect(tree()).toBeNull();
  await reload();
  expect(tree()).toBeNull();
  await act(async () => (panelBtn() as HTMLElement).click());
  await press({ key: "\\", ctrlKey: true });
  expect(panelBtn().getAttribute("aria-expanded")).toBe("true");
  expect(tree()).not.toBeNull();
  await pickSide(/changes/i);
  await press({ key: "\\", ctrlKey: true });
  expect(sideTab()).toMatch(/files/i);
  expect(tree()).not.toBeNull();
  localStorage.clear();
});

it("the terminal panel stays open across a reload", async () => {
  await act(async () => el.querySelector<HTMLElement>('[data-testid="terminal-toggle"]')!.click());
  expect(el.querySelector('[data-testid="terminal-toggle"]')!.getAttribute("aria-pressed")).toBe("true");
  act(() => root.unmount());
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  expect(el.querySelector('[data-testid="terminal-toggle"]')!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="terminal-toggle"]')!.click());
  localStorage.clear();
});

const rerender = async () => {
  act(() => root.unmount());
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
};
const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const clickId = (id: string) => act(async () => q(id)!.click());

it("wide screens dock the terminal at the bottom by default, spanning the session and side panel", async () => {
  await clickId("terminal-toggle");
  const t = q("terminal-panel")!;
  expect(t.dataset.dock).toBe("bottom");
  expect(q("bottom-panel")!.parentElement).toBe(q("work-area"));
  expect(q("bottom-panel")!.contains(t)).toBe(true);
  expect(q("bottom-panel")!.querySelector('[data-testid="pane-terminal"]')!.getAttribute("aria-selected")).toBe("true");
  expect(t.closest("main")).toBeNull();
  expect(q("work-area")!.querySelector('[data-testid="side-panel"]')).not.toBeNull();
  expect(q("work-area")!.contains(q("sidebar"))).toBe(false);
});

it("GH-434: the side panel terminal toggle uses the quiet pressed style", async () => {
  const b = () => q("terminal-toggle")!;
  expect(b().className).toContain("aria-pressed:bg-transparent");
  expect(b().className).toContain("aria-pressed:shadow-none");
  expect(b().className).toContain("aria-pressed:text-faint");
  expect(b().className).toContain("aria-pressed:hover:bg-accent");
  // The default pressed fill is replaced, not stacked under the quiet one.
  expect(b().className).not.toContain("aria-pressed:bg-secondary");
  expect(b().getAttribute("aria-pressed")).toBe("false");
  await clickId("terminal-toggle");
  expect(b().getAttribute("aria-pressed")).toBe("true");
});

it("the titlebar terminal button opens and hides the terminal, pressed while shown", async () => {
  const b = () => q("terminal-toggle-titlebar")!;
  expect(b().getAttribute("aria-pressed")).toBe("false");
  expect(b().className).toContain("max-lg:hidden");
  expect(b().getAttribute("aria-label")).toBe("Toggle terminal (Ctrl+`)");
  await clickId("terminal-toggle-titlebar");
  expect(b().getAttribute("aria-pressed")).toBe("true");
  expect(q("terminal-panel")).not.toBeNull();
  await clickId("terminal-toggle-titlebar");
  expect(b().getAttribute("aria-pressed")).toBe("false");
  expect(q("terminal-panel")).toBeNull();
});

it("the bottom terminal resizes with the arrow keys (100px to 60%) and keeps its height across a reload", async () => {
  await clickId("terminal-toggle");
  const handle = () => el.querySelector<HTMLElement>('[role="separator"][aria-label="Resize terminal"]')!;
  expect(handle().getAttribute("aria-valuenow")).toBe("280");
  await press({ key: "ArrowUp" }, handle());
  expect(handle().getAttribute("aria-valuenow")).toBe("312");
  for (let i = 0; i < 30; i++) await press({ key: "ArrowUp" }, handle());
  expect(handle().getAttribute("aria-valuenow")).toBe(String(Math.round(window.innerHeight * 0.6)));
  for (let i = 0; i < 30; i++) await press({ key: "ArrowDown" }, handle());
  expect(handle().getAttribute("aria-valuenow")).toBe("100");
  await press({ key: "ArrowUp" }, handle());
  await rerender();
  expect(handle().getAttribute("aria-valuenow")).toBe("132");
  expect(q("work-area")!.style.getPropertyValue("--terminal-h")).toBe("132px");
});

const menuItem = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const layoutKey = () => JSON.parse(localStorage.getItem("claude-ui.layout") ?? "null") as { side: string; areas: { side: string[]; bottom: string[] } } | null;

it("the terminal moves between bottom and side panel from the area menu, kept across a reload", async () => {
  await clickId("terminal-toggle");
  await clickId("dock-menu-bottom");
  expect(menuItem("dock-move").textContent).toBe("Move Terminal to side panel");
  await act(async () => menuItem("dock-move").click());
  expect(q("terminal-panel")!.dataset.dock).toBe("side");
  expect(q("side-panel")!.contains(q("terminal-panel"))).toBe(true);
  expect(q("side-panel")!.querySelector('[data-testid="pane-terminal"]')!.getAttribute("aria-selected")).toBe("true");
  expect(q("bottom-panel")).toBeNull();
  expect(layoutKey()!.areas.side).toContain("terminal");
  await rerender();
  // The layout is kept; which pane shows is per page and tab (Files), so pick the terminal again.
  expect(q("side-panel")!.querySelector('[data-testid="pane-terminal"]')).not.toBeNull();
  await clickId("pane-terminal");
  expect(q("terminal-panel")!.dataset.dock).toBe("side");
  await clickId("dock-menu-side");
  expect(menuItem("dock-move").textContent).toBe("Move Terminal to bottom panel");
  await act(async () => menuItem("dock-move").click());
  expect(q("terminal-panel")!.dataset.dock).toBe("bottom");
  expect(localStorage.getItem("claude-ui.layout")).toBeNull();
});

it("maximize hides the session view and side panel; restore and hide give them back", async () => {
  await clickId("terminal-toggle");
  const main = () => el.querySelector("main")!;
  await clickId("dock-maximize");
  expect(main().className).toContain("hidden");
  expect(el.querySelector('[aria-label="Resize terminal"]')).toBeNull();
  expect(q("bottom-panel")!.className).toContain("flex-1");
  expect(q("dock-maximize")!.getAttribute("aria-label")).toBe("Restore panel");
  await clickId("dock-maximize");
  expect(main().className).not.toMatch(/(^| )hidden( |$)/);
  expect(el.querySelector('[aria-label="Resize terminal"]')).not.toBeNull();
  await clickId("dock-maximize");
  await clickId("dock-hide");
  expect(q("terminal-panel")).toBeNull();
  expect(main().className).not.toMatch(/(^| )hidden( |$)/);
  expect(q("terminal-toggle")!.getAttribute("aria-pressed")).toBe("false");
});

const mainHidden = () => /(^| )hidden( |$)/.test(el.querySelector("main")!.className);

it("a maximized terminal restores for Focus prompt, the side panel toggle and the show-pane commands", async () => {
  await clickId("terminal-toggle");
  for (const key of [{ key: "l", code: "KeyL", ctrlKey: true }, { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true }]) {
    await clickId("dock-maximize");
    expect(mainHidden()).toBe(true);
    await press(key);
    expect(mainHidden()).toBe(false);
    expect(q("dock-maximize")!.getAttribute("aria-label")).toBe("Maximize panel");
  }
});

it("a maximized terminal restores when the shown session asks for permission", async () => {
  await clickId("terminal-toggle");
  await clickId("dock-maximize");
  expect(mainHidden()).toBe(true);
  await act(async () =>
    emit({ type: "event", sessionId: ID, seq: 1, part: { type: "permission_request", id: "p1", requestId: "r1", toolUseId: "t1", tool: "Bash", input: { command: "touch x" }, suggestions: [], settled: false } }),
  );
  expect(mainHidden()).toBe(false);
});

it("hiding the side panel keeps the bottom terminal", async () => {
  await clickId("terminal-toggle");
  await clickId("panel-toggle");
  expect(q("side-panel")!.parentElement!.className).toContain("lg:hidden");
  expect(q("terminal-panel")!.dataset.dock).toBe("bottom");
  expect(el.querySelector('[aria-label="Resize side panel"]')).toBeNull();
});

it("narrow screens keep the terminal pane whatever the position", async () => {
  width = 800;
  await rerender();
  await clickId("pane-terminal");
  const t = q("terminal-panel")!;
  expect(t.dataset.dock).toBe("side");
  expect(q("side-panel")!.contains(t)).toBe(true);
  expect(q("bottom-panel")).toBeNull();
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "terminal"], bottom: [] } }));
  await rerender();
  await clickId("pane-terminal");
  expect(q("side-panel")!.contains(q("terminal-panel"))).toBe(true);
  expect(q("bottom-panel")).toBeNull();
});

const moveFromMenu = async (area: "side" | "bottom") => {
  await clickId(`dock-menu-${area}`);
  await act(async () => menuItem("dock-move").click());
};
const paneTab = (area: string, p: string) => q(area)!.querySelector<HTMLElement>(`[data-pane-tab="${p}"]`);

it("the side panel docks left from its menu: DOM order side, resizer, session; kept across a reload; Reset layout restores right", async () => {
  const side = () => q("side-panel")!.parentElement!;
  const resizer = () => el.querySelector<HTMLElement>('[role="separator"][aria-label="Resize side panel"]')!;
  const session = () => el.querySelector("main > div.bg-card.flex-1")!;
  expect(q("dock-side-flip")).toBeNull();
  await clickId("dock-menu-side");
  expect(menuItem("dock-side-flip").textContent).toBe("Move side panel to left");
  await act(async () => menuItem("dock-side-flip").click());
  expect(layoutKey()!.side).toBe("left");
  const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(side(), resizer())).toBe(true);
  expect(follows(resizer(), session())).toBe(true);
  expect(q("panel-toggle")!.querySelector("svg")!.getAttribute("class")).toContain("panel-left");
  // Arrow keys grow the panel to the right when it is on the left.
  const w = () => +resizer().getAttribute("aria-valuenow")!;
  const before = w();
  await press({ key: "ArrowRight" }, resizer());
  expect(w()).toBe(before + 32);
  await rerender();
  expect(follows(side(), session())).toBe(true);
  await clickId("dock-menu-side");
  expect(menuItem("dock-side-flip").textContent).toBe("Move side panel to right");
  await act(async () => menuItem("dock-reset").click());
  expect(localStorage.getItem("claude-ui.layout")).toBeNull();
  expect(follows(session(), side())).toBe(true);
  expect(q("panel-toggle")!.querySelector("svg")!.getAttribute("class")).toContain("panel-right");
});

it("moving Files to the bottom keeps its content mounted (same host and child nodes)", async () => {
  const host = () => el.querySelector<HTMLElement>('[data-pane-host="files"]')!;
  const h = host();
  const child = h.firstElementChild;
  expect(q("side-panel")!.contains(h)).toBe(true);
  await clickId("pane-files");
  await moveFromMenu("side");
  expect(host()).toBe(h);
  expect(h.firstElementChild).toBe(child);
  expect(q("bottom-panel")!.contains(h)).toBe(true);
  expect(paneTab("bottom-panel", "files")!.getAttribute("aria-selected")).toBe("true");
  expect(paneTab("bottom-panel", "terminal")).not.toBeNull();
  expect(layoutKey()!.areas.bottom).toEqual(["terminal", "files"]);
});

it("an area without panes is hidden: terminal to the side hides the bottom, all side panes to the bottom hide the side", async () => {
  await clickId("terminal-toggle");
  await moveFromMenu("bottom");
  expect(q("bottom-panel")).toBeNull();
  await clickId("dock-menu-side");
  await act(async () => menuItem("dock-move").click()); // terminal back
  expect(q("bottom-panel")).not.toBeNull();
  for (const p of ["changes", "files", "graph"]) {
    const tab = paneTab("side-panel", p);
    if (!tab) continue;
    await act(async () => tab.click());
    await moveFromMenu("side");
  }
  expect(q("side-panel")!.parentElement!.className).toContain("lg:hidden");
  expect(el.querySelector('[aria-label="Resize side panel"]')).toBeNull();
});

it("each session tab remembers its pane per area", async () => {
  await clickId("terminal-toggle");
  await clickId("pane-terminal"); // tab = bottom's terminal
  await clickId("pane-changes");
  expect(paneTab("side-panel", "changes")!.getAttribute("aria-selected")).toBe("true");
  expect(paneTab("bottom-panel", "terminal")!.getAttribute("aria-selected")).toBe("true");
});

it("shortcuts follow the panes: Ctrl+` shows the terminal in the side panel, Ctrl+Shift+G changes in the bottom, Ctrl+Shift+R toggles the side panel", async () => {
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "left", areas: { side: ["files", "graph", "terminal"], bottom: ["changes"] } }));
  await rerender();
  await press({ key: "`", ctrlKey: true });
  expect(q("side-panel")!.contains(q("terminal-panel"))).toBe(true);
  expect(q("terminal-toggle-titlebar")!.getAttribute("aria-pressed")).toBe("true");
  await press({ key: "`", ctrlKey: true });
  expect(q("terminal-panel")).toBeNull();
  expect(q("side-panel")!.parentElement!.className).toContain("lg:hidden");
  await press({ key: "G", ctrlKey: true, shiftKey: true });
  expect(q("bottom-panel")).not.toBeNull();
  expect(paneTab("bottom-panel", "changes")!.getAttribute("aria-selected")).toBe("true");
  await press({ key: "R", ctrlKey: true, shiftKey: true });
  expect(q("side-panel")!.parentElement!.className).not.toContain("lg:hidden");
  await press({ key: "\\", ctrlKey: true });
  expect(q("side-panel")!.parentElement!.className).not.toContain("lg:hidden");
});

it("Reset layout from the palette restores the default", async () => {
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "left", areas: { side: ["changes", "files"], bottom: ["graph", "terminal"] } }));
  await rerender();
  await press({ key: "k", code: "KeyK", ctrlKey: true });
  const row = [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith("Reset layout"))!;
  await act(async () => row.click());
  expect(localStorage.getItem("claude-ui.layout")).toBeNull();
});

it("a pane's context menu moves it and focus lands on its tab in the new area", async () => {
  const tab = paneTab("side-panel", "changes")!;
  await act(async () => void tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  expect(menuItem("pane-move").textContent).toBe("Move to bottom panel");
  await act(async () => menuItem("pane-move").click());
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(q("bottom-panel")!.contains(paneTab("bottom-panel", "changes"))).toBe(true);
  expect(document.activeElement).toBe(paneTab("bottom-panel", "changes"));
});

const dnd = (target: Element | null, type: string, data: Map<string, string>, types = ["application/x-claude-ui-pane"]) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { dataTransfer: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", types, dropEffect: "", effectAllowed: "" } });
  return act(async () => void target!.dispatchEvent(e));
};

it("dragging a pane tab outlines the areas, shows the bottom drop strip when hidden; drop moves; dragend (Esc) changes nothing", async () => {
  const data = new Map<string, string>();
  expect(q("bottom-panel")).toBeNull();
  await dnd(paneTab("side-panel", "files"), "dragstart", data);
  expect(q("side-panel")!.className).toContain("outline-dashed");
  expect(q("drop-bottom")!.textContent).toBe("Bottom panel");
  // Esc: the browser fires dragend without drop.
  await dnd(paneTab("side-panel", "files"), "dragend", data);
  expect(q("drop-bottom")).toBeNull();
  expect(q("side-panel")!.className).not.toContain("outline");
  expect(localStorage.getItem("claude-ui.layout")).toBeNull();
  await dnd(paneTab("side-panel", "files"), "dragstart", data);
  await dnd(q("drop-bottom"), "dragover", data);
  expect(q("drop-bottom")!.className).toContain("border-primary bg-primary/5");
  await dnd(q("drop-bottom"), "drop", data);
  expect(q("bottom-panel")!.contains(paneTab("bottom-panel", "files"))).toBe(true);
  expect(paneTab("bottom-panel", "files")!.getAttribute("aria-selected")).toBe("true");
  expect(layoutKey()!.areas.bottom).toEqual(["terminal", "files"]);
  // Drop on a tab inserts before it.
  await dnd(paneTab("bottom-panel", "files"), "dragstart", data);
  await dnd(paneTab("bottom-panel", "terminal"), "drop", data);
  expect(layoutKey()!.areas.bottom).toEqual(["files", "terminal"]);
});

it("dropping a pane on the area body appends it; a session tab drag is not a target", async () => {
  await clickId("terminal-toggle");
  const data = new Map<string, string>();
  await dnd(paneTab("bottom-panel", "terminal"), "dragstart", data);
  await dnd(q("side-panel"), "dragover", data);
  expect(q("side-panel")!.className).toContain("outline-primary");
  await dnd(q("side-panel"), "drop", data);
  expect(layoutKey()!.areas.side).toEqual(["changes", "files", "graph", "plan", "terminal"]);
  const other = new Map<string, string>();
  await dnd(q("side-panel"), "dragover", other, ["application/x-claude-ui-tab"]);
  expect(q("side-panel")!.className).not.toContain("outline-primary");
});

it("dropping a pane on an area's content (inside a pane host) moves it and fills the area", async () => {
  await clickId("terminal-toggle");
  const data = new Map<string, string>();
  await dnd(paneTab("bottom-panel", "terminal"), "dragstart", data);
  // The pane content is portaled: its React events do not reach the section, so the section listens natively.
  const body = q("side-panel")!.querySelector('[data-pane-host="files"]')!.firstElementChild!;
  await dnd(body, "dragover", data);
  expect(q("side-panel")!.className).toContain("outline-primary");
  expect(q("side-panel")!.hasAttribute("data-drop-target")).toBe(true);
  await dnd(body, "drop", data);
  expect(layoutKey()!.areas.side).toEqual(["changes", "files", "graph", "plan", "terminal"]);
});

/** Terminal in the side panel, Files in a maximized bottom panel: the side panel is hidden behind the maximize. */
const maximizedBottomWithSideTerminal = async () => {
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["graph", "terminal"], bottom: ["files", "changes"] } }));
  await rerender();
  await press({ key: "E", ctrlKey: true, shiftKey: true }); // shows Files: opens the bottom panel
  await clickId("dock-maximize");
  expect(mainHidden()).toBe(true);
};

it("Ctrl+` with the terminal in the side panel restores a maximized bottom panel", async () => {
  await maximizedBottomWithSideTerminal();
  await press({ key: "`", ctrlKey: true });
  expect(mainHidden()).toBe(false);
  expect(q("side-panel")!.contains(q("terminal-panel"))).toBe(true);
});

it("New terminal with the terminal in the side panel restores a maximized bottom panel, even when the terminal was the shown side pane", async () => {
  await maximizedBottomWithSideTerminal();
  await press({ key: "`", ctrlKey: true });
  await clickId("dock-maximize");
  expect(mainHidden()).toBe(true);
  await press({ key: "`", ctrlKey: true, shiftKey: true });
  expect(mainHidden()).toBe(false);
});

it("moving a pane from a maximized bottom panel to the side panel restores it", async () => {
  await maximizedBottomWithSideTerminal();
  await clickId("dock-menu-bottom");
  expect(menuItem("dock-move").textContent).toBe("Move Files to side panel");
  await act(async () => menuItem("dock-move").click());
  expect(mainHidden()).toBe(false);
  expect(q("side-panel")!.contains(paneTab("side-panel", "files"))).toBe(true);
});

it("reordering tabs inside a maximized bottom panel keeps it maximized", async () => {
  await maximizedBottomWithSideTerminal();
  const data = new Map<string, string>();
  await dnd(paneTab("bottom-panel", "changes"), "dragstart", data);
  await dnd(paneTab("bottom-panel", "files"), "drop", data);
  expect(layoutKey()!.areas.bottom).toEqual(["changes", "files"]);
  expect(mainHidden()).toBe(true);
});

it("Ctrl+` with the terminal shown behind a maximized bottom panel restores it and focuses the shell", async () => {
  await maximizedBottomWithSideTerminal();
  await press({ key: "`", ctrlKey: true }); // terminal now the shown side pane
  await clickId("dock-maximize");
  q("dock-maximize")!.focus();
  const g = globalThis as { __termFocused?: number };
  const before = g.__termFocused ?? 0;
  await press({ key: "`", ctrlKey: true });
  expect(mainHidden()).toBe(false);
  await vi.waitFor(() => expect(g.__termFocused ?? 0).toBeGreaterThan(before));
});

it("moving a pane from its tab's context menu opened from the keyboard (Shift+F10, Enter) leaves the focus on the moved tab", async () => {
  const tab = paneTab("side-panel", "changes")!;
  tab.focus();
  await act(async () => void tab.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
  await act(async () => void tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 0, clientY: 0 })));
  await vi.waitFor(() => expect(document.activeElement).toBe(menuItem("pane-move")));
  await act(async () => void menuItem("pane-move").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await vi.waitFor(() => expect(q("bottom-panel")!.contains(paneTab("bottom-panel", "changes"))).toBe(true));
  await vi.waitFor(() => expect(document.activeElement).toBe(paneTab("bottom-panel", "changes")), { timeout: 2000 });
});

it("moving the last pane of the bottom panel from its ⋯ menu puts the focus on the moved tab, not on the prompt box", async () => {
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "graph", "terminal"], bottom: ["files"] } }));
  await rerender();
  // The prompt box had the focus before: the menu's own focus return would fall back to it once the area unmounts.
  await press({ key: "E", ctrlKey: true, shiftKey: true });
  promptBox().focus();
  await clickId("dock-menu-bottom");
  expect(menuItem("dock-move").textContent).toBe("Move Files to side panel");
  await act(async () => menuItem("dock-move").click());
  await act(async () => new Promise((r) => setTimeout(r, 100)));
  expect(q("bottom-panel")).toBeNull();
  expect(document.activeElement).toBe(paneTab("side-panel", "files"));
});

it("moving a pane away from a terminal that then shows (or moving the terminal) keeps the focus on the moved tab, not the shell", async () => {
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "terminal"], bottom: [] } }));
  await rerender();
  await press({ key: "`", ctrlKey: true });
  await clickId("pane-files"); // the terminal stays mounted, hidden
  const g = globalThis as { __termFocused?: number };
  const before = g.__termFocused ?? 0;
  const tab = paneTab("side-panel", "files")!;
  await act(async () => void tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  await act(async () => menuItem("pane-move").click());
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(q("terminal-panel")!.className).not.toContain("hidden");
  expect(document.activeElement).toBe(paneTab("bottom-panel", "files"));
  expect(g.__termFocused ?? 0).toBe(before);
  // The terminal itself moved: it shows in the bottom panel, its tab keeps the focus.
  const t = paneTab("side-panel", "terminal")!;
  await act(async () => void t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  await act(async () => menuItem("pane-move").click());
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(q("bottom-panel")!.contains(q("terminal-panel"))).toBe(true);
  expect(document.activeElement).toBe(paneTab("bottom-panel", "terminal"));
  expect(g.__termFocused ?? 0).toBe(before);
  // Revealing it on purpose still focuses the shell (no key or pointer press before: the move's quiet is still on).
  await act(async () => paneTab("bottom-panel", "files")!.click());
  await act(async () => paneTab("bottom-panel", "terminal")!.click());
  await vi.waitFor(() => expect(g.__termFocused ?? 0).toBeGreaterThan(before));
});

it("a click on the terminal's pane tab, the selected one too, focuses the shell (GH-374)", async () => {
  await clickId("terminal-toggle");
  const g = globalThis as { __termFocused?: number };
  const tab = paneTab("bottom-panel", "terminal")!;
  expect(tab.getAttribute("aria-selected")).toBe("true");
  tab.focus();
  const before = g.__termFocused ?? 0;
  await act(async () => tab.click());
  await vi.waitFor(() => expect(g.__termFocused ?? 0).toBeGreaterThan(before));
});

it("narrow screens: a click on the selected terminal pane tab focuses the shell too (GH-374)", async () => {
  width = 800;
  await rerender();
  const g = globalThis as { __termFocused?: number };
  const start = g.__termFocused ?? 0;
  await clickId("pane-terminal");
  // The first reveal's own shell focus lands first, then the count settles.
  await vi.waitFor(() => expect(g.__termFocused ?? 0).toBeGreaterThan(start));
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  expect(q("pane-terminal")!.getAttribute("aria-selected")).toBe("true");
  const before = g.__termFocused ?? 0;
  await clickId("pane-terminal");
  await vi.waitFor(() => expect(g.__termFocused ?? 0).toBeGreaterThan(before));
});

it("a kept-mounted terminal revealed by Ctrl+`, New terminal or its pane tab takes the shell focus; a move before does not keep it quiet", async () => {
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "terminal"], bottom: [] } }));
  await rerender();
  await press({ key: "`", ctrlKey: true });
  const g = globalThis as { __termFocused?: number };
  // A move first: the terminal stays quiet only until the user's next input.
  await act(async () => paneTab("side-panel", "changes")!.click());
  const t = paneTab("side-panel", "changes")!;
  await act(async () => void t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
  await act(async () => menuItem("pane-move").click());
  const panel = q("terminal-panel")!;
  for (const reveal of [() => press({ key: "`", ctrlKey: true }), () => press({ key: "`", ctrlKey: true, shiftKey: true }), () => act(async () => paneTab("side-panel", "terminal")!.click())]) {
    await act(async () => paneTab("side-panel", "files")!.click());
    expect(panel.className).toContain("hidden");
    const before = g.__termFocused ?? 0;
    await reveal();
    expect(q("terminal-panel")).toBe(panel);
    expect(panel.className).not.toContain("hidden");
    await vi.waitFor(() => expect(g.__termFocused ?? 0).toBeGreaterThan(before));
  }
});

it("after a move the focus is not taken back: a button focused right after keeps it", async () => {
  await clickId("terminal-toggle");
  const tab = paneTab("side-panel", "changes")!;
  tab.focus();
  await act(async () => void tab.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
  await act(async () => void tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 0, clientY: 0 })));
  await vi.waitFor(() => expect(document.activeElement).toBe(menuItem("pane-move")));
  await act(async () => void menuItem("pane-move").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await vi.waitFor(() => expect(document.activeElement).toBe(paneTab("bottom-panel", "changes")));
  // The user tabs on at once (Tab from the moved tab reaches the bottom panel's buttons).
  q("dock-maximize")!.focus();
  await act(async () => new Promise((r) => setTimeout(r, 600)));
  expect(document.activeElement).toBe(q("dock-maximize"));
});

it("with no pane in the side panel the toggle is disabled with the reason, and Ctrl+Shift+R does nothing", async () => {
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: [], bottom: ["changes", "files", "graph", "terminal"] } }));
  await rerender();
  const b = q("panel-toggle")!;
  expect(b.getAttribute("aria-label")).toBe("No panes in the side panel");
  expect(b.getAttribute("aria-disabled")).toBe("true");
  expect(b.getAttribute("aria-expanded")).toBe("false");
  await act(async () => b.click());
  await press({ key: "R", ctrlKey: true, shiftKey: true });
  expect(q("panel-toggle")!.getAttribute("aria-expanded")).toBe("false");
});

it("the terminal stays mounted while another pane of its area is selected", async () => {
  localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "terminal"], bottom: [] } }));
  await rerender();
  await press({ key: "`", ctrlKey: true });
  const t = q("terminal-panel")!;
  await clickId("pane-files");
  expect(q("terminal-panel")).toBe(t);
  expect(t.className).toContain("hidden");
  await clickId("pane-terminal");
  expect(q("terminal-panel")).toBe(t);
  expect(t.className).not.toContain("hidden");
  // Hiding the area unmounts it as before.
  await press({ key: "`", ctrlKey: true });
  expect(q("terminal-panel")).toBeNull();
});

it("Hide bottom panel is not the terminal's command (no Ctrl+` tip)", async () => {
  await clickId("terminal-toggle");
  expect(q("dock-hide")!.hasAttribute("data-command")).toBe(false);
  expect(q("dock-hide")!.getAttribute("aria-label")).toBe("Hide bottom panel");
});

it("the sessions sidebar resizes with the arrow keys (200px to half the window) and keeps its width across a reload", async () => {
  const handle = () => el.querySelector<HTMLElement>('[data-testid="sidebar-resizer"]')!;
  const width = () => el.querySelector<HTMLElement>('[data-testid="sidebar"]')!.style.getPropertyValue("--sidebar-w");
  expect(handle().getAttribute("aria-valuenow")).toBe("288");
  await press({ key: "ArrowRight" }, handle());
  expect(width()).toBe("320px");
  for (let i = 0; i < 30; i++) await press({ key: "ArrowLeft" }, handle());
  expect(handle().getAttribute("aria-valuenow")).toBe("200");
  await press({ key: "ArrowRight" }, handle());
  act(() => root.unmount());
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  expect(width()).toBe("232px");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="tab-home"]')!.click());
  expect(handle()).toBeNull();
  await act(async () => el.querySelector<HTMLElement>('[data-testid="tab-home"]')!.click());
  localStorage.clear();
});

const MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk"] as const;
const AUTO_MODELS = [
  { value: "sonnet", displayName: "Sonnet 5.5", description: "", supportsAutoMode: true },
  { value: "haiku", displayName: "Haiku 4.5", description: "" },
];
/** Mounts the app again so the first replies carry `over`. */
async function remount(over: Record<string, unknown>) {
  const saved = Object.fromEntries(Object.keys(over).map((k) => [k, replies[k]]));
  Object.assign(replies, over);
  act(() => root.unmount());
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  return () => Object.assign(replies, saved);
}
const pickOption = async (trigger: string, name: string) => {
  await act(async () => el.querySelector<HTMLElement>(trigger)!.click());
  await act(async () => [...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent === name)!.click());
};
const optionsOf = async (scope: string) => {
  await act(async () => el.querySelector<HTMLElement>(`${scope} [data-testid="mode-select"]`)!.click());
  const names = [...document.querySelectorAll<HTMLElement>("[role=option]")].map((o) => o.textContent);
  await press({ key: "Escape" });
  return names;
};

it("a session in auto mode that gets a model without auto support is in Ask, and a toast says why", async () => {
  const auto = { ...session, model: "sonnet", permissionMode: "auto", permissionModes: [...MODES] };
  const restore = await remount({
    "session.list": { sessions: [auto], projects: ["/p/demo"] },
    "session.subscribe": { logEpoch: "e1", session: auto },
    "models.list": { models: AUTO_MODELS },
    "session.setModel": { session: { ...auto, model: "haiku", permissionMode: "default", permissionModes: ["default", "acceptEdits", "plan", "dontAsk"] } },
  });
  try {
    expect(el.querySelector('[data-testid="toast"]')).toBeNull();
    await pickOption('[data-testid="session-model"]', "Haiku 4.5");
    // The daemon's session_model and session_permission_mode events (the log tells every tab).
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "session_model", id: "session_model", model: "haiku" } }));
    await act(async () => emit({ type: "event", sessionId: ID, seq: 2, part: { type: "session_permission_mode", id: "session_permission_mode", mode: "default" } }));
    expect(el.querySelector('[data-testid="toast"]')?.textContent).toBe("Auto mode not available for Haiku 4.5; switched to Ask");
    expect(el.querySelector('[data-testid="mode-select"]')?.textContent).toContain("Ask");
  } finally {
    restore();
  }
});

it("a model change in another mode shows no toast", async () => {
  const plan = { ...session, model: "sonnet", permissionMode: "plan", permissionModes: [...MODES] };
  const restore = await remount({
    "session.list": { sessions: [plan], projects: ["/p/demo"] },
    "session.subscribe": { logEpoch: "e1", session: plan },
    "models.list": { models: AUTO_MODELS },
    "session.setModel": { session: { ...plan, model: "haiku", permissionModes: ["default", "acceptEdits", "plan", "dontAsk"] } },
  });
  try {
    await pickOption('[data-testid="session-model"]', "Haiku 4.5");
    expect(el.querySelector('[data-testid="toast"]')).toBeNull();
  } finally {
    restore();
  }
});

it("the new-session tab offers Auto mode only while its model supports it, and leaving auto shows the toast", async () => {
  const restore = await remount({
    "session.list": { sessions: [session], projects: ["/p/demo"], permissionModes: ["default", "acceptEdits", "plan", "auto", "dontAsk"] },
    "models.list": { models: [{ ...AUTO_MODELS[0]!, value: "default", displayName: "Default (recommended)" }, AUTO_MODELS[1]!] },
  });
  try {
    await openNewTab();
    const tab = '[data-testid="new-session-tab"]';
    expect(await optionsOf(tab)).toEqual(["Ask before edits", "Edit automatically", "Plan mode", "Auto mode", "Don't ask (deny unapproved)"]);
    await pickOption(`${tab} [data-testid="mode-select"]`, "Auto mode");
    expect(el.querySelector(`${tab} [data-testid="mode-select"]`)?.textContent).toContain("Auto mode");
    expect(el.querySelector('[data-testid="toast"]')).toBeNull();
    await pickOption(`${tab} [data-testid="session-model"]`, "Haiku 4.5");
    expect(el.querySelector('[data-testid="toast"]')?.textContent).toBe("Auto mode not available for Haiku 4.5; switched to Ask");
    expect(el.querySelector(`${tab} [data-testid="mode-select"]`)?.textContent).toContain("Ask");
    expect(await optionsOf(tab)).not.toContain("Auto mode");
  } finally {
    restore();
  }
});

it("the new-session tab preselects the mode the daemon reports for its project; a picked mode stays", async () => {
  const restore = await remount({
    "session.list": { sessions: [session], projects: ["/p/demo"], permissionModes: ["default", "acceptEdits", "plan", "auto", "dontAsk"] },
    "models.list": { models: [{ ...AUTO_MODELS[0]!, value: "default", displayName: "Default (recommended)" }, AUTO_MODELS[1]!] },
    "session.defaultMode": { mode: "auto" },
  });
  try {
    sent.length = 0;
    await openNewTab();
    const select = '[data-testid="new-session-tab"] [data-testid="mode-select"]';
    expect(sent).toContainEqual({ type: "session.defaultMode", cwd: "/p/demo" });
    expect(el.querySelector(select)?.textContent).toContain("Auto mode");
    await pickOption(select, "Plan mode");
    expect(el.querySelector(select)?.textContent).toContain("Plan mode");
    await pickOption('[data-testid="new-session-tab"] [data-testid="session-model"]', "Haiku 4.5");
    // Picked Plan stays; the model change does not bring the settings mode back.
    expect(el.querySelector(select)?.textContent).toContain("Plan mode");
  } finally {
    restore();
  }
});

it("the new-session tab shows Ask when a project's default mode (auto) arrives for a model without auto", async () => {
  const restore = await remount({
    "session.list": { sessions: [session, { ...session, id: "other", cwd: "/p/other" }], projects: ["/p/demo", "/p/other"], permissionModes: ["default", "acceptEdits", "plan", "auto", "dontAsk"] },
    "models.list": { models: [{ ...AUTO_MODELS[0]!, value: "default", displayName: "Default (recommended)" }, AUTO_MODELS[1]!] },
    "session.defaultMode": (m: { cwd: string }) => ({ mode: m.cwd === "/p/other" ? "auto" : "default" }),
  });
  try {
    await openNewTab();
    const tab = '[data-testid="new-session-tab"]';
    await pickOption(`${tab} [data-testid="session-model"]`, "Haiku 4.5");
    await pickOption(`${tab} [data-testid="project-chip"]`, "Oother/p/other");
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(sent).toContainEqual({ type: "session.defaultMode", cwd: "/p/other" });
    expect(el.querySelector(`${tab} [data-testid="mode-select"]`)?.textContent).toContain("Ask");
  } finally {
    restore();
  }
});

it("the new-session tab starts in Ask when the daemon reports no default mode", async () => {
  await openNewTab();
  expect(el.querySelector('[data-testid="new-session-tab"] [data-testid="mode-select"]')?.textContent).toContain("Ask");
});

it("another client that gets only the session_model part follows the model's permission modes", async () => {
  const sonnet = { ...session, model: "sonnet", permissionMode: "default", permissionModes: [...MODES] };
  const restore = await remount({
    "session.list": { sessions: [sonnet], projects: ["/p/demo"] },
    "session.subscribe": { logEpoch: "e1", session: sonnet },
    "models.list": { models: AUTO_MODELS },
  });
  try {
    expect(await optionsOf("*")).toContain("Auto mode");
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "session_model", id: "session_model", model: "haiku" } }));
    expect(await optionsOf("*")).not.toContain("Auto mode");
    await act(async () => emit({ type: "event", sessionId: ID, seq: 2, part: { type: "session_model", id: "session_model", model: "sonnet" } }));
    expect(await optionsOf("*")).toContain("Auto mode");
  } finally {
    restore();
  }
});

it("with no added project: empty state, and the Open project dialog adds a recent project in one click", async () => {
  replies["session.list"] = { sessions: [], projects: [], recentProjects: [{ cwd: "/p/cli", sessionCount: 2, lastActivity: Date.now() }] };
  location.hash = "";
  try {
    await act(async () => sessionsChanged({ type: "sessions.changed" }));
    await act(async () => {});
    expect(el.textContent).toContain("No projects yet");
    await act(async () => el.querySelector<HTMLElement>('[data-testid="open-project"]')!.click());
    await act(async () => {});
    sent.length = 0;
    await act(async () => document.querySelector<HTMLElement>('[data-testid="recent-row"]')!.click());
    expect(sent).toContainEqual(expect.objectContaining({ type: "project.open", cwd: "/p/cli" }));
  } finally {
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
  }
});

it("a page-load link does not re-add a removed project; opening the session (click, popstate, notification) does", async () => {
  const subscribes = () => sent.filter((m) => m.type === "session.subscribe");
  // Page load with the session in the hash: only subscribed, the project stays removed until the user opens the session.
  sent.length = 0;
  await act(async () => (root.unmount(), (root = createRoot(el)), root.render(<App />)));
  await act(async () => {});
  expect(subscribes()).toContainEqual(expect.objectContaining({ sessionId: ID }));
  expect(subscribes().some((m) => "addProject" in m)).toBe(false);
  // Reconnect: every held view is subscribed again, without addProject either.
  sent.length = 0;
  await act(async () => reconnect());
  await act(async () => {});
  expect(subscribes()).toContainEqual(expect.objectContaining({ sessionId: ID }));
  expect(subscribes().some((m) => "addProject" in m)).toBe(false);
  // The user opens a session of a project that is not added (sidebar row): addProject.
  const other = { ...session, id: "99999999-2222-3333-4444-555555555555", cwd: "/p/other" };
  replies["session.list"] = { sessions: [session, other], projects: ["/p/demo", "/p/other"] };
  replies["session.subscribe"] = { logEpoch: "e1", session: other };
  sent.length = 0;
  await act(async () => (location.hash = `#${other.id}`, window.dispatchEvent(new PopStateEvent("popstate"))));
  await act(async () => {});
  expect(subscribes()).toContainEqual(expect.objectContaining({ sessionId: other.id, addProject: true }));
  replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
  replies["session.subscribe"] = { logEpoch: "e1", session };
});

it("opening the page-load session of a removed project (popstate, tab click) adds the project, though its view exists", async () => {
  const subscribes = () => sent.filter((m) => m.type === "session.subscribe");
  // The session is in the hash but not in the list: its project is not added.
  sent.length = 0;
  const restore = await remount({ "session.list": { sessions: [], projects: [] } });
  try {
    expect(subscribes().some((m) => "addProject" in m)).toBe(false);
    sent.length = 0;
    await act(async () => (location.hash = "#new", window.dispatchEvent(new PopStateEvent("popstate"))));
    await act(async () => (location.hash = `#${ID}`, window.dispatchEvent(new PopStateEvent("popstate"))));
    await act(async () => {});
    expect(subscribes()).toContainEqual(expect.objectContaining({ sessionId: ID, addProject: true }));
  } finally {
    restore();
  }
});

it("a page-load link to a session of a removed project shows the session with its title from the subscribe reply, no 'no longer exists' error, when subscribe answers before the list", async () => {
  // The daemon answers subscribe at once; the list waits for models and transcripts, then omits the session (project not added).
  let release!: (r: unknown) => void;
  const restore = await remount({ "session.list": new Promise((r) => (release = r)), "session.subscribe": { logEpoch: "e1", session, title: "Fix the parser" } });
  try {
    // Before the list answers: the tab already has its title.
    expect(el.querySelector('[data-testid="tab-switcher"]')?.parentElement?.textContent).toContain("Fix the parser");
    await act(async () => release({ sessions: [], projects: [] }));
    await act(async () => {});
    expect(el.textContent).not.toContain("That session no longer exists");
    expect(location.hash).toBe(`#${ID}`);
    expect(el.querySelector('[data-testid="tab-switcher"]')?.textContent).toContain("Fix the parser");
  } finally {
    restore();
  }
});

it("a session in a linked worktree shows '<project> · <branch>' in its tab tooltip and session header", async () => {
  const wt = { ...session, cwd: "/p/demo-wt" };
  const worktrees = { "/p/demo": [{ path: "/p/demo", branch: "main", main: true }, { path: "/p/demo-wt", branch: "feature-x", main: false }] };
  const restore = await remount({ "session.list": { sessions: [wt], projects: ["/p/demo"], worktrees }, "session.subscribe": { logEpoch: "e1", session: wt } });
  try {
    expect(el.querySelector(`[data-tab-id="${ID}"]`)!.getAttribute("title")).toContain("demo · feature-x");
    expect(el.querySelector('[data-testid="session-project"]')?.textContent).toBe("demo · feature-x");
  } finally {
    restore();
  }
});

it("the Tab grouping setting drives the tab order and which tabs may move past each other (GH-135)", async () => {
  const A = "aaaaaaaa-2222-3333-4444-555555555555", B = "bbbbbbbb-2222-3333-4444-555555555555", C = "cccccccc-2222-3333-4444-555555555555";
  const sA = { ...session, id: A, title: "Alpha", cwd: "/p/demo" };
  const sB = { ...session, id: B, title: "Beta", cwd: "/p/demo-wt" };
  const sC = { ...session, id: C, title: "Gamma", cwd: "/p/other" };
  const worktrees = { "/p/demo": [{ path: "/p/demo", branch: "main", main: true }, { path: "/p/demo-wt", branch: "feature-x", main: false }] };
  const order = () => [...el.querySelectorAll<HTMLElement>("[data-tab-id]:not([data-testid=focus-tab])")].map((t) => t.dataset.tabId);
  const alt = (id: string, key: string) => press({ key, altKey: true, shiftKey: true }, el.querySelector(`[data-tab-id="${id}"] [role="tab"]`)!);
  const mount = async (grouping?: string) => {
    location.hash = `#${A}`;
    localStorage.setItem("claude-ui.tabs", JSON.stringify([A, C, B]));
    if (grouping) localStorage.setItem("claude-ui.tabGrouping", grouping);
    else localStorage.removeItem("claude-ui.tabGrouping");
    const back = await remount({ "session.list": { sessions: [sA, sB, sC], projects: ["/p/demo", "/p/other"], worktrees }, "session.subscribe": (m: { sessionId: string }) => ({ logEpoch: "e1", session: [sA, sB, sC].find((x) => x.id === m.sessionId) ?? sA }) });
    await act(async () => void new Promise((r) => setTimeout(r, 50)));
    return back;
  };
  let restore = await mount();
  try {
    // By project: the worktree session joins its project's group, which may reorder inside it.
    expect(order()).toEqual([A, B, C]);
    await alt(A, "ArrowRight");
    expect(order()).toEqual([B, A, C]);
    restore();
    // By worktree: B is its own group, so the stored order stays and A cannot move past C.
    restore = await mount("worktree");
    expect(order()).toEqual([A, C, B]);
    await alt(A, "ArrowRight");
    expect(order()).toEqual([A, C, B]);
    restore();
    // None: one flat list, A moves past C.
    restore = await mount("none");
    expect(order()).toEqual([A, C, B]);
    await alt(A, "ArrowRight");
    expect(order()).toEqual([C, A, B]);
  } finally {
    restore();
    localStorage.removeItem("claude-ui.tabGrouping");
    localStorage.removeItem("claude-ui.tabs");
  }
});

describe("a reload keeps the stored tab order while the session list is late (GH-196)", () => {
  const mk = (id: string, cwd: string) => ({ ...session, id, title: id.slice(0, 1), cwd });
  const order = () => [...el.querySelectorAll<HTMLElement>("[data-tab-id]:not([data-testid=focus-tab])")].map((t) => t.dataset.tabId);
  const stored = () => JSON.parse(localStorage.getItem("claude-ui.tabs")!);
  const ids = { A: "aaaaaaaa-2222-3333-4444-555555555555", B: "bbbbbbbb-2222-3333-4444-555555555555", C: "cccccccc-2222-3333-4444-555555555555" };
  afterEach(() => {
    localStorage.removeItem("claude-ui.tabs");
    localStorage.removeItem("claude-ui.tabGrouping");
  });

  it("the subscribe reply before the list does not gather the unknown tabs", async () => {
    const { A, B, C } = ids;
    const all = [mk(A, "/p/one"), mk(B, "/p/two"), mk(C, "/p/one")];
    location.hash = `#${A}`;
    localStorage.setItem("claude-ui.tabs", JSON.stringify([B, A, C]));
    let release!: (r: unknown) => void;
    const restore = await remount({ "session.list": new Promise((r) => (release = r)), "session.subscribe": (m: { sessionId: string }) => ({ logEpoch: "e1", session: all.find((x) => x.id === m.sessionId) ?? all[0] }) });
    try {
      expect(order()).toEqual([B, A, C]);
      expect(stored()).toEqual([B, A, C]);
      await act(async () => release({ sessions: all, projects: ["/p/one", "/p/two"] }));
      await act(async () => {});
      expect(order()).toEqual([B, A, C]);
      expect(stored()).toEqual([B, A, C]);
    } finally {
      restore();
    }
  });

  it("a worktree session keeps its slot until the list brings the worktrees", async () => {
    const X = ids.A, Y = ids.B, Z = ids.C;
    const all = [mk(X, "/p/one"), mk(Y, "/p/one-wt"), mk(Z, "/p/one")];
    const worktrees = { "/p/one": [{ path: "/p/one", branch: "main", main: true }, { path: "/p/one-wt", branch: "f", main: false }] };
    location.hash = `#${Y}`;
    localStorage.setItem("claude-ui.tabs", JSON.stringify([X, Y, Z]));
    let release!: (r: unknown) => void;
    const restore = await remount({ "session.list": new Promise((r) => (release = r)), "session.subscribe": (m: { sessionId: string }) => ({ logEpoch: "e1", session: all.find((x) => x.id === m.sessionId) ?? all[0] }) });
    try {
      expect(stored()).toEqual([X, Y, Z]);
      await act(async () => release({ sessions: all, projects: ["/p/one"], worktrees }));
      await act(async () => {});
      expect(order()).toEqual([X, Y, Z]);
      expect(stored()).toEqual([X, Y, Z]);
    } finally {
      restore();
    }
  });
});

describe("a tab that never resolves, and moves while the list loads (GH-201)", () => {
  const mk = (id: string, cwd: string) => ({ ...session, id, title: id.slice(0, 1), cwd });
  const ids = { A: "aaaaaaaa-2222-3333-4444-555555555555", B: "bbbbbbbb-2222-3333-4444-555555555555", H: "dddddddd-2222-3333-4444-555555555555" };
  afterEach(() => localStorage.removeItem("claude-ui.tabs"));

  it("a tab whose subscribe fails with another code than unknown_session does not hide the group chips", async () => {
    const { A, B, H } = ids;
    const all = [mk(A, "/p/one"), mk(B, "/p/two")];
    location.hash = `#${H}`;
    localStorage.setItem("claude-ui.tabs", JSON.stringify([A, B, H]));
    const restore = await remount({
      "session.list": { sessions: all, projects: ["/p/one", "/p/two"] },
      "session.subscribe": (m: { sessionId: string }) => {
        if (m.sessionId === H) throw Object.assign(new Error("boom"), { code: "internal" });
        return { logEpoch: "e1", session: all.find((x) => x.id === m.sessionId) };
      },
    });
    try {
      await act(async () => {});
      expect(el.querySelectorAll("[data-group-chip]").length).toBe(2);
    } finally {
      restore();
    }
  });

  it("a move while the session list is not in is applied, not refused silently", async () => {
    const { A, B } = ids;
    const C = "cccccccc-2222-3333-4444-555555555555";
    const all = [mk(A, "/p/one"), mk(B, "/p/two"), mk(C, "/p/one")];
    location.hash = `#${A}`;
    localStorage.setItem("claude-ui.tabs", JSON.stringify([A, B, C]));
    const restore = await remount({ "session.list": new Promise(() => {}), "session.subscribe": (m: { sessionId: string }) => ({ logEpoch: "e1", session: all.find((x) => x.id === m.sessionId) ?? all[0] }) });
    try {
      await press({ key: "ArrowRight", altKey: true, shiftKey: true }, el.querySelector(`[data-tab-id="${A}"] [role="tab"]`)!);
      expect(JSON.parse(localStorage.getItem("claude-ui.tabs")!)).toEqual([B, A, C]);
    } finally {
      restore();
    }
  });
});

describe("worktrees", () => {
  const main = { path: "/p/demo", branch: "main", main: true };
  const managed = "/p/demo/.claude/worktrees/x";
  const field = (name: string, value: string) =>
    act(async () => {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="${name}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("Shift+click on Create worktree creates at once with a generated name: the new-session tab held, then in the new worktree", async () => {
    let done!: (r: unknown) => void;
    const listed = { sessions: [session], projects: ["/p/demo"], worktrees: { "/p/demo": [main] } };
    const restore = await remount({
      "session.list": listed,
      "worktree.create": () => new Promise((r) => (done = r)),
    });
    const from = sent.length;
    try {
      await act(async () => void el.querySelector<HTMLElement>('[data-testid="project-new-worktree"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
      expect(sent.slice(from).filter((m) => m.type === "worktree.create")).toEqual([{ type: "worktree.create", cwd: "/p/demo" }]);
      expect(el.querySelector('[data-testid="external-turn"]')?.textContent).toBe("Creating worktree…");
      replies["session.list"] = { ...listed, worktrees: { "/p/demo": [main, { path: managed, branch: "worktree-x", main: false }] } };
      await act(async () => done({ path: managed, branch: "worktree-x" }));
      await act(async () => {});
      expect(el.querySelector('[data-testid="worktree-chip"]')?.textContent).toContain("worktree-x");
      expect(el.querySelector('[data-testid="external-turn"]')).toBeNull();
    } finally {
      restore();
    }
  });

  it("Remove worktree asks with the counts and removes on confirm; Esc returns focus to the button", async () => {
    const listed = { sessions: [session], projects: ["/p/demo"], worktrees: { "/p/demo": [main, { path: managed, branch: "worktree-x", main: false }] } };
    const restore = await remount({ "session.list": listed, "worktree.status": { uncommitted: 2, commits: 1, branch: "worktree-x" } });
    const from = sent.length;
    const trash = () => el.querySelector<HTMLElement>('[data-testid="worktree-remove"]')!;
    try {
      // A real click focuses the button (jsdom's does not); the dialog returns focus to it.
      await act(async () => (trash().focus(), trash().click()));
      expect(document.querySelector('[data-testid="remove-worktree-dialog"]')?.textContent).toContain("You have 2 uncommitted files and 1 commit on worktree-x. All will be lost if you remove.");
      await press({ key: "Escape" });
      expect(document.querySelector('[data-testid="remove-worktree-dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trash());
      await act(async () => trash().click());
      await act(async () => document.querySelector<HTMLElement>('[data-testid="remove-worktree-confirm"]')!.click());
      expect(sent.slice(from).filter((m) => m.type === "worktree.remove")).toEqual([{ type: "worktree.remove", cwd: "/p/demo", path: managed }]);
    } finally {
      restore();
    }
  });

  it("hovering the trash button warms the status once per 10 s, as a cancellable scan", async () => {
    const listed = { sessions: [session], projects: ["/p/demo"], worktrees: { "/p/demo": [main, { path: managed, branch: "worktree-x", main: false }] } };
    const restore = await remount({ "session.list": listed, "worktree.status": { uncommitted: 0, untracked: 0, commits: 0, ahead: 0, branch: "worktree-x", branchMerged: false, running: 0, safety: "safe" } });
    const from = sent.length;
    const trash = () => el.querySelector<HTMLElement>('[data-testid="worktree-remove"]')!;
    const warms = () => sent.slice(from).filter((m) => m.type === "worktree.status");
    const hover = () => act(async () => void trash().dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    const now = vi.spyOn(Date, "now");
    try {
      const t0 = Date.now();
      now.mockReturnValue(t0);
      await hover();
      await hover();
      expect(warms()).toEqual([{ type: "worktree.status", cwd: "/p/demo", path: managed, scan: expect.any(String) }]);
      now.mockReturnValue(t0 + 11_000);
      await hover();
      expect(warms()).toHaveLength(2);
      expect(sent.slice(from).filter((m) => m.type === "worktree.cancel")).toHaveLength(1);
    } finally {
      now.mockRestore();
      restore();
    }
  });

  describe("Remove worktree dialog (GH-462)", () => {
    const dlg = () => document.querySelector<HTMLElement>('[data-testid="remove-worktree-dialog"]');
    const confirmBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="remove-worktree-confirm"]');
    const stat = (o: object = {}) => ({ checkedAt: Date.now(), uncommitted: 0, untracked: 0, commits: 0, ahead: 0, branch: "worktree-x", branchMerged: false, running: 0, safety: "safe", ...o });
    const listed = { sessions: [session], projects: ["/p/demo"], worktrees: { "/p/demo": [main, { path: managed, branch: "worktree-x", main: false }] } };
    const trash = (path = managed) => el.querySelector<HTMLElement>(`[data-path="${path}"] [data-testid="worktree-remove"]`)!;
    const removing = () => [...el.querySelectorAll<HTMLElement>('[data-testid="worktree-removing"]')].map((e) => e.closest<HTMLElement>('[data-testid="worktree-row"]')!.dataset.path);

    it("the trash opens the remove dialog at once with Checking… and Remove worktree disabled", async () => {
      const restore = await remount({ "session.list": listed, "worktree.status": () => new Promise(() => {}) });
      try {
        await act(async () => trash().click());
        expect(dlg()?.querySelector('[role="heading"], h2')?.textContent ?? dlg()!.textContent).toContain("Remove worktree worktree-x?");
        expect(dlg()!.textContent).toContain("Checking…");
        expect(confirmBtn()!.disabled).toBe(true);
      } finally {
        restore();
      }
    });

    it("the status fills the description and enables Remove; a blocked status shows the reason and no Remove button", async () => {
      let st: object = stat({ uncommitted: 2, commits: 1 });
      const restore = await remount({ "session.list": listed, "worktree.status": () => st });
      try {
        await act(async () => trash().click());
        expect(dlg()!.textContent).toContain("You have 2 uncommitted files and 1 commit on worktree-x. All will be lost if you remove.");
        expect(confirmBtn()!.disabled).toBe(false);
        await press({ key: "Escape" });
        st = stat({ safety: "blocked", blocked: "sessions_running", running: 1 });
        await act(async () => trash().click());
        expect(dlg()!.textContent).toContain("Worktree worktree-x cannot be removed: A session there is running or needs input");
        expect(confirmBtn()).toBeNull();
        expect(document.querySelector('[data-testid="remove-worktree-cancel"]')).not.toBeNull();
        await press({ key: "Escape" });
        // An error reply shows its message, also without Remove.
        st = Promise.reject(new Error("daemon says no")) as never;
        await act(async () => trash().click());
        expect(dlg()!.textContent).toContain("daemon says no");
        expect(confirmBtn()).toBeNull();
      } finally {
        restore();
      }
    });

    it("Esc during Checking… closes the dialog and a late reply does not reopen it", async () => {
      let answer!: (r: unknown) => void;
      const restore = await remount({ "session.list": listed, "worktree.status": () => new Promise((r) => (answer = r)) });
      try {
        await act(async () => trash().click());
        expect(dlg()).not.toBeNull();
        await press({ key: "Escape" });
        expect(dlg()).toBeNull();
        await act(async () => answer(stat()));
        expect(dlg()).toBeNull();
        expect(el.textContent).not.toContain("not removed");
      } finally {
        restore();
      }
    });

    it("a cached status shows at once with checked N min ago", async () => {
      let calls = 0;
      const restore = await remount({ "session.list": listed, "worktree.status": () => (++calls === 1 ? stat({ uncommitted: 3, checkedAt: Date.now() - 5 * 60_000 }) : new Promise(() => {})) });
      try {
        // Hover warms the status (the first call); the click then waits for a fresh one.
        await act(async () => void trash().dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
        await act(async () => trash().click());
        expect(calls).toBe(2);
        expect(dlg()!.textContent).toContain("You have 3 uncommitted files on worktree-x. All will be lost if you remove.");
        expect(dlg()!.textContent).toContain("checked 5m");
        expect(dlg()!.textContent).toContain("Checking…");
        expect(confirmBtn()!.disabled).toBe(true);
      } finally {
        restore();
      }
    });

    it("Confirm closes at once; the row shows Removing… until the list refresh drops it; a failure restores it and shows the daemon message", async () => {
      let settle!: { ok: () => void; fail: (e: Error) => void };
      const restore = await remount({
        "session.list": listed,
        "worktree.status": stat(),
        "worktree.remove": () => new Promise((ok, fail) => (settle = { ok: () => ok({}), fail })),
      });
      try {
        await act(async () => trash().click());
        await act(async () => confirmBtn()!.click());
        expect(dlg()).toBeNull();
        expect(removing()).toEqual([managed]);
        // Failure: the row is back and the message shows.
        await act(async () => settle.fail(new Error("Changed since the list: 1 files, 0 commits")));
        expect(removing()).toEqual([]);
        expect(el.textContent).toContain("Worktree worktree-x not removed: Changed since the list: 1 files, 0 commits");
        expect(el.querySelector(`[data-path="${managed}"]`)).not.toBeNull();
        // Success: the refreshed list drops the row.
        await act(async () => trash().click());
        await act(async () => confirmBtn()!.click());
        expect(removing()).toEqual([managed]);
        replies["session.list"] = { ...listed, worktrees: { "/p/demo": [main] } };
        await act(async () => settle.ok());
        await act(async () => {});
        expect(removing()).toEqual([]);
        expect(el.querySelector(`[data-path="${managed}"]`)).toBeNull();
      } finally {
        restore();
      }
    });

    it("two removals run at once, each row with its own Removing…", async () => {
      const two = "/p/demo/.claude/worktrees/y";
      const both = { ...listed, worktrees: { "/p/demo": [main, { path: managed, branch: "worktree-x", main: false }, { path: two, branch: "worktree-y", main: false }] } };
      const done: Record<string, () => void> = {};
      const restore = await remount({
        "session.list": both,
        "worktree.status": (m: { path: string }) => stat({ branch: m.path === two ? "worktree-y" : "worktree-x" }),
        "worktree.remove": (m: { path: string }) => new Promise((ok) => (done[m.path] = () => ok({}))),
      });
      try {
        await act(async () => trash(managed).click());
        await act(async () => confirmBtn()!.click());
        await act(async () => trash(two).click());
        await act(async () => confirmBtn()!.click());
        expect(removing().sort()).toEqual([managed, two].sort());
        await act(async () => done[managed]!());
        await act(async () => {});
        expect(removing()).toEqual([two]);
      } finally {
        restore();
      }
    });
  });

  it("palette Clean up worktrees and workers… opens the Clean up dialog for all projects", async () => {
    const listed = { sessions: [session], projects: ["/p/demo"], worktrees: { "/p/demo": [main, { path: managed, branch: "worktree-x", main: false }] } };
    const restore = await remount({ "session.list": listed, "worktree.status": { uncommitted: 0, untracked: 0, commits: 0, ahead: 0, branch: "worktree-x", branchMerged: false, running: 0, safety: "safe" } });
    const from = sent.length;
    try {
      await press({ key: "k", code: "KeyK", ctrlKey: true });
      await act(async () => paletteRow("Clean up worktrees and workers…")!.click());
      await act(async () => {});
      const d = document.querySelector('[data-testid="cleanup-dialog"]')!;
      expect(d.textContent).toContain("All projects");
      expect(sent.slice(from).filter((m) => m.type === "worktree.status")).toEqual([{ type: "worktree.status", cwd: "/p/demo", path: managed, scan: expect.any(String) }]);
      expect(d.textContent).toContain("Remove 1");
    } finally {
      restore();
    }
  });

  it("Create worktree: click opens the modal; Create sends the normalized branch and opens a new session tab in the worktree; Shift+click and the palette", async () => {
    const made = "/p/demo/.claude/worktrees/fix-login-u";
    const listed = { sessions: [session], projects: ["/p/demo"], worktrees: { "/p/demo": [main] } };
    const restore = await remount({
      "session.list": listed,
      "settings.get": { settings: { jira: { url: "", email: "", template: "{type}/{key}-{summary}" } }, jiraToken: false },
      "worktree.branches": { branches: [{ name: "main", local: true, worktree: "/p/demo" }], defaultBase: "HEAD" },
      "worktree.create": { path: made, branch: "fix-login-u" },
    });
    const from = sent.length;
    try {
      await act(async () => el.querySelector<HTMLElement>('[data-testid="project-new-worktree"]')!.click());
      await act(async () => {});
      expect(document.querySelector('[data-testid="create-worktree"]')).not.toBeNull();
      expect(sent.slice(from).filter((m) => m.type === "worktree.create")).toEqual([]);
      await field("create-worktree-name", "Fix Login Ü");
      replies["session.list"] = { ...listed, worktrees: { "/p/demo": [main, { path: made, branch: "fix-login-u", main: false }] } };
      await act(async () => document.querySelector<HTMLElement>('[data-testid="create-worktree-confirm"]')!.click());
      await act(async () => {});
      await act(async () => {});
      expect(sent.slice(from).filter((m) => m.type === "worktree.create")).toEqual([{ type: "worktree.create", cwd: "/p/demo", branch: "fix-login-u" }]);
      expect(document.querySelector('[data-testid="create-worktree"]')).toBeNull();
      expect(el.querySelector('[data-testid="worktree-chip"]')?.textContent).toContain("fix-login-u");
      // The palette opens the same modal.
      await press({ key: "k", code: "KeyK", ctrlKey: true });
      await act(async () => paletteRow("New worktree…")!.click());
      await act(async () => {});
      expect(document.querySelector('[data-testid="create-worktree"]')).not.toBeNull();
    } finally {
      restore();
    }
  });
});

it("a session without transcript gets its title during the first turn: its events refresh the list, throttled", async () => {
  const fresh = { ...session, title: "New session", transcript: false };
  const restore = await remount({ "session.list": { sessions: [fresh], projects: ["/p/demo"] }, "session.subscribe": { logEpoch: "e1", session: fresh } });
  const lists = () => sent.filter((m) => m.type === "session.list").length;
  const event = (seq: number) => act(async () => emit({ type: "event", sessionId: ID, seq, part: { type: "user_text", id: `u${seq}`, text: "hi", images: [] } }));
  try {
    expect(el.querySelector('[data-testid="tab-switcher"]')?.textContent).toContain("New session");
    const before = lists();
    await event(1);
    await event(2);
    expect(lists()).toBe(before + 1);
    // Its transcript exists now: the title is the SDK's, and further events do not refresh the list.
    replies["session.list"] = { sessions: [{ ...fresh, title: "hi", transcript: true }], projects: ["/p/demo"] };
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 5_000 });
    await event(3);
    vi.useRealTimers();
    await act(async () => {});
    expect(el.textContent).toContain("hi");
    const after = lists();
    await event(4);
    expect(lists()).toBe(after);
  } finally {
    vi.useRealTimers();
    restore();
  }
});

it("a link to an open session opens it at the bottom: the timeline remounts, like a notification click", async () => {
  const log = () => el.querySelector('[role="log"]');
  const before = log();
  expect(before).not.toBeNull();
  await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(log()).not.toBeNull();
  expect(log()).not.toBe(before);
});

it("a session opened in Don't ask that goes to Auto mode with Shift+Tab and then gets a model without auto support ends in Ask: the picker sends no mode the user did not pick", async () => {
  const dontAsk = { ...session, model: "sonnet", permissionMode: "dontAsk", permissionModes: [...MODES] };
  const restore = await remount({
    "session.list": { sessions: [dontAsk], projects: ["/p/demo"] },
    "session.subscribe": { logEpoch: "e1", session: dontAsk },
    "models.list": { models: AUTO_MODELS },
    "session.setPermissionMode": { session: dontAsk },
    "session.setModel": { session: { ...dontAsk, model: "haiku", permissionMode: "default", permissionModes: ["default", "acceptEdits", "plan", "dontAsk"] } },
  });
  let seq = 0;
  const event = (part: unknown) => act(async () => emit({ type: "event", sessionId: ID, seq: ++seq, part }));
  try {
    // Opened once: the picker's items are registered (development-docs/GH-37 proposals: the tester picked Don't ask first).
    await pickOption('[data-testid="mode-select"]', "Don't ask (deny unapproved)");
    for (const mode of ["default", "acceptEdits", "plan", "auto"]) {
      await press({ key: "Tab", shiftKey: true }, el.querySelector("textarea")!);
      await event({ type: "session_permission_mode", id: "session_permission_mode", mode });
    }
    sent.length = 0;
    await pickOption('[data-testid="session-model"]', "Haiku 4.5");
    await event({ type: "session_model", id: "session_model", model: "haiku" });
    await event({ type: "session_permission_mode", id: "session_permission_mode", mode: "default" });
    expect(sent.filter((m) => m.type.startsWith("session.set"))).toEqual([{ type: "session.setModel", sessionId: ID, model: "haiku" }]);
    expect(el.querySelector('[data-testid="mode-select"]')?.textContent).toContain("Ask");
  } finally {
    restore();
  }
});

it("a pending permission request keeps the Permission mode picker; changing the mode sends setPermissionMode and leaves the request pending (GH-145)", async () => {
  const s = { ...session, model: "sonnet", permissionMode: "default", permissionModes: [...MODES] };
  const restore = await remount({
    "session.list": { sessions: [s], projects: ["/p/demo"] },
    "session.subscribe": { logEpoch: "e1", session: s },
    "models.list": { models: AUTO_MODELS },
    "session.setPermissionMode": { session: { ...s, permissionMode: "auto" } },
  });
  try {
    await act(async () =>
      emit({ type: "event", sessionId: ID, seq: 1, part: { type: "permission_request", id: "p1", requestId: "r1", toolUseId: "t1", tool: "Bash", input: { command: "touch x" }, suggestions: [], settled: false } }),
    );
    expect(el.querySelector('[data-testid="permission-panel"] [data-testid="mode-select"]')).not.toBeNull();
    sent.length = 0;
    await pickOption('[data-testid="permission-panel"] [data-testid="mode-select"]', "Auto mode");
    expect(sent.filter((m) => m.type.startsWith("session.set"))).toEqual([{ type: "session.setPermissionMode", sessionId: ID, mode: "auto" }]);
    expect(sent.some((m) => m.type === "permission.respond")).toBe(false);
    expect(el.querySelector('[data-testid="permission-panel"]')).not.toBeNull();
  } finally {
    restore();
  }
});

const say = (seq: number, part: object) => act(async () => emit({ type: "event", sessionId: ID, seq, part }));

afterEach(() => void delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect);

it("Quote: selecting assistant text and clicking the floating Quote puts it in the prompt box as a blockquote, focused, caret at the end", async () => {
  Range.prototype.getBoundingClientRect = () => new DOMRect(100, 200, 80, 20);
  await say(1, { type: "assistant_text", id: "a1", text: "Alpha beta", streaming: false });
  const p = el.querySelector('[data-testid="assistant-text"] p')!;
  document.getSelection()!.selectAllChildren(p);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((r) => setTimeout(r, 160));
  });
  await act(async () => document.querySelector<HTMLElement>('[data-testid="quote-button"]')!.click());
  const box = el.querySelector("textarea")!;
  expect(box.value).toBe("> Alpha beta\n\n");
  expect(box.selectionStart).toBe(box.value.length);
  expect(document.activeElement).toBe(box);
});

it("hover Quote on an assistant message quotes the whole message; on a user message it quotes the selection in it, and a selection in another message is ignored", async () => {
  Range.prototype.getBoundingClientRect = () => new DOMRect(100, 200, 80, 20);
  await say(1, { type: "user_text", id: "u1", text: "Gamma delta", images: [] });
  await say(2, { type: "assistant_text", id: "a1", text: "Alpha beta", streaming: false });
  const quote = (row: string) => el.querySelector<HTMLElement>(`[data-testid="${row}"] button[title="Quote"]`)!;
  await act(async () => quote("assistant-text").click());
  const box = el.querySelector("textarea")!;
  expect(box.value).toBe("> Alpha beta\n\n");
  const bubble = el.querySelector('[data-testid="user-message"] [class*="rounded"]')!;
  const text = [...bubble.querySelectorAll("*"), bubble].flatMap((n) => [...n.childNodes]).find((n) => n.nodeType === 3 && n.textContent!.includes("Gamma delta"))!;
  document.getSelection()!.setBaseAndExtent(text, 6, text, 11);
  await act(async () => quote("user-message").click());
  expect(box.value).toBe("> Alpha beta\n\n> delta\n\n");
  // A selection in the user message does not narrow the hover Quote of the assistant message.
  await act(async () => quote("assistant-text").click());
  expect(box.value).toBe("> Alpha beta\n\n> delta\n\n> Alpha beta\n\n");
});

const paletteRows = () => [...document.querySelectorAll('[data-testid="palette"] [role="option"]')].map((o) => o.textContent ?? "");
const ORCH = (enabled: boolean) => ({ settings: { orchestration: { enabled, workerCap: 20, coordinatorAnswersPermissions: false } } });
const ALL_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

it("the new-session tab has no Coordinator toggle, also with orchestration on", async () => {
  const restore = await remount({ "settings.get": ORCH(true), "session.list": { sessions: [session], projects: ["/p/demo"], permissionModes: ALL_MODES } });
  try {
    await openNewTab();
    expect(el.querySelector('[data-testid="coordinator-toggle"]')).toBeNull();
  } finally {
    restore();
  }
});

it("an orchestration notice shows as a chip in a coordinator session, and as a plain user message elsewhere", async () => {
  const notice = "[claude-ui orchestration notice] Worker a: turn end. Call worker_wait to read the events.";
  const send = async () => {
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "user_text", id: "n1", text: notice, images: [] } }));
    await act(async () => emit({ type: "event", sessionId: ID, seq: 2, part: { type: "user_text", id: "u2", text: "hello", images: [] } }));
  };
  await send();
  expect(el.querySelectorAll('[data-testid="orchestration-notice"]')).toHaveLength(0);
  expect(el.querySelectorAll('[data-testid="user-message"]')).toHaveLength(2);
  const coord = { ...session, coordinator: true as const };
  const restore = await remount({ "session.list": { sessions: [coord], projects: ["/p/demo"] }, "session.subscribe": { logEpoch: "e1", session: coord } });
  try {
    await send();
    const chips = el.querySelectorAll('[data-testid="orchestration-notice"]');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain("Worker a: turn end.");
    expect(chips[0]!.textContent).not.toContain("[claude-ui");
    expect(el.querySelectorAll('[data-testid="user-message"]')).toHaveLength(1);
    // The Rewind list of the palette has the user's prompt, not the notice.
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    await act(async () => paletteRow("Rewind")!.click());
    const rewind = paletteRows().join("|");
    expect(rewind).toContain("hello");
    expect(rewind).not.toContain("orchestration notice");
  } finally {
    restore();
  }
});

it("the graph tab shows only when the session cwd is a git repository", async () => {
  expect(el.querySelector('[data-testid="pane-graph"]')).toBeNull();
  await act(async () => root.unmount());
  replies["git.status"] = { status: { branch: "main", added: 0, removed: 0 } };
  try {
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    expect(el.querySelector('[data-testid="side-panel"] [data-testid="pane-graph"]')).not.toBeNull();
    // Narrow tabs (one more list, outside the side panel).
    expect(el.querySelectorAll('[data-testid="pane-graph"]').length).toBe(2);
    await act(async () => el.querySelector<HTMLElement>('[data-testid="side-panel"] [data-testid="pane-graph"]')!.click());
    expect(sideTab()).toBe("graph");
  } finally {
    delete replies["git.status"];
  }
});

const gitList = { sessions: [session], projects: ["/p/demo"], worktrees: { "/p/demo": [{ path: "/p/demo", branch: "main", main: true }] } };

it("the graph tab shows at once for a project with a session.list worktrees entry, before git.status replies", async () => {
  const restore = await remount({ "session.list": gitList, "git.status": () => new Promise(() => {}) });
  try {
    expect(el.querySelector('[data-testid="side-panel"] [data-testid="pane-graph"]')).not.toBeNull();
  } finally {
    restore();
    delete replies["git.status"];
  }
});

it("leaving and coming back to the graph tab keeps the panel mounted", async () => {
  const restore = await remount({ "session.list": gitList, "git.status": { status: { branch: "main", added: 0, removed: 0, refs: "s1" } }, "git.refs": { refs: "s1" }, "git.log": { log: { commits: [], more: false, branches: ["refs/heads/main"], refs: "s1", head: "refs/heads/main" } } });
  try {
    const gitLogs = () => sent.filter((m) => m.type === "git.log").length;
    const before = gitLogs();
    await act(async () => el.querySelector<HTMLElement>('[data-testid="side-panel"] [data-testid="pane-graph"]')!.click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(sideTab()).toBe("graph");
    expect(gitLogs() - before).toBe(1);
    await pickSide(/changes/i);
    const panel = el.querySelector('[data-testid="graph-panel"]');
    expect(panel).not.toBeNull();
    expect(panel!.className).toContain("hidden");
    await act(async () => el.querySelector<HTMLElement>('[data-testid="side-panel"] [data-testid="pane-graph"]')!.click());
    expect(el.querySelector('[data-testid="graph-panel"]')!.className).not.toContain("hidden");
    expect(gitLogs() - before).toBe(1);
  } finally {
    restore();
    delete replies["git.status"];
    delete replies["git.log"];
    delete replies["git.refs"];
  }
});

const api = { path: "/p/demo/api", rel: "api", kind: "nested", branch: "main" };
const web = { path: "/p/demo/web", rel: "web", kind: "nested", branch: "main" };
const reposOf = () => (sent as { type: string; cwd?: string; exact?: boolean; openFiles?: string[]; fresh?: boolean }[]).filter((m) => m.type === "git.repos");

it("a workspace folder that holds repositories shows the Graph tab; the graph reads the first repository with exact", async () => {
  const restore = await remount({ "git.repos": { repos: [api, web] }, "git.status": { status: null }, "git.refs": { refs: "s1" }, "git.log": { log: { commits: [], more: false, branches: ["refs/heads/main"], refs: "s1", head: "refs/heads/main" } } });
  try {
    expect(el.querySelector('[data-testid="side-panel"] [data-testid="pane-graph"]')).not.toBeNull();
    sent.length = 0;
    await act(async () => el.querySelector<HTMLElement>('[data-testid="side-panel"] [data-testid="pane-graph"]')!.click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect((sent as { type: string; cwd?: string; exact?: boolean }[]).filter((m) => m.type === "git.log")).toMatchObject([{ cwd: "/p/demo/api", exact: true }]);
  } finally {
    restore();
    for (const k of ["git.status", "git.refs", "git.log", "git.repos"]) delete replies[k];
  }
});

it("Changes and Graph show the repository chosen for the project; a pick in either switches both", async () => {
  localStorage.setItem("claude-ui.diffMode", "uncommitted");
  localStorage.setItem("claude-ui.repoChoice", JSON.stringify({ "/p/demo": "web" }));
  const restore = await remount({ "git.repos": { repos: [api, web] }, "git.status": { status: null }, "git.diff": { diff: { prefix: "", base: "b".repeat(40), files: [] } }, "git.refs": { refs: "s1" }, "git.log": { log: { commits: [], more: false, branches: ["refs/heads/main"], refs: "s1", head: "refs/heads/main" } } });
  try {
    const wait = () => act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    const gits = sent as { type: string; cwd?: string; exact?: boolean }[];
    const last = (t: string) => gits.filter((m) => m.type === t).at(-1);
    const selectors = () => [...el.querySelectorAll<HTMLElement>('[data-testid="side-panel"] [data-testid=repo-selector]')];
    const pick = async (trigger: HTMLElement, rel: string) => {
      await act(async () => trigger.click());
      await act(async () => document.querySelector<HTMLElement>(`[role=treeitem][data-rel="${rel}"]`)!.click());
      await wait();
    };
    await pickSide(/changes/i);
    await wait();
    expect(gits.filter((m) => m.type === "git.diff")).toMatchObject([{ cwd: "/p/demo/web", exact: true }]);
    expect(el.querySelector("[data-testid=repo-selector]")!.getAttribute("aria-label")).toBe("Repository: web, branch main");
    gits.length = 0;
    await act(async () => el.querySelector<HTMLElement>('[data-testid="side-panel"] [data-testid="pane-graph"]')!.click());
    // The graph chunk loads lazily.
    for (let i = 0; i < 40 && !gits.some((m) => m.type === "git.log"); i++) await wait();
    expect(gits.filter((m) => m.type === "git.log").length).toBeGreaterThan(0);
    for (const l of gits.filter((m) => m.type === "git.log")) expect(l).toMatchObject({ cwd: "/p/demo/web", exact: true });
    const graphSel = () => el.querySelector<HTMLElement>("[data-testid=graph-panel] [data-testid=repo-selector]")!;
    expect(graphSel().getAttribute("aria-label")).toBe("Repository: web, branch main");
    await pick(graphSel(), "api");
    expect(last("git.log")).toMatchObject({ cwd: "/p/demo/api", exact: true });
    await act(async () => el.querySelector<HTMLElement>('[data-testid="side-panel"] [data-testid="pane-changes"]')!.click());
    await wait();
    expect(selectors().some((s) => s.getAttribute("aria-label") === "Repository: api, branch main")).toBe(true);
    expect(last("git.diff")).toMatchObject({ cwd: "/p/demo/api", exact: true });
    const changesSel = selectors().find((s) => !s.closest("[data-testid=graph-panel]"))!;
    await pick(changesSel, "web");
    await act(async () => el.querySelector<HTMLElement>('[data-testid="side-panel"] [data-testid="pane-graph"]')!.click());
    await wait();
    expect(last("git.log")).toMatchObject({ cwd: "/p/demo/web", exact: true });
  } finally {
    restore();
    localStorage.removeItem("claude-ui.diffMode");
    localStorage.removeItem("claude-ui.repoChoice");
    for (const k of ["git.status", "git.refs", "git.log", "git.repos", "git.diff"]) delete replies[k];
  }
});

it("the Graph shows Loading graph… until the session list is loaded, then mounts once", async () => {
  const saved = replies["session.list"];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const list = { sessions: [session], projects: ["/p/demo"] };
  const restore = await remount({ "session.list": async () => (await gate, list), "git.repos": { repos: [api, web] }, "git.status": { status: null }, "git.refs": { refs: "s1" }, "git.log": { log: { commits: [], more: false, branches: ["refs/heads/main"], refs: "s1", head: "refs/heads/main" } } });
  try {
    const gits = sent as { type: string; skip?: number }[];
    gits.length = 0;
    release();
    for (let i = 0; i < 40 && !el.querySelector('[data-testid="side-panel"] [data-testid="pane-graph"]'); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    await act(async () => el.querySelector<HTMLElement>('[data-testid="side-panel"] [data-testid="pane-graph"]')!.click());
    for (let i = 0; i < 40 && !gits.some((m) => m.type === "git.log"); i++) await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    await act(async () => void (await new Promise((r) => setTimeout(r, 100))));
    expect(gits.filter((m) => m.type === "git.log" && !m.skip)).toHaveLength(1);
  } finally {
    restore();
    replies["session.list"] = saved;
    for (const k of ["git.status", "git.refs", "git.log", "git.repos"]) delete replies[k];
  }
});

it("settings ignoreSubmodules from settings.get and settings_changed reach ChangesPanel", async () => {
  localStorage.setItem("claude-ui.diffMode", "uncommitted");
  const own = { path: "/p/demo", rel: "", kind: "main", branch: "main" };
  const lib = { path: "/p/demo/libs/lib", rel: "libs/lib", kind: "submodule", parent: "/p/demo", branch: "x" };
  const probes = () => (sent as { type: string; cwd?: string; exact?: boolean }[]).filter((m) => m.type === "git.status" && m.cwd === lib.path && m.exact);
  const restore = await remount({
    "settings.get": { settings: { orchestration: {}, git: { ignoreSubmodules: true } } },
    "git.repos": { repos: [own, lib] },
    "git.status": { status: { branch: "main", added: 0, removed: 0, files: 1 } },
    "git.diff": { diff: { prefix: "", base: "b".repeat(40), files: [] } },
  });
  try {
    await pickSide(/changes/i);
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(probes()).toEqual([]);
    await act(async () => settingsChanged({ settings: { orchestration: {}, git: { ignoreSubmodules: false } } }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(probes().length).toBeGreaterThan(0);
  } finally {
    restore();
    localStorage.removeItem("claude-ui.diffMode");
    for (const k of ["settings.get", "git.status", "git.repos", "git.diff"]) delete replies[k];
  }
});

it("git.repos [] hides the Graph tab even when git.status would answer; without a repos array git.status decides", async () => {
  let restore = await remount({ "git.repos": { repos: [] }, "git.status": { status: { branch: "main", added: 0, removed: 0 } } });
  try {
    expect(el.querySelector('[data-testid="side-panel"] [data-testid="pane-graph"]')).toBeNull();
    restore();
    restore = await remount({ "git.repos": {}, "git.status": { status: { branch: "main", added: 0, removed: 0 } } });
    expect(el.querySelector('[data-testid="side-panel"] [data-testid="pane-graph"]')).not.toBeNull();
  } finally {
    restore();
    for (const k of ["git.status", "git.repos"]) delete replies[k];
  }
});

it("git.repos is asked again on sessions.changed and on settings_changed", async () => {
  const restore = await remount({ "git.repos": { repos: [api] } });
  try {
    const n = reposOf().length;
    await act(async () => sessionsChanged({}));
    await act(async () => {});
    expect(reposOf().length).toBe(n + 1);
    await act(async () => settingsChanged({ settings: { orchestration: {} } }));
    await act(async () => {});
    expect(reposOf().length).toBe(n + 2);
    expect(reposOf().at(-1)!.fresh).toBeUndefined();
  } finally {
    restore();
    delete replies["git.repos"];
  }
});

describe("idle close: holds and background follows", () => {
  const subscribes = () => sent.filter((m) => m.type === "session.subscribe") as { type: string; sessionId: string; background?: boolean }[];
  const other = { ...session, id: "99999999-2222-3333-4444-555555555555", cwd: "/p/other", title: "Other" };
  const closeActive = async () => {
    sent.length = 0;
    await act(async () => el.querySelector<HTMLElement>('[data-testid="tab-close-active"]')!.click());
    await act(async () => {});
  };

  it("closing the tab of a live session follows it in the background", async () => {
    await closeActive();
    expect(subscribes()).toContainEqual(expect.objectContaining({ sessionId: ID, background: true }));
    expect(sent.some((m) => m.type === "session.unsubscribe")).toBe(false);
  });

  it("closing the tab of a closed session unsubscribes it and drops its view", async () => {
    const restore = await remount({ "session.list": { sessions: [{ ...session, state: "closed" }], projects: ["/p/demo"] } });
    try {
      await closeActive();
      expect(sent).toContainEqual({ type: "session.unsubscribe", sessionId: ID });
      expect(subscribes()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("an unsubscribed error session is not followed again by the next list refresh", async () => {
    const restore = await remount({ "session.list": { sessions: [{ ...session, state: "error" }], projects: ["/p/demo"] } });
    try {
      await closeActive();
      expect(sent).toContainEqual({ type: "session.unsubscribe", sessionId: ID });
      sent.length = 0;
      await act(async () => sessionsChanged({ type: "sessions.changed" }));
      await act(async () => {});
      expect(subscribes()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("the list follows sessions without a tab in the background; opening one holds it", async () => {
    const restore = await remount({ "session.list": { sessions: [session, other], projects: ["/p/demo", "/p/other"] } });
    try {
      expect(subscribes()).toContainEqual(expect.objectContaining({ sessionId: other.id, background: true }));
      expect(subscribes().find((m) => m.sessionId === ID)).not.toHaveProperty("background");
      sent.length = 0;
      await act(async () => (location.hash = `#${other.id}`, window.dispatchEvent(new PopStateEvent("popstate"))));
      await act(async () => {});
      expect(subscribes().find((m) => m.sessionId === other.id)).not.toHaveProperty("background");
    } finally {
      restore();
    }
  });

  it("reconnect: tab sessions resubscribe holding, the others in the background", async () => {
    const restore = await remount({ "session.list": { sessions: [session, other], projects: ["/p/demo", "/p/other"] } });
    try {
      sent.length = 0;
      await act(async () => reconnect());
      await act(async () => {});
      expect(subscribes().find((m) => m.sessionId === ID)).not.toHaveProperty("background");
      expect(subscribes()).toContainEqual(expect.objectContaining({ sessionId: other.id, background: true }));
    } finally {
      restore();
    }
  });
});

it("a daemon that rejects this browser shows the pairing form in place of the session", async () => {
  await act(async () => setStatus("unauthorized"));
  expect(el.querySelector('[data-testid="pairing-needed"]')!.textContent).toContain("it is not paired");
  expect(el.querySelector('[data-testid="pairing-input"]')).not.toBeNull();
  await act(async () => setStatus("connected"));
  expect(el.querySelector('[data-testid="pairing-needed"]')).toBeNull();
});

it("unpairing clears the prompt drafts of this browser", async () => {
  localStorage.setItem("claude-ui.draft." + ID, "unsent");
  localStorage.setItem("claude-ui.drafts", JSON.stringify({ [ID]: 1 }));
  await act(async () => setStatus("unauthorized"));
  expect(localStorage.getItem("claude-ui.draft." + ID)).toBeNull();
});

describe("key promoter (GH-234)", () => {
  const mouseClick = (sel: string) =>
    act(async () => {
      const b = el.querySelector(sel)!;
      b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
      b.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "mouse", detail: 1 }));
    });
  const tipToast = () => document.querySelector<HTMLElement>('[data-testid="toast"]');
  const gone = () => act(async () => void (await new Promise((r) => setTimeout(r, 320))));

  it("a 2nd mouse click on New session shows its key; after Ctrl+Shift+S the tips for it end", async () => {
    const { loadKeyTips } = await import("./key-tips.ts");
    await mouseClick('[data-testid="tab-new"]');
    await mouseClick('[data-testid="tab-new"]');
    expect(tipToast()?.textContent).toContain("New session: Ctrl+Shift+S");
    await act(async () => document.querySelector<HTMLElement>('[data-testid="toast"] [aria-label="Dismiss"]')!.click());
    await gone();
    await press({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
    expect(loadKeyTips().learned).toContain("session.new");
    for (let i = 0; i < 3; i++) await mouseClick('[data-testid="tab-new"]');
    expect(tipToast()?.textContent ?? "").not.toContain("New session:");
  });

  it("the prefix key and a command key end the tips of that command (Alt+A, s: Toggle sidebar)", async () => {
    const { loadKeyTips } = await import("./key-tips.ts");
    await press({ key: "a", code: "KeyA", altKey: true });
    await press({ key: "s", code: "KeyS" });
    expect(loadKeyTips().learned).toContain("sidebar.toggle");
  });

  it("Assign a shortcut… opens Keyboard shortcuts recording that command", async () => {
    const target = el.querySelector('[data-testid="focus-tab"] button') ? '[data-testid="focus-tab"] button' : '[data-testid="focus-row-sidebar"]';
    await mouseClick(target);
    await mouseClick(target);
    expect(tipToast()?.textContent).toContain("Open Focus has no shortcut.");
    const assign = [...document.querySelectorAll<HTMLElement>('[data-testid="toast"] button')].find((b) => b.textContent === "Assign a shortcut…")!;
    await act(async () => assign.click());
    expect(document.querySelector('[data-testid="shortcuts-dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="shortcut-row-focus.open"] [data-testid="shortcut-recording"]')).not.toBeNull();
  });

  it("Reset shortcut tips from the palette clears the counts", async () => {
    const { loadKeyTips } = await import("./key-tips.ts");
    localStorage.setItem("claude-ui.key-tips", JSON.stringify({ v: 1, off: true, counts: { "session.new": 3 }, learned: ["sidebar.toggle"] }));
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    const input = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Reset shortcut tips");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLElement>('[data-id="tips.reset"]')!.click());
    expect(loadKeyTips()).toEqual({ v: 1, counts: {}, learned: [] });
    expect(tipToast()?.textContent).toContain("Shortcut tips reset.");
  });
});

describe("GH-359 tab menu commands", () => {
  const S2 = "22222222-2222-3333-4444-555555555555";
  const S3 = "33333333-2222-3333-4444-555555555555";
  const sessions = [session, { ...session, id: S2, title: "Second" }, { ...session, id: S3, title: "Third" }];
  const tabIds = () => [...el.querySelectorAll<HTMLElement>('[data-testid="tab-strip"] [data-testid="tab"]')].map((t) => t.dataset.tabId);
  const menu = async (id: string) => {
    await act(async () => void el.querySelector(`[data-tab-id="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    return (label: string) => act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === label)!.click());
  };
  const toast = () => el.querySelector<HTMLElement>('[data-testid="toast"]');
  async function remount() {
    act(() => root.unmount());
    replies["session.list"] = { sessions, projects: ["/p/demo"] };
    localStorage.setItem("claude-ui.tabs", JSON.stringify([ID, S2, S3]));
    location.hash = `#${S2}`;
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
  }
  afterEach(() => void (replies["session.list"] = { sessions: [session], projects: ["/p/demo"] }));

  it("Close others closes the other tabs without a dialog, toasts 'Closed 2 tabs'; Undo puts them back in place", async () => {
    await remount();
    expect(tabIds()).toEqual([ID, S2, S3]);
    const click = await menu(S2);
    await click("Close others");
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    expect(tabIds()).toEqual([S2]);
    expect(toast()?.textContent).toContain("Closed 2 tabs");
    await act(async () => [...toast()!.querySelectorAll("button")].find((b) => b.textContent === "Undo")!.click());
    expect(tabIds()).toEqual([ID, S2, S3]);
  });

  it("Close to the right closes the tabs after it and Reopen closed tab brings the last one back", async () => {
    await remount();
    const click = await menu(ID);
    await click("Close to the right");
    expect(tabIds()).toEqual([ID]);
    expect(toast()?.textContent).toContain("Closed 2 tabs");
    const again = await menu(ID);
    await again("Reopen closed tab");
    expect(tabIds()).toHaveLength(2);
  });

  it("Pin tab pins it first in the strip; Close all keeps pinned tabs; the pin survives a reload; Close tab drops it", async () => {
    await remount();
    const click = await menu(S3);
    await click("Pin tab");
    expect(tabIds()).toEqual([S3, ID, S2]);
    expect(JSON.parse(localStorage.getItem("claude-ui.pinned-tabs")!)).toEqual([S3]);
    const all = await menu(S2);
    await all("Close all");
    expect(tabIds()).toEqual([S3]);
    expect(toast()?.textContent).toContain("Closed 2 tabs");
    act(() => root.unmount());
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    expect(tabIds()).toEqual([S3]);
    expect(el.querySelector<HTMLElement>(`[data-tab-id="${S3}"]`)!.dataset.pinned).toBe("true");
    const close = await menu(S3);
    await close("Close tab");
    await act(async () => {});
    expect(JSON.parse(localStorage.getItem("claude-ui.pinned-tabs")!)).toEqual([]);
  });

  it("Copy session ID writes the id to the clipboard and toasts; without a clipboard the toast says why", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const click = await menu(ID);
    await click("Copy session ID");
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(toast()?.textContent).toBe("Copied session ID");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const again = await menu(ID);
    await again("Copy session ID");
    expect(toast()?.textContent).toContain("Copy failed");
  });
});

describe("GH-358 sidebar menus", () => {
  const DAY = 86_400_000;
  const W1 = "aaaaaaaa-2222-3333-4444-555555555555";
  const W2 = "bbbbbbbb-2222-3333-4444-555555555555";
  const O1 = "cccccccc-2222-3333-4444-555555555555";
  const O2 = "dddddddd-2222-3333-4444-555555555555";
  const main = { path: "/p/demo", branch: "main", main: true };
  const managed = "/p/demo/.claude/worktrees/x";
  const toast = () => el.querySelector<HTMLElement>('[data-testid="toast"]');
  const ctx = (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  const rowOf = (id: string) => el.querySelector(`[data-session-id="${id}"]`)!;
  const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  const click = (id: string) => act(async () => tid(id).click());
  const flush = () => act(async () => {});
  const coord = { ...session, coordinator: true as const };
  const worker = (id: string, name: string, o: Partial<SessionListItem> = {}): SessionListItem => ({ ...session, id, title: name, workerName: name, coordinatorId: ID, lastActivity: Date.now() - DAY, ...o });
  const saved = { list: replies["session.list"] };
  afterEach(() => {
    replies["session.list"] = saved.list;
    delete replies["worker.close"];
    delete replies["worker.remove"];
    delete replies["worktree.status"];
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });
  const mount = async (sessions: SessionListItem[], worktrees: Record<string, unknown[]> = {}) => {
    replies["session.list"] = { sessions, projects: ["/p/demo"], worktrees };
    localStorage.setItem("claude-ui.expandedWorkers", JSON.stringify([`coordinator:${ID}`]));
    act(() => root.unmount());
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await flush();
  };
  const bodies = (type: string, from: number) => sent.slice(from).filter((m) => m.type === type);

  it("Copy session ID from the sidebar writes the clipboard and toasts; without a clipboard the toast says why", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await ctx(rowOf(ID));
    await click("action-copy-id");
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(toast()?.textContent).toBe("Copied session ID");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await ctx(rowOf(ID));
    await click("action-copy-id");
    expect(toast()?.textContent).toContain("Copy failed");
  });

  it("Close tab from the sidebar menu closes the tab; the session stays listed", async () => {
    await ctx(rowOf(ID));
    expect(tid("action-close-tab")).not.toBeNull();
    await click("action-close-tab");
    expect(el.querySelector(`[data-tab-id="${ID}"]`)).toBeNull();
    expect(rowOf(ID)).not.toBeNull();
    await ctx(rowOf(ID));
    expect(document.querySelector('[data-testid="action-close-tab"]')).toBeNull();
  });

  it("Close finished workers sends one worker.close per idle worker, no dialog, then toasts", async () => {
    await mount([coord, worker(W1, "one"), worker(W2, "two", { live: false })]);
    const from = sent.length;
    await ctx(el.querySelector('[data-testid="worker-group-toggle"]')!);
    await click("workers-menu-close-finished");
    expect(bodies("worker.close", from)).toEqual([{ type: "worker.close", sessionId: W1 }]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(toast()?.textContent).toBe("Closed 1 worker");
  });

  it("Remove closed workers confirms with the count and names, then one worker.remove each; a failure shows '1 of 2 …'", async () => {
    await mount([coord, worker(W1, "one", { live: false }), worker(W2, "two", { live: false })]);
    replies["worker.remove"] = (m: { sessionId: string }) => (m.sessionId === W2 ? Promise.reject(new Error("The worker is running or waiting for input: close it first")) : {});
    const from = sent.length;
    await ctx(rowOf(ID));
    await click("action-remove-closed");
    const dialog = tid("remove-workers-dialog");
    expect(dialog.textContent).toContain("Remove 2 closed workers?");
    expect(dialog.textContent).toContain("one, two");
    expect(bodies("worker.remove", from)).toEqual([]);
    await click("remove-workers-confirm");
    await flush();
    expect(bodies("worker.remove", from).map((m) => (m as unknown as { sessionId: string }).sessionId).sort()).toEqual([W1, W2]);
    expect(el.textContent).toContain("1 of 2 workers removed: The worker is running or waiting for input: close it first");
  });

  it("Close worker from the row sends worker.close", async () => {
    await mount([coord, worker(W1, "one")]);
    const from = sent.length;
    await ctx(rowOf(W1));
    await click("action-close-worker");
    expect(bodies("worker.close", from)).toEqual([{ type: "worker.close", sessionId: W1 }]);
  });

  it("Remove worker asks first and sends worker.remove; the worktree option is absent for a worker in a plain folder", async () => {
    await mount([coord, worker(W1, "one", { live: false })]);
    const from = sent.length;
    await ctx(rowOf(W1));
    await click("action-remove-worker");
    expect(tid("remove-worker-dialog").textContent).toContain("Remove worker one?");
    expect(document.querySelector('[data-testid="remove-worker-worktree"]')).toBeNull();
    await click("remove-worker-confirm");
    await flush();
    expect(bodies("worker.remove", from)).toEqual([{ type: "worker.remove", sessionId: W1 }]);
    expect(bodies("worktree.remove", from)).toEqual([]);
    expect(toast()?.textContent).toBe("Removed worker one");
  });

  it("Remove worker with 'Also remove worktree' ticked fetches the worktree status on open, then removes the worker and the worktree", async () => {
    replies["worktree.status"] = { uncommitted: 1, commits: 0, branch: "worktree-x" };
    await mount([coord, worker(W1, "one", { live: false, cwd: managed }), { ...session, id: O1, title: "Other", cwd: managed }], { "/p/demo": [main, { path: managed, branch: "worktree-x", main: false }] });
    const from = sent.length;
    await ctx(rowOf(W1));
    await click("action-remove-worker");
    await flush();
    expect(bodies("worktree.status", from)).toEqual([{ type: "worktree.status", cwd: "/p/demo", path: managed }]);
    expect(tid("remove-worker-worktree").textContent ?? "").toBe("");
    expect(tid("remove-worker-dialog").textContent).toContain("Also remove worktree worktree-x");
    expect(tid("remove-worker-worktree-text").textContent).toContain("1 uncommitted file");
    expect(tid("remove-worker-worktree-text").textContent).toContain("1 other session there; their transcripts stay.");
    await act(async () => tid("remove-worker-worktree").click());
    await click("remove-worker-confirm");
    await flush();
    expect(bodies("worker.remove", from)).toEqual([{ type: "worker.remove", sessionId: W1 }]);
    expect(bodies("worktree.remove", from)).toEqual([{ type: "worktree.remove", cwd: "/p/demo", path: managed }]);
  });

  it("unticked, Remove worker leaves the worktree alone", async () => {
    replies["worktree.status"] = { uncommitted: 0, commits: 0, branch: "worktree-x" };
    await mount([coord, worker(W1, "one", { live: false, cwd: managed })], { "/p/demo": [main, { path: managed, branch: "worktree-x", main: false }] });
    const from = sent.length;
    await ctx(rowOf(W1));
    await click("action-remove-worker");
    await flush();
    await click("remove-worker-confirm");
    await flush();
    expect(bodies("worker.remove", from)).toHaveLength(1);
    expect(bodies("worktree.remove", from)).toEqual([]);
  });

  it("Archive idle sessions confirms with the count, archives each at once, and a failure refreshes with the error", async () => {
    const old = (id: string, title: string, days: number): SessionListItem => ({ ...session, id, title, lastActivity: Date.now() - days * DAY });
    await mount([old(O1, "Old one", 40), old(O2, "Old two", 20), { ...session, lastActivity: Date.now() }]);
    replies["session.archive"] = (m: { sessionId: string }) => (m.sessionId === O2 ? Promise.reject(new Error("no transcript")) : {});
    const from = sent.length;
    await ctx(el.querySelector('[data-testid="group-toggle"]')!);
    expect(tid("group-menu-archive-7").textContent).toBe("7 days (2)…");
    await click("group-menu-archive-7");
    expect(tid("archive-idle-dialog").textContent).toContain("Archive 2 sessions?");
    expect(tid("archive-idle-dialog").textContent).toContain("idle for more than 7 days");
    expect(bodies("session.archive", from)).toEqual([]);
    await click("archive-idle-confirm");
    await flush();
    expect(bodies("session.archive", from).map((m) => (m as unknown as { sessionId: string; archived: boolean }).archived)).toEqual([true, true]);
    expect(el.textContent).toContain("1 of 2 sessions archived: no transcript");
    delete replies["session.archive"];
  });

  it("Archive idle sessions drops the rows from the list at once and toasts", async () => {
    const old = (id: string, title: string, days: number): SessionListItem => ({ ...session, id, title, lastActivity: Date.now() - days * DAY });
    await mount([old(O1, "Old one", 40), { ...session, lastActivity: Date.now() }]);
    await ctx(el.querySelector('[data-testid="group-toggle"]')!);
    await click("group-menu-archive-30");
    await click("archive-idle-confirm");
    await flush();
    expect(rowOf(O1)).toBeNull();
    expect(toast()?.textContent).toBe("Archived 1 session");
  });

  it("Rename from the row context menu opens the title editor with the title selected and keeps it: Enter saves, Escape cancels", async () => {
    const input = () => el.querySelector<HTMLInputElement>('[data-testid="rename-input"]');
    await ctx(rowOf(ID));
    await click("action-rename");
    await new Promise((r) => setTimeout(r, 400));
    await flush();
    expect(input()).not.toBeNull();
    expect(document.activeElement).toBe(input());
    expect(input()!.selectionStart).toBe(0);
    expect(input()!.selectionEnd).toBe(input()!.value.length);
    const from = sent.length;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input()!, "Renamed");
      input()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(bodies("session.rename", from)).toEqual([{ type: "session.rename", sessionId: ID, title: "Renamed" }]);
    await ctx(rowOf(ID));
    await click("action-rename");
    await new Promise((r) => setTimeout(r, 400));
    await flush();
    expect(input()).not.toBeNull();
    await act(async () => void input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(input()).toBeNull();
  });

  it("Rename from the row context menu survives the closing menu taking the focus back", async () => {
    await ctx(rowOf(ID));
    await click("action-rename");
    const input = () => el.querySelector<HTMLInputElement>('[data-testid="rename-input"]');
    // The menu's focus return, as a real browser does it while the popup fades out.
    await act(async () => void input()!.blur());
    await new Promise((r) => setTimeout(r, 50));
    await flush();
    expect(input()).not.toBeNull();
    expect(document.activeElement).toBe(input());
    // A blur after the grace period still ends the edit.
    await new Promise((r) => setTimeout(r, 600));
    await act(async () => void input()!.blur());
    expect(input()).toBeNull();
  });
});

describe("GH-356 split view", () => {
  const S2 = "22222222-2222-3333-4444-555555555555";
  const S3 = "33333333-2222-3333-4444-555555555555";
  const sessions = [session, { ...session, id: S2, title: "Second", cwd: "/p/other" }, { ...session, id: S3, title: "Third" }];
  const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent")!;
  const splits = () => [...el.querySelectorAll<HTMLElement>('[data-testid="split"]')];
  const activeSplit = () => el.querySelector<HTMLElement>('[data-testid="split"][data-active]');
  const labels = () => splits().sort((a, b) => +a.style.order - +b.style.order).map((s) => s.getAttribute("aria-label"));
  const menu = async (id: string) => {
    await act(async () => void el.querySelector(`[data-tab-id="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    return (label: string) => act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === label)!.click());
  };
  const tabIds = () => [...el.querySelectorAll<HTMLElement>('[data-testid="tab-strip"] [data-testid="tab"]')].map((t) => t.dataset.tabId);
  async function remount(hash = S2, tabs = [ID, S2, S3]) {
    act(() => root.unmount());
    replies["session.list"] = { sessions, projects: ["/p/demo", "/p/other"] };
    replies["session.subscribe"] = (m: { sessionId: string }) => ({ logEpoch: "e1", session: sessions.find((s) => s.id === m.sessionId) ?? session });
    localStorage.setItem("claude-ui.tabs", JSON.stringify(tabs));
    location.hash = `#${hash}`;
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
  }
  const splitRight = async (id = S2) => (await menu(id))("Split right");
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get(this: HTMLElement) { return this.closest('[style*="display: none"]') ? null : document.body; } });
  });
  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent);
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
    replies["session.subscribe"] = { logEpoch: "e1", session };
    sent.length = 0;
  });

  it("GH-378 the session in the other split pane gets its shown record (list lastActivity) too", async () => {
    localStorage.setItem("claude-ui.shown-activity", "{}");
    await remount(ID);
    await splitRight(S2);
    await act(async () => void window.dispatchEvent(new Event("focus")));
    // ID is on screen but not active; its session's lastActivity moves.
    replies["session.list"] = { sessions: [{ ...sessions[0]!, lastActivity: 500 }, ...sessions.slice(1)], projects: ["/p/demo", "/p/other"] };
    await act(async () => sessionsChanged({}));
    await act(async () => {});
    expect(JSON.parse(localStorage.getItem("claude-ui.shown-activity")!)[ID]).toBe(500);
    localStorage.removeItem("claude-ui.shown-activity");
  });

  it("GH-378 Clean up tabs keeps the tab shown in the other split like the active tab", async () => {
    localStorage.setItem("claude-ui.shown-activity", JSON.stringify({ [ID]: 1e15, [S2]: 1e15, [S3]: 1e15 }));
    await remount(ID);
    await splitRight(S2);
    await (await menu(S3))("Clean up tabs");
    await act(async () => document.querySelector<HTMLElement>('[data-testid="tab-cleanup-idle"]')!.click());
    expect(tabIds()).toEqual([ID, S2]);
    expect(labels()).toHaveLength(2);
    localStorage.removeItem("claude-ui.shown-activity");
  });

  it("Split right from the tab menu shows both sessions side by side, focuses the new split's prompt and puts it in the hash", async () => {
    await remount(ID);
    expect(splits()).toHaveLength(0);
    await splitRight(S2);
    expect(labels()).toEqual(["Demo, split 1 of 2", "Second, split 2 of 2, active"]);
    expect(el.querySelector('[data-testid="session-area"]')!.getAttribute("data-split")).toBe("row");
    expect(activeSplit()).toBe(splits()[1]);
    expect(location.hash).toBe(`#${S2}`);
    await vi.waitFor(() => expect(document.activeElement).toBe(activeSplit()!.querySelector('textarea[aria-label="Prompt"]')));
    expect(splits().map((s) => s.style.order)).toEqual(["0", "2"]);
  });

  it("the tab shown in the other split is marked with an icon and text, not by color", async () => {
    await remount(ID);
    await splitRight(S2);
    const mark = el.querySelector(`[data-tab-id="${ID}"] [data-testid="tab-split-mark"]`);
    expect(mark).not.toBeNull();
    expect(el.querySelector(`[data-tab-id="${ID}"] [role="tab"]`)!.getAttribute("aria-label")).toContain("shown in split 1");
    expect(el.querySelector(`[data-tab-id="${S2}"] [data-testid="tab-split-mark"]`)).toBeNull();
  });

  it("Split down stacks the sessions with a horizontal resizer", async () => {
    await remount(ID);
    await (await menu(S2))("Split down");
    expect(el.querySelector('[data-testid="session-area"]')!.className).toContain("flex-col");
    expect(el.querySelector('[data-testid="split-resizer"]')!.getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("clicking the other split makes it active: hash, side panel and tab follow", async () => {
    await remount(ID);
    await splitRight(S2);
    await act(async () => void splits()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(activeSplit()).toBe(splits()[0]);
    expect(location.hash).toBe(`#${ID}`);
    expect(el.querySelector(`[data-tab-id="${ID}"]`)!.getAttribute("data-active")).not.toBeNull();
    expect(labels()).toEqual(["Demo, split 1 of 2, active", "Second, split 2 of 2"]);
  });

  it("Esc stops only the active split's turn", async () => {
    await remount(ID);
    await splitRight(S2);
    for (const [i, id] of [ID, S2].entries()) await act(async () => emit({ type: "event", sessionId: id, seq: 1 + i, part: { type: "session_state", id: "session_state", state: "running" } }));
    sent.length = 0;
    await press({ key: "Escape" });
    const stops = sent.filter((m) => m.type === "session.interrupt") as unknown as { sessionId: string }[];
    expect(stops.map((m) => m.sessionId)).toEqual([S2]);
  });

  it("Focus next split (Ctrl+Alt+ArrowUp) and the prefix key o move the focus between the splits' prompts", async () => {
    await remount(ID);
    await splitRight(S2);
    const focusIn = (i: number) => vi.waitFor(() => expect(document.activeElement).toBe(splits()[i]!.querySelector('textarea[aria-label="Prompt"]')));
    await press({ key: "ArrowUp", code: "ArrowUp", ctrlKey: true, altKey: true });
    await focusIn(0);
    expect(activeSplit()).toBe(splits()[0]);
    await press({ key: "a", code: "KeyA", altKey: true });
    await press({ key: "o", code: "KeyO" });
    await focusIn(1);
    expect(activeSplit()).toBe(splits()[1]);
  });

  it("closing the other split's tab ends the split; closing the active split's tab shows the next tab outside the splits", async () => {
    await remount(ID);
    await splitRight(S2);
    await act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${ID}"] button[aria-label^="Close"]`)!.click());
    expect(splits()).toHaveLength(0);
    expect(location.hash).toBe(`#${S2}`);
    await splitRight(S2);
    expect(splits()).toHaveLength(2);
    await act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${S2}"] button[aria-label^="Close"]`)!.click());
    expect(splits()).toHaveLength(0);
    expect(tabIds()).toEqual([S3]);
    expect(location.hash).toBe(`#${S3}`);
  });

  it("closing the active split's tab with no tab outside the splits leaves the other split's tab", async () => {
    await remount(ID, [ID, S2]);
    await splitRight(S2);
    await act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${S2}"] button[aria-label^="Close"]`)!.click());
    expect(splits()).toHaveLength(0);
    expect(location.hash).toBe(`#${ID}`);
  });

  it("the split survives a remount", async () => {
    await remount(ID);
    await splitRight(S2);
    act(() => root.unmount());
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    expect(labels()).toEqual(["Demo, split 1 of 2", "Second, split 2 of 2, active"]);
  });

  it("narrow screens show one session; the split comes back on a wide screen", async () => {
    await remount(ID);
    await splitRight(S2);
    width = 800;
    await act(async () => window.dispatchEvent(new Event("resize")));
    act(() => root.unmount());
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    expect(splits()).toHaveLength(0);
    expect(el.querySelector(`[data-tab-id="${S2}"]`)).not.toBeNull();
    expect(localStorage.getItem("claude-ui.split")).not.toBeNull();
    await act(async () => void el.querySelector(`[data-tab-id="${ID}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
    expect([...document.querySelectorAll('[role="menuitem"]')].some((i) => i.textContent === "Split right")).toBe(false);
  });

  it("the resizer: arrow keys change the ratio, Home and End stop at the limits, Enter resets, and it persists", async () => {
    await remount(ID);
    await splitRight(S2);
    const bar = () => el.querySelector<HTMLElement>('[data-testid="split-resizer"]')!;
    expect(bar().getAttribute("aria-valuenow")).toBe("50");
    expect(splits()[0]!.style.flex).toBe("0.5 1 0%");
    // 1000px area, 8px gap: each split keeps 320px.
    bar().parentElement!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON() {} });
    await press({ key: "Home" }, bar());
    expect(bar().getAttribute("aria-valuenow")).toBe("32");
    await press({ key: "End" }, bar());
    expect(bar().getAttribute("aria-valuenow")).toBe("68");
    expect(JSON.parse(localStorage.getItem("claude-ui.split")!).ratio).toBeCloseTo(0.677, 2);
    await press({ key: "Enter" }, bar());
    expect(bar().getAttribute("aria-valuenow")).toBe("50");
  });

  it("the New session tab suspends the split; the next session tab brings it back", async () => {
    await remount(ID);
    await splitRight(S2);
    await act(async () => el.querySelector<HTMLElement>('[data-testid="tab-new"]')!.click());
    expect(location.hash).toBe("#new");
    expect(splits()).toHaveLength(0);
    await act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${ID}"] [role="tab"]`)!.click());
    expect(labels()).toEqual(["Demo, split 1 of 2, active", "Second, split 2 of 2"]);
  });

  it("Join splits (palette) shows the active session alone", async () => {
    await remount(ID);
    await splitRight(S2);
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    await act(async () => [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith("Join splits"))!.click());
    expect(splits()).toHaveLength(0);
    expect(location.hash).toBe(`#${S2}`);
    expect(localStorage.getItem("claude-ui.split")).toBeNull();
  });

  it("Split right is disabled with one session tab and the palette does not list it", async () => {
    await remount(ID, [ID]);
    await menu(ID);
    expect(document.querySelector<HTMLElement>('[data-testid="tab-menu-splitRight"]')!.hasAttribute("data-disabled")).toBe(true);
  });

  // Slice 2: dragging a tab onto the session area.
  const drag = (area: HTMLElement, type: string, x: number, y: number, id = S3) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { clientX: x, clientY: y, dataTransfer: { types: ["application/x-claude-ui-tab"], getData: () => id, dropEffect: "none" } });
    return act(async () => void area.dispatchEvent(e));
  };
  const area = () => {
    const a = el.querySelector<HTMLElement>('[data-testid="session-area"]')!;
    a.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, x: 0, y: 0, toJSON() {} });
    return a;
  };

  it("dragging a tab over the right edge shows the overlay on the right half; dropping splits right with that tab; dragleave clears", async () => {
    await remount(ID);
    await drag(area(), "dragover", 880, 300);
    const o = () => el.querySelector<HTMLElement>('[data-testid="split-drop"]');
    expect(o()?.dataset.zone).toBe("right");
    expect(o()!.style.left).toBe("450px");
    expect(o()!.style.width).toBe("450px");
    await drag(area(), "dragleave", 880, 300);
    expect(o()).toBeNull();
    await drag(area(), "dragover", 880, 300);
    await drag(area(), "drop", 880, 300);
    expect(o()).toBeNull();
    expect(labels()).toEqual(["Demo, split 1 of 2", "Third, split 2 of 2, active"]);
  });

  it("dropping on the left edge puts the tab left; on the bottom edge it stacks", async () => {
    await remount(ID);
    await drag(area(), "drop", 10, 300);
    expect(labels()).toEqual(["Third, split 1 of 2, active", "Demo, split 2 of 2"]);
    await drag(area(), "drop", 450, 590, S2);
    expect(el.querySelector('[data-testid="session-area"]')!.getAttribute("data-split")).toBe("col");
  });

  it("dropping on the middle of a split shows the tab there; with no split it just shows the tab", async () => {
    await remount(ID);
    await drag(area(), "drop", 450, 300, S2);
    expect(splits()).toHaveLength(0);
    expect(location.hash).toBe(`#${S2}`);
    await splitRight(S2);
    for (const s of splits()) s.getBoundingClientRect = () => ({ left: s === splits()[0] ? 0 : 450, top: 0, width: 440, height: 600, right: s === splits()[0] ? 440 : 890, bottom: 600, x: 0, y: 0, toJSON() {} });
    await drag(area(), "dragover", 350, 300);
    expect(el.querySelector<HTMLElement>('[data-testid="split-drop"]')!.style.width).toBe("440px");
    await drag(area(), "drop", 350, 300, S3);
    expect(labels()).toEqual(["Third, split 1 of 2, active", "Second, split 2 of 2"]);
  });

  it("Remove project returns the focus to the active split's prompt, not the other split's", async () => {
    await remount(ID, [ID, S3]);
    replies["session.list"] = { sessions: [session, sessions[2]!], projects: ["/p/other"] };
    await act(async () => void sessionsChanged({}));
    await splitRight(S3);
    // The last project (no next row) has no tab open: the dialog hands the focus to the prompt box.
    await act(async () => el.querySelector<HTMLElement>('[data-cwd="/p/other"] [data-testid="project-remove"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="remove-project-confirm"]')!.click());
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(document.activeElement).toBe(activeSplit()!.querySelector('textarea[aria-label="Prompt"]'));
    expect(activeSplit()!.getAttribute("aria-label")).toContain("Third");
  });

  it("the resizer's aria-controls names the first split's element", async () => {
    await remount(ID);
    await splitRight(S2);
    const id = el.querySelector('[data-testid="split-resizer"]')!.getAttribute("aria-controls")!;
    expect(document.getElementById(id)).toBe(splits().find((s) => s.getAttribute("aria-label")!.includes("split 1 of 2")));
  });

  it("a centre drop overlay matches the target split when the ratio is not 50%, in screen order", async () => {
    await remount(ID);
    await splitRight(S2); // ids [ID, S2]
    await act(async () => void el.querySelector<HTMLElement>('[data-testid="split-resizer"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    const r = (left: number, width: number) => () => ({ left, top: 0, width, height: 600, right: left + width, bottom: 600, x: 0, y: 0, toJSON() {} });
    const [a, b] = [...splits()].sort((x, y) => +x.style.order - +y.style.order);
    a!.getBoundingClientRect = r(0, 300);
    b!.getBoundingClientRect = r(308, 592);
    await drag(area(), "dragover", 500, 300);
    const o = el.querySelector<HTMLElement>('[data-testid="split-drop"]')!;
    expect([o.style.left, o.style.width]).toEqual(["308px", "592px"]);
    await drag(area(), "drop", 500, 300, S3);
    expect(labels()).toEqual(["Demo, split 1 of 2", "Third, split 2 of 2, active"]);
  });

  it("a saved ratio that would leave a split under the minimum is clamped when drawn only; the saved ratio returns with the space", async () => {
    const callbacks: { cb: ResizeObserverCallback; target?: Element }[] = [];
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      rec: { cb: ResizeObserverCallback; target?: Element };
      constructor(cb: ResizeObserverCallback) {
        this.rec = { cb };
        callbacks.push(this.rec);
      }
      observe(t: Element) {
        this.rec.target = t;
      }
      unobserve() {}
      disconnect() {}
    } as never;
    try {
      localStorage.setItem("claude-ui.split", JSON.stringify({ dir: "row", ids: [ID, S2], at: 0, ratio: 0.3 }));
      await remount(ID);
      const size = (w: number) =>
        act(async () => callbacks.filter((c) => (c.target as HTMLElement | undefined)?.dataset?.testid === "session-area").forEach((c) => c.cb([{ contentRect: { width: w, height: 800 } } as ResizeObserverEntry], {} as ResizeObserver)));
      const saved = () => JSON.parse(localStorage.getItem("claude-ui.split")!).ratio as number;
      const drawn = () => parseFloat(splits().sort((a, b) => +a.style.order - +b.style.order)[0]!.style.flex);
      await size(3000);
      expect(drawn()).toBeCloseTo(0.3, 3);
      await size(1000);
      expect(drawn()).toBeCloseTo(320 / 992, 3);
      expect(saved()).toBe(0.3);
      await size(3000);
      expect(drawn()).toBeCloseTo(0.3, 3);
      expect(saved()).toBe(0.3);
    } finally {
      globalThis.ResizeObserver = RO;
    }
  });

  it("a session area narrower than two minimum splits shows the active split alone; the split returns with the space", async () => {
    const callbacks: { cb: ResizeObserverCallback; target?: Element }[] = [];
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      rec: { cb: ResizeObserverCallback; target?: Element };
      constructor(cb: ResizeObserverCallback) {
        this.rec = { cb };
        callbacks.push(this.rec);
      }
      observe(t: Element) {
        this.rec.target = t;
      }
      unobserve() {}
      disconnect() {}
    } as never;
    try {
      await remount(ID);
      await splitRight(S2);
      const size = (w: number, h = 800) =>
        act(async () => callbacks.filter((c) => (c.target as HTMLElement | undefined)?.dataset?.testid === "session-area").forEach((c) => c.cb([{ contentRect: { width: w, height: h } } as ResizeObserverEntry], {} as ResizeObserver)));
      await size(1000);
      expect(splits()).toHaveLength(2);
      await size(600);
      expect(splits()).toHaveLength(0);
      expect(localStorage.getItem("claude-ui.split")).not.toBeNull();
      expect(el.querySelector('[data-testid="split-hint"]')!.textContent).toContain("Split hidden — widen the window or hide a panel");
      expect(el.querySelector(`[data-tab-id="${ID}"] [role="tab"]`)!.getAttribute("aria-label")).toBe("Demo (hidden: not enough room)");
      await size(900);
      expect(el.querySelector('[data-testid="split-hint"]')).toBeNull();
      await size(600);
      await act(async () => [...el.querySelectorAll<HTMLElement>('[data-testid="split-hint"] button')].find((b) => b.textContent === "Close split")!.click());
      expect(el.querySelector('[data-testid="split-hint"]')).toBeNull();
      expect(localStorage.getItem("claude-ui.split")).toBeNull();
      await splitRight(S2);
      await size(900);
      expect(labels()).toEqual(["Third, split 1 of 2", "Second, split 2 of 2, active"]);
    } finally {
      globalThis.ResizeObserver = RO;
    }
  });

  it("a drag that is no tab, or on a narrow screen, shows no overlay", async () => {
    await remount(ID);
    const e = new Event("dragover", { bubbles: true, cancelable: true });
    Object.assign(e, { clientX: 880, clientY: 300, dataTransfer: { types: ["Files"], getData: () => "" } });
    await act(async () => void area().dispatchEvent(e));
    expect(el.querySelector('[data-testid="split-drop"]')).toBeNull();
    width = 800;
    act(() => root.unmount());
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    await drag(area(), "dragover", 880, 300);
    expect(el.querySelector('[data-testid="split-drop"]')).toBeNull();
  });

  it("Split right from the palette splits the active tab", async () => {
    await remount(S2);
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    await act(async () => [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith("Split right"))!.click());
    expect(labels()).toHaveLength(2);
    expect(activeSplit()!.getAttribute("aria-label")).toContain("Second");
  });
});

describe("GH-378 clean up tabs", () => {
  const S = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-2222-3333-4444-555555555555`;
  const [S2, S3, S4, S5] = [S(2), S(3), S(4), S(5)];
  const mk = (id: string, title: string, over: Partial<SessionListItem> = {}): SessionListItem => ({ ...session, id, title, ...over });
  const tabIds = () => [...el.querySelectorAll<HTMLElement>('[data-testid="tab-strip"] [data-testid="tab"]')].map((t) => t.dataset.tabId);
  const toast = () => el.querySelector<HTMLElement>('[data-testid="toast"]');
  const undo = () => act(async () => [...toast()!.querySelectorAll("button")].find((b) => b.textContent === "Undo")!.click());
  const rule = async (from: string, r: string) => {
    await act(async () => void el.querySelector(`[data-tab-id="${from}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Clean up tabs")!.click());
    await act(async () => document.querySelector<HTMLElement>(`[data-testid="tab-cleanup-${r}"]`)!.click());
  };
  async function remount(list: SessionListItem[], tabs: string[], active: string) {
    act(() => root.unmount());
    replies["session.list"] = { sessions: list, projects: ["/p/demo"] };
    // An error session's state comes from its snapshot heads, as from the daemon.
    const errorSnapshot = (id: string) => ({ seq: 1, snapshot: { heads: [{ type: "event", sessionId: id, seq: 1, part: { type: "session_state", id: "session_state", state: "error" } }], attentionSeq: 0, page: { parts: [] }, aux: [] } });
    replies["session.subscribe"] = (m: { sessionId: string }) => {
      const s = list.find((x) => x.id === m.sessionId) ?? session;
      return { logEpoch: "e1", seq: 0, session: s, ...(s.state === "error" && errorSnapshot(s.id)) };
    };
    localStorage.setItem("claude-ui.tabs", JSON.stringify(tabs));
    location.hash = `#${active}`;
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
  }
  const draft = (id: string) => {
    localStorage.setItem(`claude-ui.draft.${id}`, "unsent");
    localStorage.setItem("claude-ui.drafts", JSON.stringify({ ...JSON.parse(localStorage.getItem("claude-ui.drafts") ?? "{}"), [id]: Date.now() }));
  };
  // This browser showed every session after its last output (tests that need otherwise set the record themselves).
  beforeEach(() => localStorage.setItem("claude-ui.shown-activity", JSON.stringify(Object.fromEntries([ID, S2, S3, S4, S5, S(6)].map((id) => [id, 1e15])))));
  afterEach(() => {
    vi.useRealTimers();
    replies["session.list"] = { sessions: [session], projects: ["/p/demo"] };
    replies["session.subscribe"] = { logEpoch: "e1", session };
    localStorage.clear();
  });

  it("Close idle tabs closes idle read tabs, keeps the active, a running and a draft one; toast 'Closed 2 tabs'; Undo restores tabs and order; no session is stopped", async () => {
    await remount([session, mk(S2, "Second"), mk(S3, "Third", { state: "running" }), mk(S4, "Fourth"), mk(S5, "Fifth")], [ID, S2, S3, S4, S5], S2);
    draft(S4);
    sent.length = 0;
    await rule(S2, "idle");
    expect(tabIds()).toEqual([S2, S3, S4]);
    expect(toast()?.textContent).toContain("Closed 2 tabs");
    await undo();
    expect(tabIds()).toEqual([ID, S2, S3, S4, S5]);
    expect(sent.filter((m) => ["session.interrupt", "session.close", "session.delete", "session.archive"].includes(m.type))).toEqual([]);
  });

  it("Close tabs of archived or deleted sessions closes an archived tab and a tab whose session is not listed", async () => {
    await remount([session, mk(S2, "Second"), mk(S3, "Third", { archived: true })], [ID, S2, S3, S4], S2);
    await rule(S2, "archived");
    expect(tabIds()).toEqual([ID, S2]);
  });

  it("Close worker tabs closes tabs with coordinatorId", async () => {
    await remount([session, mk(S2, "Second"), mk(S3, "Third", { coordinatorId: ID })], [ID, S2, S3], S2);
    await rule(S2, "workers");
    expect(tabIds()).toEqual([ID, S2]);
  });

  it("Close tabs not used for 1 hour uses claude-ui.tab-used; switching tabs stamps both tabs", async () => {
    const old = Date.now() - 2 * 3_600_000;
    localStorage.setItem("claude-ui.tab-used", JSON.stringify({ [ID]: old, [S2]: old, [S3]: old }));
    await remount([session, mk(S2, "Second"), mk(S3, "Third")], [ID, S2, S3], S2);
    // The shown tab is stamped on load; ID and S3 are not shown.
    await act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${S3}"] [role="tab"]`)!.click());
    await act(async () => {});
    const used = JSON.parse(localStorage.getItem("claude-ui.tab-used")!) as Record<string, number>;
    expect(Date.now() - used[S2]!).toBeLessThan(60_000);
    expect(Date.now() - used[S3]!).toBeLessThan(60_000);
    expect(used[ID]).toBe(old);
    await rule(S3, "unused1h");
    expect(tabIds()).toEqual([S2, S3]);
  });

  it("pinned tabs and a tab with a draft are never closed by a rule", async () => {
    await remount([session, mk(S2, "Second"), mk(S3, "Third"), mk(S4, "Fourth")], [ID, S2, S3, S4], S2);
    localStorage.setItem("claude-ui.pinned-tabs", JSON.stringify([S3]));
    await remount([session, mk(S2, "Second"), mk(S3, "Third"), mk(S4, "Fourth")], [ID, S2, S3, S4], S2);
    draft(ID);
    await rule(S2, "idle");
    expect(tabIds().sort()).toEqual([ID, S2, S3].sort());
  });

  it("auto-close 1 hour closes stale idle tabs once with one 'Auto-closed N idle tabs' toast and does not toast again within 15 minutes", async () => {
    const old = Date.now() - 3 * 3_600_000;
    localStorage.setItem("claude-ui.tab-used", JSON.stringify({ [ID]: old, [S2]: old, [S3]: old, [S4]: old }));
    localStorage.setItem("claude-ui.tabAutoClose", "1h");
    await remount([session, mk(S2, "Second"), mk(S3, "Third"), mk(S4, "Fourth", { state: "running" })], [ID, S2, S3, S4], S2);
    await act(async () => {});
    expect(tabIds()).toEqual([S2, S4]);
    expect(toast()?.textContent).toContain("Auto-closed 2 idle tabs");
    // Undo brings them back; the throttle keeps the next check from closing them again.
    const before = Date.now();
    await undo();
    expect(tabIds()).toEqual([ID, S2, S3, S4]);
    // Undo counts as use.
    const used = JSON.parse(localStorage.getItem("claude-ui.tab-used")!) as Record<string, number>;
    expect(used[ID]).toBeGreaterThanOrEqual(before);
    expect(used[S3]).toBeGreaterThanOrEqual(before);
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {});
    expect(tabIds()).toEqual([ID, S2, S3, S4]);
  });

  it("the Clean up tabs counts, kept line and closed set are the same whichever tab opens the menu (not the active one, not a stale render)", async () => {
    await remount([session, mk(S2, "Second"), mk(S3, "Third"), mk(S4, "Fourth", { state: "running" }), mk(S5, "Fifth")], [ID, S2, S3, S4, S5], S2);
    // A draft appears without any prop of a tab changing: a memoized tab does not render again.
    draft(S3);
    const open = async (from: string) => {
      await act(async () => void el.querySelector(`[data-tab-id="${from}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Clean up tabs")!.click());
      return document.querySelector<HTMLElement>('[data-testid="tab-cleanup-menu"]')!;
    };
    const read = (m: HTMLElement) => [m.querySelector('[data-testid="tab-cleanup-idle"]')!.getAttribute("aria-label"), m.querySelector('[data-testid="tab-cleanup-kept"]')?.textContent];
    const seen: unknown[] = [];
    for (const from of [S5, ID, S4]) {
      seen.push(read(await open(from)));
      await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    }
    // Idle and unprotected: ID and S5 (S3 has a draft, S4 runs, S2 is active).
    for (const r of seen) expect(r).toEqual(["Close idle tabs (2)", "2 kept: running/draft"]);
    await rule(S5, "idle");
    expect(tabIds()).toEqual([S2, S3, S4]);
    expect(toast()?.textContent).toContain("Closed 2 tabs");
  });

  it("a palette rule or a bound key with nothing to close shows 'No tabs to close'; the page lists the rule disabled", async () => {
    await remount([session], [ID], ID);
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    const input = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Clean up tabs");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => paletteRow("Clean up tabs…")!.click());
    const idle = paletteRow("Close idle tabs")!;
    expect(idle.getAttribute("aria-disabled")).toBe("true");
    await act(async () => idle.click());
    expect(document.querySelector('[data-testid="palette"]')).not.toBeNull();
    await press({ key: "Escape", code: "Escape" });
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    const again = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(again, "Close idle tabs");
      again.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => paletteRow("Close idle tabs")!.click());
    expect(toast()?.textContent).toContain("No tabs to close");
  });

  it("a session tab whose view is still loading is kept by auto-close and by a manual rule until its view arrives", async () => {
    const old = Date.now() - 3 * 3_600_000;
    localStorage.setItem("claude-ui.tab-used", JSON.stringify({ [ID]: old, [S2]: old, [S3]: old }));
    localStorage.setItem("claude-ui.tabAutoClose", "1h");
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((r) => (release = r));
    const list = [session, mk(S2, "Second"), mk(S3, "Third")];
    act(() => root.unmount());
    replies["session.list"] = { sessions: list, projects: ["/p/demo"] };
    // The view of S3 arrives late.
    replies["session.subscribe"] = (m: { sessionId: string }) => (m.sessionId === S3 ? slow.then(() => ({ logEpoch: "e1", seq: 0, session: list[2] })) : { logEpoch: "e1", seq: 0, session: list.find((x) => x.id === m.sessionId) });
    localStorage.setItem("claude-ui.tabs", JSON.stringify([ID, S2, S3]));
    location.hash = `#${S2}`;
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    // Auto-close ran at the list load: S3 (loading) stays, ID (view loaded) closed.
    expect(tabIds()).toEqual([S2, S3]);
    await rule(S2, "idle");
    expect(tabIds()).toEqual([S2, S3]);
    // The disabled item left its menu open: close it.
    for (let i = 0; i < 2; i++) await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => release(undefined));
    for (let i = 0; i < 3; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    await rule(S2, "idle");
    expect(tabIds()).toEqual([S2]);
  });

  it("a cleanup close while another cleanup toast shows joins it: one toast, Undo restores both sets", async () => {
    await remount([session, mk(S2, "Second"), mk(S3, "Third", { archived: true }), mk(S4, "Fourth", { coordinatorId: ID }), mk(S5, "Fifth", { state: "running" })], [ID, S2, S3, S4, S5], S2);
    await rule(S2, "archived");
    expect(tabIds()).toEqual([ID, S2, S4, S5]);
    expect(toast()?.textContent).toContain("Closed Third");
    await rule(S2, "workers");
    expect(tabIds()).toEqual([ID, S2, S5]);
    expect(toast()?.textContent).toContain("Closed 2 tabs");
    await undo();
    expect(tabIds()).toEqual([ID, S2, S3, S4, S5]);
  });

  it("a tab shown in another window (newer claude-ui.tab-used in storage) is not closed by a time rule or auto-close", async () => {
    const old = Date.now() - 3 * 3_600_000;
    localStorage.setItem("claude-ui.tab-used", JSON.stringify({ [ID]: old, [S2]: old, [S3]: old }));
    await remount([session, mk(S2, "Second"), mk(S3, "Third")], [ID, S2, S3], S2);
    // Window B shows S3 now.
    localStorage.setItem("claude-ui.tab-used", JSON.stringify({ [ID]: old, [S2]: old, [S3]: Date.now() }));
    await rule(S2, "unused1h");
    expect(tabIds()).toEqual([S2, S3]);
  });

  it("after a reload, tabs of closed sessions (not loaded in this daemon run) are counted and closed by rules without a subscribe; one with output after this browser last showed it stays unread", async () => {
    const S6 = S(6);
    const old = Date.now() - 3 * 3_600_000;
    localStorage.setItem("claude-ui.tab-used", JSON.stringify({ [ID]: old, [S2]: old, [S3]: old, [S4]: old, [S5]: old, [S6]: old }));
    // lastActivity of each session's list item when this browser last showed it; S5 ran a turn after that.
    localStorage.setItem("claude-ui.shown-activity", JSON.stringify({ [ID]: 100, [S3]: 100, [S4]: 100, [S5]: 150, [S6]: 100 }));
    const closed = { state: "closed" as const, lastActivity: 100 };
    sent.length = 0;
    await remount(
      [mk(ID, "First", closed), mk(S2, "Second"), mk(S3, "Third", { ...closed, archived: true }), mk(S4, "Fourth", { ...closed, coordinatorId: S2 }), mk(S5, "Fifth", { ...closed, lastActivity: 200 }), mk(S6, "Sixth", { state: "error", lastActivity: 100 })],
      [ID, S2, S3, S4, S5, S6],
      S2,
    );
    await act(async () => void el.querySelector(`[data-tab-id="${S2}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Clean up tabs")!.click());
    expect(document.querySelector('[data-testid="tab-cleanup-menu"]')!.textContent).toContain("1 kept: unread");
    expect(document.querySelector('[data-testid="tab-cleanup-idle"]')!.textContent).toContain("3");
    // The error tab is followed in the background (not shown), so its unread state is known.
    expect(document.querySelector('[data-testid="tab-cleanup-unused1h"]')!.textContent).toContain("4");
    for (let i = 0; i < 2; i++) await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    // The unread one shows its marker in the strip.
    expect(el.querySelector(`[data-tab-id="${S5}"] [aria-label]`)?.getAttribute("aria-label")).toContain("unread");
    await rule(S2, "archived");
    expect(tabIds()).toEqual([ID, S2, S4, S5, S6]);
    await rule(S2, "workers");
    expect(tabIds()).toEqual([ID, S2, S5, S6]);
    await rule(S2, "unused1h");
    expect(tabIds()).toEqual([S2, S5]);
    // No transcript restore for the closed ones: only the shown tab and the error tab were subscribed.
    const subscribed = sent.filter((m) => m.type === "session.subscribe").map((m) => (m as unknown as { sessionId: string }).sessionId);
    for (const id of [ID, S3, S4, S5]) expect(subscribed).not.toContain(id);
    expect(subscribed).toContain(S6);
  });

  it("auto-close 1 hour after a reload closes read tabs of closed sessions; keeps one with unseen output and one this browser has no record of", async () => {
    const old = Date.now() - 3 * 3_600_000;
    localStorage.setItem("claude-ui.tab-used", JSON.stringify({ [ID]: old, [S2]: old, [S3]: old, [S4]: old, [S5]: old }));
    localStorage.setItem("claude-ui.shown-activity", JSON.stringify({ [ID]: 100, [S3]: 150, [S5]: 100 }));
    localStorage.setItem("claude-ui.tabAutoClose", "1h");
    const closed = { state: "closed" as const, lastActivity: 100 };
    await remount([mk(ID, "First", closed), mk(S2, "Second"), mk(S3, "Third", { ...closed, lastActivity: 200 }), mk(S4, "Fourth", closed), mk(S5, "Fifth", closed)], [ID, S2, S3, S4, S5], S2);
    await act(async () => {});
    expect(tabIds()).toEqual([S2, S3, S4]);
    expect(toast()?.textContent).toContain("Auto-closed 2 idle tabs");
    await act(async () => void el.querySelector(`[data-tab-id="${S2}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Clean up tabs")!.click());
    expect(document.querySelector('[data-testid="tab-cleanup-menu"]')!.textContent).toContain("2 kept: unknown/unread");
  });

  it("showing a tab records its session's list lastActivity, so a closed session read here is closable after the next reload", async () => {
    localStorage.removeItem("claude-ui.shown-activity");
    await remount([mk(ID, "First", { lastActivity: 100 }), mk(S2, "Second", { lastActivity: 300 })], [ID, S2], S2);
    await act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${ID}"] [role="tab"]`)!.click());
    await act(async () => {});
    expect(JSON.parse(localStorage.getItem("claude-ui.shown-activity")!)).toMatchObject({ [ID]: 100, [S2]: 300 });
  });

  it("a tab whose subscribe failed is kept as 'unknown' by every rule", async () => {
    const list = [session, mk(S2, "Second"), mk(S3, "Third")];
    act(() => root.unmount());
    replies["session.list"] = { sessions: list, projects: ["/p/demo"] };
    replies["session.subscribe"] = (m: { sessionId: string }) => {
      if (m.sessionId === S3) throw new Error("boom");
      return { logEpoch: "e1", seq: 0, session: list.find((x) => x.id === m.sessionId) };
    };
    localStorage.setItem("claude-ui.tabs", JSON.stringify([ID, S2, S3]));
    location.hash = `#${S2}`;
    root = createRoot(el);
    await act(async () => root.render(<App />));
    await act(async () => {});
    await rule(S2, "idle");
    expect(tabIds()).toEqual([S2, S3]);
    await act(async () => void el.querySelector(`[data-tab-id="${S2}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Clean up tabs")!.click());
    expect(document.querySelector('[data-testid="tab-cleanup-menu"]')!.textContent).toContain("1 kept: unknown");
  });

  it("page open across a daemon restart: a background tab with output this browser never showed keeps its unread marker and is not closed", async () => {
    localStorage.setItem("claude-ui.shown-activity", JSON.stringify({ [ID]: 100, [S2]: 100 }));
    await remount([mk(ID, "First", { lastActivity: 100 }), mk(S2, "Second", { lastActivity: 100 })], [ID, S2], S2);
    const st = (seq: number, state: string) => ({ type: "event", sessionId: ID, seq, part: { type: "session_state", id: "session_state", state } });
    await act(async () => (emit(st(1, "running")), emit(st(2, "idle"))));
    expect(el.querySelector(`[data-tab-id="${ID}"] [aria-label]`)?.getAttribute("aria-label")).toContain("unread");
    // Daemon restart (new log epoch) while the page stays open: the replay has no attention, the list shows the new output time.
    replies["session.list"] = { sessions: [mk(ID, "First", { lastActivity: 200 }), mk(S2, "Second", { lastActivity: 100 })], projects: ["/p/demo"] };
    replies["session.subscribe"] = (m: { sessionId: string }) => ({ logEpoch: "e2", seq: 0, session: m.sessionId === ID ? mk(ID, "First", { lastActivity: 200 }) : mk(S2, "Second") });
    await act(async () => reconnect());
    await act(async () => {});
    expect(el.querySelector(`[data-tab-id="${ID}"] [aria-label]`)?.getAttribute("aria-label")).toContain("unread");
    await rule(S2, "idle");
    expect(tabIds()).toEqual([ID, S2]);
  });

  it("after a reconnect, every session tab is kept ('loading') until a session.list reply after it arrives; a failed list keeps them", async () => {
    localStorage.setItem("claude-ui.shown-activity", JSON.stringify({ [ID]: 100, [S2]: 100 }));
    await remount([mk(ID, "First", { lastActivity: 100 }), mk(S2, "Second", { lastActivity: 100 })], [ID, S2], S2);
    // Daemon restarted; a turn of ID ended while disconnected. The resubscribe replies first, the list is late.
    let release: (v: unknown) => void = () => {};
    const late = new Promise((r) => (release = r));
    replies["session.list"] = () => late;
    replies["session.subscribe"] = (m: { sessionId: string }) => ({ logEpoch: "e2", seq: 0, session: m.sessionId === ID ? mk(ID, "First", { lastActivity: 200 }) : mk(S2, "Second") });
    await act(async () => reconnect());
    await act(async () => {});
    await rule(S2, "idle");
    expect(tabIds()).toEqual([ID, S2]);
    for (let i = 0; i < 2; i++) await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => release({ sessions: [mk(ID, "First", { lastActivity: 200 }), mk(S2, "Second", { lastActivity: 100 })], projects: ["/p/demo"] }));
    await act(async () => {});
    expect(el.querySelector(`[data-tab-id="${ID}"] [aria-label]`)?.getAttribute("aria-label")).toContain("unread");
    await rule(S2, "idle");
    expect(tabIds()).toEqual([ID, S2]);
    for (let i = 0; i < 2; i++) await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    // Another restart, the list request fails. ID is then shown in a focused page (read by its record): still kept, the list is not fresh.
    await act(async () => void window.dispatchEvent(new Event("focus")));
    replies["session.list"] = () => {
      throw new Error("boom");
    };
    replies["session.subscribe"] = (m: { sessionId: string }) => ({ logEpoch: "e3", seq: 0, session: m.sessionId === ID ? mk(ID, "First", { lastActivity: 200 }) : mk(S2, "Second") });
    await act(async () => reconnect());
    await act(async () => {});
    await act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${ID}"] [role="tab"]`)!.click());
    await act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${S2}"] [role="tab"]`)!.click());
    await rule(S2, "idle");
    expect(tabIds()).toEqual([ID, S2]);
  });

  it("after a daemon restart, a tab with a replayed view and no shown record is kept as 'unknown'; with an older record it closes", async () => {
    localStorage.setItem("claude-ui.shown-activity", JSON.stringify({ [S2]: 100, [S3]: 100 }));
    localStorage.setItem("claude-ui.seen", JSON.stringify({ [ID]: { epoch: "e0", seq: 4 }, [S3]: { epoch: "e0", seq: 4 } }));
    await remount([mk(ID, "First", { lastActivity: 100 }), mk(S2, "Second", { lastActivity: 100 }), mk(S3, "Third", { lastActivity: 100 })], [ID, S2, S3], S2);
    await rule(S2, "idle");
    expect(tabIds()).toEqual([ID, S2]);
    await act(async () => void el.querySelector(`[data-tab-id="${S2}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Clean up tabs")!.click());
    expect(document.querySelector('[data-testid="tab-cleanup-menu"]')!.textContent).toContain("1 kept: unknown");
  });

  it("a tab whose resubscribe is in flight or failed after a reconnect is kept ('loading', then 'unknown'), its old view does not count as read", async () => {
    await remount([session, mk(S2, "Second"), mk(S3, "Third")], [ID, S2, S3], S2);
    let fail: (e: Error) => void = () => {};
    const slow = new Promise((_, r) => (fail = r));
    replies["session.subscribe"] = (m: { sessionId: string }) => (m.sessionId === ID ? slow : { logEpoch: "e2", seq: 0, session: m.sessionId === S2 ? mk(S2, "Second") : mk(S3, "Third") });
    await act(async () => reconnect());
    await act(async () => {});
    await rule(S2, "idle");
    expect(tabIds()).toEqual([ID, S2]);
    await undo();
    await act(async () => fail(new Error("boom")));
    await act(async () => {});
    await rule(S2, "idle");
    expect(tabIds()).toEqual([ID, S2]);
  });

  it("showing a tab while the page is not focused writes no shown record", async () => {
    localStorage.setItem("claude-ui.shown-activity", "{}");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      await remount([mk(ID, "First", { lastActivity: 100 }), mk(S2, "Second", { lastActivity: 300 })], [ID, S2], S2);
      await act(async () => el.querySelector<HTMLElement>(`[data-tab-id="${ID}"] [role="tab"]`)!.click());
      await act(async () => {});
      expect(JSON.parse(localStorage.getItem("claude-ui.shown-activity")!)).toEqual({});
    } finally {
      hasFocus.mockRestore();
    }
  });

  it("claude-ui.shown-activity keeps only open tabs and the closed-tab stack", async () => {
    localStorage.setItem("claude-ui.shown-activity", JSON.stringify({ [ID]: 1, [S2]: 1, [S3]: 1, [S4]: 1 }));
    localStorage.setItem("claude-ui.closed-tabs", JSON.stringify([{ id: S3, at: 1 }]));
    await remount([session, mk(S2, "Second")], [ID, S2], S2);
    expect(Object.keys(JSON.parse(localStorage.getItem("claude-ui.shown-activity")!)).sort()).toEqual([ID, S2, S3].sort());
  });

  it("a cleanup right after Undo (toast still leaving) does not join the undone toast", async () => {
    await remount([session, mk(S2, "Second"), mk(S3, "Third", { archived: true }), mk(S4, "Fourth", { coordinatorId: ID })], [ID, S2, S3, S4], S2);
    await rule(S2, "archived");
    await undo();
    await rule(S2, "workers");
    expect(tabIds()).toEqual([ID, S2, S3]);
    expect(toast()?.textContent).toContain("Closed Fourth");
  });

  it("auto-close off (default) closes nothing", async () => {
    const old = Date.now() - 30 * 3_600_000;
    localStorage.setItem("claude-ui.tab-used", JSON.stringify({ [ID]: old, [S2]: old, [S3]: old }));
    await remount([session, mk(S2, "Second"), mk(S3, "Third")], [ID, S2, S3], S2);
    await act(async () => {});
    expect(tabIds()).toEqual([ID, S2, S3]);
  });
});

describe("GH-394: the file dialog", () => {
  // jsdom has no layout: CodeMirror measures through Range rects when it scrolls to a line.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  const lines = Array.from({ length: 60 }, (_, i) => `l${i + 1}`).join("\n");
  const call = (id: string, tool: string, input: unknown) => ({ type: "tool_call", id, toolUseId: id, tool, input, status: "done" });
  const fileDialog = () => document.querySelector("[data-testid=file-dialog]");
  const popup = () => document.querySelector("[data-testid=viewer-dialog]");
  const cursorLine = async () => {
    const v = (await import("@codemirror/view")).EditorView.findFromDOM(document.querySelector<HTMLElement>("[data-testid=file-dialog] .cm-editor")!)!;
    return v.state.doc.lineAt(v.state.selection.main.head).number;
  };
  beforeEach(() => void (replies["fs.read"] = { content: lines, mtime: 1 }));
  afterEach(() => void (replies["fs.read"] = { content: "x", mtime: 1 }));

  it("a Read card's open button opens the file dialog at the read's offset, not the popup viewer", async () => {
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: call("r1", "Read", { file_path: "/p/demo/a.ts", offset: 40 }) }));
    const open = el.querySelector<HTMLElement>("[data-testid=viewer-open]")!;
    expect(open.getAttribute("aria-label")).toBe("Open a.ts in file dialog");
    await act(async () => open.click());
    await act(async () => {});
    expect(fileDialog()).not.toBeNull();
    expect(popup()).toBeNull();
    expect(await cursorLine()).toBe(40);
  });

  it("a file reference in assistant text opens the file dialog with the cursor on its line", async () => {
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: { type: "assistant_text", id: "a1", text: "See `/p/demo/a.ts:12` now.", streaming: false } }));
    const ref = el.querySelector<HTMLElement>("button[title='Open in file dialog']")!;
    await act(async () => ref.click());
    await act(async () => {});
    expect(fileDialog()).not.toBeNull();
    expect(await cursorLine()).toBe(12);
  });

  it("git.repos gets the open editor tab paths as openFiles", async () => {
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: call("r1", "Read", { file_path: "/p/demo/a.ts" }) }));
    await act(async () => el.querySelector<HTMLElement>("[data-testid=viewer-open]")!.click());
    await act(async () => {});
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(reposOf().at(-1)!.openFiles).toEqual(["/p/demo/a.ts"]);
  });

  it("an Edit card still opens the diff popup, not the file dialog", async () => {
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: call("e1", "Edit", { file_path: "/p/demo/a.ts", old_string: "a", new_string: "b" }) }));
    await act(async () => el.querySelector<HTMLElement>("[data-testid=viewer-open]")!.click());
    await act(async () => {});
    expect(popup()).not.toBeNull();
    expect(fileDialog()).toBeNull();
  });

  it("the file dialog closes when another tab shows", async () => {
    await act(async () => emit({ type: "event", sessionId: ID, seq: 1, part: call("r1", "Read", { file_path: "/p/demo/a.ts" }) }));
    await act(async () => el.querySelector<HTMLElement>("[data-testid=viewer-open]")!.click());
    await act(async () => {});
    expect(fileDialog()).not.toBeNull();
    await act(async () => void (location.hash = "#new"));
    await act(async () => {});
    await vi.waitFor(() => expect(fileDialog()).toBeNull());
  });
});

describe("GH-381: remembered dock tabs", () => {
  const tabsKey = () => JSON.parse(localStorage.getItem("claude-ui.paneTabs") ?? "null") as Record<string, string> | null;
  const selected = (area: string, p: string) => paneTab(area, p)?.getAttribute("aria-selected");

  it("the selected side and bottom tabs reopen after a reload", async () => {
    await clickId("terminal-toggle");
    await clickId("pane-files");
    await moveFromMenu("side");
    await act(async () => paneTab("bottom-panel", "terminal")!.click());
    await act(async () => paneTab("side-panel", "changes")!.click());
    expect(tabsKey()).toMatchObject({ side: "changes", bottom: "terminal" });
    await rerender();
    expect(selected("side-panel", "changes")).toBe("true");
    expect(selected("bottom-panel", "terminal")).toBe("true");
  });

  it("a remembered tab the area no longer holds falls back to the area's default", async () => {
    localStorage.setItem("claude-ui.paneTabs", JSON.stringify({ side: "terminal", bottom: "zzz" }));
    await rerender();
    expect(selected("side-panel", "files")).toBe("true");
    localStorage.setItem("claude-ui.paneTabs", JSON.stringify({ side: "graph" }));
    await rerender();
    expect(selected("side-panel", "files")).toBe("true");
  });

  it("Reset layout forgets the remembered side and bottom tabs", async () => {
    await act(async () => paneTab("side-panel", "changes")!.click());
    expect(tabsKey()?.side).toBe("changes");
    await clickId("dock-menu-side");
    await act(async () => menuItem("dock-reset").click());
    expect(localStorage.getItem("claude-ui.paneTabs")).toBeNull();
    await rerender();
    expect(selected("side-panel", "files")).toBe("true");
  });

  it("narrow: the pane switcher reopens on the last selected pane", async () => {
    width = 390;
    await rerender();
    await clickId("pane-files");
    await rerender();
    expect(q("pane-files")!.getAttribute("aria-selected")).toBe("true");
    expect(q("pane-session")!.getAttribute("aria-selected")).toBe("false");
    await clickId("pane-session");
    await rerender();
    expect(q("pane-session")!.getAttribute("aria-selected")).toBe("true");
    width = 1440;
  });

  it("a terminal restored as the remembered pane does not take the focus (narrow, and in the side panel)", async () => {
    const g = globalThis as { __termFocused?: number };
    width = 390;
    localStorage.setItem("claude-ui.paneTabs", JSON.stringify({ narrow: "terminal", bottom: "terminal" }));
    const before = g.__termFocused ?? 0;
    await rerender();
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(q("pane-terminal")!.getAttribute("aria-selected")).toBe("true");
    expect(q("terminal-panel")).not.toBeNull();
    expect(g.__termFocused ?? 0).toBe(before);
    width = 1440;
    localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "terminal"], bottom: [] } }));
    localStorage.setItem("claude-ui.paneTabs", JSON.stringify({ side: "terminal" }));
    await rerender();
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(selected("side-panel", "terminal")).toBe("true");
    expect(g.__termFocused ?? 0).toBe(before);
  });

  it("a bottom terminal shown by the page load does not take the focus; a Terminal tab click then does", async () => {
    const g = globalThis as { __termFocused?: number };
    localStorage.setItem("claude-ui.terminalOpen", "1");
    localStorage.setItem("claude-ui.paneTabs", JSON.stringify({ side: "changes" }));
    const before = g.__termFocused ?? 0;
    await rerender();
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(q("bottom-panel")!.contains(q("terminal-panel"))).toBe(true);
    expect(g.__termFocused ?? 0).toBe(before);
    // Also after the user's first key: the latch ends on an explicit request, not on input.
    await press({ key: "a" });
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(g.__termFocused ?? 0).toBe(before);
    await act(async () => paneTab("bottom-panel", "terminal")!.click());
    await vi.waitFor(() => expect(g.__termFocused ?? 0).toBeGreaterThan(before));
  });

  it("another browser tab's pick (storage event) changes nothing shown here and focuses nothing", async () => {
    const g = globalThis as { __termFocused?: number };
    localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "terminal"], bottom: [] } }));
    await rerender();
    expect(selected("side-panel", "files")).toBe("true");
    const before = g.__termFocused ?? 0;
    localStorage.setItem("claude-ui.paneTabs", JSON.stringify({ side: "terminal", narrow: "terminal" }));
    await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: "claude-ui.paneTabs" })));
    await act(async () => new Promise((r) => setTimeout(r, 200)));
    expect(selected("side-panel", "files")).toBe("true");
    expect(q("terminal-panel")).toBeNull();
    expect(g.__termFocused ?? 0).toBe(before);
  });

  it("narrow: the restore waits for the first session tab (a New session tab at load does not use it up)", async () => {
    width = 390;
    localStorage.setItem("claude-ui.paneTabs", JSON.stringify({ narrow: "files" }));
    location.hash = "#new";
    await rerender();
    await act(async () => {
      location.hash = `#${ID}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await act(async () => {});
    expect(q("pane-files")!.getAttribute("aria-selected")).toBe("true");
    width = 1440;
  });
});

// GH-430: the new-session tab shows the side and bottom panel of its project (wide screens), so nothing jumps when the first prompt is sent.
describe("GH-430: panels on the new-session tab", () => {
  const OTHER_ID = "99999999-2222-3333-4444-555555555555";
  const other: SessionListItem = { ...session, id: OTHER_ID, cwd: "/p/other", title: "Other" };
  const NEW_ID = "aaaaaaaa-2222-3333-4444-555555555555";
  const created: SessionListItem = { ...session, id: NEW_ID, title: "New session", transcript: false };
  const TWO = { sessions: [session, other], projects: ["/p/demo", "/p/other"] };
  /** An element is out of sight when it or an ancestor is `hidden` (not `hidden lg:flex`) or `lg:hidden`. */
  const hiddenBy = (n: Element | null) => {
    for (let e: Element | null = n; e; e = e.parentElement) {
      const c = (e.getAttribute("class") ?? "").split(/\s+/);
      if ((c.includes("hidden") && !c.includes("lg:flex")) || c.includes("lg:hidden")) return true;
    }
    return false;
  };
  const panelShown = (id: string) => !!q(id) && !hiddenBy(q(id));
  const callsSince = (n: number, type: string) => sent.slice(n).filter((m) => m.type === type) as Record<string, unknown>[];
  const sendFirst = async (text: string) => {
    const box = newPrompt() as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
  };
  const hashTo = async (id: string) => {
    await act(async () => {
      location.hash = `#${id}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await act(async () => new Promise((r) => setTimeout(r, 50)));
  };
  const bySession = (m: { sessionId: string }) => ({ logEpoch: "e1", session: [session, other, created].find((x) => x.id === m.sessionId) ?? session });

  it("AC1: the new-session tab shows the side panel and the remembered bottom terminal; after the first prompt the same panels and panes stay", async () => {
    localStorage.setItem("claude-ui.terminalOpen", "1");
    const restore = await remount({
      "session.list": () => ({ sessions: sent.some((m) => m.type === "session.create") ? [session, created] : [session], projects: ["/p/demo"] }),
      "session.subscribe": bySession,
      "session.create": { session: created },
      "session.prompt": {},
    });
    try {
      await openNewTab();
      expect(panelShown("side-panel")).toBe(true);
      expect(panelShown("bottom-panel")).toBe(true);
      expect(q("bottom-panel")!.querySelector('[data-testid="pane-terminal"]')!.getAttribute("aria-selected")).toBe("true");
      await pickSide(/changes/i);
      const side = q("side-panel")!;
      const term = q("terminal-panel")!;
      expect(term).not.toBeNull();
      expect(sideTab()).toMatch(/changes/i);
      await sendFirst("hello");
      expect(location.hash).toBe(`#${NEW_ID}`);
      expect(q("side-panel")).toBe(side);
      expect(q("terminal-panel")).toBe(term);
      expect(panelShown("bottom-panel")).toBe(true);
      expect(q("bottom-panel")!.querySelector('[data-testid="pane-terminal"]')!.getAttribute("aria-selected")).toBe("true");
      expect(sideTab()).toMatch(/changes/i);
    } finally {
      restore();
    }
  });

  it("AC2: on the new-session tab Files, Graph and Terminal ask with the draft project's cwd", async () => {
    const restore = await remount({
      "session.list": { ...TWO, worktrees: { "/p/other": [{ path: "/p/other", branch: "main", main: true }] } },
      "terminal.list": (m: { cwd: string }) => ({ terminals: m.cwd === "/p/other" ? [{ id: "t9", title: "Terminal 1" }] : [] }),
      "git.status": { status: { branch: "main", added: 0, removed: 0, refs: "s1" } },
      "git.log": { log: { commits: [], more: false, branches: ["refs/heads/main"], refs: "s1", head: "refs/heads/main" } },
      "git.refs": { refs: "s1" },
    });
    try {
      await openNewTab();
      const n = sent.length;
      await pickOption('[data-testid="new-session-tab"] [data-testid="project-chip"]', "Oother/p/other");
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(callsSince(n, "terminal.list")).toContainEqual({ type: "terminal.list", cwd: "/p/other" });
      expect(callsSince(n, "fs.list")).toContainEqual({ type: "fs.list", path: "/p/other" });
      // The terminal of that folder shows (it has a shell); the Graph tab is there (a git work tree) and asks for the draft's log.
      expect(panelShown("side-panel")).toBe(true);
      expect(q("terminal-panel")).toBeNull();
      await pickSide(/graph/i);
      await vi.waitFor(() => expect(callsSince(n, "git.log").some((m) => m.cwd === "/p/other")).toBe(true));
      expect(callsSince(n, "git.log").every((m) => m.cwd === "/p/other")).toBe(true);
    } finally {
      restore();
    }
  });

  it("AC3: Changes on the new-session tab shows the empty state; Uncommitted asks git.diff for the draft cwd", async () => {
    await openNewTab();
    await pickSide(/changes/i);
    expect(q("changes-empty")!.textContent).toBe("No changes yet. Claude's edits appear here.");
    // The session's own Changes keeps its message.
    await act(async () => void (location.hash = `#${ID}`));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(q("changes-empty")!.textContent).toBe("No changes in this session yet.");
    saveDiffMode("uncommitted");
    const restore = await remount({ "git.status": { status: { branch: "main", added: 0, removed: 0, refs: "s1" } }, "git.diff": { diff: { prefix: "", base: "b", files: [] } } });
    try {
      await openNewTab();
      await pickSide(/changes/i);
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(sent.filter((m) => m.type === "git.diff")).toContainEqual({ type: "git.diff", cwd: "/p/demo", base: "head" });
    } finally {
      restore();
    }
  });

  it("AC4: switching the draft's project chip moves the panels to the new project", async () => {
    const restore = await remount({ "session.list": TWO });
    try {
      await openNewTab();
      const chip = '[data-testid="new-session-tab"] [data-testid="project-chip"]';
      const n = sent.length;
      await pickOption(chip, "Oother/p/other");
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(callsSince(n, "fs.list")).toContainEqual({ type: "fs.list", path: "/p/other" });
      const m = sent.length;
      await pickOption(chip, "Ddemo/p/demo");
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(callsSince(m, "fs.list")).toContainEqual({ type: "fs.list", path: "/p/demo" });
      expect(callsSince(m, "terminal.list").every((c) => c.cwd === "/p/demo")).toBe(true);
    } finally {
      restore();
    }
  });

  it("AC5: on the new-session tab the titlebar side panel and terminal toggles show and work; the palette lists Toggle terminal and Toggle side panel; Ctrl+` toggles the terminal", async () => {
    await openNewTab();
    expect(q("panel-toggle")).not.toBeNull();
    expect(q("terminal-toggle-titlebar")).not.toBeNull();
    await clickId("terminal-toggle-titlebar");
    expect(q("terminal-toggle-titlebar")!.getAttribute("aria-pressed")).toBe("true");
    expect(panelShown("bottom-panel")).toBe(true);
    expect(q("terminal-panel")).not.toBeNull();
    await clickId("terminal-toggle-titlebar");
    expect(q("bottom-panel")).toBeNull();
    await press({ key: "`", code: "Backquote", ctrlKey: true });
    expect(panelShown("bottom-panel")).toBe(true);
    await press({ key: "`", code: "Backquote", ctrlKey: true });
    expect(q("bottom-panel")).toBeNull();
    expect(q("panel-toggle")!.getAttribute("aria-expanded")).toBe("true");
    await clickId("panel-toggle");
    expect(q("panel-toggle")!.getAttribute("aria-expanded")).toBe("false");
    await clickId("panel-toggle");
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(paletteRow("Toggle side panel")).toBeDefined();
    expect(paletteRow("Toggle terminal")).toBeDefined();
    expect(paletteRow("View changes in popup")).toBeUndefined();
  });

  it("AC6: a new-session tab in another project shows the draft's project, not the last shown session's", async () => {
    const restore = await remount({ "session.list": TWO });
    try {
      const n = sent.length;
      await act(async () => el.querySelector<HTMLElement>('[data-cwd="/p/other"] [data-testid="project-new-session"]')!.click());
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(el.querySelector('[data-testid="new-session-tab"] [data-testid="project-chip"]')!.getAttribute("title")).toBe("/p/other");
      expect(callsSince(n, "fs.list")).toContainEqual({ type: "fs.list", path: "/p/other" });
      expect(callsSince(n, "terminal.list").at(-1)).toEqual({ type: "terminal.list", cwd: "/p/other" });
    } finally {
      restore();
    }
  });

  it("AC7: below 1024px the new-session tab shows no side or bottom panel and no titlebar toggles", async () => {
    width = 390;
    localStorage.setItem("claude-ui.terminalOpen", "1");
    await rerender();
    await openNewTab();
    expect(q("panel-toggle")).toBeNull();
    expect(q("terminal-toggle-titlebar")).toBeNull();
    expect(q("bottom-panel")).toBeNull();
    expect(panelShown("side-panel")).toBe(false);
    width = 1440;
  });

  it("AC8: the titlebar terminal toggle uses the terminal icon and the quiet pressed style", async () => {
    const b = q("terminal-toggle-titlebar")!;
    expect(b.querySelector("svg.lucide-square-terminal")).not.toBeNull();
    expect(b.className).toContain("aria-pressed:bg-transparent");
  });

  /** terminal.list / terminal.create over a list of shells per folder, like the daemon. */
  const shellsFor = (initial: Record<string, number> = {}) => {
    const shells: Record<string, { id: string; title: string }[]> = {};
    for (const [cwd, n] of Object.entries(initial)) shells[cwd] = Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, title: `Terminal ${i + 1}` }));
    return {
      "terminal.list": (m: { cwd: string }) => ({ terminals: [...(shells[m.cwd] ??= [])] }),
      "terminal.create": (m: { cwd: string }) => {
        const l = (shells[m.cwd] ??= []);
        const t = { id: `n${l.length + 1}`, title: `Terminal ${l.length + 1}` };
        l.push(t);
        return { terminal: t };
      },
      reset: () => Object.keys(shells).forEach((k) => delete shells[k]),
    };
  };
  const creates = () => sent.filter((m) => m.type === "terminal.create");

  it("AC9: a remembered-open bottom terminal stays hidden after a reload when the folder has no shells; no terminal.create", async () => {
    localStorage.setItem("claude-ui.terminalOpen", "1");
    const { reset: _r, ...rest } = shellsFor();
    const restore = await remount(rest);
    sent.length = 0;
    try {
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(q("bottom-panel")).toBeNull();
      expect(q("terminal-panel")).toBeNull();
      expect(creates()).toEqual([]);
      // The preference is kept: the folder gets shells and the terminal shows again.
      expect(localStorage.getItem("claude-ui.terminalOpen")).toBe("1");
    } finally {
      restore();
    }
  });

  it("AC9: with the terminal in the side panel and no shells the side panel shows another pane; its Terminal tab click spawns a shell", async () => {
    localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "terminal"], bottom: [] } }));
    const { reset: _r, ...rest } = shellsFor();
    const restore = await remount(rest);
    sent.length = 0;
    try {
      expect(panelShown("side-panel")).toBe(true);
      expect(paneTab("side-panel", "terminal")).not.toBeNull();
      expect(paneTab("side-panel", "terminal")!.getAttribute("aria-selected")).toBe("false");
      expect(q("terminal-panel")).toBeNull();
      expect(creates()).toEqual([]);
      await act(async () => paneTab("side-panel", "terminal")!.click());
      await act(async () => new Promise((r) => setTimeout(r, 100)));
      expect(paneTab("side-panel", "terminal")!.getAttribute("aria-selected")).toBe("true");
      expect(q("terminal-panel")).not.toBeNull();
      expect(creates()).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("AC9: Toggle terminal, Ctrl+` and New terminal on a folder without shells open the terminal and send one terminal.create", async () => {
    const { reset, ...rest } = shellsFor();
    const restore = await remount(rest);
    sent.length = 0;
    try {
      await clickId("terminal-toggle-titlebar");
      await act(async () => new Promise((r) => setTimeout(r, 100)));
      expect(q("terminal-panel")).not.toBeNull();
      expect(creates()).toHaveLength(1);
      // Hidden and shown again with a shell running: no second shell.
      await clickId("terminal-toggle-titlebar");
      await clickId("terminal-toggle-titlebar");
      await act(async () => new Promise((r) => setTimeout(r, 100)));
      expect(creates()).toHaveLength(1);

      for (const open of [
        () => press({ key: "`", code: "Backquote", ctrlKey: true }),
        async () => {
          await press({ key: "k", code: "KeyK", ctrlKey: true });
          await act(async () => paletteRow("New terminal")!.click());
        },
      ]) {
        reset();
        sent.length = 0;
        await rerender();
        await act(async () => new Promise((r) => setTimeout(r, 50)));
        expect(q("terminal-panel")).toBeNull();
        await open();
        await act(async () => new Promise((r) => setTimeout(r, 100)));
        expect(q("terminal-panel")).not.toBeNull();
        expect(creates()).toHaveLength(1);
      }
    } finally {
      restore();
    }
  }, 20000);

  it("AC9: switching to a session of a project without shells hides the bottom terminal; back to a project with shells shows it", async () => {
    localStorage.setItem("claude-ui.terminalOpen", "1");
    const { reset: _r, ...rest } = shellsFor({ "/p/demo": 1 });
    const restore = await remount({ ...rest, "session.list": TWO, "session.subscribe": bySession });
    sent.length = 0;
    try {
      expect(panelShown("bottom-panel")).toBe(true);
      await hashTo(OTHER_ID);
      expect(q("bottom-panel")).toBeNull();
      await hashTo(ID);
      expect(panelShown("bottom-panel")).toBe(true);
      expect(creates()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("AC9: moving the Terminal pane on purpose with no shells shows its empty tab bar, no terminal.create", async () => {
    localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "terminal"], bottom: [] } }));
    const { reset: _r, ...rest } = shellsFor();
    const restore = await remount(rest);
    sent.length = 0;
    try {
      expect(q("bottom-panel")).toBeNull();
      const tab = paneTab("side-panel", "terminal")!;
      await act(async () => void tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
      await act(async () => menuItem("pane-move").click());
      await act(async () => new Promise((r) => setTimeout(r, 100)));
      expect(panelShown("bottom-panel")).toBe(true);
      expect(q("bottom-panel")!.querySelector('[data-testid="terminal-new"]')).not.toBeNull();
      expect(q("bottom-panel")!.querySelectorAll('[data-testid="terminal-tab"]')).toHaveLength(0);
      expect(creates()).toEqual([]);
    } finally {
      restore();
    }
  });

  // Review round 1: a remembered terminal never collapses, steals the focus or starts a shell when switching sessions or reloading.
  describe("review round 1", () => {
    const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
    const focusedN = () => (globalThis as { __termFocused?: number }).__termFocused ?? 0;
    const T1 = { id: "t1", title: "Terminal 1" };
    /** terminal.list per folder from `shells` (mutable); `gate` holds every reply back until released. */
    const lists = (shells: Record<string, { id: string; title: string }[]>) => {
      const gate: { p?: Promise<void>; release: () => void } = { release: () => {} };
      return {
        gate,
        hold: () => (gate.p = new Promise<void>((r) => (gate.release = () => (gate.p = undefined, r())))),
        replies: {
          "terminal.list": async (m: { cwd: string }) => (gate.p && (await gate.p), { terminals: [...(shells[m.cwd] ?? [])] }),
          "terminal.create": (m: { cwd: string }) => {
            const t = { id: `n${(shells[m.cwd] ??= []).length + 1}`, title: "Terminal" };
            shells[m.cwd]!.push(t);
            return { terminal: t };
          },
        },
      };
    };
    const hash = async (id: string) => {
      await act(async () => {
        location.hash = `#${id}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
    };
    const both = { sessions: [session, other], projects: ["/p/demo", "/p/other"] };
    const bySess = (m: { sessionId: string }) => ({ logEpoch: "e1", session: m.sessionId === OTHER_ID ? other : session });

    it("a session switch to a project whose shells are not listed yet keeps the bottom panel mounted and the focus off the shell", async () => {
      localStorage.setItem("claude-ui.terminalOpen", "1");
      const l = lists({ "/p/demo": [T1], "/p/other": [T1] });
      const restore = await remount({ ...l.replies, "session.list": both, "session.subscribe": bySess });
      try {
        await wait(100);
        const panel = q("bottom-panel");
        expect(panel).not.toBeNull();
        const before = focusedN();
        l.hold();
        await hash(OTHER_ID);
        await wait(30);
        expect(q("bottom-panel")).toBe(panel);
        l.gate.release();
        await wait(300);
        expect(q("bottom-panel")).toBe(panel);
        expect(focusedN()).toBe(before);
      } finally {
        restore();
      }
    });

    it("a reload with a remembered terminal: input before terminal.list answers, then the shell shows without the focus", async () => {
      localStorage.setItem("claude-ui.terminalOpen", "1");
      const l = lists({ "/p/demo": [T1] });
      l.hold();
      const before = focusedN();
      const restore = await remount({ ...l.replies });
      try {
        await wait(50);
        expect(q("bottom-panel")).toBeNull();
        await act(async () => void window.dispatchEvent(new PointerEvent("pointerdown")));
        await press({ key: "a" });
        l.gate.release();
        await wait(300);
        expect(q("bottom-panel")).not.toBeNull();
        expect(focusedN()).toBe(before);
      } finally {
        restore();
      }
    });

    it("New session while the bottom panel is maximized shows the draft", async () => {
      localStorage.setItem("claude-ui.terminalOpen", "1");
      await rerender();
      await wait(100);
      await clickId("dock-maximize");
      expect(el.querySelector("main")!.className.split(/\s+/)).toContain("hidden");
      await act(async () => el.querySelector<HTMLElement>('[data-testid="project-new-session"]')!.click());
      await wait(100);
      expect(el.querySelector("main")!.className.split(/\s+/)).not.toContain("hidden");
    });

    it("Ctrl+` twice before the list answers leaves no pending spawn: reopening the side panel starts no shell", async () => {
      localStorage.setItem("claude-ui.layout", JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "terminal"], bottom: [] } }));
      const l = lists({});
      l.hold();
      const restore = await remount({ ...l.replies });
      sent.length = 0;
      try {
        await press({ key: "`", code: "Backquote", ctrlKey: true });
        await wait(50);
        await press({ key: "`", code: "Backquote", ctrlKey: true });
        l.gate.release();
        await wait(200);
        await clickId("panel-toggle");
        await wait(200);
        expect(sent.filter((m) => m.type === "terminal.create")).toEqual([]);
      } finally {
        restore();
      }
    });

    it("shells that ended while another folder showed: coming back hides the terminal instead of an empty tab bar", async () => {
      const shells: Record<string, { id: string; title: string }[]> = { "/p/demo": [T1], "/p/other": [] };
      const l = lists(shells);
      const restore = await remount({ ...l.replies, "session.list": both, "session.subscribe": bySess });
      try {
        await clickId("terminal-toggle");
        await wait(100);
        expect(q("bottom-panel")).not.toBeNull();
        await hash(OTHER_ID);
        await wait(100);
        expect(q("bottom-panel")).toBeNull();
        shells["/p/demo"] = [];
        await hash(ID);
        await wait(200);
        expect(q("bottom-panel")).toBeNull();
      } finally {
        restore();
      }
    });

    it("the draft's project chip and a reconnect start no shell", async () => {
      localStorage.setItem("claude-ui.terminalOpen", "1");
      const l = lists({});
      const restore = await remount({ ...l.replies, "session.list": both });
      sent.length = 0;
      try {
        await openNewTab();
        await pickOption('[data-testid="new-session-tab"] [data-testid="project-chip"]', "Oother/p/other");
        await wait(100);
        await act(async () => setStatus("reconnecting"));
        await act(async () => setStatus("connected"));
        await wait(100);
        expect(sent.filter((m) => m.type === "terminal.create")).toEqual([]);
      } finally {
        restore();
      }
    });
  });
});

describe("GH-395 Plan pane", () => {
  const OTHER = "99999999-8888-7777-6666-555555555555";
  const other: SessionListItem = { ...session, id: OTHER, cwd: "/p/demo", title: "Other" };
  const two = { sessions: [session, other], projects: ["/p/demo"] };
  const bySess = (m: { sessionId: string }) => ({ logEpoch: "e1", session: m.sessionId === OTHER ? other : session });
  const hashTo = async (id: string) => {
    await act(async () => {
      location.hash = `#${id}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  };
  const planPart = (id = "plan1", plan = "# Plan\n\n1. do **it**") => ({ type: "tool_call", id, toolUseId: id, tool: "ExitPlanMode", input: { plan }, status: "done" });
  const permPart = { type: "permission_request", id: "perm1", requestId: "r1", toolUseId: "plan1", tool: "ExitPlanMode", input: { plan: "# Plan" }, suggestions: [], settled: false };
  const sendPart = (sessionId: string, seq: number, part: unknown) => act(async () => emit({ type: "event", sessionId, seq, part }));
  const sideTabs = () => [...el.querySelectorAll<HTMLElement>('[data-testid="side-panel"] [data-testid^="pane-"]')].map((b) => b.getAttribute("data-testid"));

  it("the Plan tab appears in the side panel only while the current session has a plan, after Files", async () => {
    const restore = await remount({ "session.list": two, "session.subscribe": bySess });
    try {
      expect(sideTabs()).not.toContain("pane-plan");
      await sendPart(ID, 1, planPart());
      const tabs = sideTabs();
      expect(tabs).toContain("pane-plan");
      expect(tabs.indexOf("pane-plan")).toBeGreaterThan(tabs.indexOf("pane-files"));
      await hashTo(OTHER);
      expect(sideTabs()).not.toContain("pane-plan");
      await hashTo(ID);
      expect(sideTabs()).toContain("pane-plan");
    } finally {
      restore();
    }
  });

  it("the Plan tab appears for a plan only in the snapshot aux", async () => {
    const withAux = { logEpoch: "e1", session, seq: 1, snapshot: { heads: [], attentionSeq: 0, page: { parts: [] }, aux: [{ part: planPart("old", "# Old call"), pos: 1 }] } };
    const restore = await remount({ "session.subscribe": withAux });
    try {
      expect(sideTabs()).toContain("pane-plan");
      await pickSide(/plan/i);
      expect(q("plan-pane")!.textContent).toContain("Old call");
    } finally {
      restore();
    }
  });

  it("the Plan tab shows the plan the model wrote to its plan file when ExitPlanMode has an empty input (Claude Code 2.1.294)", async () => {
    await sendPart(ID, 1, { type: "tool_call", id: "w", toolUseId: "w", tool: "Write", input: { file_path: "/home/user/.claude/plans/p.md", content: "# Plan from the file" }, status: "done" });
    expect(sideTabs()).not.toContain("pane-plan");
    await sendPart(ID, 2, planPart("exit", ""));
    await sendPart(ID, 3, { ...planPart("exit", ""), input: {} });
    expect(sideTabs()).toContain("pane-plan");
    await pickSide(/plan/i);
    expect(q("plan-pane")!.textContent).toContain("Plan from the file");
  });

  it("Go to request in the Plan pane focuses the plan permission panel of the session", async () => {
    await sendPart(ID, 1, planPart());
    await sendPart(ID, 2, permPart);
    await pickSide(/plan/i);
    expect(q("plan-waiting")!.textContent).toContain("Waiting for your answer");
    // jsdom has no layout: every element counts as visible.
    const spy = vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as never);
    try {
      await clickId("plan-go-to-request");
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(q("permission-panel")!.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(q("plan-open"));
    } finally {
      spy.mockRestore();
    }
  });

  it("Open in tab on the ExitPlanMode card reveals the dock Plan tab", async () => {
    await sendPart(ID, 1, planPart());
    await pickSide(/changes/i);
    await clickId("plan-open-tab");
    expect(sideTab()).toMatch(/plan/i);
  });

  it("narrow: the pane switcher lists Plan while a plan exists and selecting it shows the plan", async () => {
    width = 800;
    await sendPart(ID, 1, planPart());
    expect(q("pane-plan")).not.toBeNull();
    await clickId("pane-plan");
    expect(q("plan-pane")!.textContent).toContain("Plan");
    expect(q("pane-plan")!.getAttribute("aria-selected")).toBe("true");
  });

  // --- the Plan tab in the main area ---
  const REF = `plan:${ID}`;
  const REF2 = `plan:${OTHER}`;
  const MAIN = JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph"], bottom: ["terminal"], main: ["plan"] } });
  const subs = (id: string) => sent.filter((m) => m.type === "session.subscribe" && (m as unknown as { sessionId: string }).sessionId === id) as unknown as { sessionId: string; background?: boolean }[];
  const unsubs = (id: string) => sent.filter((m) => m.type === "session.unsubscribe" && (m as unknown as { sessionId: string }).sessionId === id);
  const tabIds = () => [...el.querySelectorAll<HTMLElement>('[data-testid="tab"]')].map((t) => t.dataset.tabId);
  const stripTab = (id: string) => el.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
  const ctxMenu = (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  const menuItem = (id: string) => document.querySelector<HTMLElement>(`[data-testid="tab-menu-${id}"]`)!;
  const toastEl = () => el.querySelector<HTMLElement>('[data-testid="toast"]');
  const undoToast = () => act(async () => [...toastEl()!.querySelectorAll("button")].find((b) => b.textContent === "Undo")!.click());
  const layoutNow = () => JSON.parse(localStorage.getItem("claude-ui.layout") ?? "null") as { areas: { side: string[]; main: string[] } } | null;
  const bodyOf = (ref: string) => el.querySelector<HTMLElement>(`[data-pane-tab-body="${ref}"]`);
  /** Mounts with the stored layout, tabs and hash, and both sessions (the plan of `ID` and `OTHER` come as events). */
  async function mountMain(opts: { tabs: string[]; hash?: string; layout?: string; pinned?: string[]; list?: typeof two; extra?: Record<string, unknown> }) {
    localStorage.setItem("claude-ui.layout", opts.layout ?? MAIN);
    localStorage.setItem("claude-ui.tabs", JSON.stringify(opts.tabs));
    if (opts.pinned) localStorage.setItem("claude-ui.pinned-tabs", JSON.stringify(opts.pinned));
    location.hash = opts.hash ?? `#${encodeURIComponent(opts.tabs[0]!)}`;
    sent.length = 0;
    return remount({ "session.list": opts.list ?? two, "session.subscribe": bySess, ...opts.extra });
  }
  const visible = () => vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as never);

  it("Move to main area from the Plan tab menu opens \"Plan · <title>\" right of its session tab, focused; Open in tab again focuses the same tab", async () => {
    const restore = await mountMain({ tabs: [ID, OTHER], layout: JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "plan"], bottom: ["terminal"], main: [] } }) });
    const spy = visible();
    try {
      await sendPart(ID, 1, planPart());
      await act(async () => void el.querySelector('[data-pane-tab="plan"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 })));
      await act(async () => document.querySelector<HTMLElement>('[data-testid="pane-move-main"]')!.click());
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(tabIds()).toEqual([ID, REF, OTHER]);
      expect(stripTab(REF).textContent).toContain("Plan · Demo");
      expect(location.hash).toBe(`#plan%3A${ID}`);
      expect(document.activeElement).toBe(stripTab(REF).querySelector('[role="tab"]'));
      expect(layoutNow()!.areas.main).toEqual(["plan"]);
      expect(sideTabs()).not.toContain("pane-plan");
      // The plan card's Open in tab: the same tab, no second one.
      await clickId("plan-open-tab");
      expect(tabIds().filter((t) => t === REF)).toHaveLength(1);
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("Open in tab on the ExitPlanMode card with home main opens the plan tab", async () => {
    const restore = await mountMain({ tabs: [ID, OTHER] });
    try {
      await sendPart(ID, 1, planPart());
      expect(sideTabs()).not.toContain("pane-plan");
      await clickId("plan-open-tab");
      expect(tabIds()).toEqual([ID, REF, OTHER]);
      expect(bodyOf(REF)!.textContent).toContain("do it");
    } finally {
      restore();
    }
  });

  it("Activating a plan tab makes its session current: the side panel shows that session's changes; the split is suspended", async () => {
    localStorage.setItem("claude-ui.split", JSON.stringify({ dir: "row", ids: [ID, OTHER], at: 1, ratio: 0.5 }));
    const restore = await mountMain({ tabs: [ID, OTHER, REF2], hash: `#${ID}` });
    try {
      await sendPart(OTHER, 1, { type: "tool_call", id: "e1", toolUseId: "e1", tool: "Edit", input: { file_path: "/p/demo/a.ts", old_string: "a", new_string: "b" }, status: "done" });
      await sendPart(OTHER, 2, { type: "tool_result", id: "e1:result", toolUseId: "e1", output: "ok", isError: false });
      expect(q("pane-changes")!.textContent).not.toContain("1");
      await hashTo(`plan%3A${OTHER}`);
      expect(location.hash).toBe(`#plan%3A${OTHER}`);
      expect(q("pane-changes")!.textContent).toContain("1");
      expect(el.querySelectorAll('[data-testid="split"]')).toHaveLength(0);
      // The sidebar shows the owner's row as the current one.
      expect(el.querySelector('[data-testid="sidebar"] [aria-current="page"]')?.textContent).toContain("Other");
    } finally {
      restore();
    }
  });

  it("A plan tab keeps showing its own session's plan while another session is active", async () => {
    const restore = await mountMain({ tabs: [ID, OTHER, REF], hash: `#${OTHER}` });
    try {
      await sendPart(ID, 1, planPart("a", "# Plan of Demo"));
      await sendPart(OTHER, 1, planPart("b", "# Plan of Other"));
      expect(bodyOf(REF)!.textContent).toContain("Plan of Demo");
      expect(bodyOf(REF)!.textContent).not.toContain("Plan of Other");
      expect(sideTabs()).not.toContain("pane-plan");
    } finally {
      restore();
    }
  });

  it("Move Plan to side panel from a plan tab closes all plan tabs with \"Closed 2 Plan tabs\"; Undo restores the main home and the tabs", async () => {
    const restore = await mountMain({ tabs: [ID, REF, OTHER, REF2], hash: `#plan%3A${ID}` });
    try {
      await sendPart(ID, 1, planPart());
      await sendPart(OTHER, 1, planPart("b"));
      await ctxMenu(stripTab(REF));
      await act(async () => menuItem("moveSide").click());
      expect(toastEl()!.textContent).toContain("Closed 2 Plan tabs");
      expect(tabIds()).toEqual([ID, OTHER]);
      expect(layoutNow()?.areas.main ?? []).toEqual([]);
      expect(sideTabs()).toContain("pane-plan");
      await undoToast();
      expect(layoutNow()!.areas.main).toEqual(["plan"]);
      expect(tabIds()).toEqual([ID, REF, OTHER, REF2]);
      // No stray close after the Undo.
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(tabIds()).toEqual([ID, REF, OTHER, REF2]);
    } finally {
      restore();
    }
  });

  it("Reset layout returns Plan to the side panel and closes plan tabs", async () => {
    const restore = await mountMain({ tabs: [ID, REF] });
    try {
      await sendPart(ID, 1, planPart());
      await press({ key: "k", code: "KeyK", ctrlKey: true });
      const row = [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith("Reset layout"))!;
      await act(async () => row.click());
      expect(tabIds()).toEqual([ID]);
      expect(toastEl()!.textContent).toContain("Closed 1 Plan tab");
      expect(localStorage.getItem("claude-ui.layout")).toBeNull();
      expect(sideTabs()).toContain("pane-plan");
    } finally {
      restore();
    }
  });

  it("Reload restores plan tabs, order, pin and the active plan tab from the hash; its owner without a tab is subscribed once with background: true", async () => {
    const restore = await mountMain({ tabs: [REF], hash: `#plan%3A${ID}`, pinned: [REF] });
    try {
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(tabIds()).toEqual([REF]);
      expect(stripTab(REF).hasAttribute("data-pinned")).toBe(true);
      expect(stripTab(REF).querySelector('[role="tab"]')!.getAttribute("aria-selected")).toBe("true");
      expect(location.hash).toBe(`#plan%3A${ID}`);
      // Double subscribe guard: the owner is followed once, without a CLI hold.
      expect(subs(ID)).toHaveLength(1);
      expect(subs(ID)[0]!.background).toBe(true);
      await sendPart(ID, 1, planPart("a", "# Restored plan"));
      expect(bodyOf(REF)!.textContent).toContain("Restored plan");
      // A list refresh and a reconnect resubscribe the one view, still in the background.
      await act(async () => sessionsChanged({}));
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(subs(ID).filter((m) => !m.background)).toEqual([]);
    } finally {
      restore();
    }
  });

  it("A subscribe error of a plan tab's owner ends Loading plan… with a message and is asked again after a reconnect", async () => {
    let broken = true;
    const restore = await mountMain({
      tabs: [REF],
      hash: `#plan%3A${ID}`,
      extra: { "session.subscribe": async (m: { sessionId: string }) => (broken ? Promise.reject(Object.assign(new Error("boom"), { code: "failed" })) : bySess(m)) },
    });
    try {
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(bodyOf(REF)!.querySelector('[data-testid="plan-failed"]')).not.toBeNull();
      broken = false;
      await act(async () => setStatus("reconnecting"));
      await act(async () => setStatus("connected"));
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(subs(ID).length).toBeGreaterThanOrEqual(2);
      await sendPart(ID, 1, planPart());
      expect(bodyOf(REF)!.textContent).toContain("do it");
      expect(bodyOf(REF)!.querySelector('[data-testid="plan-failed"]')).toBeNull();
    } finally {
      restore();
    }
  });

  it("Move plan to main area from the palette without a plan says so in a toast", async () => {
    const restore = await mountMain({ tabs: [ID], layout: JSON.stringify({ side: "right", areas: { side: ["changes", "files", "graph", "plan"], bottom: ["terminal"], main: [] } }) });
    try {
      await press({ key: "k", code: "KeyK", ctrlKey: true });
      const row = [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith("Move plan to main area"))!;
      await act(async () => row.click());
      expect(toastEl()!.textContent).toContain("Plan moved to the main area");
      expect(layoutNow()!.areas.main).toEqual(["plan"]);
    } finally {
      restore();
    }
  });

  it("A dropped subscription of a plan tab's owner is asked again after a reconnect", async () => {
    let n = 0;
    const restore = await mountMain({
      tabs: [REF],
      hash: `#plan%3A${ID}`,
      extra: { "session.subscribe": async (m: { sessionId: string }) => (++n === 1 ? Promise.reject(new Error("disconnected")) : bySess(m)) },
    });
    try {
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      await act(async () => setStatus("reconnecting"));
      await act(async () => setStatus("connected"));
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(subs(ID).length).toBeGreaterThanOrEqual(2);
      await sendPart(ID, 1, planPart());
      expect(bodyOf(REF)!.textContent).toContain("do it");
    } finally {
      restore();
    }
  });

  it("Closing the owner's session tab keeps the plan tab and follows the owner in the background; closing the plan tab then drops a closed owner", async () => {
    const closedList = { sessions: [{ ...session, state: "closed" as const }, other], projects: ["/p/demo"] };
    const restore = await mountMain({ tabs: [ID, REF], hash: `#${ID}`, list: closedList as never });
    try {
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      sent.length = 0;
      await act(async () => stripTab(ID).querySelector<HTMLElement>('[data-testid="tab-close"]')!.click());
      expect(tabIds()).toEqual([REF]);
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(unsubs(ID)).toHaveLength(0);
      expect(subs(ID).every((m) => m.background)).toBe(true);
      expect(subs(ID).length).toBeGreaterThan(0);
      await act(async () => stripTab(REF).querySelector<HTMLElement>('[data-testid="tab-close"]')!.click());
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(tabIds()).toEqual([]);
      expect(unsubs(ID).length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("Deleting the session closes its plan tab; a session whose project was removed closes its plan tab", async () => {
    const restore = await mountMain({ tabs: [ID, REF, OTHER, REF2], hash: `#plan%3A${ID}` });
    try {
      await act(async () => sessionsChanged({ deleted: ID }));
      expect(tabIds()).toEqual([OTHER, REF2]);
      expect(location.hash).not.toContain(ID);
      replies["session.list"] = { sessions: [], projects: [] };
      await act(async () => sessionsChanged({}));
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(tabIds()).toEqual([]);
    } finally {
      restore();
    }
  });

  it("Plan tab menu: Close others, Pin, Go to session; Split right and down are disabled", async () => {
    const restore = await mountMain({ tabs: [ID, REF, OTHER], hash: `#plan%3A${ID}` });
    try {
      await ctxMenu(stripTab(REF));
      expect(menuItem("splitRight").hasAttribute("data-disabled")).toBe(true);
      expect(menuItem("splitDown").hasAttribute("data-disabled")).toBe(true);
      expect(document.querySelector('[data-testid="tab-menu-copyId"]')).toBeNull();
      await act(async () => menuItem("pin").click());
      expect(stripTab(REF).hasAttribute("data-pinned")).toBe(true);
      await ctxMenu(stripTab(REF));
      await act(async () => menuItem("goToSession").click());
      expect(location.hash).toBe(`#${ID}`);
      await ctxMenu(stripTab(REF));
      await act(async () => menuItem("closeOthers").click());
      expect(tabIds()).toEqual([REF]);
    } finally {
      restore();
    }
  });

  it("Phone switcher: removing a plan row toasts \"Closed Plan · Demo\" with Undo", async () => {
    width = 500;
    const restore = await mountMain({ tabs: [ID, REF], hash: `#${ID}` });
    try {
      await act(async () => q("tab-switcher")!.click());
      const row = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((r) => r.textContent?.includes("Plan · Demo"))!;
      await act(async () => void row.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
      expect(toastEl()!.textContent).toContain("Closed Plan · Demo");
      expect(tabIds()).toEqual([ID]);
      await undoToast();
      expect(tabIds()).toEqual([ID, REF]);
    } finally {
      restore();
    }
  });

  it("Narrow: with home main the Plan switcher entry opens and focuses the plan tab; leaving it by Session returns to the session", async () => {
    width = 800;
    const restore = await mountMain({ tabs: [ID], hash: `#${ID}` });
    const spy = visible();
    try {
      await sendPart(ID, 1, planPart());
      expect(q("pane-plan")).not.toBeNull();
      await clickId("pane-plan");
      expect(location.hash).toBe(`#plan%3A${ID}`);
      expect(q("pane-plan")!.getAttribute("aria-selected")).toBe("true");
      await clickId("pane-session");
      expect(location.hash).toBe(`#${ID}`);
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("Stored layout and tabs without plan or main load with the default; a stored plan tab while Plan's home is the side panel closes silently", async () => {
    const old = JSON.stringify({ side: "left", areas: { side: ["files", "changes", "graph"], bottom: ["terminal"] } });
    const restore = await mountMain({ tabs: [ID, REF], layout: old });
    try {
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      expect(tabIds()).toEqual([ID]);
      expect(toastEl()).toBeNull();
      await sendPart(ID, 1, planPart());
      expect(sideTabs().at(-1)).toBe("pane-plan");
    } finally {
      restore();
    }
  });

  it("Clean up: the archived rule closes a plan tab of an archived owner; Close idle tabs does not", async () => {
    const archived = { sessions: [{ ...session, archived: true }, other], projects: ["/p/demo"] };
    const restore = await mountMain({ tabs: [REF, OTHER], hash: `#${OTHER}`, list: archived as never });
    try {
      await act(async () => new Promise((r) => setTimeout(r, 30)));
      await ctxMenu(stripTab(OTHER));
      await act(async () => document.querySelector<HTMLElement>('[data-testid="tab-menu-cleanup"]')!.click());
      const items = () => [...document.querySelectorAll<HTMLElement>('[data-testid="tab-cleanup-menu"] [role="menuitem"]')];
      const idle = items().find((x) => /idle/i.test(x.textContent ?? ""));
      if (idle && !idle.hasAttribute("data-disabled")) await act(async () => idle.click());
      expect(tabIds()).toContain(REF);
      await ctxMenu(stripTab(OTHER));
      await act(async () => document.querySelector<HTMLElement>('[data-testid="tab-menu-cleanup"]')!.click());
      const arch = items().find((x) => /archived/i.test(x.textContent ?? ""))!;
      await act(async () => arch.click());
      expect(tabIds()).not.toContain(REF);
    } finally {
      restore();
    }
  });
});

describe("GH-396 Files and Git graph in the main area", () => {
  const SAME = "99999999-8888-7777-6666-555555555555";
  const OTHERP = "aaaaaaaa-8888-7777-6666-555555555555";
  const same: SessionListItem = { ...session, id: SAME, cwd: "/p/demo", title: "Same" };
  const elsewhere: SessionListItem = { ...session, id: OTHERP, cwd: "/p/other", title: "Elsewhere" };
  const list3 = { sessions: [session, same, elsewhere], projects: ["/p/demo", "/p/other"], worktrees: { "/p/demo": [{ path: "/p/demo", branch: "main", main: true }], "/p/other": [{ path: "/p/other", branch: "main", main: true }] } };
  const FILES = `files:${ID}`;
  const GRAPH = `graph:${ID}`;
  const FILES_O = `files:${OTHERP}`;
  const bySess = (m: { sessionId: string }) => ({ logEpoch: "e1", session: [session, same, elsewhere].find((s) => s.id === m.sessionId) ?? session });
  const gitReplies = { "git.repos": (m: { cwd: string }) => ({ repos: [{ path: m.cwd, rel: "", kind: "main", branch: "main" }] }), "git.status": { status: { branch: "main", added: 0, removed: 0, refs: "s1" } }, "git.refs": { refs: "s1" }, "git.log": { log: { commits: [], more: false, branches: ["refs/heads/main"], refs: "s1", head: "refs/heads/main" } } };
  const HOME_MAIN = JSON.stringify({ side: "right", areas: { side: ["changes"], bottom: ["terminal"], main: ["plan", "files", "graph"] } });
  const tabIds = () => [...el.querySelectorAll<HTMLElement>('[data-testid="tab"]')].map((t) => t.dataset.tabId);
  const stripTab = (id: string) => el.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
  const bodyOf = (ref: string) => el.querySelector<HTMLElement>(`[data-pane-tab-body="${ref}"]`);
  const sideTabs = () => [...el.querySelectorAll<HTMLElement>('[data-testid="side-panel"] [data-testid^="pane-"]')].map((b) => b.getAttribute("data-testid"));
  const toastEl = () => el.querySelector<HTMLElement>('[data-testid="toast"]');
  const undoToast = () => act(async () => [...toastEl()!.querySelectorAll("button")].find((b) => b.textContent === "Undo")!.click());
  const layoutNow = () => JSON.parse(localStorage.getItem("claude-ui.layout") ?? "null") as { areas: { side: string[]; main: string[] } } | null;
  const hashTo = async (id: string) =>
    act(async () => {
      location.hash = `#${id}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));
  const ctx = (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  const palette = async (title: string) => {
    await press({ key: "k", code: "KeyK", ctrlKey: true });
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith(title));
    expect(row, title).toBeDefined();
    await act(async () => row!.click());
  };
  const visible = () => vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as never);
  const E = { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true };
  const H = { key: "H", code: "KeyH", ctrlKey: true, shiftKey: true };
  const fsLists = () => (sent as unknown as { type: string; path?: string }[]).filter((m) => m.type === "fs.list");
  async function mount(o: { tabs: string[]; hash?: string; layout?: string; git?: boolean; list?: unknown; pinned?: string[]; extra?: Record<string, unknown> }) {
    if (o.layout) localStorage.setItem("claude-ui.layout", o.layout);
    localStorage.setItem("claude-ui.tabs", JSON.stringify(o.tabs));
    if (o.pinned) localStorage.setItem("claude-ui.pinned-tabs", JSON.stringify(o.pinned));
    location.hash = `#${encodeURIComponent(o.hash ?? o.tabs[0]!)}`;
    sent.length = 0;
    const undo = await remount({ "session.list": o.list ?? { sessions: [session, same, elsewhere], projects: ["/p/demo", "/p/other"] }, "session.subscribe": bySess, ...(o.git ? gitReplies : {}), ...o.extra });
    return () => (undo(), void Object.keys(gitReplies).forEach((k) => delete replies[k]));
  }

  it("Move to main area from the Files dock tab menu opens \"Files · demo\" right of the session tab with the focus; the side panel has no Files tab", async () => {
    const restore = await mount({ tabs: [ID, SAME] });
    const spy = visible();
    try {
      await ctx(el.querySelector('[data-pane-tab="files"]')!);
      await act(async () => document.querySelector<HTMLElement>('[data-testid="pane-move-main"]')!.click());
      await settle();
      expect(tabIds()).toEqual([ID, FILES, SAME]);
      expect(stripTab(FILES).textContent).toContain("Files · demo");
      expect(document.activeElement).toBe(stripTab(FILES).querySelector('[role="tab"]'));
      expect(sideTabs()).not.toContain("pane-files");
      expect(layoutNow()!.areas.main).toEqual(["files"]);
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("Move git graph to main area from the palette opens \"Git graph · demo\"; the stored layout has files and graph in main", async () => {
    const restore = await mount({ tabs: [ID], git: true, list: list3 });
    try {
      await settle();
      await palette("Move git graph to main area");
      await settle();
      expect(tabIds()).toEqual([ID, GRAPH]);
      expect(stripTab(GRAPH).textContent).toContain("Git graph · demo");
      await palette("Move files to main area");
      await settle();
      expect(layoutNow()!.areas.main).toEqual(["graph", "files"]);
      expect(tabIds()).toEqual([ID, FILES, GRAPH]);
    } finally {
      restore();
    }
  });

  it("Ctrl+Shift+E with home main opens the current session's Files tab; again focuses the same tab; a second session in the same folder focuses it (one tab per folder); another folder opens a second tab", async () => {
    const restore = await mount({ tabs: [ID, SAME, OTHERP], layout: HOME_MAIN });
    try {
      await press(E);
      expect(tabIds()).toEqual([ID, FILES, SAME, OTHERP]);
      expect(location.hash).toBe(`#files%3A${ID}`);
      await press(E);
      expect(tabIds().filter((t) => t === FILES)).toHaveLength(1);
      await hashTo(SAME);
      await press(E);
      expect(tabIds().filter((t) => t?.startsWith("files:"))).toEqual([FILES]);
      expect(location.hash).toBe(`#files%3A${ID}`);
      await hashTo(OTHERP);
      await press(E);
      expect(tabIds().filter((t) => t?.startsWith("files:"))).toEqual([FILES, FILES_O]);
      expect(stripTab(FILES_O).textContent).toContain("Files · other");
    } finally {
      restore();
    }
  });

  it("Ctrl+Shift+H with home main opens or focuses the Git graph tab; Ctrl+\\ hides the tree of a Files tab that shows", async () => {
    const restore = await mount({ tabs: [ID], layout: HOME_MAIN, git: true, list: list3 });
    try {
      await settle();
      await press(H);
      await settle();
      expect(tabIds()).toEqual([ID, GRAPH]);
      await press(H);
      expect(tabIds().filter((t) => t === GRAPH)).toHaveLength(1);
      expect(bodyOf(GRAPH)!.querySelector('[data-testid="graph-panel"]')).not.toBeNull();
      await press(E);
      expect(location.hash).toBe(`#files%3A${ID}`);
      expect(bodyOf(FILES)!.querySelector('[data-testid="file-tree"]')).not.toBeNull();
      await press({ key: "\\", ctrlKey: true });
      expect(bodyOf(FILES)!.querySelector('[data-testid="file-tree"]')).toBeNull();
      await press({ key: "\\", ctrlKey: true });
      expect(bodyOf(FILES)!.querySelector('[data-testid="file-tree"]')).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("Quick open and the file popup's Open in editor open the file in the current session's Files tab (openPath reaches only that tab)", async () => {
    const restore = await mount({ tabs: [ID, SAME, OTHERP], layout: HOME_MAIN });
    try {
      replies["fs.search"] = { paths: ["src/app.ts"] };
      await press({ key: "k", code: "KeyK", ctrlKey: true });
      const input = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "app");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {});
      await act(async () => document.querySelector<HTMLElement>('[data-id="file:src/app.ts"]')!.click());
      await settle();
      expect(tabIds()).toEqual([ID, FILES, SAME, OTHERP]);
      expect(location.hash).toBe(`#files%3A${ID}`);
      expect(sent.some((m) => (m as unknown as { path?: string }).path === "/p/demo/src/app.ts" && m.type === "fs.read")).toBe(true);
      expect(bodyOf(FILES)!.textContent).toContain("app.ts");
    } finally {
      replies["fs.search"] = { paths: [] };
      restore();
    }
  });

  it("Show changes from the Files tab reveals Changes of the tab's owner in the side panel", async () => {
    const restore = await mount({ tabs: [ID, FILES], layout: HOME_MAIN, hash: FILES });
    try {
      expect(location.hash).toBe(`#files%3A${ID}`);
      await press({ key: "G", code: "KeyG", ctrlKey: true, shiftKey: true });
      expect(sideTab()).toMatch(/changes/i);
      expect(sideTabs()).not.toContain("pane-files");
    } finally {
      restore();
    }
  });

  it("On New session and Focus, Ctrl+Shift+E opens the Files tab of the session shown last; with no session shown yet it toasts \"Open a session to show Files.\"", async () => {
    const restore = await mount({ tabs: [ID, "new"], layout: HOME_MAIN, hash: ID });
    try {
      await settle();
      await hashTo("new");
      await press(E);
      expect(tabIds()).toContain(FILES);
      expect(location.hash).toBe(`#files%3A${ID}`);
    } finally {
      restore();
    }
    const restore2 = await mount({ tabs: ["new"], layout: HOME_MAIN, hash: "new", list: { sessions: [], projects: ["/p/demo"] } });
    try {
      await press(E);
      expect(toastEl()!.textContent).toContain("Open a session to show Files.");
    } finally {
      restore2();
    }
  });

  it("A hidden Files tab keeps its tree and editor tabs: switching to another session's tab and back sends no new fs.list for the open folders and shows the same file", async () => {
    const restore = await mount({ tabs: [ID, FILES, OTHERP], layout: HOME_MAIN, hash: FILES });
    try {
      await settle();
      replies["fs.search"] = { paths: [] };
      // Open a file in the tab through the palette's file search.
      replies["fs.search"] = { paths: ["a.ts"] };
      await press({ key: "k", code: "KeyK", ctrlKey: true });
      const input = document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "a");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {});
      await act(async () => document.querySelector<HTMLElement>('[data-id="file:a.ts"]')!.click());
      await settle();
      expect(bodyOf(FILES)!.textContent).toContain("a.ts");
      const before = fsLists().length;
      await hashTo(OTHERP);
      expect(bodyOf(FILES)!.className).toContain("hidden");
      await hashTo(FILES.replace(":", "%3A"));
      await settle();
      expect(bodyOf(FILES)!.className).not.toContain("hidden");
      expect(bodyOf(FILES)!.textContent).toContain("a.ts");
      expect(fsLists().length).toBe(before);
    } finally {
      replies["fs.search"] = { paths: [] };
      restore();
    }
  });

  it("A hidden Git graph tab keeps its loaded graph: no new git.log after a round trip when git.refs is unchanged", async () => {
    const restore = await mount({ tabs: [ID, GRAPH, SAME], layout: HOME_MAIN, hash: GRAPH, git: true, list: list3 });
    try {
      await settle();
      const logs = () => (sent as unknown as { type: string }[]).filter((m) => m.type === "git.log").length;
      const n = logs();
      expect(n).toBeGreaterThan(0);
      await hashTo(SAME);
      expect(bodyOf(GRAPH)!.className).toContain("hidden");
      await hashTo(GRAPH.replace(":", "%3A"));
      await settle();
      expect(bodyOf(GRAPH)!.className).not.toContain("hidden");
      expect(logs()).toBe(n);
    } finally {
      restore();
    }
  });

  it("While two sessions are split, activating a Git graph tab shows it alone (no split) and the next session tab brings the split back", async () => {
    localStorage.setItem("claude-ui.split", JSON.stringify({ dir: "row", ids: [ID, SAME], at: 1, ratio: 0.5 }));
    const restore = await mount({ tabs: [ID, SAME, GRAPH], layout: HOME_MAIN, hash: ID, git: true, list: list3 });
    try {
      await settle();
      expect(el.querySelectorAll("[data-split]")).toHaveLength(1);
      await hashTo(GRAPH.replace(":", "%3A"));
      expect(el.querySelectorAll("[data-split]")).toHaveLength(0);
      await hashTo(ID);
      expect(el.querySelectorAll("[data-split]")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("Move Files to side panel from a files tab closes all files tabs with \"Closed 2 Files tabs\"; Undo restores the main home and the tabs", async () => {
    const restore = await mount({ tabs: [ID, FILES, OTHERP, FILES_O], layout: HOME_MAIN, hash: FILES });
    try {
      await ctx(stripTab(FILES));
      await act(async () => document.querySelector<HTMLElement>('[data-testid="tab-menu-moveSide"]')!.click());
      expect(toastEl()!.textContent).toContain("Closed 2 Files tabs");
      expect(tabIds()).toEqual([ID, OTHERP]);
      expect(layoutNow()!.areas.main).not.toContain("files");
      expect(sideTabs()).toContain("pane-files");
      await undoToast();
      expect(layoutNow()!.areas.main).toContain("files");
      expect(tabIds()).toEqual([ID, FILES, OTHERP, FILES_O]);
      await settle();
      expect(tabIds()).toEqual([ID, FILES, OTHERP, FILES_O]);
    } finally {
      restore();
    }
  });

  it("Changes never reaches the main area: no Move to main area in its dock menus or the palette; a stored layout with changes in main keeps it in the side panel", async () => {
    const restore = await mount({ tabs: [ID], layout: JSON.stringify({ side: "right", areas: { side: [], bottom: ["terminal"], main: ["changes", "files"] } }) });
    try {
      expect(sideTabs()).toContain("pane-changes");
      await ctx(el.querySelector('[data-pane-tab="changes"]')!);
      expect(document.querySelector('[data-testid="pane-move-main"]')).toBeNull();
      await press({ key: "Escape" });
      await press({ key: "k", code: "KeyK", ctrlKey: true });
      const titles = [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].map((o) => o.textContent ?? "");
      expect(titles.some((t) => /move changes/i.test(t))).toBe(false);
      expect(titles.some((t) => t.startsWith("Move files to side panel"))).toBe(true);
    } finally {
      restore();
    }
  });

  it("Reset layout returns Files and Git graph to the side panel and closes plan, files and graph tabs with \"Closed 3 pane tabs\"; Undo brings them back", async () => {
    const PLAN = `plan:${ID}`;
    const restore = await mount({ tabs: [ID, PLAN, FILES, GRAPH], layout: HOME_MAIN, git: true, list: list3 });
    try {
      await settle();
      await palette("Reset layout");
      expect(tabIds()).toEqual([ID]);
      expect(toastEl()!.textContent).toContain("Closed 3 pane tabs");
      expect(localStorage.getItem("claude-ui.layout")).toBeNull();
      expect(sideTabs()).toContain("pane-files");
      await undoToast();
      expect(tabIds()).toEqual([ID, PLAN, FILES, GRAPH]);
    } finally {
      restore();
    }
  });

  it("Reload restores files and graph tabs, order, pins and the active tab from the hash; a stored second files tab of the same folder closes silently", async () => {
    const FILES_S = `files:${SAME}`;
    const restore = await mount({ tabs: [ID, FILES, FILES_S, GRAPH], layout: HOME_MAIN, hash: GRAPH, pinned: [GRAPH], git: true, list: list3 });
    try {
      await settle();
      expect(tabIds()).toEqual([GRAPH, ID, FILES]);
      expect(stripTab(GRAPH).hasAttribute("data-pinned")).toBe(true);
      expect(stripTab(GRAPH).querySelector('[role="tab"]')!.getAttribute("aria-selected")).toBe("true");
      expect(location.hash).toBe(`#graph%3A${ID}`);
      expect(toastEl()).toBeNull();
    } finally {
      restore();
    }
  });

  it("Narrow: the pane switcher's Files with home main opens the files tab; Session returns to the session; a restored narrow \"files\" pane reads as session", async () => {
    width = 800;
    localStorage.setItem("claude-ui.pane-tabs", JSON.stringify({ narrow: "files" }));
    const restore = await mount({ tabs: [ID], layout: HOME_MAIN });
    const spy = visible();
    try {
      await settle();
      expect(q("pane-session")!.getAttribute("aria-selected")).toBe("true");
      await clickId("pane-files");
      expect(location.hash).toBe(`#files%3A${ID}`);
      expect(q("pane-files")!.getAttribute("aria-selected")).toBe("true");
      await clickId("pane-session");
      expect(location.hash).toBe(`#${ID}`);
    } finally {
      spy.mockRestore();
      restore();
    }
  });

  it("Phone switcher lists \"Files · demo\" and \"Git graph · demo\" rows with their icons; Delete on a row toasts \"Closed Files · demo\" with Undo", async () => {
    width = 500;
    const restore = await mount({ tabs: [ID, FILES, GRAPH], layout: HOME_MAIN, hash: ID, git: true, list: list3 });
    try {
      await act(async () => q("tab-switcher")!.click());
      const rows = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
      const files = rows().find((r) => r.textContent?.includes("Files · demo"))!;
      expect(files.querySelector(".lucide-folder")).not.toBeNull();
      expect(rows().find((r) => r.textContent?.includes("Git graph · demo"))!.querySelector(".lucide-git-graph")).not.toBeNull();
      await act(async () => void files.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
      expect(toastEl()!.textContent).toContain("Closed Files · demo");
      expect(tabIds()).toEqual([ID, GRAPH]);
      await undoToast();
      expect(tabIds()).toEqual([ID, FILES, GRAPH]);
    } finally {
      restore();
    }
  });

  it("Deleting the owner closes its files and graph tabs; closing the owner's session tab keeps them", async () => {
    const restore = await mount({ tabs: [ID, FILES, GRAPH, OTHERP], layout: HOME_MAIN, hash: ID, git: true, list: list3 });
    try {
      await settle();
      await act(async () => stripTab(ID).querySelector<HTMLElement>('[data-testid="tab-close"]')!.click());
      expect(tabIds()).toEqual([FILES, GRAPH, OTHERP]);
      await act(async () => sessionsChanged({ deleted: ID }));
      expect(tabIds()).toEqual([OTHERP]);
    } finally {
      restore();
    }
  });

  it("Only one fs.watch stream runs for the store: the shared sync, not one per Files view", async () => {
    const restore = await mount({ tabs: [ID, FILES, OTHERP, FILES_O], layout: HOME_MAIN, hash: FILES });
    try {
      await settle();
      const watches = (sent as unknown as { type: string; paths: string[] }[]).filter((m) => m.type === "fs.watch");
      // Every watch carries the one list of the store; no per-view lists alternate.
      expect(new Set(watches.map((w) => JSON.stringify(w.paths))).size).toBeLessThanOrEqual(1);
    } finally {
      restore();
    }
  });
});
