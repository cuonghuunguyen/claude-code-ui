// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadUsed, pruneUsed, saveUsed, seedUsed, stampUsed } from "./tab-used.ts";

beforeEach(() => localStorage.clear());

describe("GH-378 tab used stamps", () => {
  it("GH-378 stampUsed sets now for the given ids, skips undefined", () => {
    expect(stampUsed({ a: 1 }, ["b", undefined], 9)).toEqual({ a: 1, b: 9 });
    expect(stampUsed({ a: 1 }, ["a"], 9)).toEqual({ a: 9 });
  });
  it("GH-378 seedUsed adds now only for tabs without a stamp and returns the same object when none", () => {
    const u = { a: 1 };
    expect(seedUsed(u, ["a", "b"], 9)).toEqual({ a: 1, b: 9 });
    expect(seedUsed(u, ["a"], 9)).toBe(u);
  });
  it("GH-378 pruneUsed drops ids not kept", () => {
    const u = { a: 1, b: 2 };
    expect(pruneUsed(u, new Set(["a"]))).toEqual({ a: 1 });
    expect(pruneUsed(u, new Set(["a", "b", "c"]))).toBe(u);
  });
  it("GH-378 loadUsed ignores junk; saveUsed merges the max per id with what another window stored", () => {
    localStorage.setItem("claude-ui.tab-used", "{nope");
    expect(loadUsed()).toEqual({});
    localStorage.setItem("claude-ui.tab-used", JSON.stringify({ a: 5, b: "x", c: null, d: 7 }));
    expect(loadUsed()).toEqual({ a: 5, d: 7 });
    saveUsed({ a: 3, d: 9 });
    expect(loadUsed()).toEqual({ a: 5, d: 9 });
  });
});
