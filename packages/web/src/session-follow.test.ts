import type { SessionListItem, SubscribeResult } from "@claude-ui/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionFollow, type FollowHost } from "./session-follow.ts";
import { emptySession, type SessionView } from "./store.ts";

type Msg = { type: string; sessionId: string; background?: boolean; from?: string; sinceSeq?: number; addProject?: boolean };
type Call = { msg: Msg; ok(v?: unknown): void; fail(code: string, message?: string): void };

const flush = () => vi.advanceTimersByTimeAsync(0);
const reply = (id: string): SubscribeResult => ({ logEpoch: "e1", seq: 7, title: id, session: { id } as never });
const error = (code: string, message = code) => Object.assign(new Error(message), { code });

/** A `Client` whose requests wait until the test settles them (or `auto` answers them at once). */
function fakeClient(auto?: (msg: Msg) => unknown) {
  const calls: Call[] = [];
  const request = (msg: Msg) =>
    new Promise((resolve, reject) => {
      if (auto) {
        try {
          return resolve(auto(msg));
        } catch (e) {
          return reject(e);
        }
      }
      calls.push({ msg, ok: (v) => resolve(v ?? reply(msg.sessionId)), fail: (code, message) => reject(error(code, message)) });
    });
  const of = (type: string) => calls.filter((c) => c.msg.type === type);
  return { client: { request } as never, calls, of, subs: () => of("session.subscribe") };
}

function setup(over: Partial<FollowHost> = {}, auto?: (msg: Msg) => unknown) {
  const fake = fakeClient(auto);
  let clock = 1_000_000;
  const listed = new Map<string, SessionListItem>();
  const shown = new Map<string, "hash" | "aside" | "tab">();
  const unread = new Set<string>();
  const host = {
    client: () => fake.client,
    listed: (id: string) => listed.get(id),
    isLocal: () => true,
    shownAs: (id: string) => shown.get(id),
    hashId: () => [...shown].find(([, v]) => v === "hash")?.[0],
    unread: (id: string) => unread.has(id),
    pageVisible: () => true,
    onScreen: () => true,
    refreshList: vi.fn(() => Promise.resolve()),
    replied: vi.fn(),
    dropped: vi.fn(),
    gone: vi.fn(),
    failed: vi.fn(),
    error: vi.fn(),
    now: () => clock,
    ...over,
  } satisfies FollowHost;
  const follow = createSessionFollow(host);
  return { follow, host, fake, listed, shown, unread, advance: (ms: number) => (clock += ms) };
}

const row = (id: string, state: SessionListItem["state"] = "running", extra: Partial<SessionListItem> = {}) => ({ id, state, lastActivity: 1_000_000, cwd: "/p", ...extra }) as SessionListItem;
const view = (extra: Partial<SessionView> = {}): SessionView => ({ ...emptySession(), ...extra });
/** A view with an older page to load. */
const paged = () => view({ logEpoch: "e1", older: { before: "c1", pos: 3 }, order: ["u1"], parts: new Map([["u1", { type: "user_text", id: "u1", text: "hi" } as never]]) });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("reconnect with hundreds of Sessions", () => {
  const seedMany = (t: ReturnType<typeof setup>) => {
    for (let i = 0; i < 300; i++) t.follow.seed(`s${i}`, view());
    t.shown.set("s0", "hash");
    t.shown.set("s1", "tab");
    t.follow.opened(undefined);
  };

  it("shown Sessions resubscribe at once holding; background ones wait for the list and the shown ones, at most 4 in flight, every one in the end", async () => {
    let release!: () => void;
    const list = new Promise<void>((r) => (release = r));
    const t = setup({ refreshList: () => list });
    seedMany(t);
    void t.follow.resync();
    await flush();
    expect(t.fake.subs().map((c) => [c.msg.sessionId, !!c.msg.background])).toEqual([["s0", false], ["s1", false]]);
    t.fake.subs().forEach((c) => c.ok());
    await flush();
    expect(t.fake.subs()).toHaveLength(2); // the list is still out
    expect(t.follow.synced()).toBe(false);
    release();
    await flush();
    expect(t.follow.synced()).toBe(true);
    const done = new Set<string>();
    let max = 0;
    for (let guard = 0; guard < 400; guard++) {
      const open = t.fake.subs().filter((c) => c.msg.background && !done.has(c.msg.sessionId));
      max = Math.max(max, open.length);
      if (!open.length) break;
      for (const c of open) (done.add(c.msg.sessionId), c.ok());
      await flush();
    }
    expect(max).toBe(4);
    expect(done.size).toBe(298);
  });

  it("goes on after 15 s when a shown subscribe hangs", async () => {
    const t = setup();
    seedMany(t);
    void t.follow.resync();
    await flush();
    expect(t.fake.subs()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(t.fake.subs()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fake.subs().filter((c) => c.msg.background)).toHaveLength(4);
  });

  it("a second connection stops the queue of the old one", async () => {
    const t = setup();
    seedMany(t);
    const resync = t.follow.resync();
    await flush();
    t.fake.subs().forEach((c) => c.ok());
    await flush();
    const first = t.fake.subs().filter((c) => c.msg.background);
    expect(first).toHaveLength(4);
    t.follow.opened(undefined);
    first.forEach((c) => c.ok());
    await flush();
    await resync;
    expect(t.fake.subs().filter((c) => c.msg.background)).toHaveLength(4);
  });

  it("a background view of a Session that is not live is dropped unless it is unread, without unsubscribing", async () => {
    const t = setup();
    t.follow.seed("idle", view());
    t.follow.seed("kept", view());
    t.listed.set("idle", row("idle", "idle", { live: false }));
    t.listed.set("kept", row("kept", "idle", { live: false }));
    t.unread.add("kept");
    t.follow.opened(undefined);
    void t.follow.resync();
    await flush();
    expect(Object.keys(t.follow.views())).toEqual(["kept"]);
    expect(t.host.dropped).toHaveBeenCalledWith("idle");
    expect(t.fake.of("session.unsubscribe")).toHaveLength(0);
  });
});

describe("side_not_ready burst", () => {
  const sideStopped = (calls: string[] = []) => (msg: Msg) => {
    calls.push(msg.sessionId);
    throw error("side_not_ready", "side stopped");
  };
  const ids = Array.from({ length: 50 }, (_, i) => `s${i}`);

  it("one failure report for 50 Sessions", async () => {
    const t = setup({}, sideStopped());
    t.follow.opened(undefined);
    ids.forEach((id) => t.follow.ensure(id));
    await flush();
    expect(t.host.failed).toHaveBeenCalledTimes(1);
    expect(t.host.failed).toHaveBeenCalledWith(ids, "side stopped");
  });

  it("a list reply does not ask again; a side that became ready asks each once", async () => {
    const calls: string[] = [];
    const t = setup({}, sideStopped(calls));
    const gen = t.follow.opened(undefined);
    const rows = ids.map((id) => row(id));
    t.follow.listReplied(gen, rows, []);
    await flush();
    expect(calls).toHaveLength(50);
    t.follow.listReplied(gen, rows, []);
    await flush();
    expect(calls).toHaveLength(50);
    t.follow.listReplied(gen, rows, ["side1"]);
    await flush();
    expect(calls).toHaveLength(100);
    expect(new Set(calls.slice(50)).size).toBe(50);
  });
});

describe("paging", () => {
  const stale = (code: string, sent: Msg[]) => (msg: Msg) => {
    sent.push(msg);
    if (msg.type === "session.page") throw error(code);
    return reply(msg.sessionId);
  };

  it("stale_epoch resubscribes from the oldest loaded turn and keeps a held Session held", async () => {
    const sent: Msg[] = [];
    const t = setup({}, stale("stale_epoch", sent));
    t.follow.seed("a", paged());
    await t.follow.show("a");
    sent.length = 0;
    await t.follow.loadOlder("a");
    const sub = sent.find((m) => m.type === "session.subscribe")!;
    expect(sub.from).toBe("u1");
    expect(sub.background).toBeUndefined();
  });

  it("stale_epoch of a background Session stays background", async () => {
    const sent: Msg[] = [];
    const t = setup({}, stale("stale_epoch", sent));
    t.follow.seed("a", paged());
    await t.follow.background("a");
    sent.length = 0;
    await t.follow.loadOlder("a");
    expect(sent.find((m) => m.type === "session.subscribe")).toMatchObject({ background: true, from: "u1" });
  });

  it("unknown_cursor takes a fresh snapshot", async () => {
    const sent: Msg[] = [];
    const t = setup({}, stale("unknown_cursor", sent));
    t.follow.seed("a", paged());
    await t.follow.show("a");
    sent.length = 0;
    await t.follow.loadOlder("a");
    const sub = sent.find((m) => m.type === "session.subscribe")!;
    expect(sub.sinceSeq).toBe(0);
    expect(sub.from).toBeUndefined();
  });

  it("another error toasts once per cursor and is retried only by a user scroll after 3 s", async () => {
    const sent: Msg[] = [];
    const t = setup({}, stale("boom", sent));
    const pages = () => sent.filter((m) => m.type === "session.page").length;
    t.follow.seed("a", paged());
    await t.follow.loadOlder("a");
    await t.follow.loadOlder("a", { user: true }); // within 3 s
    expect(pages()).toBe(1);
    t.advance(3000);
    await t.follow.loadOlder("a"); // a layout pass never retries
    expect(pages()).toBe(1);
    await t.follow.loadOlder("a", { user: true });
    expect(pages()).toBe(2);
    expect(t.host.error).toHaveBeenCalledTimes(1);
  });
});

describe("close then Undo", () => {
  it("a holding subscribe follows the background one still in flight and the Session ends held", async () => {
    const t = setup();
    t.follow.seed("a", view());
    void t.follow.background("a");
    void t.follow.show("a");
    await flush();
    expect(t.fake.subs().map((c) => !!c.msg.background)).toEqual([true, false]);
    t.fake.subs().forEach((c) => c.ok());
    await flush();
    void t.follow.show("a");
    await flush();
    expect(t.fake.subs()).toHaveLength(2); // held already: nothing more
  });

  it("show twice while the first is in flight sends one request", async () => {
    const t = setup();
    void t.follow.show("a");
    void t.follow.show("a");
    await flush();
    expect(t.fake.subs()).toHaveLength(1);
  });

  it("a failed holding subscribe is asked again by the next show", async () => {
    const t = setup();
    void t.follow.show("a");
    await flush();
    t.fake.subs()[0]!.fail("boom");
    await flush();
    void t.follow.show("a");
    await flush();
    expect(t.fake.subs()).toHaveLength(2);
  });
});
