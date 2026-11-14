import { parseDiffFromFile } from "@pierre/diffs";
import { expect, it } from "vitest";
import { lineStats } from "./diff-stats.ts";

const pierre = (a: string, b: string) => {
  const { hunks } = parseDiffFromFile({ name: "f.ts", contents: a }, { name: "f.ts", contents: b });
  return { added: hunks.reduce((n, h) => n + h.additionLines, 0), removed: hunks.reduce((n, h) => n + h.deletionLines, 0) };
};

it.each([
  ["", "a\nb\n"],
  ["a\nb\n", ""],
  ["a\nb\nc\n", "a\nB\nc\n"],
  ["a\nb\nc", "a\nb\nc\n"],
  ["x\n", "x\n"],
  ["1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n3\n4\nfive\n6\n7\n8\n9\n10\n11\n"],
  ["+plus\n-minus\n", "-minus\n+plus\n"],
])("lineStats(%j, %j) equals the diffs library's counts", (a, b) => {
  expect(lineStats("f.ts", a, b)).toEqual(pierre(a, b));
});
