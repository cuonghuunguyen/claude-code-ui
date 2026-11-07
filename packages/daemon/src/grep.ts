// Find in files (`fs.grep`) over `git grep`, through the git runner (docs/spec.md "Wire protocol"). In a repository:
// `--untracked` (tracked and untracked files, ignored ones only on request); outside one: `--no-index`, which also walks
// nested repositories' work trees. Inside a repository, each nested repository or submodule (`git.repos`) gets its own run,
// because git grep stops at them. Caps: bytes per run and in total, a deadline, files and match lines of the reply.
import { join } from "node:path";
import { wslPathOf } from "@claude-ui/protocol";
import type { FsGrepResult, GitRepo, GrepFile, GrepLine } from "@claude-ui/protocol";
import { gitEscapes, gitTopOf, limiter, pinEnv } from "./git.ts";
import { runGit } from "./git-runner.ts";

export const GREP_LIMITS = { matches: 2000, files: 200, runBytes: 8 << 20, bytes: 16 << 20, ms: 5000, lineChars: 300, context: 2 };
export type GrepLimits = typeof GREP_LIMITS;
export class GrepError extends Error {
  constructor(message: string, readonly code: "grep_failed" | "git_missing") {
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

export function grepArgs(q: { query: string; regex: boolean; globs: string[]; includeIgnored: boolean; git: boolean }): string[] {
  const where = q.git ? ["--untracked", ...(q.includeIgnored ? ["--no-exclude-standard"] : [])] : ["--no-index", ...(q.includeIgnored ? [] : ["--exclude-standard"])];
  // `-e` keeps a query that starts with `-` a pattern; `--null --column` tells match lines (3 NUL fields) from context lines (2).
  return ["-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "grep", ...where, "-n", q.regex ? "-E" : "-F", "-I", "-i", "-C", String(GREP_LIMITS.context), "--null", "--column", "--no-color", "-e", q.query, "--", ...q.globs];
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
  const re = matcher(q.query, q.regex);
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
      const ranges = l.match ? rangesOf(l.text, re) : undefined;
      const c = cutLine(l.text, ranges, limits.lineChars);
      cut ||= c.cut;
      const line: GrepLine = { n: l.n, text: c.text, ...(l.match ? { ranges: c.ranges ?? [] } : {}) };
      if (!cur) files.push((cur = { path: l.path, lines: [] }));
      cur.lines.push(line);
      if (l.match) matches++;
    }
  }
  if (capped === "matches") {
    // Context after the last kept match belongs to the match that was cut.
    const last = files[files.length - 1];
    while (last && last.lines.length && last.lines[last.lines.length - 1]!.ranges === undefined) last.lines.pop();
    if (last && !last.lines.length) files.pop();
  }
  const stopped = capped ?? (hit.bytes ? "bytes" : hit.time ? "time" : hit.canceled || signal.aborted ? "canceled" : undefined);
  return { files, matches, ms: Date.now() - t0, includeIgnored, git, ...(stopped ? { stopped } : {}), ...(cut ? { cut: true as const } : {}) };
}
