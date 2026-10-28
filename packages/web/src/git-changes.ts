// Rows of the Changes tab's git modes (docs/spec.md "Layout"): a `git.diff` reply as the panel's file list.
import type { GitDiff, GitRepo } from "@claude-ui/protocol";
import type { Stats } from "./changes.ts";
import { joinPath } from "./paths.ts";
import { pathKey } from "./file-tree-model.ts";
import { repoRoot } from "./diff-mode.ts";

export type GitKind = "A" | "D" | "M" | "R";
/** `path`: absolute (under the repository root as cwd spells it); `rel`: relative to the repository top, as git names it; `oldPath`: the before side's relative path of a rename. */
export type GitRow = { path: string; rel: string; oldPath?: string; kind: GitKind; stats?: Stats; untracked?: boolean; submodule?: { from?: string; to?: string };
  /** The listed nested repository an untracked folder entry stands for (a row of its own, not its files). */
  nested?: GitRepo };

/** Stats only when git counted lines (a binary or an oversized untracked file has none). */
export function gitRows(d: GitDiff, cwd: string, nested?: { top: string; repos: GitRepo[] }): GitRow[] {
  const root = repoRoot(cwd, d.prefix);
  // An untracked folder ("inner/") that is a listed nested repository of `top`.
  const repoOf = (f: GitDiff["files"][number]) => {
    if (!nested || !f.untracked || !f.path.endsWith("/")) return undefined;
    const key = pathKey(joinPath(nested.top, f.path.slice(0, -1)));
    return nested.repos.find((r) => r.kind === "nested" && r.parent !== undefined && pathKey(r.parent) === pathKey(nested.top) && pathKey(r.path) === key);
  };
  return d.files.map((f) => {
    const repo = repoOf(f);
    if (repo) return { path: joinPath(root, f.path.slice(0, -1)), rel: f.path.slice(0, -1), kind: "A" as const, nested: repo };
    return {
      path: joinPath(root, f.path),
      rel: f.path,
      ...(f.oldPath !== undefined && { oldPath: f.oldPath }),
      kind: f.status,
      ...(f.added !== undefined && f.removed !== undefined && { stats: { added: f.added, removed: f.removed } }),
      ...(f.untracked && { untracked: true }),
      ...(f.submodule && { submodule: f.submodule }),
    };
  });
}

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const next = async (): Promise<void> => {
    const x = queue.shift();
    if (x === undefined) return;
    await fn(x);
    return next();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

/**
 * One limiter for jobs of many runs: at most `limit` jobs run at once; a queued job whose `live()` is false when its turn comes is skipped.
 */
export function createLimiter(limit: number): (live: () => boolean, fn: () => Promise<void>) => Promise<void> {
  let active = 0;
  const queue: { live: () => boolean; fn: () => Promise<void>; done: () => void }[] = [];
  const pump = (): void => {
    while (active < limit && queue.length) {
      const job = queue.shift()!;
      if (!job.live()) {
        job.done();
        continue;
      }
      active++;
      void job.fn().catch(() => {}).finally(() => {
        active--;
        job.done();
        pump();
      });
    }
  };
  return (live, fn) =>
    new Promise<void>((done) => {
      queue.push({ live, fn, done });
      pump();
    });
}

/**
 * The after side as git sees it: the repository stores LF (core.autocrlf, .gitattributes), the disk has CRLF, so every line would differ.
 * A before side without any CR (or none at all) means the repository's text is LF: the disk's CRLF becomes LF.
 */
export const gitEol = (before: string, after: string): string => (before.includes("\r") ? after : after.replace(/\r\n/g, "\n"));
