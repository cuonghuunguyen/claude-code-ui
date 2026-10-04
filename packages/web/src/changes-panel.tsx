// Changes tab (docs/spec.md "Layout"): files changed in the session, each with its diff, like OpenCode's review panel.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { FsReadResult } from "@claude-ui/protocol";
import { MultiFileDiff } from "@pierre/diffs/react";
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, Columns2Icon, FileDiffIcon, RotateCwIcon, Rows2Icon, SearchIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { baseline, callStats, fileStats, sessionChanges, type FileChange, type Stats } from "./changes.ts";
import type { SessionView } from "./store.ts";
import { useDark } from "./theme.ts";
import { DIFF_OPTIONS, InputDiff } from "./tool-card.tsx";
import { FileIcon } from "./file-icon.tsx";
import { inDir, isWinPath, relPath } from "./paths.ts";
import { readFailure } from "./files.ts";
import { filePath } from "./tools.ts";

type Client = ReturnType<typeof connect>;
type DiffStyle = "unified" | "split";
/** Disk content of a changed file: "" once deleted. */
type Disk = { content?: string; deleted?: boolean; error?: string; notice?: boolean };
/** `kind`: OpenCode's file badge, A(dded) / D(eleted) / M(odified). */
type Row = { change: FileChange; before?: string; after?: string; error?: string; notice?: boolean; stats?: Stats; kind: Kind };
type Kind = "A" | "D" | "M";
const KIND_TITLE = { A: "Added", D: "Deleted", M: "Modified" } as const;
const KIND_COLOR = { A: "text-success", D: "text-destructive", M: "text-info" } as const;

// Diff style like OpenCode's review panel: split by default, the choice kept per browser; below md always unified.
const STYLE_KEY = "claude-ui.diffStyle";
function loadStyle(): DiffStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === "unified" ? "unified" : "split";
  } catch {
    return "split";
  }
}
function saveStyle(s: DiffStyle) {
  try {
    localStorage.setItem(STYLE_KEY, s);
  } catch {
    // Storage blocked: the choice lasts while the panel is open.
  }
}
const narrowQuery = () => matchMedia("(max-width: 767.98px)");
const onNarrowChange = (cb: () => void) => {
  const mq = narrowQuery();
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const useNarrow = () => useSyncExternalStore(onNarrowChange, () => narrowQuery().matches);

/** A folder of OpenCode's review file tree: folders first, then files, each by name. */
type Folder = { name: string; path: string; folders: Folder[]; files: Row[] };
function fileTree(rows: Row[], cwd: string): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  for (const r of rows) {
    const { dir } = filePath(r.change.path, cwd);
    // A file outside cwd keeps its absolute directory as one top-level folder.
    let at = root;
    const win = isWinPath(r.change.path);
    for (const name of !dir ? [] : dir.startsWith("/") || (win && isWinPath(dir)) ? [dir] : dir.split(win ? /[\\/]/ : "/")) {
      let next = at.folders.find((f) => f.name === name);
      if (!next) at.folders.push((next = { name, path: at.path ? `${at.path}/${name}` : name, folders: [], files: [] }));
      at = next;
    }
    at.files.push(r);
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name)).forEach(sort);
    f.files.sort((a, b) => a.change.path.localeCompare(b.change.path));
  };
  sort(root);
  return root;
}
const treeOrder = (f: Folder): Row[] => [...f.folders.flatMap(treeOrder), ...f.files];

/**
 * Re-reads the files whenever a call changes one, so the diffs follow Claude live, and on `fs.changed` (Bash or outside edits).
 * The files panel owns this connection's fs.watch list; App adds the changed files to it.
 */
/** `hidden`: mounted behind another pane, only to report `onCount` (the listed files) for the pane tab. */
export function ChangesPanel({
  client,
  view,
  cwd,
  onOpen,
  hidden,
  onCount,
}: {
  client: Client;
  view: SessionView;
  cwd: string;
  onOpen: (path: string) => void;
  hidden?: boolean;
  onCount?: (n: number) => void;
}) {
  const fresh = useMemo(() => sessionChanges(view), [view.parts]);
  // Same calls and results per path: the previous list, so streamed text does not re-parse every diff.
  const key = fresh.map((c) => `${c.path}\n${c.calls.length}\n${c.results.filter(Boolean).length}`).join("\n");
  const changes = useMemo(() => fresh, [key]);
  const [disk, setDisk] = useState<Record<string, Disk>>({});
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [chosen, setChosen] = useState(loadStyle);
  const narrow = useNarrow();
  const style: DiffStyle = narrow ? "unified" : chosen;
  const choose = (s: DiffStyle) => (setChosen(s), saveStyle(s));

  useEffect(() => {
    let live = true;
    for (const { path } of changes)
      client
        .request<FsReadResult>({ type: "fs.read", path })
        .then((r): Disk => ({ content: r.content }))
        .catch((e: RequestError): Disk => (e.code === "not_found" ? { content: "", deleted: true } : { error: readFailure(e).text, notice: readFailure(e).notice }))
        .then((d) => live && setDisk((x) => ({ ...x, [path]: d })));
    return () => void (live = false);
  }, [key, reload]);
  useEffect(() => client.onFsChanged((m) => changes.some((c) => c.path === m.path) && setReload((n) => n + 1)), [client, key]);

  const rows = useMemo(
    () =>
      changes.flatMap((change): Row[] => {
        const d = disk[change.path];
        if (d?.content === undefined) return [{ change, error: d?.error, notice: d?.notice, stats: callStats(change), kind: "M" }];
        const before = baseline(d.content, change);
        // Added: the file did not exist (original null), or a restored transcript's Write created it. An existing empty file is M.
        const created = change.original === null || (change.original === undefined && before === "");
        // Created and deleted again: no net change, so no row (OpenCode's before/after list has none).
        if (d.deleted && created) return [];
        const kind = d.deleted ? "D" : created ? "A" : "M";
        // A deleted file with an unknown before has no net stats; the per-call sums would not count the deletion.
        if (before === undefined) return [{ change, after: d.content, stats: d.deleted ? undefined : callStats(change), kind }];
        return [{ change, before, after: d.content, stats: fileStats(before, d.content, change.path), kind }];
      }),
    [changes, disk],
  );
  const total = rows.reduce((t, r) => ({ added: t.added + (r.stats?.added ?? 0), removed: t.removed + (r.stats?.removed ?? 0) }), { added: 0, removed: 0 });
  const [filter, setFilter] = useState("");
  // No filter in the narrow accordion (OpenCode has none there).
  const q = narrow ? "" : filter.trim().toLowerCase();
  const matched = q ? rows.filter((r) => relPath(r.change.path, cwd).toLowerCase().includes(q)) : rows;
  const tree = useMemo(() => fileTree(matched, cwd), [rows, q, cwd]);
  // The order on screen: the tree's on wide screens, by path in the narrow accordion (OpenCode's mobile review).
  const shown = narrow ? [...matched].sort((a, b) => relPath(a.change.path, cwd).localeCompare(relPath(b.change.path, cwd))) : treeOrder(tree);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const allExpanded = shown.length > 0 && shown.every((r) => expanded[r.change.path]);
  const active = shown.find((r) => r.change.path === selected) ?? shown[0];
  const index = active ? shown.indexOf(active) : -1;
  // Previous/next file like OpenCode's review toolbar: cycles the listed files, also on ←/→ while focus is not in a text field.
  const cycle = (step: number) => shown.length && setSelected(shown[(index + step + shown.length) % shown.length]!.change.path);
  const cycleRef = useRef(cycle);
  cycleRef.current = cycle;
  // Only while the file list is on screen: not behind another pane, a closed side panel or the new-session tab (display: none).
  const listRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef(false);
  keysRef.current = !hidden && !narrow;
  useEffect(() => onCount?.(rows.length), [rows.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!keysRef.current || listRef.current?.checkVisibility?.() === false || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const t = e.target;
      // Text fields keep their caret keys; widgets with their own arrow keys (tabs, the panel resizer, menus) keep theirs.
      if (t instanceof HTMLElement && (t.isContentEditable || t.closest("input, textarea, select, [role=tab], [role=separator], [role=menu], [role=listbox], [role=radiogroup]"))) return;
      e.preventDefault();
      cycleRef.current(e.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const label = (r: Row) => `${KIND_TITLE[r.kind]} ${relPath(r.change.path, cwd)}${r.stats ? `, +${r.stats.added} -${r.stats.removed}` : ""}`;
  const treeRow =
    "flex min-h-11 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:min-h-7";
  const pad = (depth: number) => ({ paddingLeft: `${depth * 16 + 8}px` });
  // OpenCode's FileTree: a folder row (chevron, open by default) above its files; a file row with its type icon and A/D.
  const branch = (f: Folder, depth: number): ReactNode => (
    <>
      {f.folders.map((d) => (
        <li key={d.path}>
          <button
            className={treeRow}
            style={pad(depth)}
            aria-expanded={!closed[d.path]}
            onClick={() => setClosed((c) => ({ ...c, [d.path]: !c[d.path] }))}
            data-testid="changed-folder"
          >
            {closed[d.path] ? <ChevronRightIcon className="size-4 shrink-0 text-faint" aria-hidden /> : <ChevronDownIcon className="size-4 shrink-0 text-faint" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
          </button>
          {!closed[d.path] && <ul className="mt-0.5 flex flex-col gap-0.5">{branch(d, depth + 1)}</ul>}
        </li>
      ))}
      {f.files.map((r) => (
        <li key={r.change.path}>
          <button
            className={cn(treeRow, r === active && "bg-secondary text-foreground")}
            style={pad(depth)}
            aria-current={r === active}
            title={r.change.path}
            aria-label={label(r)}
            onClick={() => setSelected(r.change.path)}
            data-testid="changed-file"
          >
            <FileIcon path={r.change.path} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{filePath(r.change.path, cwd).name}</span>
            {/* OpenCode's v2 tree marks added and deleted files; M shows in the diff header only. */}
            {r.kind !== "M" && <KindBadge kind={r.kind} />}
          </button>
        </li>
      ))}
    </>
  );

  if (hidden) return null;
  if (!rows.length)
    return (
      <div className="m-auto flex flex-col items-center gap-2 p-4 text-muted-foreground" data-testid="changes-empty">
        <FileDiffIcon className="size-5 text-faint" aria-hidden />
        No changes in this session yet.
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="changes-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 max-md:h-14">
        <span className="font-medium">
          {rows.length} Changed {rows.length === 1 ? "file" : "files"}
        </span>
        {rows.some((r) => r.stats) && <StatsText stats={total} />}
        <div className="ml-auto flex items-center gap-1 max-md:gap-2" data-testid="changes-actions">
          {narrow ? (
            <Button
              size="sm"
              variant="outline"
              className="h-11"
              onClick={() => setExpanded(allExpanded ? {} : Object.fromEntries(shown.map((r) => [r.change.path, true])))}
              data-testid="expand-all"
            >
              {allExpanded ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />} {allExpanded ? "Collapse all" : "Expand all"}
            </Button>
          ) : (
            <>
          {shown.length > 0 && (
            <span className="font-mono text-muted-foreground text-xs" data-testid="file-position">
              {index + 1}/{shown.length}
            </span>
          )}
          <Button size="icon-sm" variant="ghost" className="max-md:size-11" disabled={!shown.length} onClick={() => cycle(-1)} title="Previous file (←)" aria-label="Previous file">
            <ArrowLeftIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" className="max-md:size-11" disabled={!shown.length} onClick={() => cycle(1)} title="Next file (→)" aria-label="Next file">
            <ArrowRightIcon />
          </Button>
            </>
          )}
          <Button size="icon-sm" variant="ghost" className="max-md:size-11" onClick={() => setReload((n) => n + 1)} title="Reload from disk" aria-label="Reload from disk">
            <RotateCwIcon />
          </Button>
          {!narrow && (
            <div className="flex rounded-md bg-secondary p-0.5" role="group" aria-label="Diff view">
              {(["unified", "split"] as const).map((s) => (
                <Button
                  key={s}
                  size="icon-sm"
                  variant="ghost"
                  aria-pressed={style === s}
                  aria-label={s === "unified" ? "Unified diff" : "Split diff"}
                  title={s === "unified" ? "Unified diff" : "Split diff"}
                  className={cn(style === s && "bg-card shadow-xs hover:bg-card")}
                  onClick={() => choose(s)}
                  data-testid={`diff-${s}`}
                >
                  {s === "unified" ? <Rows2Icon /> : <Columns2Icon />}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
      {narrow ? (
        // OpenCode's mobile review: an accordion of the files, each diff under its row.
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <ul className="overflow-hidden rounded-lg border" aria-label="Changed files">
            {shown.map((r) => {
              const path = r.change.path;
              const { name, dir } = filePath(path, cwd);
              const open = !!expanded[path];
              return (
                <li key={path} className="border-b last:border-b-0">
                  <button
                    className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    aria-expanded={open}
                    title={path}
                    aria-label={label(r)}
                    onClick={() => setExpanded((x) => ({ ...x, [path]: !x[path] }))}
                    data-testid="changed-file"
                  >
                    <FileIcon path={path} className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {dir && <span className="text-muted-foreground">{dir.replace(/\/$/, "")}/</span>}
                      {name}
                    </span>
                    {r.kind !== "M" && <span className={cn("shrink-0 text-xs", KIND_COLOR[r.kind])}>{KIND_TITLE[r.kind]}</span>}
                    {r.stats && <StatsText stats={r.stats} />}
                    {open ? <ChevronDownIcon className="size-4 shrink-0 text-faint" aria-hidden /> : <ChevronRightIcon className="size-4 shrink-0 text-faint" aria-hidden />}
                  </button>
                  {open && <FileDiff row={r} cwd={cwd} style={style} onOpen={onOpen} inline />}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        // OpenCode's review file sidebar (240px, 200px in a narrow panel): filter and folder tree beside the diff.
        <div className="@container flex min-h-0 flex-1">
          <div ref={listRef} className="flex w-50 shrink-0 flex-col border-r @2xl:w-60">
            <label className="relative flex items-center px-2 pt-2 pb-1">
              <SearchIcon className="pointer-events-none absolute left-4 size-4 text-faint" aria-hidden />
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter files"
                aria-label="Filter files"
                className="h-8 w-full rounded-md bg-secondary/60 pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="changes-filter"
              />
            </label>
            {!shown.length && <p className="px-3 py-2 text-muted-foreground">No files match.</p>}
            <ul className="flex min-h-0 flex-col gap-0.5 overflow-auto p-1" aria-label="Changed files">
              {branch(tree, 0)}
            </ul>
          </div>
          {active && <FileDiff key={active.change.path} row={active} cwd={cwd} style={style} onOpen={onOpen} />}
        </div>
      )}
    </div>
  );
}

function StatsText({ stats }: { stats: Stats }) {
  return (
    <span className="shrink-0 font-mono text-xs" data-testid="change-stats">
      <span className="text-success">+{stats.added}</span>
      <span className="ml-1 text-destructive">-{stats.removed}</span>
    </span>
  );
}

function KindBadge({ kind }: { kind: Kind }) {
  return (
    <span className={cn("w-4 shrink-0 text-center font-[530] font-mono text-[11px]", KIND_COLOR[kind])} title={KIND_TITLE[kind]} data-testid="change-badge">
      {kind}
    </span>
  );
}

/** `inline`: under its accordion row, which already names the file: only Open in editor above the diff, and no own scroll. */
function FileDiff({ row, cwd, style, onOpen, inline }: { row: Row; cwd: string; style: DiffStyle; onOpen: (path: string) => void; inline?: boolean }) {
  const { path } = row.change;
  const dark = useDark();
  // Drawn once the highlighter is loaded (seconds on a first load): until then a loading line.
  const [drawn, setDrawn] = useState(false);
  // One header per file, like OpenCode's (file header off in the library): the panel's own, with the relative path.
  const options = useMemo(
    () => ({ ...DIFF_OPTIONS, diffStyle: style, themeType: dark ? ("dark" as const) : ("light" as const), disableFileHeader: true, onPostRender: () => setDrawn(true) }),
    [style, dark],
  );
  const files = useMemo(
    () => (row.before === undefined || row.after === undefined ? undefined : { old: { name: path, contents: row.before }, new: { name: path, contents: row.after } }),
    [path, row.before, row.after],
  );
  const same = files !== undefined && row.before === row.after;
  return (
    <div className={inline ? "flex flex-col border-t" : "flex min-h-0 min-w-0 flex-1 flex-col"} data-testid="file-diff" data-diff-style={style}>
      {inline ? (
        inDir(path, cwd) && (
          <div className="flex justify-end px-2 pt-1">
            <Button size="sm" variant="ghost" className="h-11" onClick={() => onOpen(path)} data-testid="open-in-editor">
              <SquareArrowOutUpRightIcon /> Open in editor
            </Button>
          </div>
        )
      ) : (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3" data-testid="file-diff-header">
          <KindBadge kind={row.kind} />
          <FileIcon path={path} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs" title={path}>
            {relPath(path, cwd)}
          </span>
          {row.stats && <StatsText stats={row.stats} />}
          {/* The files pane shows only tabs inside cwd, so a file outside it has no Open in editor (OpenCode lists only project files). */}
          {inDir(path, cwd) && (
            <Button size="sm" variant="ghost" onClick={() => onOpen(path)} data-testid="open-in-editor">
              <SquareArrowOutUpRightIcon /> Open in editor
            </Button>
          )}
        </div>
      )}
      <div className={cn("text-xs", !inline && "min-h-0 flex-1 overflow-auto p-2")}>
        {row.error && <p className={cn("p-2", row.notice ? "text-muted-foreground" : "text-destructive")}>{row.error}</p>}
        {!row.error && (row.after === undefined || (files && !same && !drawn)) && (
          <p className="p-2 text-muted-foreground" data-testid="diff-loading">
            Loading diff…
          </p>
        )}
        {same ? (
          <p className="p-2 text-muted-foreground">No changes against the file before this session.</p>
        ) : files ? (
          <MultiFileDiff oldFile={files.old} newFile={files.new} options={options} />
        ) : (
          !row.error &&
          row.after !== undefined && (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">The file before this session is unknown: each edit is shown.</p>
              {row.change.calls.map((c) => (
                <InputDiff key={c.id} tool={c.tool} input={c.input} diffStyle={style} fileHeader={false} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
