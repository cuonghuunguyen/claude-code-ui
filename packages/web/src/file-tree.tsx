// The Files tab's file tree (docs/spec.md "Layout", Side panel): a flat ARIA tree with file-type icons, git marks, a filter field and keyboard navigation.
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import type { FsEntry, FsListResult, FsSearchResult, GitDiffResult } from "@claude-ui/protocol";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import type { connect } from "./client.ts";
import { FileIcon } from "./file-icon.tsx";
import { ancestors, gitMarks, moveFocus, pathKey, searchRows, sortEntries, typeAhead, visibleRows, type DirMark, type DirState, type Mark, type Row } from "./file-tree-model.ts";
import { gitRows } from "./git-changes.ts";
import { joinPath } from "./paths.ts";

type Client = ReturnType<typeof connect>;

export type FileTreeHandle = {
  /** Lists and expands the folders above `path` (and `path` itself with `expandSelf`), scrolls its row into view and focuses it when asked. */
  reveal: (path: string, focus: boolean, expandSelf?: boolean) => Promise<void>;
  collapseAll: () => void;
  /** Lists `dir` again (for a later change of a folder's content). */
  refreshDir: (dir: string) => Promise<void>;
};

export type OpenOptions = { focusEditor?: boolean; pinned?: boolean };

const MARK_STYLE: Record<Mark, { text: string; label: string }> = {
  M: { text: "text-info", label: "modified" },
  R: { text: "text-info", label: "renamed" },
  A: { text: "text-success", label: "added" },
  U: { text: "text-success", label: "untracked" },
  D: { text: "text-destructive", label: "deleted" },
};
const DIR_STYLE: Record<DirMark, string> = { D: "text-destructive", M: "text-info", A: "text-success" };

const rowEl = (root: HTMLElement | null, path: string) => [...(root?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].find((e) => e.dataset.path === path);

export function FileTree({
  client,
  cwd,
  activePath,
  reloadKey = 0,
  gitStamp,
  visible = true,
  gitNudge = 0,
  onOpen,
  onRowContextMenu,
  handleRef,
  onFilter,
}: {
  client: Client;
  cwd: string;
  activePath?: string;
  /** Bumped by the reload button: the root and every expanded folder are listed again and the git marks read again. */
  reloadKey?: number;
  /** Defined in a git work tree; a new value reads the git marks again. */
  gitStamp?: string;
  /** The tree is on screen; the git marks are read only then. */
  visible?: boolean;
  /** Bumped after a save or a change of an open file: reads the git marks again. */
  gitNudge?: number;
  onOpen: (path: string, opts: OpenOptions) => void;
  /** For a context menu (not built yet): the row's entry. */
  onRowContextMenu?: (e: MouseEvent, entry: FsEntry) => void;
  handleRef?: RefObject<FileTreeHandle | undefined>;
  /** Told whether the filter field has a query (the tree then shows results). */
  onFilter?: (active: boolean) => void;
}) {
  const [model, setModel] = useState<{ dirs: Record<string, DirState>; expanded: ReadonlySet<string> }>({ dirs: {}, expanded: new Set() });
  const modelRef = useRef(model);
  modelRef.current = model;
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; paths: string[] }>();
  const [focused, setFocused] = useState<string>();
  const [marks, setMarks] = useState<ReturnType<typeof gitMarks>>();
  const [, tick] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<{ path: string; focus: boolean }>(undefined);
  const buffer = useRef({ text: "", timer: 0 });
  const q = query.trim();

  async function list(dir: string) {
    setModel((m) => ({ ...m, dirs: { ...m.dirs, [dir]: Array.isArray(m.dirs[dir]) ? m.dirs[dir]! : "loading" } }));
    let next: DirState;
    try {
      next = sortEntries((await client.request<FsListResult>({ type: "fs.list", path: dir })).entries);
    } catch (e) {
      next = { error: (e as Error).message };
    }
    setModel((m) => ({ ...m, dirs: { ...m.dirs, [dir]: next } }));
  }

  const expand = (dir: string) => {
    setModel((m) => ({ ...m, expanded: new Set(m.expanded).add(dir) }));
    if (!Array.isArray(modelRef.current.dirs[dir])) void list(dir);
  };
  const collapse = (dir: string) =>
    setModel((m) => {
      const expanded = new Set(m.expanded);
      expanded.delete(dir);
      return { ...m, expanded };
    });

  // The root on mount; every listed folder again after a reload.
  useEffect(() => {
    void list(cwd);
    for (const d of modelRef.current.expanded) void list(d);
  }, [cwd, reloadKey]);

  useEffect(() => onFilter?.(!!q), [!!q]);
  useEffect(() => {
    if (!q) return;
    let live = true;
    const timer = setTimeout(
      () =>
        client
          .request<FsSearchResult>({ type: "fs.search", cwd, query: q })
          .then((r) => live && setFound({ query: q, paths: r.paths }))
          .catch(() => live && setFound({ query: q, paths: [] })),
      150,
    );
    return () => ((live = false), clearTimeout(timer));
  }, [q, cwd]);

  // Git marks: read while the tree is on screen in a git work tree; a failed read or a plain directory shows none.
  useEffect(() => {
    if (!visible || gitStamp === undefined) return void setMarks(undefined);
    let live = true;
    const timer = setTimeout(
      () =>
        client
          .request<GitDiffResult>({ type: "git.diff", cwd, base: "head" })
          .then((r) => live && setMarks(r.diff ? gitMarks(gitRows(r.diff, cwd), cwd) : undefined))
          .catch(() => live && setMarks(undefined)),
      300,
    );
    return () => ((live = false), clearTimeout(timer));
  }, [visible, gitStamp, cwd, reloadKey, gitNudge]);

  const rows: Row[] = q ? (found?.query === q ? searchRows(found.paths.map((p) => joinPath(cwd, p)), cwd) : []) : visibleRows(model, cwd);
  const entries = rows.flatMap((r, i) => (r.kind === "entry" ? [{ r, i }] : []));
  const rowAt = (path: string) => rows.findIndex((r) => r.kind === "entry" && r.entry.path === path);
  const tabPath = [focused, activePath].find((p) => p !== undefined && rowAt(p) >= 0) ?? entries[0]?.r.entry.path;

  // Scroll and focus a revealed or moved-to row once it renders.
  useEffect(() => {
    const p = pending.current;
    const el = p && rowEl(root.current, p.path);
    if (!p || !el) return;
    pending.current = undefined;
    el.scrollIntoView?.({ block: "nearest" });
    if (p.focus) el.focus();
  });

  const goTo = (path: string, focus: boolean) => {
    pending.current = { path, focus };
    if (focus) setFocused(path);
    tick((n) => n + 1);
  };

  async function reveal(path: string, focus: boolean, expandSelf = false) {
    setQuery("");
    for (const dir of ancestors(expandSelf ? joinPath(path, "x") : path, cwd)) {
      setModel((m) => ({ ...m, expanded: new Set(m.expanded).add(dir) }));
      if (!Array.isArray(modelRef.current.dirs[dir])) await list(dir);
    }
    goTo(path, focus);
  }
  useImperativeHandle(handleRef, () => ({ reveal, collapseAll: () => setModel((m) => ({ ...m, expanded: new Set() })), refreshDir: list }));

  // Follow the active tab (VS Code's explorer.autoReveal): expand to its file without taking focus.
  useEffect(() => {
    if (activePath && !q) void reveal(activePath, false);
  }, [activePath, cwd]);

  const toggle = (e: FsEntry) => (modelRef.current.expanded.has(e.path) ? collapse(e.path) : expand(e.path));
  const rowOf = (target: EventTarget) => {
    const path = (target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset.path;
    return path === undefined ? -1 : rowAt(path);
  };

  function onKeyDown(e: KeyboardEvent) {
    const i = rowOf(e.target);
    const row = rows[i];
    if (!row || row.kind !== "entry" || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      return row.entry.isDir ? toggle(row.entry) : onOpen(row.entry.path, e.key === "Enter" ? { focusEditor: true } : {});
    }
    if (e.key.length === 1) {
      window.clearTimeout(buffer.current.timer);
      buffer.current.text += e.key;
      buffer.current.timer = window.setTimeout(() => (buffer.current.text = ""), 500);
      const j = typeAhead(rows, i, buffer.current.text);
      const hit = rows[j];
      if (hit?.kind === "entry") goTo(hit.entry.path, true);
      return e.preventDefault();
    }
    const move = moveFocus(rows, i, e.key);
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    if (move.expand) expand(move.expand);
    if (move.collapse) collapse(move.collapse);
    const target = move.index === undefined ? undefined : rows[move.index];
    if (target?.kind === "entry") goTo(target.entry.path, true);
  }

  const clear = () => (setQuery(""), setFound(undefined));
  const coarse = "max-md:h-11 pointer-coarse:h-11";
  return (
    <>
      <div className="sticky top-0 z-10 border-b bg-card px-2 py-1">
        <input
          type="search"
          value={query}
          placeholder="Filter files"
          aria-label="Filter files"
          aria-controls="file-tree-rows"
          data-testid="tree-filter"
          className={`h-7 w-full rounded-md border bg-background px-2 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring md:text-xs ${coarse}`}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) return (e.stopPropagation(), clear());
            if (e.key === "ArrowDown" && entries[0]) (e.preventDefault(), goTo(entries[0].r.entry.path, true));
          }}
        />
      </div>
      <div role="tree" id="file-tree-rows" aria-label="Files" ref={root} onKeyDown={onKeyDown}>
        {rows.map((r, i) => {
          const pad = { paddingLeft: `${8 + r.depth * 12}px` };
          if (r.kind === "status")
            return (
              <div key={`s${i}`} role="none" className={r.error ? "px-2 text-destructive" : "px-2 text-muted-foreground"} style={pad}>
                {r.text}
              </div>
            );
          const { entry } = r;
          const mark = entry.isDir ? undefined : marks?.files.get(pathKey(entry.path));
          const dirMark = entry.isDir ? marks?.dirs.get(pathKey(entry.path)) : undefined;
          const selected = entry.path === activePath;
          return (
            <div
              key={entry.path}
              role="treeitem"
              tabIndex={entry.path === tabPath ? 0 : -1}
              aria-level={r.depth + 1}
              aria-setsize={r.setsize}
              aria-posinset={r.posinset}
              aria-expanded={entry.isDir ? !!r.expanded : undefined}
              aria-selected={selected}
              data-testid="tree-entry"
              data-path={entry.path}
              data-dir={entry.isDir ? "" : undefined}
              className={`flex h-7 w-full cursor-pointer items-center gap-1 pr-2 text-left outline-none select-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${coarse} ${selected ? "bg-muted text-foreground" : ""}`}
              style={pad}
              onFocus={() => setFocused(entry.path)}
              onClick={() => (entry.isDir ? toggle(entry) : onOpen(entry.path, {}))}
              onDoubleClick={() => !entry.isDir && onOpen(entry.path, { pinned: true })}
              onContextMenu={(e) => onRowContextMenu?.(e, entry)}
            >
              {entry.isDir ? (
                <ChevronRightIcon className={`size-3.5 shrink-0 text-faint transition-transform motion-reduce:transition-none ${r.expanded ? "rotate-90" : ""}`} aria-hidden />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              {entry.isDir ? (
                r.expanded ? <FolderOpenIcon className="size-4 shrink-0 text-faint" aria-hidden /> : <FolderIcon className="size-4 shrink-0 text-faint" aria-hidden />
              ) : (
                <FileIcon path={entry.path} className="size-4 shrink-0" />
              )}
              <span className="truncate">{entry.name}</span>
              {mark && (
                <>
                  <span className={`ml-auto w-4 shrink-0 text-center font-semibold text-[11px] ${MARK_STYLE[mark].text}`} data-testid="git-mark" aria-hidden>
                    {mark}
                  </span>
                  <span className="sr-only">, {MARK_STYLE[mark].label}</span>
                </>
              )}
              {dirMark && (
                <>
                  <span className={`ml-auto size-1.5 shrink-0 rounded-full bg-current ${DIR_STYLE[dirMark]}`} data-testid="git-mark" aria-hidden />
                  <span className="sr-only">, contains changes</span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {q && found?.query === q && found.paths.length === 0 && (
        <p className="px-2 py-1 text-muted-foreground" role="status">
          No matching files.
        </p>
      )}
      {q && found?.query === q && found.paths.length >= 50 && <p className="px-2 py-1 text-muted-foreground">First 50 matches.</p>}
    </>
  );
}

