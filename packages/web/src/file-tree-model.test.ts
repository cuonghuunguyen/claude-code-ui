import { expect, it } from "vitest";
import type { FsEntry } from "@claude-ui/protocol";
import type { GitRow } from "./git-changes.ts";
import { ancestors, dropPaths, gitMarks, movePaths, moveFocus, pathKey, searchRows, sortEntries, typeAhead, visibleRows, type Row } from "./file-tree-model.ts";

const d = (path: string): FsEntry => ({ name: path.split("/").at(-1)!, path, isDir: true });
const f = (path: string): FsEntry => ({ name: path.split("/").at(-1)!, path, isDir: false });
const names = (rows: Row[]) => rows.map((r) => (r.kind === "entry" ? r.entry.name : r.kind === "input" ? "[input]" : `[${r.text}]`));

it("visibleRows: dirs first, .git dropped, an expanded dir lists its children one level deeper, unlisted shows …, a failed one its error", () => {
  const dirs = {
    "/p": sortEntries([f("/p/b.ts"), d("/p/.git"), d("/p/src"), d("/p/lib"), d("/p/bad")]),
    "/p/src": [f("/p/src/a.ts")],
    "/p/bad": { error: "denied" },
  };
  const rows = visibleRows({ dirs, expanded: new Set(["/p/src", "/p/lib", "/p/bad"]) }, "/p");
  expect(names(rows)).toEqual(["src", "a.ts", "lib", "[…]", "bad", "[denied]", "b.ts"]);
  const a = rows[1]!;
  expect(a).toMatchObject({ depth: 1, posinset: 1, setsize: 1, parent: "/p/src" });
  expect(rows[0]).toMatchObject({ depth: 0, expanded: true, posinset: 1, setsize: 4 });
  expect(rows.at(-1)).toMatchObject({ depth: 0, posinset: 4, setsize: 4 });
  expect(rows[5]).toMatchObject({ kind: "status", error: true, depth: 1 });
  expect(visibleRows({ dirs: {}, expanded: new Set() }, "/p")).toMatchObject([{ kind: "status", text: "…" }]);
});

it("searchRows: hits under nested dirs become a tree with every ancestor expanded, dirs first", () => {
  const rows = searchRows(["/p/src/a.ts", "/p/src/lib/b.ts", "/p/c.md"], "/p");
  expect(names(rows)).toEqual(["src", "lib", "b.ts", "a.ts", "c.md"]);
  expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0]);
  expect(rows[0]).toMatchObject({ expanded: true });
  expect(searchRows([], "/p")).toEqual([]);
});

it("ancestors: posix and Windows paths; outside the root gives none", () => {
  expect(ancestors("/p/src/lib/a.ts", "/p")).toEqual(["/p/src", "/p/src/lib"]);
  expect(ancestors("/p/a.ts", "/p/")).toEqual([]);
  expect(ancestors("/q/a.ts", "/p")).toEqual([]);
  expect(ancestors("/pp/src/a.ts", "/p")).toEqual([]);
  expect(ancestors("C:\\p\\src\\lib\\a.ts", "C:\\p")).toEqual(["C:\\p\\src", "C:\\p\\src\\lib"]);
  expect(ancestors("c:\\P\\src\\a.ts", "C:\\p")).toEqual(["C:\\p\\src"]);
});

it("moveFocus: Down/Up/Home/End skip status rows; Right expands a closed dir then enters its first child; Left collapses an open dir, else goes to the parent", () => {
  const dirs = { "/p": [d("/p/src"), d("/p/lib"), f("/p/a.ts")], "/p/src": [f("/p/src/x.ts")] };
  const rows = visibleRows({ dirs, expanded: new Set(["/p/src", "/p/lib"]) }, "/p");
  expect(names(rows)).toEqual(["src", "x.ts", "lib", "[…]", "a.ts"]);
  expect(moveFocus(rows, 2, "ArrowDown")).toEqual({ index: 4 });
  expect(moveFocus(rows, 4, "ArrowUp")).toEqual({ index: 2 });
  expect(moveFocus(rows, 4, "ArrowDown")).toEqual({ index: 4 });
  expect(moveFocus(rows, 0, "ArrowUp")).toEqual({ index: 0 });
  expect(moveFocus(rows, 2, "Home")).toEqual({ index: 0 });
  expect(moveFocus(rows, 0, "End")).toEqual({ index: 4 });
  expect(moveFocus(rows, 0, "ArrowRight")).toEqual({ index: 1 });
  expect(moveFocus(rows, 2, "ArrowRight")).toEqual({});
  const closed = visibleRows({ dirs, expanded: new Set() }, "/p");
  expect(moveFocus(closed, 0, "ArrowRight")).toEqual({ expand: "/p/src" });
  expect(moveFocus(closed, 2, "ArrowRight")).toEqual({});
  expect(moveFocus(rows, 0, "ArrowLeft")).toEqual({ collapse: "/p/src" });
  expect(moveFocus(rows, 1, "ArrowLeft")).toEqual({ index: 0 });
  expect(moveFocus(rows, 4, "ArrowLeft")).toEqual({});
});

it("typeAhead: prefix match ignoring case from the focused row, one character moves past the current row, wraps, -1 when none", () => {
  const rows = visibleRows({ dirs: { "/p": [f("/p/Readme.md"), f("/p/real.ts"), f("/p/zed.ts")] }, expanded: new Set() }, "/p");
  expect(typeAhead(rows, 0, "rea")).toBe(0);
  expect(typeAhead(rows, 0, "r")).toBe(1);
  expect(typeAhead(rows, 1, "r")).toBe(0);
  expect(typeAhead(rows, 0, "z")).toBe(2);
  expect(typeAhead(rows, 0, "q")).toBe(-1);
  expect(typeAhead([], 0, "a")).toBe(-1);
});

it("gitMarks: M/R/A, untracked as U and D per file; a folder takes D over M over A; files outside cwd are ignored; Windows keys ignore case", () => {
  const row = (path: string, kind: GitRow["kind"], untracked?: boolean): GitRow => ({ path, rel: path, kind, ...(untracked && { untracked }) });
  const { files, dirs } = gitMarks(
    [row("/p/src/a.ts", "M"), row("/p/src/b.ts", "A", true), row("/p/lib/c.ts", "A"), row("/p/lib/old.ts", "D"), row("/p/r.ts", "R"), row("/other/x.ts", "M"), row("/p/n/deep/y.ts", "A", true), row("/p/n/z.ts", "M")],
    "/p",
  );
  expect(files.get("/p/src/a.ts")).toBe("M");
  expect(files.get("/p/src/b.ts")).toBe("U");
  expect(files.get("/p/lib/c.ts")).toBe("A");
  expect(files.get("/p/lib/old.ts")).toBe("D");
  expect(files.get("/p/r.ts")).toBe("R");
  expect(files.has("/other/x.ts")).toBe(false);
  expect(dirs.get("/p/src")).toBe("M");
  expect(dirs.get("/p/lib")).toBe("D");
  expect(dirs.get("/p/n")).toBe("M");
  expect(dirs.get("/p/n/deep")).toBe("A");
  expect(dirs.has("/p")).toBe(false);
  const win = gitMarks([row("c:\\P\\src\\a.ts", "M")], "C:\\p");
  expect(win.files.get(pathKey("C:\\p\\src\\a.ts"))).toBe("M");
  expect(win.dirs.get(pathKey("C:\\p\\SRC"))).toBe("M");
});

const model = () => ({
  dirs: { "/p": sortEntries([d("/p/src"), d("/p/src2"), f("/p/a.ts")]), "/p/src": sortEntries([d("/p/src/lib"), f("/p/src/x.ts")]), "/p/src/lib": [f("/p/src/lib/u.ts")] },
  expanded: new Set(["/p/src", "/p/src/lib"]),
});

it("GH-360 visibleRows puts the new-name input first in the root, in a nested folder, and marks the renamed row", () => {
  const m = model();
  expect(names(visibleRows(m, "/p", { kind: "new", dir: "/p", isDir: false }))).toEqual(["[input]", "src", "lib", "u.ts", "x.ts", "src2", "a.ts"]);
  const nested = visibleRows(m, "/p", { kind: "new", dir: "/p/src", isDir: true });
  expect(names(nested)).toEqual(["src", "[input]", "lib", "u.ts", "x.ts", "src2", "a.ts"]);
  expect(nested[1]).toMatchObject({ kind: "input", depth: 1, parent: "/p/src" });
  const renaming = visibleRows(m, "/p", { kind: "rename", path: "/p/a.ts" });
  expect(renaming.filter((r) => r.kind === "entry" && r.renaming).map((r) => r.kind === "entry" && r.entry.name)).toEqual(["a.ts"]);
});

it("GH-360 arrow keys and type-ahead skip the input row", () => {
  const rows = visibleRows(model(), "/p", { kind: "new", dir: "/p/src", isDir: false });
  const src = rows.findIndex((r) => r.kind === "entry" && r.entry.name === "src");
  expect(moveFocus(rows, src, "ArrowDown")).toEqual({ index: src + 2 });
  expect(moveFocus(rows, src, "ArrowRight")).toEqual({});
  expect(typeAhead(rows, 0, "[")).toBe(-1);
});

it("GH-360 movePaths moves open folders and listings below the renamed folder, not a sibling with the same prefix", () => {
  const m = movePaths(model(), "/p/src", "/p/code");
  expect([...m.expanded].sort()).toEqual(["/p/code", "/p/code/lib"]);
  expect(Object.keys(m.dirs).sort()).toEqual(["/p", "/p/code", "/p/code/lib"]);
  expect((m.dirs["/p/code"] as FsEntry[]).map((e) => e.path)).toEqual(["/p/code/lib", "/p/code/x.ts"]);
  const sib = movePaths({ dirs: { "/p/src2": [f("/p/src2/y")] }, expanded: new Set(["/p/src2"]) }, "/p/src", "/p/z");
  expect(Object.keys(sib.dirs)).toEqual(["/p/src2"]);
});

it("GH-360 dropPaths removes the path and below it (prefix with a separator)", () => {
  const m = dropPaths(model(), "/p/src");
  expect(Object.keys(m.dirs)).toEqual(["/p"]);
  expect([...m.expanded]).toEqual([]);
  const keep = dropPaths({ dirs: { "/p/src2": [] }, expanded: new Set(["/p/src2"]) }, "/p/src");
  expect([...keep.expanded]).toEqual(["/p/src2"]);
});
