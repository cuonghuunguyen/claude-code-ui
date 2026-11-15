// @vitest-environment jsdom
// GH-771: App wiring of the view cache (view-cache.ts): hydrate before the socket opens, resume from the cached view, daemon identity, save, unpair.
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
type Opts = { onEvents: (es: unknown[]) => void; onOpen?: (h: Hello) => void; onStatus?: (s: string) => void };
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

describe("view cache in the app (GH-771)", () => {
  it("renders the cached view and list before the socket opens", async () => {
    await seed();
    await mount();
    expect(el.textContent).toContain("cached answer");
    expect(el.textContent).toContain("cached prompt");
    expect(el.querySelector('[data-testid="tab-strip"] [data-testid="tab"]')?.textContent).toContain("Demo");
    // The git panel of the cached view may ask for its status; nothing of the resync (list, subscribe) goes out before the hello.
    expect(sent.filter((m) => m.type !== "git.status")).toEqual([]);
  });

  it("the cached view is in the DOM before any socket event can run (a fast open must not batch into the first cached render)", async () => {
    await seed();
    shownAtConnect = false;
    await mount();
    expect(shownAtConnect).toBe(true);
  });

  it("same epoch: the first list asks since the cached version and the subscribe resumes with sinceSeq, no known", async () => {
    await seed();
    await mount();
    await open({ daemonId: "d1", logEpoch: "e1" });
    expect(sent.find((m) => m.type === "session.list")?.since).toBe("v1");
    const s = subs();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ sinceSeq: 7, logEpoch: "e1" });
    expect(s[0]).not.toHaveProperty("known");
    expect(el.textContent).toContain("cached answer");
  });

  it("new epoch: known goes out, the reply's refs merge into the cached parts", async () => {
    await seed();
    replies["session.subscribe"] = {
      logEpoch: "e2",
      seq: 3,
      session: info,
      snapshot: { refs: true, heads: [], attentionSeq: 0, page: { parts: [{ ref: "u1" }, { ref: "a1" }, { type: "assistant_text", id: "a2", text: "fresh answer", streaming: false }] }, aux: [] },
    };
    await mount();
    await open({ daemonId: "d1", logEpoch: "e2" });
    expect(subs()[0]!.known).toEqual([["a1", partHash(answer)], ["u1", partHash(user)]]);
    expect(el.textContent).toContain("cached prompt");
    expect(el.textContent).toContain("cached answer");
    expect(el.textContent).toContain("fresh answer");
  });

  it("a reply that refers to a part the view does not hold is asked again as a plain snapshot", async () => {
    await seed();
    let n = 0;
    replies["session.subscribe"] = (m: { known?: unknown }) =>
      ++n === 1
        ? { logEpoch: "e2", seq: 3, session: info, snapshot: { refs: true, heads: [], attentionSeq: 0, page: { parts: [{ ref: "gone" }] }, aux: [] } }
        : { logEpoch: "e2", seq: 3, session: info, snapshot: { heads: [], attentionSeq: 0, page: { parts: [{ type: "assistant_text", id: "p1", text: "plain page", streaming: false }] }, aux: [] }, known: m.known };
    await mount();
    await open({ daemonId: "d1", logEpoch: "e2" });
    const s = subs();
    expect(s).toHaveLength(2);
    expect(s[1]).not.toHaveProperty("known");
    expect(s[1]).toMatchObject({ sinceSeq: 0 });
    expect(el.textContent).toContain("plain page");
  });

  it("another daemonId clears the cache and the views", async () => {
    await seed();
    await mount();
    expect(el.textContent).toContain("cached answer");
    await open({ daemonId: "other", logEpoch: "e9" });
    expect(el.textContent).not.toContain("cached answer");
    expect(await stored()).toBeUndefined();
    expect(subs()[0]).toMatchObject({ sinceSeq: 0 });
    expect(subs()[0]).not.toHaveProperty("known");
    const h = await createViewCache().hydrate({ tokenHash: tokenHash("tok"), tabIds: [ID] });
    expect(h.meta?.daemonId).toBe("other");
  });

  it("no hello (older daemon): the views stay, the cache is not cleared", async () => {
    await seed();
    await mount();
    await open(undefined);
    expect(el.textContent).toContain("cached answer");
    expect(await stored()).toBeDefined();
    expect(subs()[0]).toMatchObject({ sinceSeq: 7, logEpoch: "e1" });
  });

  it("unauthorized deletes the database", async () => {
    await seed();
    await mount();
    expect((await indexedDB.databases()).map((d) => d.name)).toContain("claude-ui-cache");
    await act(async () => opts.onStatus?.("unauthorized"));
    await wait(120);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain("claude-ui-cache");
  });

  it("saves a changed view 2 s after the change, and at once on pagehide", async () => {
    await seed();
    await mount();
    await open({ daemonId: "d1", logEpoch: "e1" });
    await act(async () => opts.onEvents([{ type: "event", sessionId: ID, seq: 8, part: { type: "assistant_text", id: "a2", text: "later answer", streaming: false } }]));
    await wait(100);
    expect((await stored())?.view.lastSeq).toBe(7);
    await act(async () => void window.dispatchEvent(new Event("pagehide")));
    await wait(100);
    const v = (await stored())!.view;
    expect(v.lastSeq).toBe(8);
    expect(v.parts.get("a2")).toMatchObject({ text: "later answer" });
  });

  it("a list that came from the server is saved for the next load", async () => {
    await seed();
    await mount();
    await open({ daemonId: "d1", logEpoch: "e1" });
    await act(async () => void window.dispatchEvent(new Event("pagehide")));
    await wait(100);
    const h = await createViewCache().hydrate({ tokenHash: tokenHash("tok"), tabIds: [] });
    expect(h.list?.version).toBe("v2");
  });

  it("storage blocked (the indexedDB getter throws): the app renders and loads the session without a cache", async () => {
    const own = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() {
      throw new Error("blocked");
    } });
    try {
      hold = false;
      replies["session.subscribe"] = { logEpoch: "e1", seq: 2, session: info, snapshot: { heads: [], attentionSeq: 0, page: { parts: [user, answer] }, aux: [] } };
      await mount();
      expect(el.querySelector('[data-testid="tab-strip"]')).not.toBeNull();
      expect(el.textContent).toContain("cached answer");
    } finally {
      if (own) Object.defineProperty(globalThis, "indexedDB", own);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

  it("a deleted session leaves the cache", async () => {
    await seed();
    await mount();
    await open({ daemonId: "d1", logEpoch: "e1" });
    const handlers = opts as unknown as { onSessionsChanged: (m: unknown) => void };
    await act(async () => handlers.onSessionsChanged({ type: "sessions.changed", deleted: ID }));
    await wait(100);
    expect(await stored()).toBeUndefined();
  });
});
