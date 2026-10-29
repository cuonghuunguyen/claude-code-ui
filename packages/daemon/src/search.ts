// Fuzzy file search for @-mention autocomplete and quick open (`fs.search`).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import fuzzysort from "fuzzysort";
import type { GitRepo } from "@claude-ui/protocol";
import { limiter, pinEnv } from "./git.ts";
import { runGit } from "./git-runner.ts";

const SKIP = new Set([".git", "node_modules"]);
export const searchLimits = { entries: 20_000, ttl: 10_000, cached: 64 };
const gitSlot = limiter(4);

/** Paths under `dir`, relative, folders with a trailing slash, breadth-first. Symlinked folders are listed, not entered; neither are the `stop` folders (repositories, listed by git). */
async function walk(dir: string, stop: Set<string>): Promise<string[]> {
  const out: string[] = [];
  const queue = [""];
  while (queue.length && out.length < searchLimits.entries) {
    const rel = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = rel + e.name;
      if (e.isDirectory()) {
        out.push(`${p}/`);
        if (!stop.has(p)) queue.push(`${p}/`);
      } else out.push(p);
    }
  }
  return out;
}

/** `git ls-files` through the git runner (a UNC WSL project runs it in its distro), pinned to the repository (#317). */
const git = async (dir: string, args: string[]) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", ...(await pinEnv(dir)) };
  const r = await runGit({ cwd: dir, args: ["-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "ls-files", "-z", ...args], env, maxBuffer: 64 << 20, idempotent: true });
  return r.stdout.toString("utf8").split("\0").filter(Boolean);
};

const listings = new Map<string, { at: number; files: Promise<string[]> }>();
/** Drops every cached repository listing (the daemon wrote a file, or sessions/settings changed). */
export const clearSearchCache = () => listings.clear();

/** Cached listing per repository: `ttl` ms, the in-flight load is shared, a failed load is not kept, at most `cached` repositories. */
function gitFiles(dir: string): Promise<string[]> {
  const hit = listings.get(dir);
  if (hit && Date.now() - hit.at < searchLimits.ttl) return hit.files;
  const files = loadGitFiles(dir).catch(() => {
    if (listings.get(dir) === entry) listings.delete(dir);
    return [];
  });
  const entry = { at: Date.now(), files };
  listings.delete(dir);
  listings.set(dir, entry);
  for (const k of listings.keys()) if (listings.size > searchLimits.cached) listings.delete(k);
  return files;
}

/** In a git work tree: tracked and untracked files minus gitignored and deleted ones; empty outside one or in an ignored folder. An embedded repository or submodule shows as one entry. */
async function loadGitFiles(dir: string): Promise<string[]> {
  // Two calls: `-t` (the only one-call way to see deleted files) is semi-deprecated in git.
  const [files, del] = await Promise.all([git(dir, ["--cached", "--others", "--exclude-standard"]), git(dir, ["--deleted"])]);
  const deleted = new Set(del);
  return files.filter((f) => !deleted.has(f) && !f.split("/").some((s) => SKIP.has(s))).slice(0, searchLimits.entries);
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

/**
 * Respects .gitignore inside a git work tree; a folder git lists nothing for (not a repo, or ignored as a whole) is walked.
 * `repos` (git.repos of `dir`): each repository strictly under `dir` is listed by its own git, a nested folder or gitlink is replaced by its files.
 */
export async function searchFiles(dir: string, query: string, limit = 50, repos: GitRepo[] = []): Promise<string[]> {
  const inner = repos.filter((r) => !r.outsideRoots && r.rel !== "" && !r.rel.startsWith("..")).sort((a, b) => b.rel.length - a.rel.length);
  const ownerOf = (p: string) => inner.find((r) => p === r.rel || p.startsWith(`${r.rel}/`));
  const top = await gitFiles(dir);
  const [rootFiles, ...nested] = await Promise.all([
    top.length ? Promise.resolve(top.filter((p) => !ownerOf(p))) : walk(dir, new Set(inner.map((r) => r.rel))),
    ...inner.map(async (r) => (await gitSlot(() => gitFiles(r.path))).map((f) => `${r.rel}/${f}`).filter((p) => ownerOf(p) === r)),
  ]);
  // Fair share: a huge parent must not starve the nested repositories of the cap.
  const lists = [rootFiles!, ...nested];
  const share = Math.ceil(searchLimits.entries / lists.length);
  const taken = lists.map((l) => l.slice(0, share));
  let room = searchLimits.entries - taken.reduce((n, l) => n + l.length, 0);
  const files = taken.map((t, i) => {
    const extra = lists[i]!.slice(t.length, t.length + Math.max(room, 0));
    room -= extra.length;
    return [...t, ...extra];
  });
  const out = new Set<string>(inner.map((r) => `${r.rel}/`));
  for (const f of files.flat()) {
    for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) out.add(f.slice(0, i + 1));
    out.add(f);
  }
  for (const r of inner) for (let i = r.rel.indexOf("/"); i > 0; i = r.rel.indexOf("/", i + 1)) out.add(r.rel.slice(0, i + 1));
  return fuzzyRank([...out].slice(0, searchLimits.entries), query, dir).slice(0, limit);
}
