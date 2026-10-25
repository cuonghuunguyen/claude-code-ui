import type { GitRepo } from "@claude-ui/protocol";
import { repoTree } from "@claude-ui/protocol";
import { expect, it } from "vitest";
import { repoMove, repoRows, repoTypeAhead, truncationNotes } from "./repo-selector-model.ts";

const r = (rel: string, kind: GitRepo["kind"], parent?: string): GitRepo => ({ path: rel ? `/p/${rel}` : "/p", rel, kind, ...(parent && { parent }) });
const list = [r("", "main"), r("libs/lib", "submodule", "/p"), r("tools/inner", "nested", "/p"), r("tools/inner/deep", "submodule", "/p/tools/inner"), r("web", "nested", "/p")];
const rows = (collapsed: string[] = [], q = "") => repoRows(repoTree(list), new Set(collapsed), q);

it("repoRows keeps git.repos order and indents by parent", () => {
  const rs = rows();
  expect(rs.map((x) => [x.repo.rel, x.depth, x.label])).toEqual([
    ["", 0, "p"],
    ["libs/lib", 1, "libs/lib"],
    ["tools/inner", 1, "tools/inner"],
    ["tools/inner/deep", 2, "deep"],
    ["web", 1, "web"],
  ]);
  expect(rs[0]).toMatchObject({ hasChildren: true, expanded: true, posinset: 1, setsize: 1 });
  expect(rs[4]).toMatchObject({ parent: "/p", posinset: 3, setsize: 3 });
});

it("repoRows hides children of a collapsed node", () => {
  expect(rows(["/p/tools/inner"]).map((x) => x.repo.rel)).toEqual(["", "libs/lib", "tools/inner", "web"]);
  expect(rows(["/p/tools/inner"])[2]).toMatchObject({ expanded: false, hasChildren: true });
  expect(rows(["/p"]).map((x) => x.repo.rel)).toEqual([""]);
});

it("repoRows filter keeps matches and their ancestors, ignoring collapsed", () => {
  expect(rows(["/p"], "DEEP").map((x) => x.repo.rel)).toEqual(["", "tools/inner", "tools/inner/deep"]);
  expect(rows([], "zzz")).toEqual([]);
  expect(rows([], "p").map((x) => x.repo.rel)).toContain("");
});

it("a parent above the cwd is labelled by its folder name", () => {
  const up = [{ ...r("..", "nested"), path: "/m" }, { ...r("", "main", "/m"), path: "/m/pa" }];
  expect(repoRows(repoTree(up), new Set(), "").map((x) => x.label)).toEqual(["m", "pa"]);
});

it("repoMove: ↑/↓/Home/End, → expands then enters the first child, ← collapses then goes to the parent", () => {
  const rs = rows();
  expect(repoMove(rs, 0, "ArrowDown")).toEqual({ index: 1 });
  expect(repoMove(rs, 4, "ArrowDown")).toEqual({ index: 4 });
  expect(repoMove(rs, 0, "ArrowUp")).toEqual({ index: 0 });
  expect(repoMove(rs, 2, "Home")).toEqual({ index: 0 });
  expect(repoMove(rs, 2, "End")).toEqual({ index: 4 });
  expect(repoMove(rs, 0, "ArrowRight")).toEqual({ index: 1 });
  expect(repoMove(rs, 1, "ArrowRight")).toEqual({});
  const col = rows(["/p/tools/inner"]);
  expect(repoMove(col, 2, "ArrowRight")).toEqual({ expand: "/p/tools/inner" });
  expect(repoMove(rs, 2, "ArrowLeft")).toEqual({ collapse: "/p/tools/inner" });
  expect(repoMove(rs, 3, "ArrowLeft")).toEqual({ index: 2 });
  expect(repoMove(rs, 1, "ArrowLeft")).toEqual({ index: 0 });
  expect(repoMove(rs, 0, "x")).toEqual({});
});

it("repoTypeAhead finds the next row by name prefix, wrapping", () => {
  const rs = rows();
  expect(repoTypeAhead(rs, 0, "w")).toBe(4);
  expect(repoTypeAhead(rs, 4, "w")).toBe(4);
  expect(repoTypeAhead(rs, 0, "to")).toBe(2);
  expect(repoTypeAhead(rs, 3, "L")).toBe(1);
  expect(repoTypeAhead(rs, 0, "q")).toBe(-1);
});

it("truncationNotes: scan count and submodules per repo with the limit", () => {
  expect(truncationNotes(undefined, list, 10)).toEqual([]);
  expect(truncationNotes({ scan: "count" }, list, 10)).toEqual(["Showing the first 5 repositories"]);
  expect(truncationNotes({ scan: "time" }, list, 10)).toEqual(["Showing the first 5 repositories"]);
  expect(truncationNotes({ submodules: [{ repo: "/p", count: 14 }, { repo: "/p/tools/inner", count: 11 }] }, list, 10)).toEqual([
    "14 submodules of p, only the first 10 shown",
    "11 submodules of tools/inner, only the first 10 shown",
  ]);
});
