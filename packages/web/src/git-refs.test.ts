import { describe, expect, it } from "vitest";
import { noteRefs, refsOf, subscribeRefs } from "./git-refs.ts";

describe("git-refs", () => {
  it("noteRefs notifies subscribers only when the stamp of that folder changes; undefined is ignored", () => {
    const cwd = "/refs-test";
    let n = 0;
    const off = subscribeRefs(() => n++);
    noteRefs(cwd, undefined);
    expect([refsOf(cwd), n]).toEqual([undefined, 0]);
    noteRefs(cwd, "a");
    expect([refsOf(cwd), n]).toEqual(["a", 1]);
    noteRefs(cwd, "a");
    noteRefs(cwd, undefined);
    expect([refsOf(cwd), n]).toEqual(["a", 1]);
    noteRefs(cwd, "b");
    expect([refsOf(cwd), n]).toEqual(["b", 2]);
    off();
    noteRefs(cwd, "c");
    expect(n).toBe(2);
  });
});
