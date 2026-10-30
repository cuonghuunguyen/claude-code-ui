// Rows and keyboard model of the repository selector tree (docs/spec.md "Repository selector"); mirrors file-tree-model's moveFocus/typeAhead for a repo tree.
import { repoTree, type GitRepo, type GitReposResult, type RepoNode } from "@claude-ui/protocol";
import { baseName } from "./paths.ts";
import { t } from "./i18n.ts";

export type RepoRow = { repo: GitRepo; depth: number; label: string; hasChildren: boolean; expanded: boolean; parent?: string; posinset: number; setsize: number };

/** The row's name: its `rel` below the parent entry; the folder name for the cwd itself or a folder above it. */
function labelOf(node: GitRepo, parent: GitRepo | undefined): string {
  const segs = node.rel.split("/").filter((s) => s && s !== "..");
  if (!segs.length) return baseName(node.path);
  if (parent && parent.rel && node.rel.startsWith(`${parent.rel}/`)) return node.rel.slice(parent.rel.length + 1);
  return node.rel;
}

/** Depth-first rows of the tree in `git.repos` order. A query keeps the matches and their ancestors (collapsing is ignored while filtering). */
export function repoRows(nodes: RepoNode[], collapsed: ReadonlySet<string>, query: string): RepoRow[] {
  const q = query.trim().toLowerCase();
  const matches = (n: RepoNode): boolean => labelOf(n, undefined).toLowerCase().includes(q) || n.rel.toLowerCase().includes(q) || n.children.some(matches);
  const out: RepoRow[] = [];
  const walk = (list: RepoNode[], depth: number, parent: RepoNode | undefined) => {
    const kept = q ? list.filter(matches) : list;
    kept.forEach((n, i) => {
      const kids = q ? n.children.filter(matches) : n.children;
      const expanded = q ? kids.length > 0 : !collapsed.has(n.path);
      out.push({ repo: n, depth, label: labelOf(n, parent), hasChildren: n.children.length > 0, expanded: n.children.length > 0 && expanded, ...(parent && { parent: parent.path }), posinset: i + 1, setsize: kept.length });
      if (n.children.length > 0 && expanded) walk(n.children, depth + 1, n);
    });
  };
  walk(nodes, 0, undefined);
  return out;
}

/** Where an arrow, Home or End key goes from row `i`: a row, a repository to expand or one to collapse. */
export function repoMove(rows: RepoRow[], i: number, key: string): { index?: number; expand?: string; collapse?: string } {
  if (!rows.length) return {};
  const row = rows[i];
  switch (key) {
    case "ArrowDown":
      return { index: Math.min(i + 1, rows.length - 1) };
    case "ArrowUp":
      return { index: Math.max(i - 1, 0) };
    case "Home":
      return { index: 0 };
    case "End":
      return { index: rows.length - 1 };
    case "ArrowRight": {
      if (!row?.hasChildren) return {};
      if (!row.expanded) return { expand: row.repo.path };
      return rows[i + 1]?.parent === row.repo.path ? { index: i + 1 } : {};
    }
    case "ArrowLeft": {
      if (!row) return {};
      if (row.hasChildren && row.expanded) return { collapse: row.repo.path };
      const parent = rows.findIndex((r) => r.repo.path === row.parent);
      return parent >= 0 ? { index: parent } : {};
    }
  }
  return {};
}

/** The first row at or after `from` (after it for a one-character buffer; wrapping) whose label starts with `buffer`, ignoring case; -1 when none. */
export function repoTypeAhead(rows: RepoRow[], from: number, buffer: string): number {
  const q = buffer.toLowerCase();
  const start = buffer.length === 1 ? from + 1 : from;
  for (let k = 0; k < rows.length; k++) {
    const j = (((start + k) % rows.length) + rows.length) % rows.length;
    if (rows[j]!.label.toLowerCase().startsWith(q)) return j;
  }
  return -1;
}

/** Footer lines of the selector: the list was cut by the scan, or a repository lists more submodules than the daemon reads. */
export function truncationNotes(trunc: GitReposResult["truncated"], list: GitRepo[], limit: number): string[] {
  if (!trunc) return [];
  const notes: string[] = [];
  if (trunc.scan === "count" || trunc.scan === "time" || trunc.scan === "entries") notes.push(t("sidebar.repo.showingFirst", { count: list.length }));
  for (const s of trunc.submodules ?? []) {
    const repo = list.find((r) => r.path === s.repo);
    const name = repo ? (repo.rel && repo.rel.split("/").some((x) => x && x !== "..") ? repo.rel : baseName(repo.path)) : baseName(s.repo);
    notes.push(t("sidebar.repo.submodules", { count: s.count, name, limit }));
  }
  return notes;
}
