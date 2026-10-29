// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { createEditorStore } from "./editor-store.ts";

type Client = ReturnType<typeof connect>;

function setup(files: Record<string, string> = { "/p/a.ts": "a\nb\nc", "/p/b.ts": "bb", "/p/c.md": "# c", "/o/x.ts": "x" }, delay: Record<string, Promise<unknown>> = {}) {
  const request = vi.fn(async (m: { type: string; path?: string; content?: string }) => {
    if (m.type === "fs.read") {
      await delay[m.path!];
      return { content: files[m.path!] ?? "", mtime: 1 };
    }
    if (m.type === "fs.write") return { mtime: 2 };
    return {};
  });
  const client = { request } as unknown as Client;
  return { store: createEditorStore(() => client), request };
}

it("open() makes a preview tab active; the next preview open replaces it in place", async () => {
  const { store } = setup();
  await store.open("/p/a.ts", { cwd: "/p" });
  expect(Object.keys(store.get().tabs)).toEqual(["/p/a.ts"]);
  expect(store.get().activePath).toBe("/p/a.ts");
  expect(store.get().tabs["/p/a.ts"]!.preview).toBe(true);
  await store.open("/p/b.ts", { cwd: "/p" });
  expect(Object.keys(store.get().tabs)).toEqual(["/p/b.ts"]);
  await store.open("/p/c.md", { cwd: "/p", preview: false });
  await store.open("/p/a.ts", { cwd: "/p" });
  expect(Object.keys(store.get().tabs)).toEqual(["/p/a.ts", "/p/c.md"]);
  expect(store.get().tabs["/p/c.md"]!.preview).toBeUndefined();
});

it("two views share one state: an update through the store shows in every subscriber's snapshot", async () => {
  const { store } = setup();
  const a = vi.fn();
  const b = vi.fn();
  store.subscribe(a);
  store.subscribe(b);
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  a.mockClear();
  b.mockClear();
  store.update("/p/a.ts", (t) => ({ ...t, draft: "edited" }));
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
  expect(store.get().tabs["/p/a.ts"]!.draft).toBe("edited");
});

it("a late reply of an older preview open does not take the preview slot or the focus", async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const { store } = setup(undefined, { "/p/a.ts": slow });
  const first = store.open("/p/a.ts", { cwd: "/p" });
  await store.open("/p/b.ts", { cwd: "/p" });
  release();
  await first;
  expect(store.get().activePath).toBe("/p/b.ts");
  expect(Object.keys(store.get().tabs)).toEqual(["/p/b.ts"]);
});

it("open with a line sets goto for that path; a markdown file opened at a line sets sourceOnly", async () => {
  const { store } = setup();
  await store.open("/p/a.ts", { cwd: "/p", line: 2 });
  expect(store.get().goto).toMatchObject({ path: "/p/a.ts", line: 2 });
  const key = store.get().goto!.key;
  await store.open("/p/a.ts", { cwd: "/p", line: 2 });
  expect(store.get().goto!.key).toBe(key + 1);
  await store.open("/p/c.md", { cwd: "/p", line: 1 });
  expect(store.get().sourceOnly).toBe("/p/c.md");
  await store.open("/p/c.md", { cwd: "/p" });
  expect(store.get().sourceOnly).toBeUndefined();
  store.clearGoto();
  expect(store.get().goto).toBeUndefined();
});

it("a file outside cwd opened with outside: true is a tab with outside set; the preview scope includes it", async () => {
  const { store } = setup();
  await store.open("/o/x.ts", { cwd: "/p", outside: true });
  expect(store.get().tabs["/o/x.ts"]!.outside).toBe(true);
  await store.open("/p/a.ts", { cwd: "/p", outside: false });
  // The outside file held the one preview slot of the dialog's scope: the next preview replaces it.
  expect(Object.keys(store.get().tabs)).toEqual(["/p/a.ts"]);
});

it("park/takeParked returns the parked state only while its document equals the draft; close, move and delete drop it", async () => {
  const { store } = setup();
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  await store.open("/p/b.ts", { cwd: "/p", preview: false });
  const park = (p: string, doc: string) => store.park(p, EditorState.create({ doc }));
  park("/p/a.ts", "a\nb\nc");
  expect(store.takeParked("/p/a.ts")?.doc.toString()).toBe("a\nb\nc");
  expect(store.takeParked("/p/a.ts")).toBeUndefined();
  park("/p/a.ts", "stale");
  expect(store.takeParked("/p/a.ts")).toBeUndefined();
  park("/p/a.ts", "a\nb\nc");
  store.moved("/p/a.ts", "/p/z.ts");
  expect(store.takeParked("/p/a.ts")).toBeUndefined();
  expect(store.takeParked("/p/z.ts")?.doc.toString()).toBe("a\nb\nc");
  park("/p/b.ts", "bb");
  store.close("/p/b.ts");
  expect(store.takeParked("/p/b.ts")).toBeUndefined();
  // A view that unmounts after its tab closed does not leave a state behind.
  park("/p/b.ts", "bb");
  expect(store.takeParked("/p/b.ts")).toBeUndefined();
});

it("close() of a dirty tab asks; Cancel keeps it", async () => {
  const { store } = setup();
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  store.update("/p/a.ts", (t) => ({ ...t, draft: "x" }));
  const confirmFn = vi.fn(() => false);
  vi.stubGlobal("confirm", confirmFn);
  store.close("/p/a.ts");
  expect(confirmFn).toHaveBeenCalledWith("Discard unsaved changes to a.ts?");
  expect(store.get().tabs["/p/a.ts"]).toBeDefined();
  confirmFn.mockReturnValue(true);
  store.close("/p/a.ts");
  expect(store.get().tabs["/p/a.ts"]).toBeUndefined();
  vi.unstubAllGlobals();
});

it("save writes the draft, clears dirty and bumps the git nudge", async () => {
  const { store, request } = setup();
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  store.update("/p/a.ts", (t) => ({ ...t, draft: "new" }));
  const nudge = store.get().gitNudge;
  await store.save("/p/a.ts");
  expect(request).toHaveBeenCalledWith({ type: "fs.write", path: "/p/a.ts", content: "new", baseMtime: 1 });
  expect(store.get().tabs["/p/a.ts"]!.disk).toBe("new");
  expect(store.get().gitNudge).toBe(nudge + 1);
});

it("GH-399 toItem pins, keeps the draft and the parked state, and Files' active moves to its next tab", async () => {
  const { store } = setup();
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  await store.open("/p/b.ts", { cwd: "/p", preview: false });
  store.update("/p/b.ts", (t) => ({ ...t, draft: "edited" }));
  const st = EditorState.create({ doc: "edited" });
  store.park("/p/b.ts", st);
  store.toItem("/p/b.ts");
  expect(store.get().tabs["/p/b.ts"]).toMatchObject({ item: true, draft: "edited" });
  expect(store.get().tabs["/p/b.ts"]!.preview).toBeUndefined();
  expect(store.get().activePath).toBe("/p/a.ts");
  expect(store.takeParked("/p/b.ts")).toBe(st);
});

it("GH-399 toFiles clears item and makes the tab Files' active one", async () => {
  const { store } = setup();
  await store.open("/p/a.ts", { cwd: "/p", preview: false, item: true });
  store.toFiles("/p/a.ts");
  expect(store.get().tabs["/p/a.ts"]!.item).toBeUndefined();
  expect(store.get().activePath).toBe("/p/a.ts");
});

it("GH-399 open({item}) creates a pinned item tab and never takes the preview slot", async () => {
  const { store } = setup();
  await store.open("/p/a.ts", { cwd: "/p" });
  await store.open("/p/b.ts", { cwd: "/p", item: true });
  expect(store.get().tabs["/p/b.ts"]).toMatchObject({ item: true });
  expect(store.get().tabs["/p/b.ts"]!.preview).toBeUndefined();
  expect(store.get().tabs["/p/a.ts"]!.preview).toBe(true);
  await store.open("/p/c.md", { cwd: "/p" });
  expect(Object.keys(store.get().tabs)).toEqual(["/p/c.md", "/p/b.ts"]);
});

it("GH-399 discard drops tabs without asking, also dirty ones", async () => {
  const { store } = setup();
  const ask = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  await store.open("/p/b.ts", { cwd: "/p", preview: false });
  store.update("/p/a.ts", (t) => ({ ...t, draft: "x" }));
  store.discard(["/p/a.ts", "/p/b.ts"]);
  expect(Object.keys(store.get().tabs)).toEqual([]);
  expect(ask).not.toHaveBeenCalled();
  ask.mockRestore();
});
