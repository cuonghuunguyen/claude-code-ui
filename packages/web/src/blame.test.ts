import { describe, expect, it } from "vitest";
import { blameEntries } from "./blame.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const blame = { commits: { [A]: { author: "Ann", time: 1700000000, summary: "first" }, [B]: { author: "Bob", time: 1700100000, summary: "second" } }, lines: [A, A, null, B] };

describe("blameEntries", () => {
  it("labels the first line of each run only", () => {
    const e = blameEntries(blame, 4);
    expect(e.map((x) => x.hash)).toEqual([A, A, null, B]);
    expect(e[0]!.label).toMatch(/^aaaaaaa .+ Ann$/);
    expect(e[1]!.label).toBe("");
    expect(e[2]!.label).toBe("not committed");
    expect(e[3]!.label).toMatch(/^bbbbbbb .+ Bob$/);
    expect(e[0]!.aria).toMatch(/^Commit aaaaaaa by Ann, /);
    expect(e[2]!.aria).toBe("Not committed");
  });
  it("lines past the blame (the empty last line, lines typed after it) have no entry", () => {
    expect(blameEntries(blame, 6).map((x) => x.hash)).toEqual([A, A, null, B]);
    expect(blameEntries(blame, 2)).toHaveLength(2);
  });
  it("untracked: every line not committed", () => {
    const e = blameEntries({ commits: {}, lines: [], untracked: true }, 3);
    expect(e.map((x) => x.hash)).toEqual([null, null, null]);
    expect(e.map((x) => x.label)).toEqual(["not committed", "", ""]);
  });
});
