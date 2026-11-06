// Timeline rows (docs/spec.md "Local history", Editor): the Local history entries and the commits of one file, newest first.
import type { GitCommit, HistoryEntry } from "@claude-ui/protocol";

export type TimelineRow =
  | { source: "history"; key: string; time: number; entry: HistoryEntry }
  | { source: "git"; key: string; time: number; commit: GitCommit };

export type TimelineFilter = { history: boolean; git: boolean };

/** Every row of both sources, newest first (a commit's `time` is unix seconds, an entry's ms); equal times keep the entries first. */
export function timelineRows(entries: readonly HistoryEntry[], commits: readonly GitCommit[]): TimelineRow[] {
  const rows: TimelineRow[] = [
    ...entries.map((entry): TimelineRow => ({ source: "history", key: `h:${entry.id}`, time: entry.time, entry })),
    ...commits.map((commit): TimelineRow => ({ source: "git", key: `g:${commit.hash}`, time: commit.time * 1000, commit })),
  ];
  return rows.sort((a, b) => b.time - a.time);
}

export const visibleRows = (rows: readonly TimelineRow[], f: TimelineFilter): TimelineRow[] => rows.filter((r) => (r.source === "history" ? f.history : f.git));

/** The next older row of the same source in `rows` (all rows, unfiltered); undefined for the oldest. */
export function previousOf(rows: readonly TimelineRow[], row: TimelineRow): TimelineRow | undefined {
  const i = rows.findIndex((r) => r.key === row.key);
  return i < 0 ? undefined : rows.slice(i + 1).find((r) => r.source === row.source);
}
