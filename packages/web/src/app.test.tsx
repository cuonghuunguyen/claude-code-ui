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
const session: SessionListItem = { id: ID, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"], title: "Demo", lastActivity: 0 };
const replies: Record<string, unknown> = {
  "session.list": { sessions: [session], projects: ["/p/demo"] },
  "session.subscribe": { logEpoch: "e1", session },
  "models.list": { models: [] },
  "fs.list": { entries: [] },
  "fs.search": { paths: [] },
  "fs.read": { content: "x", mtime: 1 },
  "session.rewindPreview": { filesChanged: [], insertions: 0, deletions: 0, conversation: true },
};
let emit: (e: unknown) => void = () => {};
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void }) => {
    emit = opts.onEvent;
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return { request: async (m: { type: string }) => replies[m.type] ?? {}, onFsChanged: () => () => {}, close() {} };
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
