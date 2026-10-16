// The file tree as data (docs/spec.md "Layout", Side panel): visible rows, keyboard moves, type-ahead and git marks. No React.
import type { FsEntry } from "@claude-ui/protocol";
import type { GitRow } from "./git-changes.ts";
import { baseName, inDir, isWinPath, joinPath } from "./paths.ts";

export type DirState = FsEntry[] | { error: string } | "loading";
export type TreeModel = { dirs: Record<string, DirState>; expanded: ReadonlySet<string> };
export type Mark = "M" | "A" | "U" | "R" | "D";
export type DirMark = "D" | "M" | "A";
export type EntryRow = { kind: "entry"; entry: FsEntry; depth: number; expanded?: boolean; parent: string; posinset: number; setsize: number };
export type StatusRow = { kind: "status"; depth: number; text: string; error?: boolean; parent: string };
export type Row = EntryRow | StatusRow;

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
export function visibleRows(m: TreeModel, root: string): Row[] {
  const out: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const s = m.dirs[dir];
    if (!s || s === "loading") return void out.push({ kind: "status", depth, text: "…", parent: dir });
    if (!Array.isArray(s)) return void out.push({ kind: "status", depth, text: s.error, error: true, parent: dir });
    level(s, depth, dir, out, (e) => {
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

/** Marks of the changed files under `cwd` (keys: `pathKey`) and of the folders above them: D over M (also R) over A (also untracked). */
export function gitMarks(rows: GitRow[], cwd: string): { files: Map<string, Mark>; dirs: Map<string, DirMark> } {
  const files = new Map<string, Mark>();
  const dirs = new Map<string, DirMark>();
  const rank: Record<DirMark, number> = { A: 1, M: 2, D: 3 };
  for (const r of rows) {
    if (!inDir(r.path, cwd) || r.path.length <= trimSep(cwd).length) continue;
    const mark: Mark = r.kind === "A" && r.untracked ? "U" : r.kind;
    files.set(pathKey(r.path), mark);
    const d: DirMark = mark === "D" ? "D" : mark === "M" || mark === "R" ? "M" : "A";
    for (const dir of ancestors(r.path, cwd)) {
      const k = pathKey(dir);
      const cur = dirs.get(k);
      if (!cur || rank[d] > rank[cur]) dirs.set(k, d);
    }
  }
  return { files, dirs };
}
