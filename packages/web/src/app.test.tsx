// @vitest-environment jsdom
// App wiring of the shortcut listener and the palette, with a fake daemon connection.
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
const sent: { type: string }[] = [];
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void; onSessionsChanged?: (m: unknown) => void }) => {
    emit = opts.onEvent;
    sessionsChanged = opts.onSessionsChanged ?? (() => {});
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return { request: async (m: { type: string }) => (sent.push(m), replies[m.type] ?? {}), onFsChanged: () => () => {}, onTerminal: () => () => {}, close() {} };
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
