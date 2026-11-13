import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { diffQuote, diffSelectedRows, diffSelection, hunkAnchor, wireHunk } from "./hunk.ts";

const diff = (a: string, b: string) => parseDiffFromFile({ name: "f.txt", contents: a }, { name: "f.txt", contents: b });
const nums = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`);

it("a modification: context, deletions, additions, start of the new side", () => {
  expect(wireHunk(diff("a\nb\nc\n", "a\nX\nc\n"), 0)).toEqual({ newStart: 1, lines: [" a", "-b", "+X", " c"] });
});

it("a pure deletion names the line before it; a pure addition at the end", () => {
  expect(wireHunk(diff("a\nb\nc\n", "a\nc\n"), 0)).toEqual({ newStart: 1, lines: [" a", "-b", " c"] });
  expect(wireHunk(diff("a\n", "a\nz\n"), 0)).toEqual({ newStart: 1, lines: [" a", "+z"] });
  expect(wireHunk(diff("", "a\n"), 0)).toEqual({ newStart: 1, lines: ["+a"] });
});

it("the second hunk of a file starts at its own line", () => {
  const a = nums(40);
  const b = [...a];
  b[1] = "E2";
  b[35] = "E36";
  const d = diff(a.join("\n") + "\n", b.join("\n") + "\n");
  expect(d.hunks).toHaveLength(2);
  const h = wireHunk(d, 1);
  expect(h.newStart).toBe(32);
  expect(h.lines).toEqual([" l32", " l33", " l34", " l35", "-l36", "+E36", " l37", " l38", " l39", " l40"]);
});

it("the no-newline marker follows the last line of the side that lacks it", () => {
  expect(wireHunk(diff("a\nb\n", "a\nb"), 0).lines).toEqual([" a", "-b", "+b", "\\ No newline at end of file"]);
  expect(wireHunk(diff("a\nb", "a\nb\n"), 0).lines).toEqual([" a", "-b", "\\ No newline at end of file", "+b"]);
  expect(wireHunk(diff("a\nb", "a\nX"), 0).lines).toEqual([" a", "-b", "\\ No newline at end of file", "+X", "\\ No newline at end of file"]);
});

it("the anchor is the last line of the last change block", () => {
  expect(hunkAnchor(diff("a\nb\nc\n", "a\nX\nc\n"), 0)).toEqual({ side: "additions", lineNumber: 2, first: 2, last: 2 });
  expect(hunkAnchor(diff("a\nb\nc\n", "a\nc\n"), 0)).toEqual({ side: "deletions", lineNumber: 2, first: 2, last: 2 });
});

describe("diffSelection", () => {
  const d = diff("a\nb\nc\nd\n", "a\nX\nY\nc\nd\n");
  it("context, removed and added rows with their numbers", () => {
    expect(diffSelection(d, { start: 1, end: 3 }, "f.txt")).toBe(
      "`f.txt` diff, old lines 1-2, new lines 1-3 (`-` removed, old line number, not in the current file; `+` added and ` ` unchanged, new line number):\n```diff\n 1 | a\n-2 | b\n+2 | X\n+3 | Y\n```\n",
    );
  });
  it("a reversed range and a cross-side range", () => {
    const r = diffSelection(d, { start: 3, end: 2, side: "additions", endSide: "deletions" }, "f.txt")!;
    expect(r).toContain("-2 | b\n+2 | X\n+3 | Y");
    expect(diffSelection(d, { start: 3, side: "additions", end: 2, endSide: "deletions" }, "f.txt")).toBe(r);
  });
  it("only removed lines has no new lines", () => {
    const r = diffSelection(d, { start: 2, side: "deletions", end: 2, endSide: "deletions" }, "f.txt")!;
    expect(r).toContain("diff, old lines 2 (");
    expect(r).not.toContain("new lines");
  });
  it("a context line in a gap between hunks", () => {
    const a = nums(40);
    const b = [...a];
    b[1] = "E2";
    b[35] = "E36";
    const g = diff(a.join("\n") + "\n", b.join("\n") + "\n");
    expect(diffSelection(g, { start: 20, end: 20 }, "f.txt")).toContain(" 20 | l20");
    expect(diffSelection(g, { start: 36, side: "deletions", end: 36, endSide: "additions" }, "f.txt")).toContain("-36 | l36\n+36 | E36");
  });
  it("a longer fence than any backtick run in the lines", () => {
    const f = diff("a\n", "a\n```x\n");
    expect(diffSelection(f, { start: 2, end: 2 }, "f.txt")).toContain("````diff\n+2 | ```x\n````\n");
  });
  it("a line that is not in the diff", () => {
    expect(diffSelection(d, { start: 99, end: 99 }, "f.txt")).toBeUndefined();
  });
});

describe("diffSelectedRows and diffQuote", () => {
  const d = diff("a\nb\nc\nd\n", "a\nX\nY\nc\nd\n");
  it("the rows between both ends in unified order, whatever the drag direction", () => {
    const rows = diffSelectedRows(d, { start: 1, end: 3 })!;
    expect(rows.map((r) => `${r.tag}${r.text}`)).toEqual([" a", "-b", "+X", "+Y"]);
    expect(diffSelectedRows(d, { start: 3, end: 1 })).toEqual(rows);
  });
  it("undefined when an end is not in the diff", () => {
    expect(diffSelectedRows(d, { start: 1, end: 99 })).toBeUndefined();
    expect(diffQuote(d, { start: 1, end: 99 })).toBeUndefined();
  });
  it("the quote is a fenced blockquote of the unified lines, without line numbers", () => {
    expect(diffQuote(d, { start: 1, end: 3 })).toBe("> ```\n>  a\n> -b\n> +X\n> +Y\n> ```\n\n");
  });
});
