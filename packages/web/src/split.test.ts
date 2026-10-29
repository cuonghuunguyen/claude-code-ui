// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { FOCUS_TAB, NEW_TAB } from "./tabs.ts";
import { type Split, isSession, switchRuns, clampRatio, dropZone, followSplit, loadSplit, nextAfterClose, nextSplit, parseSplit, placeIn, dropRefusal, REFUSAL_TEXT, ratioFor, saveSplit, splitTo } from "./split.ts";

const U = "0f8e7d6c-1234-4abc-8def-0123456789ab";
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

it("isSession is false for a plan ref; followSplit suspends while a plan tab is active only with no split content", () => {
  expect(isSession(`plan:${U}`)).toBe(false);
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

it("GH-396 followSplit keeps the split unchanged while a graph tab is active and returns it with the next session tab", () => {
  const U = "0f8e7d6c-1234-4abc-8def-0123456789ab";
  const ref = `graph:${U}`;
  const s = sp();
  const tabs = ["a", "b", ref];
  expect(followSplit(s, ref, tabs)).toBe(s);
  expect(followSplit(s, "b", tabs)?.ids).toEqual(s.ids);
  expect(isSession(`files:${U}`)).toBe(false);
});

it("GH-398 parseSplit keeps a session plus a session or a Plan/Files/Terminal ref; two panes, a Git graph ref and junk read as no split", () => {
  const ids = (x: string[]) => parseSplit(JSON.stringify({ ids: x }))?.ids;
  expect(ids(["a", `plan:${U}`])).toEqual(["a", `plan:${U}`]);
  expect(ids([`terminal:${U}`, "a"])).toEqual([`terminal:${U}`, "a"]);
  expect(ids(["a", `files:${U}`])).toEqual(["a", `files:${U}`]);
  expect(ids([`plan:${U}`, `terminal:${U}`])).toBeUndefined();
  expect(ids(["a", `graph:${U}`])).toBeUndefined();
  expect(ids(["a", "b"])).toEqual(["a", "b"]);
});

it("GH-398 followSplit puts an activated pane in the active split, never over the only session", () => {
  const plan = `plan:${U}`;
  const term = `terminal:${U}`;
  const tabs = ["a", "b", plan, term];
  expect(followSplit(sp({ ids: ["a", plan], at: 1 }), term, tabs)).toMatchObject({ ids: ["a", term], at: 1 });
  expect(followSplit(sp(), plan, tabs)).toMatchObject({ ids: ["a", plan], at: 1 });
  expect(followSplit(sp({ ids: ["a", plan], at: 0 }), term, tabs)).toMatchObject({ ids: ["a", term], at: 1 });
  const s = sp();
  expect(followSplit(s, `graph:${U}`, [...tabs, `graph:${U}`])).toBe(s);
  expect(followSplit(sp({ ids: ["a", plan] }), `plan:${"1".repeat(8)}-1234-4abc-8def-0123456789ab`, ["b", plan, `plan:${"1".repeat(8)}-1234-4abc-8def-0123456789ab`])).toBeUndefined();
});

it("GH-398 followSplit keeps the split unchanged while a graph tab is active and returns it with the next session tab", () => {
  const ref = `graph:${U}`;
  const s = sp();
  const tabs = ["a", "b", ref];
  expect(followSplit(s, ref, tabs)).toBe(s);
  expect(followSplit(s, "b", tabs)?.ids).toEqual(s.ids);
});

it("GH-398 splitTo pairs a pane with a session: the active session, else the split's, else its owner, else the nearest session", () => {
  const plan = `plan:${U}`;
  expect(splitTo(undefined, ["a", plan], "a", plan, "row")?.split.ids).toEqual(["a", plan]);
  expect(splitTo(undefined, [U, "x", plan], plan, plan, "row")?.split.ids).toEqual([U, plan]);
  expect(splitTo(undefined, ["x", plan], plan, plan, "row")?.split.ids).toEqual(["x", plan]);
  expect(splitTo(undefined, [plan, `files:${U}`], plan, `files:${U}`, "row")).toBeUndefined();
  expect(splitTo(undefined, ["a", `graph:${U}`], "a", `graph:${U}`, "row")).toBeUndefined();
  expect(splitTo(undefined, ["a", plan], "a", "a", "row")?.split.ids).toEqual([plan, "a"]);
});

it("GH-398 dropRefusal: Git graph is refused at an edge and over a split; a drop leaving no session is refused; a plain centre drop is allowed", () => {
  const plan = `plan:${U}`;
  const graph = `graph:${U}`;
  const files = `files:${U}`;
  const tabs = ["a", plan, files, graph];
  expect(dropRefusal(undefined, false, tabs, "a", graph, "right", -1)).toBe("whole");
  const s = sp({ ids: ["a", plan] });
  expect(dropRefusal(s, true, tabs, plan, files, "center", 0)).toBe("session");
  expect(dropRefusal(s, true, tabs, plan, files, "center", 1)).toBeUndefined();
  expect(dropRefusal(undefined, false, tabs, "a", files, "center", -1)).toBeUndefined();
  expect(REFUSAL_TEXT.whole).toBe("Git graph needs the whole area");
});
