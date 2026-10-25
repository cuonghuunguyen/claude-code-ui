import { expect, it } from "vitest";
import { repoTree, type GitRepo } from "../src/index.ts";

const r = (path: string, kind: GitRepo["kind"], parent?: string): GitRepo => ({ path, rel: path, kind, ...(parent && { parent }) });

it("repoTree nests entries under their parent in list order", () => {
  const tree = repoTree([r("m", "main"), r("libs/a", "submodule", "m"), r("tools/x", "nested", "m"), r("tools/x/m", "submodule", "tools/x"), r("tools/y", "nested", "m")]);
  expect(tree.map((n) => n.path)).toEqual(["m"]);
  expect(tree[0]!.children.map((n) => n.path)).toEqual(["libs/a", "tools/x", "tools/y"]);
  expect(tree[0]!.children[1]!.children.map((n) => n.path)).toEqual(["tools/x/m"]);
});

it("an entry whose parent is not listed is a root; an empty list gives []", () => {
  expect(repoTree([])).toEqual([]);
  expect(repoTree([r("a", "nested"), r("b", "submodule", "gone")]).map((n) => n.path)).toEqual(["a", "b"]);
  expect(repoTree([r("c", "submodule", "p"), r("p", "main")]).map((n) => [n.path, n.children.length])).toEqual([["p", 1]]);
});
