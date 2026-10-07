// Fuzzy file search for @-mention autocomplete and quick open (`fs.search`).
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import fuzzysort from "fuzzysort";

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

const depth = (p: string) => p.replace(/\/$/, "").split("/").length;

/**
 * Prepared fuzzysort targets of the last searched folders, current paths only. Passing string targets to fuzzysort.go would fill its global
 * cache with every path ever searched for the daemon's lifetime (~37 MB per 20 000 paths); preparing is what makes a repeat search fast.
 */
const PREPARED_DIRS = 2;
const prepared = new Map<string, Map<string, Fuzzysort.Prepared>>();

/** Total prepared targets kept (tests). */
export const preparedCount = () => [...prepared.values()].reduce((n, m) => n + m.size, 0);

function targets(dir: string, paths: string[]) {
  const old = prepared.get(dir);
  const next = new Map(paths.map((p) => [p, old?.get(p) ?? fuzzysort.prepare(p)]));
  prepared.delete(dir);
  prepared.set(dir, next);
  for (const d of prepared.keys()) if (prepared.size > PREPARED_DIRS) prepared.delete(d);
  return [...next.values()];
}

/** fuzzysort, as OpenCode's file search: case-insensitive, contiguous and word-start matches first. An empty query lists shallow and short paths first. */
export function fuzzyRank(paths: string[], query: string, dir?: string): string[] {
  if (query) return fuzzysort.go(query, dir ? targets(dir, paths) : paths.map((p) => fuzzysort.prepare(p))).map((r) => r.target);
  return [...paths].sort((a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b));
}

/** Respects .gitignore inside a git work tree; a folder git lists nothing for (not a repo, or ignored as a whole) is walked. */
export function searchFiles(dir: string, query: string, limit = 50) {
  const files = gitFiles(dir);
  return fuzzyRank(files.length ? files : walk(dir), query, dir).slice(0, limit);
}
