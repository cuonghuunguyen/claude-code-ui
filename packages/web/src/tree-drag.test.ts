import { describe, expect, it } from "vitest";
import { dragEntries, ENTRIES_DRAG_TYPE, isEntriesDrag, readEntriesDrag, readTreeDrag, TREE_DRAG_TYPE } from "./tree-drag.ts";

const dt = (types: string[], data: Record<string, string> = {}) => ({ types, getData: (t: string) => data[t] ?? "" }) as unknown as DataTransfer;
const order = [
  { path: "/p/a", isDir: false },
  { path: "/p/b", isDir: true },
  { path: "/p/c", isDir: false },
  { path: "/p/d", isDir: false },
];

describe("dragEntries (GH-707)", () => {
  it("a row without selection carries itself", () => {
    expect(dragEntries("/p/b", new Set(), order)).toEqual([order[1]]);
  });
  it("a row in a selection of 3 carries all, in tree order", () => {
    expect(dragEntries("/p/c", new Set(["/p/c", "/p/a", "/p/b"]), order)).toEqual([order[0], order[1], order[2]]);
  });
  it("a row outside the selection carries itself only", () => {
    expect(dragEntries("/p/d", new Set(["/p/a", "/p/b"]), order)).toEqual([order[3]]);
  });
  it("a selection of one is the row", () => {
    expect(dragEntries("/p/a", new Set(["/p/a"]), order)).toEqual([order[0]]);
  });
  it("selected paths that are not visible are skipped", () => {
    expect(dragEntries("/p/a", new Set(["/p/a", "/p/b", "/p/gone"]), order)).toEqual([order[0], order[1]]);
  });
});

describe("entries drag payload (GH-707)", () => {
  it("isEntriesDrag reads types only", () => {
    expect(isEntriesDrag(dt([ENTRIES_DRAG_TYPE]))).toBe(true);
    expect(isEntriesDrag(dt(["Files"]))).toBe(false);
  });
  it("readEntriesDrag parses the entries", () => {
    expect(readEntriesDrag(dt([ENTRIES_DRAG_TYPE], { [ENTRIES_DRAG_TYPE]: JSON.stringify([{ path: "/p/a", isDir: false }]) }))).toEqual([{ path: "/p/a", isDir: false }]);
  });
  it("bad JSON, wrong shape and empty give undefined", () => {
    for (const raw of ["", "{", "{}", "[]", '[{"path":1,"isDir":false}]', '[{"path":"/a"}]'])
      expect(readEntriesDrag(dt([ENTRIES_DRAG_TYPE], { [ENTRIES_DRAG_TYPE]: raw }))).toBeUndefined();
  });
});

describe("tree drag payload (GH-757)", () => {
  const row = { path: "/p/a", name: "a", isDir: false, side: "local" };
  const read = (v: string) => readTreeDrag(dt([TREE_DRAG_TYPE], { [TREE_DRAG_TYPE]: v }));
  it("is the same type string as before", () => {
    expect(TREE_DRAG_TYPE).toBe("application/x-claude-ui-entry");
  });
  it("an array gives its rows", () => {
    const b = { path: "/p/b", name: "b", isDir: true, side: "local" };
    expect(read(JSON.stringify([row, b]))).toEqual([row, b]);
  });
  it("a single object (old shape) gives one row", () => {
    expect(read(JSON.stringify(row))).toEqual([row]);
  });
  it("bad JSON, wrong shape and empty give undefined", () => {
    expect(read("{")).toBeUndefined();
    expect(read("")).toBeUndefined();
    expect(read("[]")).toBeUndefined();
    expect(read("{}")).toBeUndefined();
    expect(read(JSON.stringify([row, { path: "/p/x" }]))).toBeUndefined();
  });
});
