// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { FOCUS_TAB, NEW_TAB } from "./tabs.ts";
import { type Split, isSession, switchRuns, canSplit, clampRatio, dropZone, followSplit, loadSplit, nextAfterClose, nextSplit, parseSplit, placeIn, ratioFor, saveSplit, splitTo } from "./split.ts";

const sp = (o: Partial<Split> = {}): Split => ({ dir: "row", ids: ["a", "b"], at: 1, ratio: 0.5, ...o });
afterEach(() => (saveSplit(undefined), vi.restoreAllMocks()));

it("parseSplit reads invalid input as no split and clamps the rest", () => {
  for (const raw of [null, "nope", "{}", "[]", '{"ids":["a"]}', '{"ids":["a","a"]}', '{"ids":[1,2]}', '{"ids":["new","focus"]}']) expect(parseSplit(raw)).toBeUndefined();
  expect(parseSplit('{"ids":["a","b","c"],"dir":"zig","at":9,"ratio":5}')).toEqual({ dir: "row", ids: ["a", "b"], at: 1, ratio: 0.85 });
  expect(parseSplit('{"ids":["a","b"],"dir":"col","at":0,"ratio":0,"runs":{"a":"r1","z":"r2","b":3}}')).toEqual({ dir: "col", ids: ["a", "b"], at: 0, ratio: 0.15, runs: { a: "r1" } });
});

it("followSplit: the active tab is in the active split; the same object when unchanged", () => {
  const s = sp();
  expect(followSplit(s, "b", ["a", "b", "c"])).toBe(s);
  expect(followSplit(s, "a", ["a", "b", "c"])).toEqual({ ...s, at: 0 });
  expect(followSplit(s, "c", ["a", "b", "c"])).toEqual({ ...s, ids: ["a", "c"], at: 1 });
  expect(followSplit(sp({ at: 0 }), "c", ["a", "b", "c"])).toEqual({ ...sp({ at: 0 }), ids: ["c", "b"], at: 0 });
  expect(followSplit(undefined, "a", ["a"])).toBeUndefined();
});

it("followSplit: a closed tab ends the split; the New session tab and Focus page suspend it", () => {
  expect(followSplit(sp(), "b", ["b", "c"])).toBeUndefined();
  expect(followSplit(sp(), "a", ["a"])).toBeUndefined();
  const s = sp();
  for (const id of [NEW_TAB, FOCUS_TAB, undefined]) expect(followSplit(s, id, ["a", "b", NEW_TAB])).toBe(s);
  expect(followSplit(s, "c", ["a", "c"])).toEqual({ ...s, ids: ["a", "c"] });
});

it("followSplit drops runs of tabs that left", () => {
  const s = sp({ runs: { a: "r1", b: "r2" } });
  expect(followSplit(s, "c", ["a", "b", "c"])?.runs).toEqual({ a: "r1" });
});

it("isSession is false for a plan ref; parseSplit drops it; followSplit suspends while a plan tab is active", () => {
  const ref = "plan:0f8e7d6c-1234-4abc-8def-0123456789ab";
  expect(isSession(ref)).toBe(false);
  expect(parseSplit(JSON.stringify({ ids: ["a", ref] }))).toBeUndefined();
  const s = sp();
  expect(followSplit(s, ref, ["a", "b", ref])).toBe(s);
  expect(canSplit(["a", ref])).toBe(false);
  expect(splitTo(undefined, ["a", "b", ref], "a", ref, "row")).toBeUndefined();
});

it("canSplit counts session tabs only", () => {
  expect(canSplit(["a", NEW_TAB, FOCUS_TAB])).toBe(false);
  expect(canSplit(["a", "b"])).toBe(true);
});

it("splitTo: the split of the active tab takes the neighbour, any other tab takes the active tab's place beside it", () => {
  expect(splitTo(undefined, ["a", "b", "c"], "b", "b", "row")).toEqual({ split: { dir: "row", ids: ["c", "b"], at: 1, ratio: 0.5, runs: undefined }, active: "b" });
  expect(splitTo(undefined, ["a", "b", "c"], "a", "c", "col")?.split).toMatchObject({ dir: "col", ids: ["a", "c"], at: 1 });
  expect(splitTo(undefined, ["a", "b", "c"], "a", "c", "row", true)).toMatchObject({ split: { ids: ["c", "a"], at: 0 }, active: "c" });
  expect(splitTo(undefined, ["a", "b"], "b", "b", "row")?.split.ids).toEqual(["a", "b"]);
});

it("splitTo: no other session, or a tab that is not open, is undefined; New session is ignored; an existing split keeps ratio and the other tab", () => {
  expect(splitTo(undefined, ["a", NEW_TAB], "a", "a", "row")).toBeUndefined();
  expect(splitTo(undefined, ["a", "b"], "a", "z", "row")).toBeUndefined();
  expect(splitTo(undefined, ["a", "b"], NEW_TAB, "a", "row")?.split.ids).toEqual(["b", "a"]);
  expect(splitTo(sp({ ratio: 0.3 }), ["a", "b", "c"], "b", "b", "col")).toMatchObject({ split: { dir: "col", ids: ["a", "b"], ratio: 0.3 } });
});

it("placeIn shows a tab in a split; a tab shown in the other split swaps", () => {
  expect(placeIn(sp(), "c", 0)).toMatchObject({ ids: ["c", "b"], at: 0 });
  expect(placeIn(sp(), "b", 0)).toMatchObject({ ids: ["b", "a"], at: 0 });
});

it("nextSplit wraps", () => {
  expect(nextSplit(sp({ at: 1 }), 1)).toBe("a");
  expect(nextSplit(sp({ at: 0 }), -1)).toBe("b");
});

it("nextAfterClose prefers a strip neighbour outside the split, else the other split's tab", () => {
  expect(nextAfterClose(["a", "x", "b", "y"], "b", sp())).toBe("y");
  expect(nextAfterClose(["a", "x", "b"], "b", sp())).toBe("x");
  expect(nextAfterClose(["a", "b"], "b", sp())).toBe("a");
});

it("clampRatio and ratioFor keep both splits usable", () => {
  expect(clampRatio(0.01)).toBe(0.15);
  expect(clampRatio(NaN)).toBe(0.5);
  expect(ratioFor(100, 1000, 320)).toBe(0.32);
  expect(ratioFor(900, 1000, 320)).toBeCloseTo(0.68);
  expect(ratioFor(100, 500, 320)).toBe(0.5);
});

it("dropZone: outer third picks the nearest edge, the middle is the centre", () => {
  const r = { left: 0, top: 0, width: 300, height: 300 };
  expect([dropZone(r, 10, 150), dropZone(r, 290, 150), dropZone(r, 150, 10), dropZone(r, 150, 290), dropZone(r, 150, 150)]).toEqual(["left", "right", "top", "bottom", "center"]);
});

it("saves and loads the split, and falls back to memory when storage is blocked", () => {
  saveSplit(sp());
  expect(loadSplit()).toEqual(sp());
  saveSplit(undefined);
  expect(loadSplit()).toBeUndefined();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  saveSplit(sp({ at: 0 }));
  expect(loadSplit()).toEqual(sp({ at: 0 }));
});

it("switchRuns takes the target's view out and keeps the previous active tab's", () => {
  expect(switchRuns({ b: "r1" }, "a", "r0", "b")).toEqual({ runs: { a: "r0" }, run: "r1" });
  expect(switchRuns({ b: "r1" }, "a", undefined, "b")).toEqual({ runs: undefined, run: "r1" });
  expect(switchRuns(undefined, "a", undefined, "b")).toEqual({ runs: undefined, run: undefined });
});
