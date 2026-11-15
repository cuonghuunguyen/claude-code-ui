// @vitest-environment jsdom
// GH-771: the per-connection resets run before the cache check, so update/stale messages of the daemon hello burst are kept.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { partHash, type Part, type SessionInfo, type SessionListItem } from "@claude-ui/protocol";

Element.prototype.scrollIntoView ??= () => {};
window.matchMedia = ((query: string) => ({
  get matches() {
    const min = /min-width: (\d+)px/.exec(query);
    return min ? 1440 >= +min[1]! : false;
  },
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as never;

const ID = "11111111-2222-3333-4444-555555555555";
const info: SessionInfo = { id: ID, cwd: "/p/demo", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"] };
const item: SessionListItem = { ...info, title: "Demo", lastActivity: 0, archived: false, transcript: true };
const user: Part = { type: "user_text", id: "u1", text: "cached prompt", images: [] };
const answer: Part = { type: "assistant_text", id: "a1", text: "cached answer", streaming: false };
const replies: Record<string, unknown> = {};
const sent: { type: string; [k: string]: unknown }[] = [];
type Hello = { daemonId: string; logEpoch: string } | undefined;
type Opts = { onEvents: (es: unknown[]) => void; onOpen?: (h: Hello) => void; onStatus?: (s: string) => void; onStale?: (n: string) => void };
let opts!: Opts;
let hold = false;
/** Whether the cached answer was in the DOM at the first microtask after connect() (before any socket event could run). */
let shownAtConnect = false;
vi.mock("@xterm/xterm", () => ({ Terminal: class { options = {}; cols = 80; rows = 24; loadAddon() {} open() {} focus() {} write() {} reset() {} onData() {} onResize() {} onSelectionChange() {} onScroll() {} attachCustomKeyEventHandler() {} dispose() {} } }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("./client.ts", async (orig) => ({
  ...(await orig<typeof import("./client.ts")>()),
  connect: (o: Opts) => {
    opts = o;
    queueMicrotask(() => (shownAtConnect = document.body.textContent?.includes("cached answer") ?? false));
    if (!hold) queueMicrotask(() => (o.onStatus?.("connected"), o.onOpen?.(undefined)));
    return { request: async (m: { type: string }) => (sent.push(m), typeof replies[m.type] === "function" ? (replies[m.type] as (m: unknown) => unknown)(m) : (replies[m.type] ?? {})), search: async () => ({}), onFsChanged: () => () => {}, onTerminal: () => () => {}, close() {} };
  },
}));
const { App } = await import("./App.tsx");
const { createViewCache, tokenHash } = await import("./view-cache.ts");
const { emptySession } = await import("./store.ts");
const { saveTabs } = await import("./tabs.ts");

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const wait = (ms = 80) => act(async () => new Promise((r) => setTimeout(r, ms)));
const mount = async () => {
  location.hash = `#${ID}`;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<App />));
  await wait();
};
const cachedView = (epoch = "e1", lastSeq = 7) => ({ ...emptySession(), logEpoch: epoch, lastSeq, order: ["u1", "a1"], parts: new Map<string, Part>([["u1", user], ["a1", answer]]) });
/** What a previous page life left in IndexedDB. */
async function seed(o: { daemonId?: string; epoch?: string; lastSeq?: number } = {}) {
  localStorage.setItem("claude-ui.token", "tok");
  saveTabs([ID]);
  const c = createViewCache();
  await c.writeMeta({ daemonId: o.daemonId ?? "d1", tokenHash: tokenHash("tok") });
  await c.saveViews([{ id: ID, view: cachedView(o.epoch, o.lastSeq), info, title: "Demo" }]);
  await c.saveList(JSON.stringify({ sessions: [item], projects: ["/p/demo"], version: "v1" }), "v1");
}
const open = (hello: Hello) => act(async () => (opts.onStatus?.("connected"), opts.onOpen?.(hello), await new Promise((r) => setTimeout(r, 60))));
const subs = () => sent.filter((m) => m.type === "session.subscribe" && m.sessionId === ID);
const stored = () => createViewCache().readView(ID);

beforeEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  sent.length = 0;
  hold = true;
  for (const k of Object.keys(replies)) delete replies[k];
  Object.assign(replies, {
    "session.list": { sessions: [item], projects: ["/p/demo"], version: "v2" },
    "session.subscribe": { logEpoch: "e1", seq: 7, session: info },
    "models.list": { models: [] },
    "fs.list": { entries: [] },
    "fs.search": { paths: [] },
  });
});
afterEach(() => (act(() => root.unmount()), el.remove(), window.dispatchEvent(new Event("pagehide")), localStorage.clear()));

// the daemon sends daemon_hello, then update/stale messages in the same burst (server.ts connect).
// resume() runs in a promise callback after onOpen: it must not reset update/stale (those resets stay synchronous in onOpen), or it would wipe what those later messages set.
describe("hello burst", () => {
  it("cache meta known: a daemon_stale note right after the hello stays shown", async () => {
    await seed();
    await mount();
    await act(async () => (opts.onStatus?.("connected"), opts.onOpen?.({ daemonId: "d1", logEpoch: "e1" }), opts.onStale?.("STALE-NOTE-X"), await new Promise((r) => setTimeout(r, 200))));
    expect(document.body.textContent).toContain("STALE-NOTE-X");
  });
  it("first-ever load (meta read at the hello): a daemon_stale note right after the hello stays shown", async () => {
    localStorage.setItem("claude-ui.token", "tok");
    saveTabs([ID]);
    await mount();
    await act(async () => (opts.onStatus?.("connected"), opts.onOpen?.({ daemonId: "d1", logEpoch: "e1" }), opts.onStale?.("STALE-NOTE-X"), await new Promise((r) => setTimeout(r, 200))));
    expect(document.body.textContent).toContain("STALE-NOTE-X");
  });
});
