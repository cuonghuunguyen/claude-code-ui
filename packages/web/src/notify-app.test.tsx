// @vitest-environment jsdom
// In-app notifications in App (GH-158): live events of sessions this page does not show make cards; the gate, the settle, the hand-offs.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Part, SessionListItem } from "@claude-ui/protocol";

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

const A = "11111111-2222-3333-4444-555555555555";
const B = "22222222-2222-3333-4444-555555555555";
const mk = (id: string, title: string): SessionListItem => ({ id, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"], title, lastActivity: 0, archived: false, transcript: true });
const sessions = [mk(A, "Shown one"), mk(B, "Fix login redirect")];
let subscribeSeq = 0;
const replies: Record<string, unknown> = {
  "session.list": { sessions, projects: ["/p/demo"] },
  "models.list": { models: [] },
  "fs.list": { entries: [] },
  "fs.search": { paths: [] },
  "terminal.list": { terminals: [] },
};
vi.mock("@xterm/xterm", () => ({ Terminal: class { options = {}; cols = 80; rows = 24; loadAddon() {} open() {} focus() {} write() {} reset() {} onData() {} onResize() {} attachCustomKeyEventHandler() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
let emit: (e: unknown) => void = () => {};
const sent: { type: string; [k: string]: unknown }[] = [];
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void }) => {
    emit = opts.onEvent;
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return {
      request: async (m: { type: string; sessionId?: string }) => {
        sent.push(m);
        if (m.type === "session.subscribe") return { logEpoch: "e1", seq: subscribeSeq, session: sessions.find((s) => s.id === m.sessionId) };
        return replies[m.type] ?? {};
      },
      onFsChanged: () => () => {},
      onTerminal: () => () => {},
      close() {},
    };
  },
}));
const { App } = await import("./App.tsx");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let seq = 100;
const live = (sessionId: string, part: Part) => act(async () => emit({ type: "event", sessionId, seq: ++seq, part }));
const perm = (id: string, over: Record<string, unknown> = {}): Part => ({ type: "permission_request", id, requestId: id, toolUseId: `tu-${id}`, tool: "Read", input: { file_path: "/p/demo/src/a.ts" }, suggestions: [], settled: false, at: Date.now(), ...over }) as Part;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));
const cards = () => [...el.querySelectorAll<HTMLElement>('[data-testid="notification"]')];
const status = () => el.querySelector('[data-testid="attention-status"]')!.textContent;

async function mount(hash: string, setup?: () => void) {
  location.hash = hash;
  setup?.();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
  await settle();
}
beforeEach(() => {
  width = 1440;
  seq = 100;
  subscribeSeq = 0;
  sent.length = 0;
  localStorage.clear();
  document.hasFocus = () => true;
});
afterEach(() => (act(() => root.unmount()), el.remove()));

it("a live request of a session this page does not show makes a card; answering it sends permission.respond", async () => {
  await mount(`#${A}`);
  await live(B, perm("r1", { tier: "low" }));
  await settle();
  expect(cards()).toHaveLength(1);
  expect(cards()[0]!.textContent).toContain("Fix login redirect");
  expect(cards()[0]!.textContent).toContain("Needs permission");
  await act(async () => [...cards()[0]!.querySelectorAll("button")].find((b) => b.textContent === "Allow once")!.click());
  expect(sent.find((m) => m.type === "permission.respond")).toMatchObject({ requestId: "r1", decision: "allow" });
  // The settled event removes the card.
  await live(B, perm("r1", { settled: true, decision: "allow" }));
  expect(cards()).toHaveLength(0);
});

it("the status region announces the card once, with the count", async () => {
  await mount(`#${A}`);
  await live(B, perm("r1"));
  await settle();
  expect(status()).toContain("Fix login redirect needs permission: Read");
  expect(status()).toContain("1 session needs input");
});

it("the shown session makes no card", async () => {
  await mount(`#${A}`);
  await live(A, perm("r1"));
  await settle();
  expect(cards()).toHaveLength(0);
});

it("on the Focus page there is no card: the queue shows the request", async () => {
  await mount("#focus");
  await live(B, perm("r1"));
  await settle();
  expect(cards()).toHaveLength(0);
});

it("in-app notifications off: no card", async () => {
  await mount(`#${A}`, () => localStorage.setItem("claude-ui.inAppNotifications", "off"));
  await live(B, perm("r1"));
  await settle();
  expect(cards()).toHaveLength(0);
});

it("a replayed request (seq up to the subscribe reply) makes no card", async () => {
  subscribeSeq = 500;
  await mount(`#${A}`);
  await act(async () => emit({ type: "event", sessionId: B, seq: 3, part: perm("r1") }));
  await settle();
  expect(cards()).toHaveLength(0);
});

it("a page that is not focused makes no card", async () => {
  await mount(`#${A}`, () => (document.hasFocus = () => false));
  await live(B, perm("r1"));
  await settle();
  expect(cards()).toHaveLength(0);
});

it("Open in Focus opens the Focus page with the request selected and clears every card; Open session opens the session", async () => {
  await mount(`#${A}`);
  await live(B, perm("r1")); // no tier yet: Open in Focus and Open session
  await settle();
  await act(async () => [...cards()[0]!.querySelectorAll("button")].find((b) => b.textContent === "Open in Focus")!.click());
  expect(location.hash).toBe("#focus");
  expect(cards()).toHaveLength(0);
});

it("Open session opens that session and removes its card", async () => {
  await mount(`#${A}`);
  await live(B, perm("r1"));
  await settle();
  await act(async () => [...cards()[0]!.querySelectorAll("button")].find((b) => b.textContent === "Open session")!.click());
  expect(location.hash).toBe(`#${B}`);
  expect(cards()).toHaveLength(0);
});

it("a finished turn of another session shows a Finished card after 1.5 s with the last line; running again in between shows nothing", async () => {
  await mount(`#${A}`);
  const state = (s: string): Part => ({ type: "session_state", id: "st", state: s }) as Part;
  await live(B, state("running"));
  await live(B, { type: "assistant_text", id: "m", text: "Hello\nAll done here.", streaming: false });
  await live(B, state("idle"));
  await settle();
  expect(cards()).toHaveLength(0);
  await act(async () => void (await new Promise((r) => setTimeout(r, 1600))));
  expect(cards()).toHaveLength(1);
  expect(cards()[0]!.textContent).toContain("Finished");
  expect(cards()[0]!.textContent).toContain("All done here.");
});

it("Ctrl+Alt+N moves focus to the newest card", async () => {
  await mount(`#${A}`);
  await live(B, perm("r1"));
  await settle();
  await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
  expect(cards()[0]!.contains(document.activeElement)).toBe(true);
});

it("Esc on a focused card dismisses it and does not stop the shown session's turn", async () => {
  await mount(`#${A}`);
  await live(A, { type: "session_state", id: "st", state: "running" } as Part);
  await live(B, perm("r1"));
  await settle();
  await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
  sent.length = 0;
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(cards()).toHaveLength(0);
  expect(sent.some((m) => m.type === "session.interrupt")).toBe(false);
});

it("no push toggle in the page: it lives in Settings", async () => {
  await mount(`#${A}`);
  expect(el.querySelector('[data-testid="push-toggle"]')).toBeNull();
});

it("push.focus carries the covered sessions while the page is focused and in-app is on, so push and desktop stay quiet for them (GH-158)", async () => {
  await mount(`#${A}`);
  const last = () => [...sent].reverse().find((m) => m.type === "push.focus");
  expect(last()).toMatchObject({ sessionId: A, covered: [A, B].sort() });
});

it("push.focus has no covered with in-app off or an unfocused page", async () => {
  await mount(`#${A}`, () => localStorage.setItem("claude-ui.inAppNotifications", "off"));
  expect([...sent].reverse().find((m) => m.type === "push.focus")).toEqual(expect.not.objectContaining({ covered: expect.anything() }));
  act(() => root.unmount());
  el.remove();
  sent.length = 0;
  localStorage.clear();
  await mount(`#${A}`, () => (document.hasFocus = () => false));
  const m = sent.filter((x) => x.type === "push.focus").at(-1);
  expect(m).toBeDefined();
  expect(m).not.toHaveProperty("covered");
});

it("switching in-app off in Settings tells the daemon at once: push.focus without covered", async () => {
  await mount(`#${A}`);
  sent.length = 0;
  await act(async () => void window.dispatchEvent(new CustomEvent("claude-ui:in-app", { detail: false })));
  const m = sent.filter((x) => x.type === "push.focus").at(-1);
  expect(m).toBeDefined();
  expect(m).not.toHaveProperty("covered");
});
