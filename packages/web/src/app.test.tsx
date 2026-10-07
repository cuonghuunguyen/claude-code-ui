// @vitest-environment jsdom
// App wiring of the shortcut listener and the palette, with a fake daemon connection.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};
let width = 1440;
window.matchMedia = ((query: string) => ({
  matches: /min-width: (\d+)px/.test(query) ? width >= +/min-width: (\d+)px/.exec(query)![1]! : false,
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
    focus() {}
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
let settingsChanged: (m: unknown) => void = () => {};
const sent: { type: string }[] = [];
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void; onSessionsChanged?: (m: unknown) => void; onSettingsChanged?: (m: unknown) => void }) => {
    emit = opts.onEvent;
    settingsChanged = opts.onSettingsChanged ?? (() => {});
    sessionsChanged = opts.onSessionsChanged ?? (() => {});
    reconnect = opts.onOpen ?? (() => {});
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return { request: async (m: { type: string }) => (sent.push(m), typeof replies[m.type] === "function" ? (replies[m.type] as (m: unknown) => unknown)(m) : (replies[m.type] ?? {})), onFsChanged: () => () => {}, onTerminal: () => () => {}, close() {} };
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
afterEach(() => (act(() => root.unmount()), el.remove()));

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
  for (const id of ["open-drawer", "tab-switcher", "tab-new", "tab-close-active"]) expect(bar.querySelector(`[data-testid="${id}"]`)!.className).not.toContain("max-sm:hidden");
  expect(bar.querySelector('[data-testid="tab-switcher"]')!.textContent).toContain("Demo");
  // The drawer has the same two tools, for sm and up hidden.
  // The drawer is 85vw wide up to 360px (not the old fixed 288px); md and up use the sidebar width.
  expect(el.querySelector('[data-testid="sidebar"]')!.className).toContain("w-[min(85vw,360px)]");
  const tools = el.querySelector('[data-testid="drawer-tools"]')!;
  expect(tools.className).toContain("sm:hidden");
  expect(tools.querySelector('[data-testid="drawer-theme"]')).not.toBeNull();
  expect(tools.querySelector('[data-testid="drawer-quick-open"]')).not.toBeNull();
});

it("phone: the drawer Notifications toggle is a 44px target on a coarse pointer", async () => {
  await act(async () => el.querySelector<HTMLElement>('[data-testid="open-drawer"]')!.click());
  const label = document.querySelector('[data-testid="push-toggle"]')!.closest("label")!;
  expect(label.className).toContain("pointer-coarse:min-h-11");
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
    // No side panel or terminal on the new-session tab.
    expect(paletteRow("Toggle side panel")).toBeUndefined();
    expect(paletteRow("Toggle terminal")).toBeUndefined();
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
  expect(sidePanel().className).toContain("lg:hidden");
  expect(localStorage.getItem("claude-ui.sidePanelHidden")).toBe("1");
  await reload();
  expect(panelBtn().getAttribute("aria-expanded")).toBe("false");
  expect(sidePanel().className).toContain("lg:hidden");
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

it("the terminal below the side panel resizes with the arrow keys (100px to 60% of the window) and keeps its height across a reload", async () => {
  await act(async () => el.querySelector<HTMLElement>('[data-testid="terminal-toggle"]')!.click());
  const handle = () => el.querySelector<HTMLElement>('[role="separator"][aria-label="Resize terminal"]')!;
  expect(handle().getAttribute("aria-orientation")).toBe("horizontal");
  expect(handle().getAttribute("aria-valuenow")).toBe("280");
  await press({ key: "ArrowUp" }, handle());
  expect(handle().getAttribute("aria-valuenow")).toBe("312");
  for (let i = 0; i < 30; i++) await press({ key: "ArrowUp" }, handle());
  expect(handle().getAttribute("aria-valuenow")).toBe(String(Math.round(window.innerHeight * 0.6)));
  for (let i = 0; i < 30; i++) await press({ key: "ArrowDown" }, handle());
  expect(handle().getAttribute("aria-valuenow")).toBe("100");
  await press({ key: "ArrowUp" }, handle());
  act(() => root.unmount());
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  expect(handle().getAttribute("aria-valuenow")).toBe("132");
  expect(el.querySelector<HTMLElement>('[data-testid="terminal-panel"]')!.parentElement!.style.getPropertyValue("--terminal-h")).toBe("132px");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="terminal-toggle"]')!.click());
  localStorage.clear();
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
  const order = () => [...el.querySelectorAll<HTMLElement>("[data-tab-id]")].map((t) => t.dataset.tabId);
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

describe("worktrees", () => {
  const main = { path: "/p/demo", branch: "main", main: true };
  const managed = "/p/demo/.claude/worktrees/x";
  const field = (name: string, value: string) =>
    act(async () => {
      const input = document.querySelector<HTMLInputElement>(`[data-testid="${name}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("New worktree from the sidebar opens the new-session tab held, then in the new worktree", async () => {
    let done!: (r: unknown) => void;
    const listed = { sessions: [session], projects: ["/p/demo"], worktrees: { "/p/demo": [main] } };
    const restore = await remount({
      "session.list": listed,
      "worktree.create": () => new Promise((r) => (done = r)),
    });
    const from = sent.length;
    try {
      await act(async () => el.querySelector<HTMLElement>('[data-testid="project-new-worktree"]')!.click());
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

  it("the name dialog: an invalid name disables Create with the rule; Enter creates the valid one", async () => {
    const restore = await remount({ "session.list": { sessions: [session], projects: ["/p/demo"], worktrees: { "/p/demo": [main] } }, "worktree.create": { path: "/p/demo/.claude/worktrees/my-feature", branch: "worktree-my-feature" } });
    const from = sent.length;
    try {
      await act(async () => void el.querySelector<HTMLElement>('[data-testid="project-new-worktree"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
      await field("new-worktree-name", "a b");
      expect(document.querySelector<HTMLButtonElement>('[data-testid="new-worktree-confirm"]')!.disabled).toBe(true);
      expect(document.querySelector('[data-testid="new-worktree-hint"]')?.textContent).toBe("Only letters, numbers, dots, hyphens, and underscores");
      await field("new-worktree-name", "my-feature");
      expect(document.querySelector<HTMLButtonElement>('[data-testid="new-worktree-confirm"]')!.disabled).toBe(false);
      await press({ key: "Enter" }, document.querySelector('[data-testid="new-worktree-name"]')!);
      expect(sent.slice(from).filter((m) => m.type === "worktree.create")).toEqual([{ type: "worktree.create", cwd: "/p/demo", name: "my-feature" }]);
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
