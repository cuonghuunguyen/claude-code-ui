import { structuredPatch } from "diff";

/**
 * Added and removed line counts between two texts, the same counts @pierre/diffs gets from `parseDiffFromFile` (both read the
 * `diff` package's patch). It is a module of its own because the library's renderer is a lazy chunk (diffs.tsx) while the stats are
 * needed synchronously, for every tool card header and Changes row.
 */
export function lineStats(name: string, before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of structuredPatch(name, name, before, after).hunks)
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  return { added, removed };
}
