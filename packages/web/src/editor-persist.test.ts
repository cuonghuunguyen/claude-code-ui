// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { clearSaved, loadSaved, parseSaved, toSaved, writeSaved } from "./editor-persist.ts";
import { opened, openedMedia, type Tab } from "./files.ts";

const clean = (p: string, extra: Partial<Tab> = {}): Tab => ({ ...opened(p, { content: "x", mtime: 1 }), ...extra });
const dirty = (p: string) => ({ ...clean(p), draft: "mine" });
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it("toSaved keeps order, active, recent and the preview/item/outside flags; closed paths leave recent", () => {
  const tabs = { "/p/b": clean("/p/b", { preview: true }), "/p/a": clean("/p/a", { item: true }), "/o/c": clean("/o/c", { outside: true }) };
  const s = toSaved({ tabs, activePath: "/p/a", recent: ["/p/a", "/p/gone", "/p/b"] });
  expect(s.tabs).toEqual([{ path: "/p/b", preview: true }, { path: "/p/a", item: true }, { path: "/o/c", outside: true }]);
  expect(s.active).toBe("/p/a");
  expect(s.recent).toEqual(["/p/a", "/p/b"]);
});

it("toSaved stores drafts of dirty text tabs only, with the base mtime (the conflict's when in conflict)", () => {
  const media = { ...openedMedia("/p/i.png", { url: "u", mtime: 1 } as never), draft: "zzz" };
  const tabs = { "/p/c": clean("/p/c"), "/p/d": dirty("/p/d"), "/p/m": media, "/p/k": { ...dirty("/p/k"), conflict: { content: "n", mtime: 7 } } };
  expect(toSaved({ tabs, recent: [] }).drafts).toEqual({ "/p/d": { draft: "mine", mtime: 1 }, "/p/k": { draft: "mine", mtime: 7 } });
});

it("parseSaved: junk, wrong version and non-arrays give nothing; bad entries are skipped", () => {
  const empty = { tabs: [], recent: [], drafts: {} };
  for (const raw of [null, "", "{", "[]", "1", '{"v":2,"tabs":[{"path":"/a"}]}', '{"v":1,"tabs":{}}']) expect(parseSaved(raw, null)).toEqual(empty);
  expect(parseSaved('{"v":1,"tabs":[{"path":"/a"},{"x":1},null,{"path":"/a"},{"path":"/b","preview":true}],"active":"/b","recent":["/b",3]}', '{"/a":{"draft":1,"mtime":1}}')).toEqual({
    tabs: [{ path: "/a" }, { path: "/b", preview: true }],
    active: "/b",
    recent: ["/b"],
    drafts: {},
  });
});

it("parseSaved appends a draft path that is missing from the list", () => {
  const s = parseSaved('{"v":1,"tabs":[{"path":"/a"}]}', '{"/z":{"draft":"d","mtime":2}}');
  expect(s.tabs.map((t) => t.path)).toEqual(["/a", "/z"]);
  expect(s.drafts["/z"]).toEqual({ draft: "d", mtime: 2 });
});

it("write then load round-trips; clearSaved removes both keys", () => {
  const s = toSaved({ tabs: { "/p/d": dirty("/p/d") }, activePath: "/p/d", recent: ["/p/d"] });
  writeSaved(s);
  expect(localStorage.getItem("claude-ui.editorTabs")).toBeTruthy();
  expect(sessionStorage.getItem("claude-ui.editorDrafts")).toBeTruthy();
  expect(loadSaved()).toEqual(s);
  clearSaved();
  expect(loadSaved()).toEqual({ tabs: [], recent: [], drafts: {} });
});

it("a full or blocked storage never throws: load is empty, write and clear are skipped", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => writeSaved(toSaved({ tabs: { "/p/d": dirty("/p/d") }, recent: [] }))).not.toThrow();
  expect(loadSaved()).toEqual({ tabs: [], recent: [], drafts: {} });
  expect(() => clearSaved()).not.toThrow();
});
