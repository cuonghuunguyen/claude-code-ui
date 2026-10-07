import { describe, expect, it } from "vitest";
import { emptyGraph, layoutPage, LANE_COLORS } from "./git-graph.ts";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });
const shape = (commits: ReturnType<typeof c>[]) => layoutPage(commits, emptyGraph()).rows.map((r) => ({ col: r.col, color: r.color, input: r.input.map((l) => l.hash), output: r.output.map((l) => l.hash) }));

describe("layoutPage", () => {
  it("linear history: one lane, col 0", () => {
    const rows = shape([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.output)).toEqual([["b"], ["a"], []]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
  });

  it("branch + merge: second parent opens lane 1, rejoins at the fork", () => {
    // m merges f into main; both come from root r.
    const rows = shape([c("m", "x", "f"), c("f", "r"), c("x", "r"), c("r")]);
    expect(rows[0]).toMatchObject({ col: 0, input: [], output: ["x", "f"] });
    expect(rows[1]).toMatchObject({ col: 1, input: ["x", "f"], output: ["x", "r"] });
    expect(rows[2]).toMatchObject({ col: 0, input: ["x", "r"], output: ["r", "r"] });
    // Both lanes wait for r: the node takes the first and the second ends there.
    expect(rows[3]).toMatchObject({ col: 0, input: ["r", "r"], output: [] });
    expect(rows[1]!.color).not.toBe(rows[0]!.color);
  });

  it("octopus merge opens one lane per extra parent", () => {
    const rows = shape([c("o", "a", "b", "d"), c("a"), c("b"), c("d")]);
    expect(rows[0]!.output).toEqual(["a", "b", "d"]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0, 0]);
  });

  it("several roots end their lanes; a new tip takes a new color", () => {
    const rows = shape([c("a"), c("b", "p"), c("p")]);
    expect(rows[0]).toMatchObject({ col: 0, output: [] });
    expect(rows[1]).toMatchObject({ col: 0, input: [], output: ["p"] });
    expect(rows[1]!.color).toBe(1);
    expect(rows[2]!.color).toBe(1);
  });

  it("a second tip gets its own lane beside the first", () => {
    const rows = shape([c("a", "r"), c("b", "r"), c("r")]);
    expect(rows[1]).toMatchObject({ col: 1, input: ["r"], output: ["r", "r"] });
  });

  it("edges end in the lane pushed for that parent, also with duplicate lanes", () => {
    const rows = layoutPage([c("a", "r"), c("b", "r"), c("r")], emptyGraph()).rows;
    // b forks from r like a: its edge goes to its own new lane 1, not to the lane of a.
    expect(rows[1]!.edges).toEqual([1]);
    expect(rows[1]!.output.map((l) => l.hash)).toEqual(["r", "r"]);
    // Both lanes end at r, which sits in the first.
    expect(rows[2]!.input).toEqual(rows[1]!.output);
    expect(rows[2]!.col).toBe(0);
    expect(rows[2]!.output).toEqual([]);
  });

  it("a merge reuses the lane that already waits for its second parent", () => {
    const rows = layoutPage([c("f", "r"), c("m", "x", "r"), c("x", "r"), c("r")], emptyGraph()).rows;
    expect(rows[1]).toMatchObject({ col: 1, edges: [1, 0] });
    expect(rows[1]!.output.map((l) => l.hash)).toEqual(["r", "x"]);
  });

  it("lanes and colors are the same when laid out in pages of 1, 2, 3 as in one pass", () => {
    const commits = [c("m", "x", "f"), c("t", "m"), c("f", "r"), c("x", "r", "q"), c("q"), c("r", "z"), c("z")];
    const one = layoutPage(commits, emptyGraph()).rows;
    for (const size of [1, 2, 3]) {
      let state = emptyGraph();
      const rows = [];
      for (let i = 0; i < commits.length; i += size) {
        const page = layoutPage(commits.slice(i, i + size), state);
        rows.push(...page.rows);
        state = page.state;
      }
      expect(rows).toEqual(one);
    }
  });

  it("does not mutate the state it continues", () => {
    const s = layoutPage([c("a", "b")], emptyGraph()).state;
    const copy = structuredClone(s);
    layoutPage([c("b")], s);
    expect(s).toEqual(copy);
  });

  it("colors cycle through 8", () => {
    const tips = Array.from({ length: LANE_COLORS + 1 }, (_, i) => c(`t${i}`));
    const rows = layoutPage(tips, emptyGraph()).rows;
    expect(rows.map((r) => r.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0]);
  });
});
