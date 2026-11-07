// Find in files (`fs.grep`) over `git grep`, through the git runner (docs/spec.md "Wire protocol"). In a repository:
// `--untracked` (tracked and untracked files, ignored ones only on request); outside one: `--no-index`, which also walks
// nested repositories' work trees. Inside a repository, each nested repository or submodule (`git.repos`) gets its own run,
// because git grep stops at them. Caps: bytes per run and in total, a deadline, files and match lines of the reply.
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { wslPathOf } from "@claude-ui/protocol";
import type { FsGrepResult, GitRepo, GrepFile, GrepLine } from "@claude-ui/protocol";
import { gitEscapes, gitTopOf, limiter, pinEnv } from "./git.ts";
import { runGit } from "./git-runner.ts";

export const GREP_LIMITS = { matches: 2000, files: 200, runBytes: 8 << 20, bytes: 16 << 20, ms: 5000, lineChars: 300, context: 2, highlightMs: 1000 };
export type GrepLimits = typeof GREP_LIMITS;
export class GrepError extends Error {
  constructor(message: string, readonly code: "grep_failed" | "git_missing" | "regex_unsupported") {
    super(message);
  }
}

const slot = limiter(4);

/** The comma separated file patterns of the request as pathspecs, or an error message. */
export function parseGlobs(s: string | undefined): string[] | string {
  if (!s || !s.trim()) return [];
  if (s.length > 500) return "Invalid file patterns: longer than 500 characters";
  const list = s.split(",").map((g) => g.trim()).filter(Boolean);
  if (list.length > 20) return "Invalid file patterns: more than 20";
  // `:` starts git pathspec magic; `..` and a leading `/` would leave the searched folder.
  const bad = list.find((g) => g.startsWith(":") || g.startsWith("/") || g.includes("\0") || g.split(/[\\/]/).includes(".."));
  return bad === undefined ? list : `Invalid file pattern: ${bad}`;
}

/** Case-insensitive, global; a plain query is escaped. Throws a SyntaxError for an invalid regular expression. */
export const matcher = (query: string, regex: boolean) => new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

/** [start, end) offsets of the matches in `text`; empty matches are skipped, at most 50. */
export function rangesOf(text: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m && out.length < 50; m = re.exec(text)) {
    if (m[0] === "") re.lastIndex++;
    else out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** A line over `max` chars cut around its first match (head only without one), `…` marks each cut end; ranges follow. */
export function cutLine(text: string, ranges: [number, number][] | undefined, max: number): { text: string; ranges?: [number, number][]; cut: boolean } {
  if (text.length <= max) return { text, ranges, cut: false };
  const first = ranges?.[0];
  let s = first ? Math.max(0, first[0] - Math.floor((max - Math.min(max, first[1] - first[0])) / 2)) : 0;
  const e = Math.min(text.length, s + max);
  s = Math.max(0, e - max);
  const lead = s > 0 ? 1 : 0;
  const shifted = ranges?.flatMap(([a, b]): [number, number][] => (a >= s && b <= e ? [[a - s + lead, b - s + lead]] : []));
  return { text: (s > 0 ? "…" : "") + text.slice(s, e) + (e < text.length ? "…" : ""), ranges: shifted, cut: true };
}

// A user regex can backtrack without end (`x|(a+)+b`), and a JS RegExp cannot be interrupted: regex highlights run in a thread
// that is killed at the deadline (the match lines then have empty ranges), so the event loop is never blocked.
// shortcut: one thread per regex search with results (about 30 ms); keep one alive if that shows up in a profile.
const HIGHLIGHT_THREAD = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ query, texts }) => {
  let re;
  try { re = new RegExp(query, "gi"); } catch { return parentPort.postMessage(undefined); }
  parentPort.postMessage(texts.map((t) => {
    const out = [];
    re.lastIndex = 0;
    for (let m = re.exec(t); m && out.length < 50; m = re.exec(t)) {
      if (m[0] === "") re.lastIndex++;
      else out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }));
});`;

/** Highlight ranges of each text; undefined when the query is no JS RegExp or a regex search ran out of `ms` (or `signal` fired). */
export function highlights(query: string, regex: boolean, texts: string[], ms: number, signal: AbortSignal): Promise<[number, number][][] | undefined> {
  if (!regex) {
    const re = matcher(query, false);
    return Promise.resolve(texts.map((t) => rangesOf(t, re)));
  }
  if (!texts.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    let w: Worker | undefined;
    const done = (r?: [number, number][][]) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      void w?.terminate();
      resolve(r);
    };
    const stop = () => done();
    const timer = setTimeout(stop, ms);
    signal.addEventListener("abort", stop, { once: true });
    try {
      w = new Worker(HIGHLIGHT_THREAD, { eval: true });
      w.on("message", done);
      w.on("error", stop);
      w.postMessage({ query, texts });
    } catch {
      stop();
    }
  });
}

export function grepArgs(q: { query: string; regex: boolean; globs: string[]; includeIgnored: boolean; git: boolean }): string[] {
  const where = q.git ? ["--untracked", ...(q.includeIgnored ? ["--no-exclude-standard"] : [])] : ["--no-index", ...(q.includeIgnored ? [] : ["--exclude-standard"])];
  // `-e` keeps a query that starts with `-` a pattern; `--null --column` tells match lines (3 NUL fields) from context lines (2).
  return ["-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "grep", ...where, "-n", q.regex ? "-P" : "-F", "-I", "-i", "-C", String(GREP_LIMITS.context), "--null", "--column", "--no-color", "-e", q.query, "--", ...q.globs];
}

/** Lines of `git grep --null --column -n`: `path\0n\0col\0text` (match), `path\0n\0text` (context), `--` (group break, skipped). */
export function parseGrep(out: string, prefix: string): { path: string; n: number; text: string; match: boolean }[] {
  const res: { path: string; n: number; text: string; match: boolean }[] = [];
  for (const line of out.split("\n")) {
    if (!line || line === "--") continue;
    const f = line.split("\0");
    const text = (f.length === 4 ? f[3]! : f[2] ?? "").replace(/\r$/, "");
    if ((f.length !== 3 && f.length !== 4) || !/^\d+$/.test(f[1]!)) continue;
    res.push({ path: prefix + f[0]!, n: Number(f[1]), text, match: f.length === 4 });
  }
  return res;
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

export async function findInFiles(
  cwd: string,
  q: { query: string; regex: boolean; globs: string[]; includeIgnored?: boolean },
  opts: { signal: AbortSignal; allowed: (p: string) => boolean; repoAllowed: (p: string) => boolean; repos: GitRepo[]; limits?: Partial<GrepLimits> },
): Promise<FsGrepResult> {
  const limits = { ...GREP_LIMITS, ...opts.limits };
  const { signal } = opts;
  const t0 = Date.now();
  const deadline = t0 + limits.ms;
  const git = !!(await gitTopOf(cwd));
  const includeIgnored = q.includeIgnored ?? !git;
  if (signal.aborted) return { files: [], matches: 0, ms: 0, includeIgnored, git, stopped: "canceled" };
  const inner = git ? opts.repos.filter((r) => !r.outsideRoots && r.rel !== "" && !r.rel.startsWith("..")).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)) : [];
  const runs = [{ dir: cwd, prefix: "" }, ...inner.map((r) => ({ dir: r.path, prefix: `${r.rel}/` }))];
  const args = grepArgs({ query: q.query, regex: q.regex, globs: q.globs, includeIgnored, git });
  let total = 0;
  const hit = { bytes: false, time: false, canceled: false };
  // shortcut: an escaping repository is not searched (no git may read it); add a JS fallback search if users need it.
  const one = async (dir: string): Promise<string> => {
    const skip = (k: keyof typeof hit) => ((hit[k] = true), "");
    if (signal.aborted) return skip("canceled");
    if (Date.now() >= deadline) return skip("time");
    if (total >= limits.bytes) return skip("bytes");
    if (git && (await gitEscapes(dir, opts.repoAllowed))) return "";
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", ...(await pinEnv(dir)) };
    let out: Buffer;
    try {
      out = (await runGit({ cwd: dir, args, env, timeout: Math.max(1, deadline - Date.now()), maxBuffer: limits.runBytes, killTree: !wslPathOf(dir), signal, idempotent: true })).stdout;
    } catch (e) {
      const err = e as Error & { code?: string | number; killed?: boolean; stdout?: Buffer; stderr?: string };
      if (err.code === 1 && !err.killed) return "";
      if (err.code === "ENOENT") throw new GrepError("git is not installed or not on PATH", "git_missing");
      if (signal.aborted) hit.canceled = true;
      else if (err.killed) hit.time = true;
      else if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") hit.bytes = true;
      else if (q.regex && /perl-compatible/i.test(err.stderr ?? "")) throw new GrepError("This git has no Perl regex support; update git", "regex_unsupported");
      else throw new GrepError(firstLine(err.stderr ?? "") || err.message, "grep_failed");
      out = err.stdout ?? Buffer.alloc(0);
      total += out.length;
      // The last line may be unterminated.
      const s = out.toString("utf8");
      return s.slice(0, s.lastIndexOf("\n") + 1);
    }
    total += out.length;
    return out.toString("utf8");
  };
  const outs = await Promise.all(runs.map((r) => slot(() => one(r.dir))));
  const files: GrepFile[] = [];
  const okPath = new Map<string, boolean>();
  let matches = 0;
  let capped: "matches" | "files" | undefined;
  let cut = false;
  let cur: GrepFile | undefined;
  scan: for (const [i, out] of outs.entries()) {
    for (const l of parseGrep(out, runs[i]!.prefix)) {
      if (!okPath.has(l.path)) okPath.set(l.path, opts.allowed(join(cwd, l.path)));
      if (!okPath.get(l.path)) continue;
      if (cur?.path !== l.path) {
        if (files.length >= limits.files) {
          capped = "files";
          break scan;
        }
        cur = undefined;
      }
      if (l.match && matches >= limits.matches) {
        capped = "matches";
        break scan;
      }
      // Raw text and no ranges yet: they come after the caps (`highlights`), the cut after them.
      const line: GrepLine = { n: l.n, text: l.text, ...(l.match ? { ranges: [] } : {}) };
      if (!cur) files.push((cur = { path: l.path, lines: [] }));
      cur.lines.push(line);
      if (l.match) matches++;
    }
  }
  if (capped === "matches") {
    const last = files[files.length - 1];
    const lastMatch = last?.lines.filter((l) => l.ranges).pop();
    if (last) {
      // Keep the context lines right after the last kept match; a file with no kept match (only the cut match's context) goes.
      last.lines = lastMatch ? last.lines.filter((l) => l.n <= lastMatch.n + limits.context) : [];
      if (!last.lines.length) files.pop();
    }
  }
  const hits = files.flatMap((f) => f.lines.filter((l) => l.ranges));
  const found = await highlights(q.query, q.regex, hits.map((l) => l.text), limits.highlightMs, signal);
  hits.forEach((l, i) => (l.ranges = found?.[i] ?? []));
  for (const f of files)
    f.lines = f.lines.map((l) => {
      const c = cutLine(l.text, l.ranges, limits.lineChars);
      cut ||= c.cut;
      return { n: l.n, text: c.text, ...(l.ranges ? { ranges: c.ranges ?? [] } : {}) };
    });
  const stopped = capped ?? (hit.bytes ? "bytes" : hit.time ? "time" : hit.canceled || signal.aborted ? "canceled" : undefined);
  return { files, matches, ms: Date.now() - t0, includeIgnored, git, ...(stopped ? { stopped } : {}), ...(cut ? { cut: true as const } : {}) };
}
