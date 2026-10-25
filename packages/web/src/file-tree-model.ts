// The file tree as data (docs/spec.md "Layout", Side panel): visible rows, keyboard moves, type-ahead and git marks. No React.
import type { FsEntry, GitRepo } from "@claude-ui/protocol";
import type { GitRow } from "./git-changes.ts";
import { baseName, inDir, isWinPath, joinPath, repoDir } from "./paths.ts";

export type DirState = FsEntry[] | { error: string } | "loading";
export type TreeModel = { dirs: Record<string, DirState>; expanded: ReadonlySet<string> };
export type Mark = "M" | "A" | "U" | "R" | "D";
export type DirMark = "D" | "M" | "A";
export type EntryRow = { kind: "entry"; entry: FsEntry; depth: number; expanded?: boolean; /** Its name is the rename input. */ renaming?: boolean; parent: string; posinset: number; setsize: number };
export type StatusRow = { kind: "status"; depth: number; text: string; error?: boolean; parent: string };
/** A name being typed: a rename of `path`, or a new file or folder in `dir`. */
export type Editing = { kind: "rename"; path: string } | { kind: "new"; dir: string; isDir: boolean };
/** The input row of a new file or folder: the first child of its folder. */
export type InputRow = { kind: "input"; depth: number; parent: string; editing: Extract<Editing, { kind: "new" }> };
export type Row = EntryRow | StatusRow | InputRow;

/** Without ".git", directories first, otherwise in the listing's order. */
export const sortEntries = (entries: FsEntry[]): FsEntry[] => entries.filter((e) => e.name !== ".git").sort((a, b) => Number(b.isDir) - Number(a.isDir));

/** Paths compare without case and with "\" on Windows. */
export const pathKey = (p: string) => (isWinPath(p) ? p.replace(/\//g, "\\").toLowerCase() : p);

const trimSep = (dir: string) => dir.replace(isWinPath(dir) ? /[\\/]+$/ : /\/+$/, "") || dir;

/** The directories strictly between `root` and `path`, outermost first; none when `path` is not inside `root`. */
export function ancestors(path: string, root: string): string[] {
  const base = trimSep(root);
  if (!inDir(path, base) || path.length <= base.length) return [];
  const parts = path.slice(base.length + 1).split(/[\\/]/).filter(Boolean);
  return parts.slice(0, -1).map((_, i) => joinPath(base, parts.slice(0, i + 1).join("/")));
}

function level(entries: FsEntry[], depth: number, parent: string, out: Row[], descend: (e: FsEntry) => void) {
  entries.forEach((entry, i) => {
    out.push({ kind: "entry", entry, depth, parent, posinset: i + 1, setsize: entries.length, ...(entry.isDir && { expanded: false }) });
    descend(entry);
  });
}

/** Depth-first rows of the listed, expanded part of the tree. An expanded directory without a listing shows "…", a failed one its error. */
export function visibleRows(m: TreeModel, root: string, editing?: Editing): Row[] {
  const out: Row[] = [];
  const walk = (dir: string, depth: number) => {
    if (editing?.kind === "new" && editing.dir === dir) out.push({ kind: "input", depth, parent: dir, editing });
    const s = m.dirs[dir];
    if (!s || s === "loading") return void out.push({ kind: "status", depth, text: "…", parent: dir });
    if (!Array.isArray(s)) return void out.push({ kind: "status", depth, text: s.error, error: true, parent: dir });
    level(s, depth, dir, out, (e) => {
      if (editing?.kind === "rename" && editing.path === e.path) (out.at(-1) as EntryRow).renaming = true;
      if (!e.isDir) return;
      const open = m.expanded.has(e.path);
      (out.at(-1) as EntryRow).expanded = open;
      if (open) walk(e.path, depth + 1);
    });
  };
  walk(root, 0);
  return out;
}

/** Search hits (absolute file paths under `root`) as a tree with every ancestor expanded; directories first, then by name. */
export function searchRows(paths: string[], root: string): Row[] {
  const base = trimSep(root);
  const children = new Map<string, Map<string, FsEntry>>();
  const add = (parent: string, entry: FsEntry) => {
    const m = children.get(parent) ?? new Map<string, FsEntry>();
    m.set(entry.path, entry);
    children.set(parent, m);
  };
  for (const p of paths) {
    const dirs = ancestors(p, base);
    dirs.forEach((d, i) => add(i === 0 ? base : dirs[i - 1]!, { name: baseName(d), path: d, isDir: true }));
    if (inDir(p, base) && p.length > base.length) add(dirs.at(-1) ?? base, { name: baseName(p), path: p, isDir: false });
  }
  const out: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const entries = [...(children.get(dir)?.values() ?? [])].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    level(entries, depth, dir, out, (e) => {
      if (!e.isDir) return;
      (out.at(-1) as EntryRow).expanded = true;
      walk(e.path, depth + 1);
    });
  };
  walk(base, 0);
  return out;
}

const entryIndexes = (rows: Row[]) => rows.flatMap((r, i) => (r.kind === "entry" ? [i] : []));

/** Where an arrow, Home or End key goes from row `i`: a row, a directory to expand or one to collapse. */
export function moveFocus(rows: Row[], i: number, key: string): { index?: number; expand?: string; collapse?: string } {
  const idx = entryIndexes(rows);
  const row = rows[i];
  if (!idx.length) return {};
  switch (key) {
    case "ArrowDown":
      return { index: idx.find((j) => j > i) ?? idx.at(-1) };
    case "ArrowUp":
      return { index: [...idx].reverse().find((j) => j < i) ?? idx[0] };
    case "Home":
      return { index: idx[0] };
    case "End":
      return { index: idx.at(-1) };
    case "ArrowRight": {
      if (row?.kind !== "entry" || !row.entry.isDir) return {};
      if (!row.expanded) return { expand: row.entry.path };
      const next = rows[i + 1];
      return next?.kind === "entry" && next.parent === row.entry.path ? { index: i + 1 } : {};
    }
    case "ArrowLeft": {
      if (row?.kind !== "entry") return {};
      if (row.entry.isDir && row.expanded) return { collapse: row.entry.path };
      const parent = rows.findIndex((r) => r.kind === "entry" && r.entry.path === row.parent);
      return parent >= 0 ? { index: parent } : {};
    }
  }
  return {};
}

/** The first row at or after `from` (after it for a one-character buffer; wrapping) whose name starts with `buffer`, ignoring case; -1 when none. */
export function typeAhead(rows: Row[], from: number, buffer: string): number {
  const q = buffer.toLowerCase();
  const start = buffer.length === 1 ? from + 1 : from;
  for (let k = 0; k < rows.length; k++) {
    const j = (((start + k) % rows.length) + rows.length) % rows.length;
    const r = rows[j]!;
    if (r.kind === "entry" && r.entry.name.toLowerCase().startsWith(q)) return j;
  }
  return -1;
}

/** Marks of the changed files under `cwd` (keys: `pathKey`) and of the folders above them: D over M (also R) over A (also untracked). A gitlink row (a moved submodule) marks its own folder like a file. */
export function gitMarks(rows: GitRow[], cwd: string): { files: Map<string, Mark>; dirs: Map<string, DirMark> } {
  const files = new Map<string, Mark>();
  const dirs = new Map<string, DirMark>();
  const rank: Record<DirMark, number> = { A: 1, M: 2, D: 3 };
  const base = trimSep(cwd);
  const win = isWinPath(cwd);
  const prefix = base + "/";
  // Rows of one folder share their ancestors: spelled and keyed once per folder.
  const chains = new Map<string, string[]>();
  const chainOf = (path: string) => {
    const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const folder = path.slice(0, at);
    let chain = chains.get(folder);
    if (!chain) chains.set(folder, (chain = ancestors(path, cwd).map(pathKey)));
    return chain;
  };
  for (const r of rows) {
    if (r.path.length <= base.length || !(win ? inDir(r.path, cwd) : r.path.startsWith(prefix))) continue;
    const mark: Mark = r.kind === "A" && r.untracked ? "U" : r.kind;
    files.set(pathKey(r.path), mark);
    const d: DirMark = mark === "D" ? "D" : mark === "M" || mark === "R" ? "M" : "A";
    for (const k of chainOf(r.path)) {
      const cur = dirs.get(k);
      if (!cur || rank[d] > rank[cur]) dirs.set(k, d);
    }
  }
  return { files, dirs };
}

/** `p` moved from `from` to `to`: `p` itself, or below `from`; else unchanged. */
const swap = (p: string, from: string, to: string) => {
  const [k, f] = [pathKey(p), pathKey(from)];
  return k === f ? to : k.startsWith(f + (isWinPath(from) ? "\\" : "/")) ? to + p.slice(from.length) : p;
};
const under = (p: string, path: string) => {
  const [k, f] = [pathKey(p), pathKey(path)];
  return k === f || k.startsWith(f + (isWinPath(path) ? "\\" : "/"));
};

/** The model after `from` was renamed to `to`: open folders and listings below it follow (entries carry the new paths). */
export function movePaths(m: TreeModel, from: string, to: string): TreeModel {
  const dirs: Record<string, DirState> = {};
  for (const [k, v] of Object.entries(m.dirs)) dirs[swap(k, from, to)] = Array.isArray(v) ? v.map((e) => ({ ...e, path: swap(e.path, from, to) })) : v;
  return { dirs, expanded: new Set([...m.expanded].map((p) => swap(p, from, to))) };
}

/** The model after `path` was deleted: its open state and listings go. */
export function dropPaths(m: TreeModel, path: string): TreeModel {
  const dirs: Record<string, DirState> = {};
  for (const [k, v] of Object.entries(m.dirs)) if (!under(k, path)) dirs[k] = v;
  return { dirs, expanded: new Set([...m.expanded].filter((p) => !under(p, path))) };
}

/** A repository's git.diff rows; `dir` its top spelled from the cwd. */
export type RepoRead = { dir: string; rows: GitRow[] };

/**
 * The rows each read owns: a row inside a listed repository folder nested in the read's own is dropped (the innermost repository wins);
 * at that folder itself only a gitlink row stays (a moved submodule), so the parent's untracked entry ("inner/") goes. `listed`: every
 * listed repository top spelled from the cwd, outsideRoots included.
 */
export function ownRows(reads: RepoRead[], listed: string[]): GitRow[] {
  const out: GitRow[] = [];
  for (const read of reads) {
    const win = isWinPath(read.dir);
    const sep = win ? "\\" : "/";
    const key = (p: string) => (win ? p.replace(/\//g, "\\").toLowerCase() : p);
    const dir = key(trimSep(read.dir)) + sep;
    const inner = listed.map((x) => key(trimSep(x))).filter((x) => x.startsWith(dir));
    for (const r of read.rows) {
      if (!inner.length) {
        out.push(r);
        continue;
      }
      const p = key(trimSep(r.path));
      if (!inner.some((x) => p === x ? !r.submodule : p.startsWith(x + sep))) out.push(r);
    }
  }
  return out;
}

/** Marks of several repositories (docs/spec.md "Layout"): `gitMarks` over `ownRows`. */
export const repoMarks = (reads: RepoRead[], listed: string[], cwd: string) => gitMarks(ownRows(reads, listed), cwd);

/** Listed nested repositories and submodules by their folder (`pathKey` of the top spelled from the cwd); the cwd's own repository has no row. */
export function repoFolders(list: GitRepo[], cwd: string): Map<string, GitRepo> {
  const out = new Map<string, GitRepo>();
  for (const r of list) if (r.kind !== "main" && r.rel !== "" && !r.rel.startsWith("..")) out.set(pathKey(repoDir(cwd, r.rel)), r);
  return out;
}

/** The innermost listed, readable repository whose folder holds `path` (or is `path`). */
export function repoOfPath(path: string, list: GitRepo[], cwd: string): GitRepo | undefined {
  let best: { r: GitRepo; len: number } | undefined;
  for (const r of list) {
    if (r.outsideRoots) continue;
    const dir = repoDir(cwd, r.rel);
    if (under(path, dir) && (!best || dir.length > best.len)) best = { r, len: dir.length };
  }
  return best?.r;
}

/** The accessible label and tooltip of a repository folder's icon. */
export function repoIconText(repo: GitRepo, name: string): { label: string; title: string } {
  const kind = repo.kind === "submodule" ? "submodule" : "repository";
  const out = repo.outsideRoots ? " outside the allowed folders" : "";
  const label = `${repo.kind === "submodule" ? "Submodule" : "Repository"} ${name}${repo.branch ? `, branch ${repo.branch}` : ""}${out && `,${out}`}`;
  return { label, title: `${repo.branch ? `${repo.branch} · ` : ""}${kind}${out && ` ·${out}`}` };
}
