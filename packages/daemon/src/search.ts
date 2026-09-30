// Fuzzy file search for @-mention autocomplete (`fs.search`).
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set([".git", "node_modules"]);
// ponytail: walks the tree on every request, capped; cache per cwd or honor .gitignore if big repos feel slow.
const MAX_ENTRIES = 20_000;

/** Paths under `dir`, relative, folders with a trailing slash, breadth-first. Symlinked folders are listed, not entered. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const queue = [""];
  while (queue.length && out.length < MAX_ENTRIES) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = rel + e.name;
      if (e.isDirectory()) {
        out.push(`${p}/`);
        queue.push(`${p}/`);
      } else out.push(p);
    }
  }
  return out;
}

const isSubsequence = (q: string, s: string) => {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
};

/** Case-insensitive subsequence matches: file name prefix, then file name, then path substring, then scattered; shallow and short first. */
export function fuzzyRank(paths: string[], query: string): string[] {
  const q = query.toLowerCase();
  const scored: { p: string; key: number[] }[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (!isSubsequence(q, lower)) continue;
    const name = lower.replace(/\/$/, "").split("/").pop()!;
    const tier = name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : 3;
    scored.push({ p, key: [tier, p.replace(/\/$/, "").split("/").length, p.length] });
  }
  const cmp = (a: number[], b: number[]) => a.findIndex((x, i) => x !== b[i]);
  return scored
    .sort((a, b) => {
      const i = cmp(a.key, b.key);
      return i < 0 ? a.p.localeCompare(b.p) : a.key[i]! - b.key[i]!;
    })
    .map((s) => s.p);
}

export const searchFiles = (dir: string, query: string, limit = 50) => fuzzyRank(walk(dir), query).slice(0, limit);
