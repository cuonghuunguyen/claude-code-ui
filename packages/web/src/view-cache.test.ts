import type { Part, SessionInfo } from "@claude-ui/protocol";
import { IDBFactory, IDBObjectStore as FDBObjectStore, IDBTransaction as FDBTransaction } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptySession, type SessionView } from "./store.ts";
import {
  chooseEvictions,
  createSaveScheduler,
  createViewCache,
  DB_NAME,
  MAX_AGE_MS,
  reviveView,
  serializeView,
  serializeViewRecord,
  tokenHash,
  trimToCap,
  type Timer,
  type ViewMeta,
} from "./view-cache.ts";

const info = (id: string): SessionInfo => ({ id, cwd: "/w", state: "idle", model: "m", permissionMode: "default", effort: "medium", permissionModes: ["default"] });
const user = (id: string, text = "q"): Part => ({ type: "user_text", id, text, images: [] });
const asst = (id: string, text = "a"): Part => ({ type: "assistant_text", id, text, streaming: false });
const view = (parts: Part[], over: Partial<SessionView> = {}): SessionView => ({
  ...emptySession(),
  logEpoch: "e1",
  lastSeq: 7,
  order: parts.map((p) => p.id),
  parts: new Map(parts.map((p) => [p.id, p])),
  ...over,
});
const turns = (n: number, size = 10): Part[] => Array.from({ length: n }, (_, i) => [user(`u${i}`, "q".repeat(size)), asst(`a${i}`, "a".repeat(size))]).flat();
const entry = (id: string, v = view([user("u1"), asst("a1")])) => ({ id, view: v, info: info(id), title: `t-${id}` });
const meta = (id: string, savedAt: number, chars = 10): ViewMeta => ({ id, savedAt, chars, trimmed: false });

/** A timer that only fires when the test says so. */
const manualTimer = () => {
  const pending = new Set<{ fn: () => void; ms: number }>();
  const setTimer: Timer = (fn, ms) => {
    const t = { fn, ms };
    pending.add(t);
    return () => pending.delete(t);
  };
  const fireAll = () => {
    const all = [...pending];
    pending.clear();
    all.forEach((t) => t.fn());
  };
  return { setTimer, fireAll, pending };
};
const fresh = (o: Parameters<typeof createViewCache>[0] = {}) => createViewCache({ factory: new IDBFactory(), ...o });
const noConsole = () => (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));

afterEach(() => vi.restoreAllMocks());

describe("serializeView / reviveView", () => {
  it("round trips Map order, aux, older and scalars", () => {
    const parts = [user("u1"), asst("a1"), user("u2"), asst("a2")];
    const aux = [{ part: asst("x1"), pos: 3 }];
    const v = view(parts, { aux, older: { before: "u1", pos: 5 }, todos: [{ content: "c", status: "pending" }], model: "opus", state: "running", attentionSeq: 4 });
    const back = reviveView(serializeView(v, info("s"), "T")!)!;
    expect([...back.view.parts.keys()]).toEqual(["u1", "a1", "u2", "a2"]);
    expect(back.view.order).toEqual(v.order);
    expect(back.view.parts.get("a2")).toEqual(parts[3]);
    expect(back.view.aux).toEqual(aux);
    expect(back.view.older).toEqual({ before: "u1", pos: 5 });
    expect(back.view).toMatchObject({ logEpoch: "e1", lastSeq: 7, model: "opus", state: "running", attentionSeq: 4, todos: v.todos });
    expect(back.info).toEqual(info("s"));
    expect(back.title).toBe("T");
    expect(back.trimmed).toBeUndefined();
  });

  it("does not store stale views or the aux flags", () => {
    expect(serializeView(view([user("u1")], { stale: true }), info("s"), "T")).toBeUndefined();
    const back = reviveView(serializeView(view([user("u1")], { auxEdits: true, auxArtifacts: true }), info("s"), "T")!)!;
    expect(back.view.auxEdits).toBeUndefined();
    expect(back.view.auxArtifacts).toBeUndefined();
  });

  it("rejects malformed json and other record versions", () => {
    expect(reviveView("{")).toBeUndefined();
    expect(reviveView(JSON.stringify({ v: 2, view: { parts: [] }, info: info("s"), title: "" }))).toBeUndefined();
  });
});

describe("trimToCap", () => {
  const v = view(turns(10, 1000), { older: { before: "u0", pos: 3 } });
  const full = serializeView(v, info("s"), "T")!;

  it("keeps the newest whole turns, marks trimmed, drops logEpoch and older", () => {
    const cap = Math.floor(full.length / 2);
    const json = serializeView(v, info("s"), "T", cap)!;
    expect(json.length).toBeLessThanOrEqual(cap);
    const back = reviveView(json)!;
    expect(back.trimmed).toBe(true);
    expect(back.view.logEpoch).toBeUndefined();
    expect(back.view.older).toBeUndefined();
    expect(back.view.lastSeq).toBe(7);
    const ids = back.view.order;
    expect(ids.length % 2).toBe(0);
    expect(ids[0]).toMatch(/^u/);
    expect(ids.at(-1)).toBe("a9");
    expect(ids.length).toBeLessThan(20);
    // the next larger number of turns would not fit
    const more = trimToCap({ ...v, order: v.order.slice(-(ids.length + 2)) }, info("s"), "T", cap + 100_000);
    expect(more).toBeDefined();
  });

  it("is not trimmed when it fits", () => {
    expect(reviveView(serializeView(v, info("s"), "T", full.length)!)!.trimmed).toBeUndefined();
  });

  it("returns undefined when aux alone is over the cap", () => {
    const big = view(turns(2), { aux: [{ part: asst("x", "z".repeat(5000)), pos: 1 }] });
    expect(serializeView(big, info("s"), "T", 3000)).toBeUndefined();
  });

  it("returns undefined when not even the newest turn fits", () => {
    expect(serializeView(view(turns(3, 5000)), info("s"), "T", 3000)).toBeUndefined();
  });
});

describe("chooseEvictions", () => {
  const now = 100 * MAX_AGE_MS;

  it("removes sessions missing from the last list only when a list is given", () => {
    const metas = [meta("a", now), meta("b", now)];
    expect(chooseEvictions(metas, new Set(["a"]), [], now)).toEqual(["b"]);
    expect(chooseEvictions(metas, undefined, [], now)).toEqual([]);
  });

  it("over the count cap drops non-tab views by oldest savedAt, open tabs last", () => {
    const metas = [meta("tabOld", now - 5000), meta("n1", now - 4000), meta("n2", now - 3000), meta("n3", now - 2000), meta("tabNew", now - 1000)];
    expect(chooseEvictions(metas, undefined, ["tabNew", "tabOld"], now, { maxSessions: 3 }).sort()).toEqual(["n1", "n2"]);
    expect(chooseEvictions(metas, undefined, ["tabNew", "tabOld"], now, { maxSessions: 1 }).sort()).toEqual(["n1", "n2", "n3", "tabOld"]);
  });

  it("over the total chars cap evicts in priority order", () => {
    const metas = [meta("tab", now - 9000, 60), meta("a", now - 1000, 60), meta("b", now - 2000, 60)];
    expect(chooseEvictions(metas, undefined, ["tab"], now, { maxTotalChars: 130 })).toEqual(["b"]);
    expect(chooseEvictions(metas, undefined, ["tab"], now, { maxTotalChars: 70 }).sort()).toEqual(["a", "b"]);
  });
});

describe("createSaveScheduler", () => {
  const make = () => {
    const t = manualTimer();
    let clock = 0;
    const saveViews = vi.fn();
    const saveList = vi.fn();
    const s = createSaveScheduler({ saveViews, saveList, setTimer: t.setTimer, now: () => clock });
    const fire = (at: number) => {
      clock = at;
      t.fireAll();
    };
    return { s, saveViews, saveList, fire, set: (n: number) => (clock = n), t };
  };

  it("debounces 2 s after the last change", () => {
    const { s, saveViews, fire, set } = make();
    s.markView("a");
    set(1500);
    s.markView("a");
    fire(2000);
    expect(saveViews).not.toHaveBeenCalled();
    fire(3500);
    expect(saveViews).toHaveBeenCalledWith(["a"]);
  });

  it("saves at most every 5 s per session and batches ids due together", () => {
    const { s, saveViews, fire, set } = make();
    s.markView("a");
    fire(2000);
    expect(saveViews).toHaveBeenLastCalledWith(["a"]);
    set(2100);
    s.markView("a");
    s.markView("b");
    fire(4200);
    expect(saveViews).toHaveBeenLastCalledWith(["b"]);
    fire(7000);
    expect(saveViews).toHaveBeenLastCalledWith(["a"]);
    expect(saveViews).toHaveBeenCalledTimes(3);
  });

  it("debounces the list 1 s", () => {
    const { s, saveList, fire } = make();
    s.markList();
    fire(900);
    expect(saveList).not.toHaveBeenCalled();
    fire(1000);
    expect(saveList).toHaveBeenCalledTimes(1);
  });

  it("flushAll saves everything dirty at once; dispose stops timers", () => {
    const { s, saveViews, saveList, t } = make();
    s.markView("a");
    s.markView("b");
    s.markList();
    s.flushAll();
    expect(saveViews).toHaveBeenCalledWith(["a", "b"]);
    expect(saveList).toHaveBeenCalledTimes(1);
    expect(t.pending.size).toBe(0);
    s.markView("c");
    s.dispose();
    expect(t.pending.size).toBe(0);
    s.flushAll();
    expect(saveViews).toHaveBeenCalledTimes(1);
  });
});

describe("createViewCache", () => {
  const H = tokenHash("tok-1");

  it("tokenHash is stable and differs per token", () => {
    expect(tokenHash("tok-1")).toBe(H);
    expect(tokenHash("tok-2")).not.toBe(H);
  });

  it("round trips meta, list and the views of the tabs", async () => {
    const c = fresh();
    await c.writeMeta({ daemonId: "d1", tokenHash: H });
    await c.saveList('{"sessions":[]}', 3);
    await c.saveViews([entry("s1"), entry("s2"), entry("s3")]);
    const h = await c.hydrate({ tokenHash: H, tabIds: ["s2", "s1", "nope"] });
    expect(h.meta).toEqual({ schema: 1, daemonId: "d1", tokenHash: H });
    expect(h.list).toEqual({ json: '{"sessions":[]}', version: 3 });
    expect([...h.views.keys()].sort()).toEqual(["s1", "s2"]);
    expect(h.views.get("s2")!.title).toBe("t-s2");
    expect(h.views.get("s1")!.view.order).toEqual(["u1", "a1"]);
    expect((await c.readView("s3"))!.info.id).toBe("s3");
    expect(await c.readView("zzz")).toBeUndefined();
  });

  it("a save puts and commits in the task it starts, before any read (a pagehide flush must not wait for a callback the unload drops)", async () => {
    const c = fresh();
    await c.writeMeta({ daemonId: "d1", tokenHash: H });
    const commit = vi.spyOn(FDBTransaction.prototype, "commit");
    try {
      const saved = Promise.all([c.saveViews([entry("s1")]), c.saveList('{"sessions":[]}', 4)]);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const scopes = commit.mock.contexts.map((t) => [...(t as IDBTransaction).objectStoreNames].sort().join());
      expect(scopes).toContain("viewData,viewMeta");
      expect(scopes).toContain("list");
      await saved;
      const h = await c.hydrate({ tokenHash: H, tabIds: ["s1"] });
      expect(h.views.has("s1")).toBe(true);
      expect(h.list?.version).toBe(4);
    } finally {
      commit.mockRestore();
    }
  });

  it("remove and clear delete entries", async () => {
    const c = fresh();
    await c.writeMeta({ daemonId: "d1", tokenHash: H });
    await c.saveViews([entry("s1"), entry("s2")]);
    await c.remove("s1");
    expect(await c.readView("s1")).toBeUndefined();
    expect(await c.readView("s2")).toBeDefined();
    await c.clear();
    expect(await c.readView("s2")).toBeUndefined();
    expect((await c.hydrate({ tokenHash: H, tabIds: [] })).meta).toBeUndefined();
  });

  it("skips views that are not cacheable and keeps the old record", async () => {
    const c = fresh();
    await c.saveViews([entry("s1")]);
    await c.saveViews([entry("s1", view([user("u9")], { stale: true }))]);
    expect((await c.readView("s1"))!.view.order).toEqual(["u1", "a1"]);
  });

  it("clears and returns empty on a token mismatch", async () => {
    const c = fresh();
    await c.writeMeta({ daemonId: "d1", tokenHash: H });
    await c.saveViews([entry("s1")]);
    const h = await c.hydrate({ tokenHash: tokenHash("other"), tabIds: ["s1"] });
    expect(h).toEqual({ views: new Map() });
    expect(await c.readView("s1")).toBeUndefined();
    expect((await c.hydrate({ tokenHash: H, tabIds: [] })).meta).toBeUndefined();
  });

  it("clears and returns empty on a schema mismatch", async () => {
    const factory = new IDBFactory();
    const c = createViewCache({ factory });
    await c.writeMeta({ daemonId: "d1", tokenHash: H });
    await c.saveViews([entry("s1")]);
    // another schema written by a later build
    const db = await new Promise<IDBDatabase>((res) => {
      const r = factory.open(DB_NAME, 1);
      r.onsuccess = () => res(r.result);
    });
    await new Promise<void>((res) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ schema: 2, daemonId: "d1", tokenHash: H }, "meta");
      tx.oncomplete = () => res();
    });
    db.close();
    const h = await createViewCache({ factory }).hydrate({ tokenHash: H, tabIds: ["s1"] });
    expect(h.views.size).toBe(0);
    expect(h.meta).toBeUndefined();
    expect(await createViewCache({ factory }).readView("s1")).toBeUndefined();
  });

  it("saveList removes unlisted sessions and entries older than 14 days", async () => {
    let t = 1_000_000_000_000;
    const c = fresh({ now: () => t });
    await c.saveViews([entry("old")]);
    t += MAX_AGE_MS + 1;
    await c.saveViews([entry("keep"), entry("gone")]);
    expect(await c.readView("old")).toBeUndefined();
    await c.saveList("{}", 1, { listedIds: ["keep"] });
    expect(await c.readView("gone")).toBeUndefined();
    expect(await c.readView("keep")).toBeDefined();
  });

  it("saveViews evicts over the session cap by priority, open tabs last", async () => {
    let t = 1_000_000;
    const c = fresh({ now: () => t });
    for (let i = 0; i < 60; i++) {
      t += 1000;
      await c.saveViews([entry(`s${i}`)]);
    }
    t += 1000;
    await c.saveViews([entry("extra")], { openTabsByUsed: ["s0"] });
    expect(await c.readView("s0")).toBeDefined();
    expect(await c.readView("extra")).toBeDefined();
    expect(await c.readView("s1")).toBeUndefined();
    expect(await c.readView("s2")).toBeDefined();
  });

  it("hydrate returns empty when it times out (open never answers)", async () => {
    const t = manualTimer();
    const c = createViewCache({ factory: { open: () => ({}) } as unknown as IDBFactory, setTimer: t.setTimer });
    const p = c.hydrate({ tokenHash: H, tabIds: [] });
    expect([...t.pending].map((x) => x.ms)).toEqual([300]);
    t.fireAll();
    expect(await p).toEqual({ views: new Map() });
  });
});

describe("failure rule: unavailable cache, nothing thrown, no console", () => {
  const exercise = async (c: ReturnType<typeof createViewCache>) => {
    const spies = noConsole();
    await expect(c.hydrate({ tokenHash: "x", tabIds: ["a"] })).resolves.toEqual({ views: new Map() });
    await expect(c.readView("a")).resolves.toBeUndefined();
    await expect(c.saveViews([entry("a")])).resolves.toBeUndefined();
    await expect(c.saveList("{}", 1)).resolves.toBeUndefined();
    await expect(c.writeMeta({ daemonId: "d", tokenHash: "x" })).resolves.toBeUndefined();
    await expect(c.remove("a")).resolves.toBeUndefined();
    await expect(c.clear()).resolves.toBeUndefined();
    await expect(c.destroy()).resolves.toBeUndefined();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(c.available).toBe(false);
  };

  it("indexedDB undefined", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      await exercise(createViewCache());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("open throws", async () => {
    await exercise(createViewCache({ factory: { open: () => { throw new Error("denied"); } } as unknown as IDBFactory }));
  });

  it("open fires an error", async () => {
    const factory = {
      open: () => {
        const req: Record<string, unknown> = { error: new Error("boom") };
        queueMicrotask(() => (req.onerror as () => void)());
        return req;
      },
    } as unknown as IDBFactory;
    await exercise(createViewCache({ factory }));
  });

  it("put throws QuotaExceededError", async () => {
    const factory = new IDBFactory();
    const c = createViewCache({ factory });
    await c.saveViews([entry("seed")]);
    const spy = vi.spyOn(FDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const logs = noConsole();
    await expect(c.saveViews([entry("a")])).resolves.toBeUndefined();
    expect(c.available).toBe(false);
    spy.mockRestore();
    await expect(c.saveViews([entry("b")])).resolves.toBeUndefined();
    await expect(c.readView("seed")).resolves.toBeUndefined();
    for (const s of logs) expect(s).not.toHaveBeenCalled();
  });

  it("blocked open longer than 3 s", async () => {
    const t = manualTimer();
    const factory = {
      open: () => {
        const req: Record<string, unknown> = {};
        queueMicrotask(() => (req.onblocked as () => void)());
        return req;
      },
    } as unknown as IDBFactory;
    const c = createViewCache({ factory, setTimer: t.setTimer });
    const p = c.saveViews([entry("a")]);
    await Promise.resolve();
    await Promise.resolve();
    expect([...t.pending].map((x) => x.ms)).toEqual([3000]);
    t.fireAll();
    await expect(p).resolves.toBeUndefined();
    expect(c.available).toBe(false);
  });

  it("a connection of another page lets go when the database is deleted (unpair does not block)", async () => {
    const factory = new IDBFactory();
    const other = createViewCache({ factory });
    const mine = createViewCache({ factory });
    await other.writeMeta({ daemonId: "d", tokenHash: "h" });
    await mine.writeMeta({ daemonId: "d", tokenHash: "h" });
    await mine.destroy();
    expect((await factory.databases()).map((d) => d.name)).not.toContain(DB_NAME);
    expect(other.available).toBe(false);
  });
});

describe("serializeViewRecord", () => {
  it("trimmed is the fact of the cut, not a search in the text", () => {
    const text: Part = { type: "assistant_text", id: "a1", text: 'tool output {"trimmed":true}', streaming: false };
    const r = serializeViewRecord(view([text]), info("s"), "T")!;
    expect(r.json).toContain("trimmed");
    expect(r.trimmed).toBe(false);
  });
});
