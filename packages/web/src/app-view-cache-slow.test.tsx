// @vitest-environment jsdom
// GH-771: a cache read slower than the 300 ms cap is "unknown", not "another daemon": the cache is kept, and the late result is applied while nothing newer is.
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


/** An IDBFactory whose open() answers after `ms`. */
function slowFactory(real: IDBFactory, ms = 400) {
  return {
    open(name: string, v?: number) {
      const fake: Record<string, unknown> = {};
      setTimeout(() => {
        const r = real.open(name, v);
        r.onupgradeneeded = (e) => ((fake.result = r.result), (fake.onupgradeneeded as ((e: unknown) => void) | undefined)?.(e));
        r.onsuccess = (e) => ((fake.result = r.result), (fake.onsuccess as ((e: unknown) => void) | undefined)?.(e));
        r.onerror = (e) => ((fake.error = r.error), (fake.onerror as ((e: unknown) => void) | undefined)?.(e));
      }, ms);
      return fake;
    },
    deleteDatabase: (n: string) => real.deleteDatabase(n),
    databases: () => real.databases(),
    cmp: (a: unknown, b: unknown) => real.cmp(a, b),
  };
}
const useSlow = (ms = 400) => {
  const real = (globalThis as { indexedDB: IDBFactory }).indexedDB;
  (globalThis as { indexedDB: unknown }).indexedDB = slowFactory(real, ms);
  return () => ((globalThis as { indexedDB: unknown }).indexedDB = real);
};

describe("view cache read slower than the cap", () => {
  it("the same daemon keeps its cache and resumes from the late view", async () => {
    await seed();
    const restore = useSlow();
    await mount();
    await wait(600);
    restore();
    await open({ daemonId: "d1", logEpoch: "e1" });
    await wait(200);
    expect((await stored())?.view.lastSeq).toBe(7);
    expect(subs()[0]).toMatchObject({ sinceSeq: 7, logEpoch: "e1" });
  });

  it("the late result is drawn when no hello and no real list came before it", async () => {
    await seed();
    const restore = useSlow();
    await mount();
    expect(document.body.textContent).not.toContain("cached answer");
    await wait(600);
    restore();
    expect(document.body.textContent).toContain("cached answer");
  });

  it("the late result is dropped after the hello: it does not bring back what the real list removed", async () => {
    await seed();
    replies["session.list"] = { sessions: [], projects: [], version: "v2" };
    const restore = useSlow(1000);
    await mount();
    await wait(300);
    await open({ daemonId: "d1", logEpoch: "e1" });
    await wait(900);
    restore();
    expect(document.body.textContent).not.toContain("Demo");
  });

  it("another stored daemon is still cleared on its hello", async () => {
    await seed({ daemonId: "d1" });
    const restore = useSlow();
    await mount();
    await wait(600);
    restore();
    await open({ daemonId: "d2", logEpoch: "e9" });
    await wait(200);
    expect(subs()[0]).toMatchObject({ sinceSeq: 0 });
    expect(await createViewCache().hydrate({ tokenHash: tokenHash("tok"), tabIds: [ID] }).then((h) => [h.meta?.daemonId, h.views.size])).toEqual(["d2", 0]);
  });

  it("a first-ever load (no stored meta) writes the meta", async () => {
    localStorage.setItem("claude-ui.token", "tok");
    saveTabs([ID]);
    await mount();
    await open({ daemonId: "d1", logEpoch: "e1" });
    await wait(200);
    expect((await createViewCache().hydrate({ tokenHash: tokenHash("tok"), tabIds: [] })).meta?.daemonId).toBe("d1");
  });
});

describe("page-load hash session and the cached list", () => {
  it("the first real list does not close it when its project was removed while the page was closed", async () => {
    await seed();
    replies["session.list"] = { sessions: [], projects: [], version: "v2" };
    await mount();
    await open({ daemonId: "d1", logEpoch: "e1" });
    await wait(200);
    expect(location.hash).toBe(`#${ID}`);
  });
});
