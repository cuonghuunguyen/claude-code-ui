// @vitest-environment jsdom
// Paged session timeline (GH-137): paged subscribe, older pages on reaching the top, the fresh snapshot when the cursor is gone.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Part, SessionListItem, Snapshot } from "@claude-ui/protocol";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
// jsdom has no layout: the timeline's scroll element is 600px high and scrolled to 0, so it is within a viewport of the top.
let layout = true;
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get() {
    return layout && this.getAttribute?.("role") === "log" ? 600 : 0;
  },
});

const ID = "11111111-2222-3333-4444-555555555555";
const session: SessionListItem = { id: ID, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"], title: "Demo", lastActivity: 0, archived: false, transcript: true };
const user = (id: string): Part => ({ type: "user_text", id, text: `prompt ${id}`, images: [] });
const answer = (id: string): Part => ({ type: "assistant_text", id, text: `answer ${id}`, streaming: false });
const snapshot: Snapshot = { heads: [], attentionSeq: 0, page: { parts: [user("u3"), answer("a3")], older: { before: "u3", pos: 30 } }, aux: [] };

let reopen: () => void = () => {};
const replies: Record<string, (m: { [k: string]: unknown }) => unknown> = {};
const sent: { type: string; [k: string]: unknown }[] = [];
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (opts: { onEvent: (e: unknown) => void; onOpen?: () => void; onStatus?: (s: string) => void }) => {
    reopen = () => opts.onOpen?.();
    queueMicrotask(() => (opts.onStatus?.("connected"), opts.onOpen?.()));
    return {
      request: async (m: { type: string }) => (sent.push(m), (replies[m.type] ?? (() => ({})))(m)),
      onFsChanged: () => () => {},
      onTerminal: () => () => {},
      close() {},
    };
  },
}));
const { App } = await import("./App.tsx");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot> | undefined;
async function mount(hash = `#${ID}`) {
  location.hash = hash;
  el = document.createElement("div");
  document.body.append(el);
  const r = (root = createRoot(el));
  await act(async () => r.render(<App />));
  await act(async () => {});
  await act(async () => {});
}
beforeEach(() => {
  layout = true;
  sent.length = 0;
  replies["session.list"] = () => ({ sessions: [session], projects: ["/p/demo"] });
  replies["models.list"] = () => ({ models: [] });
  replies["session.edits"] = () => ({ parts: [] });
  replies["session.subscribe"] = () => ({ logEpoch: "e1", seq: 100, session, snapshot });
  replies["session.page"] = () => ({ page: { parts: [user("u1"), answer("a1"), user("u2"), answer("a2")] } });
});
afterEach(() => {
  if (root) act(() => root!.unmount()), el.remove();
  root = undefined;
});
const messages = () => [...document.querySelectorAll("[data-testid=user-message]")].map((n) => /^prompt u\d/.exec(n.textContent ?? "")?.[0]);

it("opening a session subscribes paged and renders the last page; reaching the top requests session.page with the cursor and prepends it", async () => {
  await mount();
  const sub = sent.find((m) => m.type === "session.subscribe")!;
  expect(sub).toMatchObject({ sessionId: ID, sinceSeq: 0, paged: true });
  expect(sent.find((m) => m.type === "session.page")).toMatchObject({ sessionId: ID, logEpoch: "e1", before: "u3" });
  expect(messages()).toEqual(["prompt u1", "prompt u2", "prompt u3"]);
  // The start of the session is loaded: no further page is requested.
  expect(sent.filter((m) => m.type === "session.page")).toHaveLength(1);
});

it("unknown_cursor from session.page resubscribes from scratch (a fresh snapshot, no from)", async () => {
  const page = replies["session.page"]!;
  // The cursor is gone once; the fresh snapshot's cursor is good.
  replies["session.page"] = (m) => {
    replies["session.page"] = page;
    return Promise.reject(Object.assign(new Error("no part u3"), { code: "unknown_cursor" }));
  };
  await mount();
  const subs = sent.filter((m) => m.type === "session.subscribe");
  expect(subs.length).toBeGreaterThanOrEqual(2);
  expect(subs[1]).toMatchObject({ sinceSeq: 0, paged: true });
  expect(subs[1]).not.toHaveProperty("from");
});

it("a page error that is not a cursor error is shown once and the same cursor is not retried on every render", async () => {
  replies["session.page"] = () => Promise.reject(Object.assign(new Error("boom"), { code: "internal_error" }));
  await mount();
  for (let i = 0; i < 4; i++) await act(async () => {});
  expect(sent.filter((m) => m.type === "session.page")).toHaveLength(1);
  expect(document.body.textContent).toContain("boom");
});

it("stale_epoch from session.page resubscribes with the oldest loaded turn (from), not from scratch", async () => {
  const page = replies["session.page"]!;
  replies["session.page"] = () => {
    replies["session.page"] = page;
    return Promise.reject(Object.assign(new Error("restarted"), { code: "stale_epoch" }));
  };
  await mount();
  const subs = sent.filter((m) => m.type === "session.subscribe");
  // The resubscribe after the stale reply holds a view: it continues from its seq and names the oldest loaded turn.
  expect(subs.at(-1)).toMatchObject({ paged: true, from: "u3", sinceSeq: 100 });
});

const run: Part = { type: "subagent", id: "ar", toolUseId: "ar", description: "Old run", status: "done", startedAt: 1, endedAt: 2 };
const withRun = () => {
  layout = false;
  replies["session.subscribe"] = () => ({ logEpoch: "e1", seq: 100, session, snapshot: { ...snapshot, aux: [{ part: run, pos: 10 }] } });
  replies["session.page"] = () => ({ page: { parts: [user("u1"), run, { ...answer("ac"), parentId: "ar" }] } });
};

it("a run opened by URL that is only known from aux loads back to it with until", async () => {
  withRun();
  await mount(`#${ID}/agent/ar`);
  await act(async () => {});
  expect(sent.find((m) => m.type === "session.page")).toMatchObject({ before: "u3", until: "ar" });
});

it("openRun from the agent map loads back to a run that is only in aux before showing it", async () => {
  withRun();
  await mount();
  expect(sent.find((m) => m.type === "session.page")).toBeUndefined();
  await act(async () => document.querySelector<HTMLElement>('[data-testid="agents-button"]')!.click());
  const node = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((n) => /Old run/.test(n.getAttribute("aria-label") ?? ""))!;
  await act(async () => node.click());
  await act(async () => {});
  expect(sent.find((m) => m.type === "session.page")).toMatchObject({ before: "u3", until: "ar" });
  expect(location.hash).toContain("/agent/ar");
});

it("a page error blocks the cursor; a socket reconnect clears it and the next layout pass loads the page", async () => {
  const page = replies["session.page"]!;
  replies["session.page"] = () => Promise.reject(Object.assign(new Error("side not ready"), { code: "side_not_ready" }));
  await mount();
  for (let i = 0; i < 3; i++) await act(async () => {});
  expect(sent.filter((m) => m.type === "session.page")).toHaveLength(1);
  replies["session.page"] = page;
  await act(async () => reopen());
  for (let i = 0; i < 3; i++) await act(async () => {});
  expect(sent.filter((m) => m.type === "session.page").length).toBeGreaterThanOrEqual(2);
  expect(messages()).toEqual(["prompt u1", "prompt u2", "prompt u3"]);
});

it("scroll events after a failed page retry that cursor at most once per few seconds, with one toast", async () => {
  let n = 0;
  replies["session.page"] = () => Promise.reject(Object.assign(new Error(`boom ${++n}`), { code: "internal_error" }));
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    await mount();
    const log = document.querySelector<HTMLElement>('[role="log"]')!;
    const scroll = async () => act(async () => void log.dispatchEvent(new Event("scroll")));
    for (let i = 0; i < 5; i++) await scroll();
    expect(sent.filter((m) => m.type === "session.page")).toHaveLength(1);
    now.mockReturnValue(1_000_000 + 5_000);
    for (let i = 0; i < 5; i++) await scroll();
    expect(sent.filter((m) => m.type === "session.page")).toHaveLength(2);
    // The retry failed again: still the first toast.
    expect(document.body.textContent).toContain("boom 1");
    expect(document.body.textContent).not.toContain("boom 2");
  } finally {
    now.mockRestore();
  }
});
