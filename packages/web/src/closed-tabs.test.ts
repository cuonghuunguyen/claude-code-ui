import { expect, it } from "vitest";
import { MAX_CLOSED, popClosed, pushClosed, restoreClosed } from "./closed-tabs.ts";

it("keeps the last 10, newest on top, no duplicates", () => {
  let s = pushClosed([], "a", 0);
  s = pushClosed(s, "b", 1);
  s = pushClosed(s, "a", 2);
  expect(s).toEqual([{ id: "b", at: 1 }, { id: "a", at: 2 }]);
  for (let i = 0; i < 12; i++) s = pushClosed(s, `t${i}`, i);
  expect(s).toHaveLength(MAX_CLOSED);
  expect(s.at(-1)).toEqual({ id: "t11", at: 11 });
});

it("pop skips sessions that are gone or open again", () => {
  const s = [{ id: "a", at: 0 }, { id: "b", at: 1 }, { id: "c", at: 2 }];
  const r = popClosed(s, (id) => id !== "c", ["x"]);
  expect(r.tab).toEqual({ id: "b", at: 1 });
  expect(r.rest).toEqual([{ id: "a", at: 0 }]);
  expect(popClosed(s, (id) => id !== "c", ["b"]).tab?.id).toBe("a");
  expect(popClosed(s, () => false, []).tab).toBeUndefined();
});

it("restore puts that exact entry back at its place (clamped), drops it from the stack, and ignores an open tab", () => {
  const s = [{ id: "a", at: 0 }, { id: "b", at: 1 }, { id: "c", at: 5 }];
  expect(restoreClosed(s, ["x", "y"], "b")).toEqual({ tabs: ["x", "b", "y"], stack: [{ id: "a", at: 0 }, { id: "c", at: 5 }] });
  expect(restoreClosed(s, ["x", "y"], "c").tabs).toEqual(["x", "y", "c"]);
  expect(restoreClosed(s, ["b"], "b")).toEqual({ tabs: ["b"], stack: s });
  expect(restoreClosed(s, ["x"], "zz")).toEqual({ tabs: ["x"], stack: s });
});

it("GH-359 restoreMany puts entries back at their indexes in ascending order, skips open and gone ids, drops restored from the stack", async () => {
  const { restoreMany } = await import("./closed-tabs.ts");
  const stack = [{ id: "x", at: 9 }, { id: "b", at: 1 }, { id: "d", at: 3 }];
  const entries = [{ id: "d", at: 3 }, { id: "b", at: 1 }, { id: "gone", at: 2 }, { id: "open", at: 0 }];
  const r = restoreMany(stack, ["a", "c", "e", "open"], entries, (id) => id !== "gone");
  expect(r.tabs).toEqual(["a", "b", "c", "d", "e", "open"]);
  expect(r.restored).toEqual(["b", "d"]);
  expect(r.stack).toEqual([{ id: "x", at: 9 }]);
  expect(restoreMany([], ["a"], [{ id: "z", at: 40 }], () => true).tabs).toEqual(["a", "z"]);
});
