// @vitest-environment jsdom
// Optimistic prompts (GH-133): the bubble, Thinking and skeletons show on Enter, before the daemon replies; the echo replaces them.
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
window.matchMedia = ((query: string) => ({
  matches: /min-width: (\d+)px/.test(query) ? 1440 >= +/min-width: (\d+)px/.exec(query)![1]! : false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as never;

const NEW = "aaaaaaaa-2222-3333-4444-555555555555";
const OLD = "11111111-2222-3333-4444-555555555555";
const info = { id: NEW, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"] };
const item = (id: string, title: string, transcript: boolean): SessionListItem => ({ ...info, id, title, lastActivity: 0, archived: false, transcript }) as SessionListItem;
const defer = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const replies: Record<string, unknown> = {};
vi.mock("@xterm/xterm", () => ({ Terminal: class { options = {}; cols = 80; rows = 24; loadAddon() {} open() {} focus() {} write() {} reset() {} onData() {} onResize() {} attachCustomKeyEventHandler() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
let emit: (e: unknown) => void = () => {};
const sent: { type: string }[] = [];
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void }) => {
    emit = opts.onEvent;
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return {
      request: async (m: { type: string }) => (sent.push(m), typeof replies[m.type] === "function" ? (replies[m.type] as (m: unknown) => unknown)(m) : (replies[m.type] ?? {})),
      onFsChanged: () => () => {},
      onTerminal: () => () => {},
      close() {},
    };
  },
}));
const { App } = await import("./App.tsx");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const hiddenTab = "[hidden], [style*='display: none']";
const visible = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)].filter((n) => !n.closest(hiddenTab));
const one = <T extends Element = HTMLElement>(sel: string) => visible<T>(sel)[0];
const box = () => one<HTMLTextAreaElement>('textarea[aria-label="Prompt"], textarea[aria-label="First prompt"]')!;
async function type(text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(box(), text);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const enter = () => act(async () => void box().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })));
const mount = async (hash: string) => {
  location.hash = hash;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await act(async () => {});
};

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  for (const k of Object.keys(replies)) delete replies[k];
  Object.assign(replies, {
    "session.list": { sessions: [], projects: ["/p/demo"] },
    "models.list": { models: [] },
    "session.defaultMode": { mode: "default" },
    "fs.list": { entries: [] },
    "fs.search": { paths: [] },
  });
});
afterEach(() => (act(() => root.unmount()), el.remove()));

describe("first prompt", () => {
  it("the bubble, Thinking and skeletons show on Enter, before session.create replies", async () => {
    const create = defer<unknown>();
    replies["session.create"] = () => create.promise;
    await mount("#new");
    await type("hello");
    await enter();
    const card = one('[data-testid="starting-session"]')!;
    expect(card).toBeTruthy();
    expect(card.querySelector('[data-testid="user-message"][data-pending]')?.textContent).toContain("hello");
    expect(card.querySelector('[data-testid="thinking"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="session-state-skeleton"]')).not.toBeNull();
    expect(one('[data-testid="titlebar"] [data-testid="title-skeleton"]')).toBeTruthy();
    expect(visible('[data-testid="new-session-tab"]')).toHaveLength(0);
  });

  it("a pending prompt renders markdown like a sent one", async () => {
    replies["session.create"] = () => defer<unknown>().promise;
    await mount("#new");
    await type("**hi**");
    await enter();
    expect(one('[data-testid="user-message"][data-pending] [data-streamdown="strong"]')?.textContent).toBe("hi");
  });

  it("a pending prompt renders markdown like a sent one", async () => {
    replies["session.create"] = () => defer<unknown>().promise;
    await mount("#new");
    await type("**hi**");
    await enter();
    expect(one('[data-testid="user-message"][data-pending] [data-streamdown="strong"]')?.textContent).toBe("hi");
  });

  it("after the echo the session tab shows the prompt once, not pending, with no blank card in between", async () => {
    const create = defer<unknown>();
    const prompt = defer<unknown>();
    const subscribe = defer<unknown>();
    replies["session.create"] = () => create.promise;
    replies["session.prompt"] = () => prompt.promise;
    replies["session.subscribe"] = () => subscribe.promise;
    await mount("#new");
    await type("hello");
    await enter();
    // Created: listed (so subscribed) before the prompt is taken.
    replies["session.list"] = { sessions: [item(NEW, "New session", false)], projects: ["/p/demo"] };
    await act(async () => create.resolve({ session: info }));
    await act(async () => {});
    expect(one(`[data-session-id="${NEW}"] [data-testid="title-skeleton"]`)).toBeTruthy();
    await act(async () => prompt.resolve({}));
    await act(async () => {});
    // The tab switched; the subscribe reply is still outstanding.
    expect(visible('[data-testid="starting-session"]')).toHaveLength(0);
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(1);
    // Not inside the "No session shown" hidden card (the tab strip card is `hidden` until a session is shown).
    expect(one('[data-testid="user-message"][data-pending]')!.closest(".hidden")).toBeNull();
    expect(one('[data-testid="session-state-skeleton"]')).toBeTruthy();
    await act(async () => subscribe.resolve({ logEpoch: "e1", seq: 0, session: info, title: "New session" }));
    await act(async () => emit({ type: "event", sessionId: NEW, seq: 1, part: { type: "user_text", id: "u1", text: "hello", images: [] } }));
    await act(async () => emit({ type: "event", sessionId: NEW, seq: 2, part: { type: "session_state", id: "st", state: "running" } }));
    expect(visible('[data-testid="user-message"]')).toHaveLength(1);
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(0);
    expect(one('[data-testid="session-state-skeleton"]')).toBeUndefined();
  });

  it("rejected: the new-session card comes back with the text and the error", async () => {
    replies["session.create"] = { session: info };
    replies["session.prompt"] = () => Promise.reject(new Error("boom"));
    await mount("#new");
    await type("hello");
    await enter();
    await act(async () => {});
    expect(visible('[data-testid="starting-session"]')).toHaveLength(0);
    expect(box().value).toBe("hello");
    expect(one('[data-testid="prompt-error"]')?.textContent).toContain("boom");
    expect(visible('[data-testid="user-message"]')).toHaveLength(0);
  });
});

describe("later prompts", () => {
  const open = async () => {
    replies["session.list"] = { sessions: [item(OLD, "Demo", true)], projects: ["/p/demo"] };
    replies["session.subscribe"] = { logEpoch: "e1", seq: 0, session: info && { ...info, id: OLD }, title: "Demo" };
    await mount(`#${OLD}`);
    await act(async () => {});
  };

  it("the bubble shows on Enter with the Thinking row, and once after the echo", async () => {
    const prompt = defer<unknown>();
    replies["session.prompt"] = () => prompt.promise;
    await open();
    await type("again");
    await enter();
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(1);
    expect(one('[data-testid="thinking"]')).toBeTruthy();
    await act(async () => emit({ type: "event", sessionId: OLD, seq: 1, part: { type: "user_text", id: "u1", text: "again", images: [] } }));
    expect(visible('[data-testid="user-message"]')).toHaveLength(1);
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(0);
    await act(async () => prompt.resolve({}));
    expect(visible('[data-testid="user-message"]')).toHaveLength(1);
  });

  it("a dialog command (/mcp) sends nothing and shows no bubble", async () => {
    replies["mcp.list"] = { servers: [] };
    await open();
    await type("/mcp");
    await enter();
    expect(sent.some((m) => m.type === "session.prompt")).toBe(false);
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(0);
  });

  it("a slash command whose turn ends without an echo leaves no pending bubble", async () => {
    replies["session.prompt"] = () => new Promise(() => {});
    await open();
    await type("/cost");
    await enter();
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(1);
    await act(async () => emit({ type: "event", sessionId: OLD, seq: 1, part: { type: "session_state", id: "st", state: "running" } }));
    await act(async () => emit({ type: "event", sessionId: OLD, seq: 2, part: { type: "assistant_text", id: "a1", text: "Total cost: $0", streaming: false } }));
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(1);
    await act(async () => emit({ type: "event", sessionId: OLD, seq: 3, part: { type: "turn_result", id: "r1", durationMs: 1, usage: {}, isError: false } }));
    await act(async () => emit({ type: "event", sessionId: OLD, seq: 4, part: { type: "session_state", id: "st", state: "idle" } }));
    expect(visible('[data-testid="user-message"]')).toHaveLength(0);
  });

  it("rejected: the bubble goes and the text is back in the box", async () => {
    replies["session.prompt"] = () => Promise.reject(new Error("nope"));
    await open();
    await type("again");
    await enter();
    await act(async () => {});
    expect(visible('[data-testid="user-message"]')).toHaveLength(0);
    expect(box().value).toBe("again");
  });

  it("the same text sent twice shows two bubbles until both echoes arrive", async () => {
    replies["session.prompt"] = () => new Promise(() => {});
    await open();
    await type("same");
    await enter();
    await type("same");
    await enter();
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(2);
    await act(async () => emit({ type: "event", sessionId: OLD, seq: 1, part: { type: "user_text", id: "u1", text: "same", images: [] } }));
    expect(visible('[data-testid="user-message"]')).toHaveLength(2);
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(1);
    await act(async () => emit({ type: "event", sessionId: OLD, seq: 2, part: { type: "user_text", id: "u2", text: "same", images: [] } }));
    expect(visible('[data-testid="user-message"]')).toHaveLength(2);
    expect(visible('[data-testid="user-message"][data-pending]')).toHaveLength(0);
  });
});
