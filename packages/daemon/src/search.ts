// Fuzzy file search for @-mention autocomplete and quick open (`fs.search`).
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set([".git", "node_modules"]);
// ponytail: lists the tree on every request, capped; cache per cwd if big repos feel slow.
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

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["ls-files", "-z", ...args], { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] })
    .split("\0")
    .filter(Boolean);

/** In a git work tree: tracked and untracked files minus gitignored and deleted ones, plus their folders; empty outside one or in an ignored folder. */
function gitFiles(dir: string): string[] {
  let files: string[];
  let deleted: Set<string>;
  try {
    files = git(dir, ["--cached", "--others", "--exclude-standard"]);
    deleted = new Set(git(dir, ["--deleted"]));
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const f of files) {
    if (deleted.has(f) || f.split("/").some((s) => SKIP.has(s))) continue;
    for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) out.add(f.slice(0, i + 1));
    out.add(f);
    if (out.size >= MAX_ENTRIES) break;
  }
  return [...out];
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

/** Respects .gitignore inside a git work tree; a folder git lists nothing for (not a repo, or ignored as a whole) is walked. */
export function searchFiles(dir: string, query: string, limit = 50) {
  const files = gitFiles(dir);
  return fuzzyRank(files.length ? files : walk(dir), query).slice(0, limit);
}
