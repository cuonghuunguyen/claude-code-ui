// Rows of the Changes tab's git modes (docs/spec.md "Layout"): a `git.diff` reply as the panel's file list.
import type { GitDiff } from "@claude-ui/protocol";
import type { Stats } from "./changes.ts";
import { joinPath } from "./paths.ts";
import { repoRoot } from "./diff-mode.ts";

export type GitKind = "A" | "D" | "M" | "R";
/** `path`: absolute (under the repository root as cwd spells it); `rel`: relative to the repository top, as git names it; `oldPath`: the before side's relative path of a rename. */
export type GitRow = { path: string; rel: string; oldPath?: string; kind: GitKind; stats?: Stats; untracked?: boolean };

/** Stats only when git counted lines (a binary or an oversized untracked file has none). */
export function gitRows(d: GitDiff, cwd: string): GitRow[] {
  const root = repoRoot(cwd, d.prefix);
  return d.files.map((f) => ({
    path: joinPath(root, f.path),
    rel: f.path,
    ...(f.oldPath !== undefined && { oldPath: f.oldPath }),
    kind: f.status,
    ...(f.added !== undefined && f.removed !== undefined && { stats: { added: f.added, removed: f.removed } }),
    ...(f.untracked && { untracked: true }),
  }));
}
