import { expect, it } from "vitest";
import { MAX_CLOSED, popClosed, pushClosed } from "./closed-tabs.ts";

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
