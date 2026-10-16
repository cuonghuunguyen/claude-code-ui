// The Files tab's file tree (docs/spec.md "Layout", Side panel): a flat ARIA tree with file-type icons, git marks, a filter field and keyboard navigation.
import { Fragment, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { fileNameError, type FsDeleteResult, type FsEntry, type FsListResult, type FsPathResult, type FsSearchResult, type GitDiffResult } from "@claude-ui/protocol";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon, XIcon } from "lucide-react";
import type { connect, RequestError } from "./client.ts";
import { FileIcon } from "./file-icon.tsx";
import { ancestors, dropPaths, gitMarks, moveFocus, movePaths, pathKey, searchRows, sortEntries, typeAhead, visibleRows, type DirMark, type DirState, type Editing, type Mark, type Row } from "./file-tree-model.ts";
import { nameSelection, opErrorText, treeMenuSections, type TreeCommand, type TreeTarget } from "./file-tree-menu.ts";
import { gitRows } from "./git-changes.ts";
import { isImeKey } from "./ime.ts";
import { isWinPath, joinPath, relPath } from "./paths.ts";
import { ConfirmDialog, ITEM, POPUP } from "./session-actions.tsx";
import { openContextMenuFromKey } from "./tab-menu.ts";
import { swallowKeyFollowup } from "./context-menu-key.ts";
import { cn } from "@/lib/utils";

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

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** Commands that move focus themselves (an input, a dialog, the editor): the menu does not return it to the row. */
const MOVES_FOCUS = new Set<TreeCommand>(["open", "viewer", "changes", "mention", "rename", "duplicate", "delete", "newFile", "newFolder"]);

const parentOf = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return isWinPath(p) && i === 2 ? p.slice(0, 3) : i <= 0 ? p.slice(0, i + 1) || p : p.slice(0, i);
};
/** The name field's message under its row. */
function NameMessage({ text, depth }: { text: string; depth: number }) {
  return (
    <div id="tree-name-msg" role="alert" className="break-words py-0.5 pr-2 text-destructive [overflow-wrap:anywhere]" style={{ paddingLeft: `${8 + depth * 12 + 20}px` }} data-testid="tree-name-message">
      {text}
    </div>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

type DeleteAsk = { entry: FsEntry; dirty: number; counting: boolean; count?: FsDeleteResult; countError?: string };

/** What the Delete dialog says: for good, no trash; the count of a folder; open files with unsaved edits. */
function deleteText(d: DeleteAsk) {
  const tail = "deleted for good. It does not go to the trash.";
  let text: string;
  if (!d.entry.isDir) text = `The file is ${tail}`;
  else if (d.counting) text = "Counting items…";
  else if (d.countError !== undefined) text = `The items could not be counted (${d.countError}). The folder and everything in it are ${tail}`;
  else if (d.count?.more) text = `The folder and more than 10 000 items in it are ${tail}`;
  else if (d.count && d.count.files + d.count.folders === 0) text = `The empty folder is ${tail}`;
  else text = `The folder and the ${plural(d.count?.files ?? 0, "file")} and ${plural(d.count?.folders ?? 0, "folder")} in it are ${tail}`;
  if (d.dirty) text += ` ${d.dirty === 1 ? "1 open file has" : `${d.dirty} open files have`} unsaved changes; ${d.dirty === 1 ? "it stays" : "they stay"} open.`;
  return text;
}

/** The inline name field of a new file or folder and of a rename (Enter and blur commit, Escape cancels; blur with an invalid name cancels). */
function NameInput({
  initial,
  label,
  select,
  windows,
  taken,
  error,
  busy,
  describedBy,
  onCommit,
  onCancel,
  onMessage,
  onType,
}: {
  initial: string;
  label: string;
  select: [number, number];
  windows: boolean;
  /** The name is already used in this folder. */
  taken: (name: string) => boolean;
  /** The daemon's refusal of the last commit. */
  error?: string;
  busy: boolean;
  describedBy: string;
  /** Resolves true when the field is done (it unmounts). */
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
  /** The message to show under the field. */
  onMessage: (m: string | undefined) => void;
  onType: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const name = value.trim();
  const problem = name === initial ? undefined : (fileNameError(name, windows) ?? (taken(name) ? opErrorText("exists", "", name) : undefined));
  const message = problem ?? error;
  useEffect(() => onMessage(message), [message]);
  useEffect(() => () => onMessage(undefined), []);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(...select);
  }, []);
  async function submit(blur: boolean) {
    if (finished.current || busy) return;
    if (name === "" || name === initial || (blur && problem)) {
      finished.current = true;
      return onCancel();
    }
    if (problem) return;
    finished.current = true;
    if (!(await onCommit(name))) finished.current = false;
  }
  return (
    <input
      ref={ref}
      value={value}
      readOnly={busy}
      aria-busy={busy || undefined}
      aria-label={label}
      aria-invalid={message ? true : undefined}
      aria-describedby={message ? describedBy : undefined}
      spellCheck={false}
      autoComplete="off"
      className="h-6 min-w-0 flex-1 rounded-sm bg-background px-1 text-base text-foreground outline-none ring-2 ring-ring max-md:h-9 md:text-xs"
      data-testid="tree-name-input"
      onChange={(e) => (setValue(e.target.value), onType())}
      onKeyDown={(e) => {
        // The tree's navigation and type-ahead, and the panel's Escape, must not see these keys.
        e.stopPropagation();
        if (isImeKey(e.nativeEvent)) return;
        if (e.key === "Enter") (e.preventDefault(), void submit(false));
        if (e.key === "Escape") {
          e.preventDefault();
          finished.current = true;
          onCancel();
        }
      }}
      onBlur={() => void submit(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    />
  );
}

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
  onCopy,
  onViewer,
  onShowChanges,
  onMention,
  onReload,
  onMoved,
  onDeleted,
  onChanged,
  dirtyUnder,
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
  /** Copy path / Copy relative path: the text and what it is (for the toast). */
  onCopy?: (text: string, what: string) => void;
  /** Open in popup viewer. */
  onViewer?: (path: string) => void;
  /** Show changes (a file with a git mark). */
  onShowChanges?: (path: string) => void;
  /** Add to prompt. */
  onMention?: (path: string) => void;
  /** Refresh (the header's reload). */
  onReload?: () => void;
  /** A file or folder was renamed: open tabs below `from` follow to `to`. */
  onMoved?: (from: string, to: string) => void;
  /** A file or folder was deleted: its clean tabs close. */
  onDeleted?: (path: string) => void;
  /** Any create, rename, delete or duplicate succeeded (the git marks are read again). */
  onChanged?: () => void;
  /** Open files with unsaved edits at or below `path` (the Delete dialog says so). */
  dirtyUnder?: (path: string) => number;
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
  // The context menu: one for the whole tree, its target is the row under the right click or long press (captured before Base UI opens the menu).
  const [menuTarget, setMenuTarget] = useState<TreeTarget>({ kind: "root" });
  const pendingTarget = useRef<string>(undefined);
  const keyOpenedAt = useRef(-Infinity);
  /** The chosen command moved focus (editor, prompt): the menu does not return it to the row. */
  const movedFocus = useRef(false);
  const [editing, setEditing] = useState<Editing>();
  /** The name field's message (invalid name) and the daemon's refusal of the last commit. */
  const [nameMsg, setNameMsg] = useState<string>();
  const [nameError, setNameError] = useState<string>();
  /** A failed delete or duplicate. */
  const [opError, setOpError] = useState<string>();
  /** The path a request is working on (dimmed row). */
  const [busyPath, setBusyPath] = useState<string>();
  const opBusy = useRef(false);
  const [del, setDel] = useState<DeleteAsk>();
  const delPath = useRef<string>(undefined);
  const delConfirmed = useRef(false);
  const windows = isWinPath(cwd);

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

  const rows: Row[] = q ? (found?.query === q ? searchRows(found.paths.map((p) => joinPath(cwd, p)), cwd) : []) : visibleRows(model, cwd, editing);
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

  /** A write request: the entry's name for the error text; nothing else runs while one is in flight. */
  async function write<T>(msg: Parameters<Client["request"]>[0], name: string, dir: string): Promise<{ ok: true; result: T } | { ok: false; text: string }> {
    opBusy.current = true;
    try {
      return { ok: true, result: await client.request<T>(msg) };
    } catch (e) {
      const err = e as RequestError;
      if (err.code === "not_found") void list(dir);
      return { ok: false, text: opErrorText(err.code ?? "", err.message, name) };
    } finally {
      opBusy.current = false;
    }
  }

  /** The names already used in `dir` (a rename's own name excepted); case-insensitive on Windows. */
  const taken = (dir: string, own?: string) => (name: string) => {
    const l = modelRef.current.dirs[dir];
    const k = (n: string) => (windows ? n.toLowerCase() : n);
    return Array.isArray(l) && l.some((e) => e.name !== own && k(e.name) === k(name));
  };

  async function startNew(dir: string, isDir: boolean) {
    setOpError(undefined);
    setNameError(undefined);
    await reveal(dir, false, true);
    setEditing({ kind: "new", dir, isDir });
  }
  async function startRename(path: string) {
    setOpError(undefined);
    setNameError(undefined);
    await reveal(path, false);
    setEditing({ kind: "rename", path });
  }
  /** Leaves the name field: focus goes back to `path`'s row. */
  const stopEditing = (path: string) => {
    setEditing(undefined);
    setNameError(undefined);
    goTo(path, true);
  };

  async function commitNew(e: Extract<Editing, { kind: "new" }>, name: string) {
    if (opBusy.current) return false;
    setBusyPath(e.dir);
    const path = joinPath(e.dir, name);
    const r = await write<FsPathResult>({ type: "fs.create", path, ...(e.isDir && { dir: true }) }, name, e.dir);
    setBusyPath(undefined);
    if (!r.ok) return void setNameError(r.text), false;
    setEditing(undefined);
    await list(e.dir);
    onChanged?.();
    if (e.isDir) await reveal(r.result.path, true);
    else onOpen(r.result.path, { pinned: true, focusEditor: true });
    return true;
  }
  async function commitRename(path: string, name: string) {
    if (opBusy.current) return false;
    const parent = parentOf(path);
    setBusyPath(path);
    const r = await write<FsPathResult>({ type: "fs.rename", path, name }, name, parent);
    setBusyPath(undefined);
    if (!r.ok) return void setNameError(r.text), false;
    const to = r.result.path;
    setEditing(undefined);
    setModel((m) => ({ ...m, ...movePaths(m, path, to) }));
    onMoved?.(path, to);
    await list(parent);
    onChanged?.();
    goTo(to, true);
    return true;
  }

  async function duplicate(entry: FsEntry) {
    if (opBusy.current) return;
    setOpError(undefined);
    setBusyPath(entry.path);
    const r = await write<FsPathResult>({ type: "fs.duplicate", path: entry.path }, entry.name, parentOf(entry.path));
    setBusyPath(undefined);
    if (!r.ok) return setOpError(r.text);
    await list(parentOf(entry.path));
    onChanged?.();
    await reveal(r.result.path, true);
  }

  function askDelete(entry: FsEntry) {
    setOpError(undefined);
    delPath.current = entry.path;
    delConfirmed.current = false;
    setDel({ entry, dirty: dirtyUnder?.(entry.path) ?? 0, counting: entry.isDir });
    if (!entry.isDir) return;
    client.request<FsDeleteResult>({ type: "fs.delete", path: entry.path, dryRun: true }).then(
      (count) => setDel((d) => (d?.entry.path === entry.path ? { ...d, counting: false, count } : d)),
      (e: Error) => setDel((d) => (d?.entry.path === entry.path ? { ...d, counting: false, countError: e.message } : d)),
    );
  }
  async function confirmDelete() {
    const d = del;
    if (!d || opBusy.current) return;
    delConfirmed.current = true;
    setDel(undefined);
    const { entry } = d;
    const parent = parentOf(entry.path);
    // Focus goes to the next row after the deleted one (and what is inside it), else the previous one, else the parent folder.
    const list0 = rows.flatMap((r) => (r.kind === "entry" ? [r.entry.path] : []));
    const at = list0.indexOf(entry.path);
    const inside = (p: string) => pathKey(p) === pathKey(entry.path) || pathKey(p).startsWith(pathKey(entry.path) + (windows ? "\\" : "/"));
    const next = list0.slice(at + 1).find((p) => !inside(p)) ?? list0.slice(0, at).reverse().find((p) => !inside(p)) ?? (list0.includes(parent) ? parent : undefined);
    setBusyPath(entry.path);
    const r = await write<FsDeleteResult>({ type: "fs.delete", path: entry.path }, entry.name, parent);
    setBusyPath(undefined);
    if (!r.ok) return setOpError(r.text);
    setModel((m) => ({ ...m, ...dropPaths(m, entry.path) }));
    // A filter result list still holds the row.
    setFound((f) => f && { ...f, paths: f.paths.filter((p) => !inside(joinPath(cwd, p))) });
    onDeleted?.(entry.path);
    await list(parent);
    onChanged?.();
    if (next) goTo(next, true);
  }

  const targetOf = (path: string | undefined): TreeTarget => {
    const r = path === undefined ? undefined : rows.find((x) => x.kind === "entry" && x.entry.path === path);
    if (!r || r.kind !== "entry") return { kind: "root" };
    return r.entry.isDir ? { kind: "dir", entry: r.entry, expanded: !!r.expanded } : { kind: "file", entry: r.entry, changed: !!marks?.files.get(pathKey(r.entry.path)) };
  };
  const captureTarget = (target: EventTarget) => {
    const path = (target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset.path;
    pendingTarget.current = path;
    // Right click and long press focus the row (VS Code).
    if (path !== undefined) setFocused(path);
  };
  function run(id: TreeCommand, t: TreeTarget) {
    const path = t.kind === "root" ? cwd : t.entry.path;
    if (MOVES_FOCUS.has(id)) movedFocus.current = true;
    const entry = t.kind === "root" ? undefined : t.entry;
    switch (id) {
      case "rename":
        return void startRename(path);
      case "duplicate":
        return entry && void duplicate(entry);
      case "delete":
        return entry && askDelete(entry);
      case "newFile":
        return void startNew(path, false);
      case "newFolder":
        return void startNew(path, true);
      case "open":
        return onOpen(path, { pinned: true, focusEditor: true });
      case "viewer":
        return onViewer?.(path);
      case "changes":
        return onShowChanges?.(path);
      case "mention":
        return onMention?.(path);
      case "copyPath":
        return onCopy?.(path, "path");
      case "copyRel":
        return onCopy?.(relPath(path, cwd), "relative path");
      case "collapse":
        return collapse(path);
      case "refresh":
        return onReload?.();
    }
  }
  const toggle = (e: FsEntry) => (modelRef.current.expanded.has(e.path) ? collapse(e.path) : expand(e.path));
  const rowOf = (target: EventTarget) => {
    const path = (target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset.path;
    return path === undefined ? -1 : rowAt(path);
  };

  function onKeyDown(e: KeyboardEvent) {
    const i = rowOf(e.target);
    const row = rows[i];
    if (!row || row.kind !== "entry") return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]");
    if (el && openContextMenuFromKey(e as KeyboardEvent<HTMLElement>, el)) return void (keyOpenedAt.current = performance.now());
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    if (plain && e.key === "F2") return (e.preventDefault(), void startRename(row.entry.path));
    if ((plain && e.key === "Delete") || (MAC && e.key === "Backspace" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)) return (e.preventDefault(), askDelete(row.entry));
    if (e.ctrlKey || e.altKey || e.metaKey) return;
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
      {opError && (
        <div role="alert" className="flex items-start gap-1 px-2 py-1 text-destructive" data-testid="tree-op-error">
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{opError}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring max-md:size-11"
            onClick={() => setOpError(undefined)}
          >
            <XIcon className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
      <ContextMenu.Root onOpenChange={(open) => open && ((movedFocus.current = false), setMenuTarget(targetOf(pendingTarget.current)))}>
      <ContextMenu.Trigger
        render={<div className="flex flex-1 flex-col" />}
        onContextMenuCapture={(e) => captureTarget(e.target)}
        onTouchStartCapture={(e) => captureTarget(e.target)}
        onContextMenu={(e) => swallowKeyFollowup(e, keyOpenedAt)}
      >
      <div role="tree" id="file-tree-rows" aria-label="Files" ref={root} onKeyDown={onKeyDown}>
        {rows.map((r, i) => {
          const pad = { paddingLeft: `${8 + r.depth * 12}px` };
          if (r.kind === "status")
            return (
              <div key={`s${i}`} role="none" className={r.error ? "px-2 text-destructive" : "px-2 text-muted-foreground"} style={pad}>
                {r.text}
              </div>
            );
          if (r.kind === "input") {
            const e = r.editing;
            const where = e.dir === cwd ? "the project" : relPath(e.dir, cwd);
            return (
              <Fragment key="new-input">
                <div role="none" className={`flex h-7 w-full items-center gap-1 pr-2 ${coarse}`} style={{ paddingLeft: `${8 + r.depth * 12}px` }}>
                  <span className="size-3.5 shrink-0" />
                  {e.isDir ? <FolderIcon className="size-4 shrink-0 text-faint" aria-hidden /> : <FileIcon path="untitled" className="size-4 shrink-0" />}
                  <NameInput
                    initial=""
                    select={[0, 0]}
                    label={`New ${e.isDir ? "folder" : "file"} name in ${where}`}
                    windows={windows}
                    taken={taken(e.dir)}
                    error={nameError}
                    busy={busyPath === e.dir}
                    describedBy="tree-name-msg"
                    onCommit={(name) => commitNew(e, name)}
                    onCancel={() => stopEditing(e.dir)}
                    onMessage={setNameMsg}
                    onType={() => setNameError(undefined)}
                  />
                </div>
                {nameMsg && <NameMessage text={nameMsg} depth={r.depth} />}
              </Fragment>
            );
          }
          const { entry } = r;
          const mark = entry.isDir ? undefined : marks?.files.get(pathKey(entry.path));
          const dirMark = entry.isDir ? marks?.dirs.get(pathKey(entry.path)) : undefined;
          const selected = entry.path === activePath;
          return (
            <Fragment key={entry.path}>
            <div
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
              aria-busy={busyPath === entry.path || undefined}
              className={`flex h-7 w-full cursor-pointer items-center gap-1 pr-2 text-left outline-none select-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${coarse} ${selected ? "bg-muted text-foreground" : ""} ${busyPath === entry.path ? "opacity-60" : ""}`}
              style={pad}
              onFocus={() => setFocused(entry.path)}
              onClick={() => (entry.isDir ? toggle(entry) : onOpen(entry.path, {}))}
              onDoubleClick={() => !entry.isDir && onOpen(entry.path, { pinned: true })}
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
              {r.renaming ? (
                <NameInput
                  initial={entry.name}
                  select={nameSelection(entry.name, entry.isDir)}
                  label={`Rename ${entry.name}`}
                  windows={windows}
                  taken={taken(r.parent, entry.name)}
                  error={nameError}
                  busy={busyPath === entry.path}
                  describedBy="tree-name-msg"
                  onCommit={(name) => commitRename(entry.path, name)}
                  onCancel={() => stopEditing(entry.path)}
                  onMessage={setNameMsg}
                  onType={() => setNameError(undefined)}
                />
              ) : (
                <span className="truncate">{entry.name}</span>
              )}
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
            {r.renaming && nameMsg && <NameMessage text={nameMsg} depth={r.depth} />}
            </Fragment>
          );
        })}
      </div>
      {q && found?.query === q && found.paths.length === 0 && (
        <p className="px-2 py-1 text-muted-foreground" role="status">
          No matching files.
        </p>
      )}
      {q && found?.query === q && found.paths.length >= 50 && <p className="px-2 py-1 text-muted-foreground">First 50 matches.</p>}
      <div className="min-h-6 flex-1" data-testid="tree-empty-space" />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup
            className={cn(POPUP, "max-w-[calc(100vw-2rem)]")}
            data-testid="tree-menu"
            finalFocus={() => (movedFocus.current ? false : (rowEl(root.current, menuTarget.kind === "root" ? tabPath : menuTarget.entry.path) ?? true))}
          >
            {treeMenuSections(menuTarget, MAC).map((section, i) => (
                <div key={i} role="none">
                  {i > 0 && <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />}
                  {section.map((x) => (
                    <ContextMenu.Item
                      key={x.id}
                      className={cn(ITEM, x.destructive && "text-destructive")}
                      disabled={x.disabled}
                      aria-keyshortcuts={x.keys}
                      data-testid={x.testId}
                      onClick={() => run(x.id, menuTarget)}
                    >
                      <span className="truncate">{x.label}</span>
                      {x.shortcut && (
                        <kbd className="ml-auto pl-4 font-sans text-muted-foreground text-xs" aria-hidden>
                          {x.shortcut}
                        </kbd>
                      )}
                    </ContextMenu.Item>
                  ))}
                </div>
              ))}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
      </ContextMenu.Root>
      <ConfirmDialog
        open={!!del}
        title={`Delete “${del?.entry.name ?? ""}”?`}
        description={del ? deleteText(del) : ""}
        confirm="Delete"
        destructive
        confirmDisabled={!!del?.counting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDel(undefined)}
        testId="tree-delete"
        finalFocus={() => (delConfirmed.current ? false : (rowEl(root.current, delPath.current ?? "") ?? true))}
      />
    </>
  );
}

