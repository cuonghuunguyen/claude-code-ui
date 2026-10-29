// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { emptySaved, type Saved } from "./editor-persist.ts";
import { createEditorStore } from "./editor-store.ts";

type Client = ReturnType<typeof connect>;
type Msg = { type: string; path?: string; content?: string; baseMtime?: number };

const err = (code: string, message = code) => Object.assign(new Error(message), { code });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(saved: Partial<Saved>, files: Record<string, { content: string; mtime: number }>, createFails?: string) {
  const disk = { ...files };
  const request = vi.fn(async (m: Msg) => {
    if (m.type === "fs.read") {
      const f = disk[m.path!];
      if (!f) throw err("not_found", `file is gone: ${m.path}`);
      return f;
    }
    if (m.type === "fs.create") {
      if (createFails) throw err(createFails);
      disk[m.path!] = { content: "", mtime: 1 };
      return { path: m.path };
    }
    if (m.type === "fs.write") {
      disk[m.path!] = { content: m.content!, mtime: 9 };
      return { mtime: 9 };
    }
    return {};
  });
  const write = vi.fn();
  let client: Client | undefined = { request } as unknown as Client;
  const store = createEditorStore(() => client, { load: () => ({ ...emptySaved(), ...saved }), write });
  return { store, request, write, disconnect: () => (client = undefined), connect: () => (client = { request } as unknown as Client), disk };
}

const lastWrite = (write: ReturnType<typeof vi.fn>): Saved => write.mock.calls.at(-1)![0];

it("restore rebuilds tabs in saved order with active, preview and item flags", async () => {
  const { store } = setup(
    { tabs: [{ path: "/p/b" }, { path: "/p/a", preview: true }, { path: "/p/i", item: true }], active: "/p/a", recent: ["/p/a", "/p/b"] },
    { "/p/a": { content: "A", mtime: 1 }, "/p/b": { content: "B", mtime: 1 }, "/p/i": { content: "I", mtime: 1 } },
  );
  await store.restore();
  expect(Object.keys(store.get().tabs)).toEqual(["/p/b", "/p/a", "/p/i"]);
  expect(store.get().activePath).toBe("/p/a");
  expect(store.get().tabs["/p/a"]!.preview).toBe(true);
  expect(store.get().tabs["/p/i"]!.item).toBe(true);
  expect(store.get().recent).toEqual(["/p/a", "/p/b"]);
});

it("a clean missing file is dropped, a dirty one becomes a gone tab with its draft, an item without draft is left to its file tab", async () => {
  const { store } = setup(
    { tabs: [{ path: "/p/clean" }, { path: "/p/dirty" }, { path: "/p/item", item: true }, { path: "/p/ok" }], drafts: { "/p/dirty": { draft: "mine", mtime: 1 } } },
    { "/p/ok": { content: "ok", mtime: 1 } },
  );
  await store.restore();
  expect(Object.keys(store.get().tabs)).toEqual(["/p/dirty", "/p/ok"]);
  expect(store.get().tabs["/p/dirty"]).toMatchObject({ gone: true, draft: "mine", error: "Deleted on disk. Save creates it again." });
});

it("a draft on a file that changed on disk is restored with a conflict", async () => {
  const { store } = setup({ tabs: [{ path: "/p/a" }], drafts: { "/p/a": { draft: "mine", mtime: 1 } } }, { "/p/a": { content: "new", mtime: 2 } });
  await store.restore();
  expect(store.get().tabs["/p/a"]).toMatchObject({ draft: "mine", disk: "new", conflict: { content: "new", mtime: 2 } });
});

it("open() of a pending path before restore takes its draft; restore keeps that tab", async () => {
  const { store } = setup({ tabs: [{ path: "/p/a", item: true }, { path: "/p/b" }], drafts: { "/p/a": { draft: "mine", mtime: 1 } } }, { "/p/a": { content: "A", mtime: 1 }, "/p/b": { content: "B", mtime: 1 } });
  await store.open("/p/a", { cwd: "/p", item: true });
  expect(store.get().tabs["/p/a"]).toMatchObject({ draft: "mine", disk: "A" });
  await store.restore();
  expect(store.get().tabs["/p/a"]!.draft).toBe("mine");
  expect(Object.keys(store.get().tabs)).toContain("/p/b");
});

it("a write before restore finishes never erases saved drafts: no write before restore; a write after a partial restore merges the pending entries", async () => {
  const { store, write, disconnect, connect } = setup(
    { tabs: [{ path: "/p/a" }, { path: "/p/b" }], active: "/p/b", drafts: { "/p/b": { draft: "mine", mtime: 1 } } },
    { "/p/a": { content: "A", mtime: 1 }, "/p/b": { content: "B", mtime: 1 } },
  );
  await store.open("/p/a", { cwd: "/p", preview: false });
  store.update("/p/a", (t) => ({ ...t, draft: "typed" }));
  await vi.advanceTimersByTimeAsync(1000);
  window.dispatchEvent(new Event("pagehide"));
  expect(write).not.toHaveBeenCalled();
  // restore interrupted by a disconnect: /p/b stays pending and survives a later write
  disconnect();
  await store.restore();
  connect();
  store.update("/p/a", (t) => ({ ...t, draft: "typed more" }));
  await vi.advanceTimersByTimeAsync(400);
  const w = lastWrite(write);
  expect(w.tabs.map((t) => t.path)).toEqual(["/p/a", "/p/b"]);
  expect(w.drafts["/p/b"]).toEqual({ draft: "mine", mtime: 1 });
  expect(w.drafts["/p/a"]!.draft).toBe("typed more");
  expect(w.active).toBe("/p/a");
  // second restore (next connected) reads the pending entry
  await store.restore();
  expect(store.get().tabs["/p/b"]).toMatchObject({ draft: "mine" });
});

it("after restore every change is written, debounced, and flushed on pagehide", async () => {
  const { store, write } = setup({ tabs: [{ path: "/p/a" }] }, { "/p/a": { content: "A", mtime: 1 } });
  await store.restore();
  await vi.advanceTimersByTimeAsync(400);
  write.mockClear();
  store.update("/p/a", (t) => ({ ...t, draft: "1" }));
  store.update("/p/a", (t) => ({ ...t, draft: "12" }));
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300);
  expect(write).toHaveBeenCalledTimes(1);
  expect(lastWrite(write).drafts["/p/a"]!.draft).toBe("12");
  store.update("/p/a", (t) => ({ ...t, draft: "123" }));
  window.dispatchEvent(new Event("pagehide"));
  expect(lastWrite(write).drafts["/p/a"]!.draft).toBe("123");
});

it("restore is idempotent", async () => {
  const { store, request } = setup({ tabs: [{ path: "/p/a" }] }, { "/p/a": { content: "A", mtime: 1 } });
  await Promise.all([store.restore(), store.restore()]);
  await store.restore();
  expect(request.mock.calls.filter(([m]) => m.type === "fs.read")).toHaveLength(1);
});

it("a disconnect during restore keeps the entry pending for the next connected", async () => {
  const { store, disconnect, connect } = setup({ tabs: [{ path: "/p/a" }] }, { "/p/a": { content: "A", mtime: 1 } });
  disconnect();
  await store.restore();
  expect(store.get().tabs).toEqual({});
  connect();
  await store.restore();
  expect(Object.keys(store.get().tabs)).toEqual(["/p/a"]);
});

it("recent moves the new active path to the front and closed paths leave the written list", async () => {
  const { store, write } = setup({ tabs: [{ path: "/p/a" }, { path: "/p/b" }], active: "/p/a", recent: ["/p/a", "/p/b"] }, { "/p/a": { content: "A", mtime: 1 }, "/p/b": { content: "B", mtime: 1 } });
  await store.restore();
  store.setActive("/p/b");
  expect(store.get().recent).toEqual(["/p/b", "/p/a"]);
  store.discard(["/p/a"]);
  await vi.advanceTimersByTimeAsync(400);
  expect(lastWrite(write).recent).toEqual(["/p/b"]);
});

it("save of a gone tab creates the file, then writes without baseMtime", async () => {
  const { store, request, disk } = setup({ tabs: [{ path: "/p/a" }], drafts: { "/p/a": { draft: "mine", mtime: 1 } } }, {});
  await store.restore();
  await store.save("/p/a");
  const types = request.mock.calls.map(([m]) => m.type).filter((t) => t.startsWith("fs.c") || t === "fs.write");
  expect(types).toEqual(["fs.create", "fs.write"]);
  expect(request.mock.calls.find(([m]) => m.type === "fs.write")![0].baseMtime).toBeUndefined();
  expect(disk["/p/a"]!.content).toBe("mine");
  expect(store.get().tabs["/p/a"]).toMatchObject({ disk: "mine", draft: "mine", gone: undefined, error: undefined });
});

it("save of a gone tab whose file came back shows a conflict and does not write", async () => {
  const { store, request } = setup({ tabs: [{ path: "/p/a" }], drafts: { "/p/a": { draft: "mine", mtime: 1 } } }, {});
  await store.restore();
  request.mockImplementation(async (m: Msg) => {
    if (m.type === "fs.create") throw err("exists");
    if (m.type === "fs.read") return { content: "back", mtime: 4 };
    return {};
  });
  await store.save("/p/a");
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.some(([m]) => m.type === "fs.write")).toBe(false);
  expect(store.get().tabs["/p/a"]).toMatchObject({ draft: "mine", conflict: { content: "back", mtime: 4 } });
});

it("two reloads keep a conflict; save never writes while in conflict (a plain save would send the newer mtime as base)", async () => {
  const disk = { "/p/a": { content: "theirs", mtime: 2 } };
  let written: Saved | undefined;
  const first = setup({ tabs: [{ path: "/p/a" }], drafts: { "/p/a": { draft: "mine", mtime: 1 } } }, disk);
  await first.store.restore();
  first.store.update("/p/a", (t) => ({ ...t }));
  await vi.advanceTimersByTimeAsync(400);
  written = lastWrite(first.write);
  expect(written.drafts["/p/a"]).toEqual({ draft: "mine", mtime: 2, conflict: true });
  const second = setup(written, disk);
  await second.store.restore();
  expect(second.store.get().tabs["/p/a"]).toMatchObject({ draft: "mine", conflict: { content: "theirs", mtime: 2 } });
  await second.store.save("/p/a");
  expect(second.request.mock.calls.some(([m]) => m.type === "fs.write")).toBe(false);
});

it("open() of a pending draft whose file is gone keeps a gone tab with the draft, and the next write keeps the draft", async () => {
  const { store, write } = setup({ tabs: [{ path: "/p/a", item: true }], drafts: { "/p/a": { draft: "mine", mtime: 1 } } }, {});
  await store.open("/p/a", { cwd: "/p", item: true });
  expect(store.get().tabs["/p/a"]).toMatchObject({ gone: true, draft: "mine", item: true });
  await store.restore();
  await vi.advanceTimersByTimeAsync(400);
  expect(lastWrite(write).drafts["/p/a"]!.draft).toBe("mine");
});

it("open() of a pending draft during a disconnect puts the entry back; the next open or restore still has the draft", async () => {
  const { store, write, disconnect, connect } = setup({ tabs: [{ path: "/p/a", item: true }], drafts: { "/p/a": { draft: "mine", mtime: 1 } } }, { "/p/a": { content: "A", mtime: 1 } });
  disconnect();
  await store.open("/p/a", { cwd: "/p", item: true });
  expect(store.get().tabs["/p/a"]).toBeUndefined();
  connect();
  await store.restore();
  expect(store.get().tabs["/p/a"]).toMatchObject({ draft: "mine", disk: "A" });
  await vi.advanceTimersByTimeAsync(400);
  expect(lastWrite(write).drafts["/p/a"]!.draft).toBe("mine");
});

it("after forget() (unpair) pagehide and timers write nothing", async () => {
  const { store, write } = setup({ tabs: [{ path: "/p/a" }] }, { "/p/a": { content: "A", mtime: 1 } });
  await store.restore();
  store.update("/p/a", (t) => ({ ...t, draft: "x" }));
  store.forget();
  window.dispatchEvent(new Event("pagehide"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(write).not.toHaveBeenCalled();
});

it("a drafts write that fails sets draftsNotKept; a later good write clears it", async () => {
  const { store, write } = setup({ tabs: [{ path: "/p/a" }] }, { "/p/a": { content: "A", mtime: 1 } });
  await store.restore();
  write.mockReturnValue(false);
  store.update("/p/a", (t) => ({ ...t, draft: "x" }));
  await vi.advanceTimersByTimeAsync(400);
  expect(store.get().draftsNotKept).toBe(true);
  write.mockReturnValue(true);
  store.update("/p/a", (t) => ({ ...t, draft: "xy" }));
  await vi.advanceTimersByTimeAsync(400);
  expect(store.get().draftsNotKept).toBeFalsy();
});

it("a draft of a path that is no longer allowed says so, not 'Deleted on disk'", async () => {
  const { store, request } = setup({ tabs: [{ path: "/p/a" }], drafts: { "/p/a": { draft: "mine", mtime: 1 } } }, {});
  request.mockImplementation(async () => {
    throw err("path_not_allowed", "refused path: /p/a");
  });
  await store.restore();
  expect(store.get().tabs["/p/a"]).toMatchObject({ gone: true, draft: "mine", error: "refused path: /p/a" });
});
