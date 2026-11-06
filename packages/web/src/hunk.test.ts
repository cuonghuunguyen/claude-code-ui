import { parseDiffFromFile } from "@pierre/diffs";
import { expect, it } from "vitest";
import { hunkAnchor, wireHunk } from "./hunk.ts";

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
