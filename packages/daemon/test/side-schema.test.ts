// ADR 0009: the range of side frame schemas decides whether two Hubs can attach; a mismatch row names which side updates.
import { expect, it } from "vitest";
import { schemaOverlap } from "../src/side-frame.ts";
import { mismatchMessage } from "../src/sides.ts";

it("schemaOverlap: ranges that share a number overlap", () => {
  expect(schemaOverlap([1, 1], [1, 1])).toBe(true);
  expect(schemaOverlap([1, 2], [2, 3])).toBe(true);
  expect(schemaOverlap([1, 1], [2, 2])).toBe(false);
  expect(schemaOverlap([3, 4], [1, 2])).toBe(false);
});

const m = (remoteOlder: boolean) => ({ local: "1.2.0", remote: "1.0.0", localSchema: [1, 1] as [number, number], remoteOlder });
it("mismatchMessage: an older remote is updated there, a newer remote means updating this Hub", () => {
  expect(mismatchMessage("SSH: box", m(true))).toBe("SSH: box runs Claude UI 1.0.0, this is 1.2.0: they cannot work together. Update it there; it attaches by itself afterwards.");
  expect(mismatchMessage("SSH: box", m(false))).toBe("SSH: box runs Claude UI 1.0.0, newer than this 1.2.0: they cannot work together. Update this Claude UI.");
});
