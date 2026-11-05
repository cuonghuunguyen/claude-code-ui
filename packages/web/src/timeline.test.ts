import { expect, it } from "vitest";
import type { GitCommit, HistoryEntry } from "@claude-ui/protocol";
import { previousOf, timelineRows, visibleRows } from "./timeline.ts";

const e = (id: string, time: number): HistoryEntry => ({ id, time, reason: "save", size: 1 });
const c = (hash: string, time: number): GitCommit => ({ hash, parents: [], author: "a", email: "a@example.com", time, subject: hash, refs: [] });

it("merges both sources newest first (commit seconds against entry milliseconds)", () => {
  const rows = timelineRows([e("e1", 5_000), e("e2", 9_000)], [c("c1", 7), c("c2", 2)]);
  expect(rows.map((r) => r.key)).toEqual(["h:e2", "g:c1", "h:e1", "g:c2"]);
});

it("the filter hides one source", () => {
  const rows = timelineRows([e("e1", 5_000)], [c("c1", 7)]);
  expect(visibleRows(rows, { history: true, git: false }).map((r) => r.source)).toEqual(["history"]);
  expect(visibleRows(rows, { history: false, git: true }).map((r) => r.source)).toEqual(["git"]);
  expect(visibleRows(rows, { history: false, git: false })).toEqual([]);
});

it("previous is the next older row of the same source, also when the filter hides the rows between", () => {
  const rows = timelineRows([e("e1", 5_000), e("e2", 9_000)], [c("c1", 7), c("c2", 2)]);
  expect(previousOf(rows, rows[0]!)?.key).toBe("h:e1");
  expect(previousOf(rows, rows[1]!)?.key).toBe("g:c2");
  expect(previousOf(rows, rows[2]!)).toBeUndefined();
  expect(previousOf(rows, rows[3]!)).toBeUndefined();
});
