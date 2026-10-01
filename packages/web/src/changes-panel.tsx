// Changes tab (docs/spec.md "Layout"): files changed in the session, each with its diff, like OpenCode's review panel.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FsReadResult } from "@claude-ui/protocol";
import { MultiFileDiff } from "@pierre/diffs/react";
import { Columns2Icon, FileDiffIcon, RotateCwIcon, Rows2Icon, SquareArrowOutUpRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { baseline, callStats, fileStats, sessionChanges, type FileChange, type Stats } from "./changes.ts";
import type { SessionView } from "./store.ts";
import { useDark } from "./theme.ts";
import { DIFF_OPTIONS, InputDiff } from "./tool-card.tsx";

type Client = ReturnType<typeof connect>;
type DiffStyle = "unified" | "split";
/** Disk content of a changed file: "" once deleted. */
type Disk = { content?: string; deleted?: boolean; error?: string };
/** `kind`: OpenCode's file badge, A(dded) / D(eleted) / M(odified). */
type Row = { change: FileChange; before?: string; after?: string; error?: string; stats?: Stats; kind: Kind };
type Kind = "A" | "D" | "M";
const KIND_TITLE = { A: "Added", D: "Deleted", M: "Modified" } as const;
const KIND_COLOR = { A: "text-success", D: "text-destructive", M: "text-info" } as const;

const baseName = (path: string) => path.split("/").at(-1) ?? path;
const relative = (path: string, cwd: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

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

/**
 * Re-reads the files whenever a call changes one, so the diffs follow Claude live, and on `fs.changed` (Bash or outside edits).
 * The files panel owns this connection's fs.watch list; App adds the changed files to it.
 */
export function ChangesPanel({ client, view, cwd, onOpen }: { client: Client; view: SessionView; cwd: string; onOpen: (path: string) => void }) {
  const changes = useMemo(() => sessionChanges(view), [view.parts]);
  const [disk, setDisk] = useState<Record<string, Disk>>({});
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [chosen, setChosen] = useState(loadStyle);
  const narrow = useNarrow();
  const style: DiffStyle = narrow ? "unified" : chosen;
  const choose = (s: DiffStyle) => (setChosen(s), saveStyle(s));

  const key = changes.map((c) => `${c.path}\n${c.calls.length}`).join("\n");
  useEffect(() => {
    let live = true;
    for (const { path } of changes)
      client
        .request<FsReadResult>({ type: "fs.read", path })
        .then((r): Disk => ({ content: r.content }))
        .catch((e: RequestError): Disk => (e.code === "not_found" ? { content: "", deleted: true } : { error: e.message }))
        .then((d) => live && setDisk((x) => ({ ...x, [path]: d })));
    return () => void (live = false);
  }, [key, reload]);
  useEffect(() => client.onFsChanged((m) => changes.some((c) => c.path === m.path) && setReload((n) => n + 1)), [client, key]);

  const rows = useMemo(
    () =>
      changes.map((change): Row => {
        const d = disk[change.path];
        if (d?.content === undefined) return { change, error: d?.error, stats: callStats(change), kind: "M" };
        const before = baseline(d.content, change);
        // Added: the file did not exist (original null), or a restored transcript's Write created it. An existing empty file is M.
        const kind = d.deleted ? "D" : change.original === null || (change.original === undefined && before === "") ? "A" : "M";
        return before === undefined
          ? { change, after: d.content, stats: callStats(change), kind }
          : { change, before, after: d.content, stats: fileStats(before, d.content, change.path), kind };
      }),
    [changes, disk],
  );
  const total = rows.reduce((t, r) => ({ added: t.added + (r.stats?.added ?? 0), removed: t.removed + (r.stats?.removed ?? 0) }), { added: 0, removed: 0 });
  const active = rows.find((r) => r.change.path === selected) ?? rows[0];

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
        <StatsText stats={total} />
        <div className="ml-auto flex items-center gap-1 max-md:gap-2" data-testid="changes-actions">
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
      <ul className="max-h-[35%] shrink-0 overflow-auto border-b p-1" aria-label="Changed files">
        {rows.map((r) => {
          const path = r.change.path;
          const rel = relative(path, cwd);
          const dir = rel.slice(0, -baseName(rel).length);
          return (
            <li key={path}>
              <button
                className={cn(
                  "flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left hover:bg-accent lg:min-h-7",
                  r === active && "bg-secondary",
                )}
                aria-current={r === active}
                title={path}
                onClick={() => setSelected(path)}
                data-testid="changed-file"
              >
                <KindBadge kind={r.kind} />
                <span className="min-w-0 flex-1 truncate">
                  {baseName(path)}
                  {dir && <span className="ml-2 text-muted-foreground">{dir.replace(/\/$/, "")}</span>}
                </span>
                {r.stats && <StatsText stats={r.stats} />}
              </button>
            </li>
          );
        })}
      </ul>
      {active && <FileDiff key={active.change.path} row={active} cwd={cwd} style={style} onOpen={onOpen} />}
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

function FileDiff({ row, cwd, style, onOpen }: { row: Row; cwd: string; style: DiffStyle; onOpen: (path: string) => void }) {
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
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-diff" data-diff-style={style}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 max-md:h-14" data-testid="file-diff-header">
        <KindBadge kind={row.kind} />
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs" title={path}>
          {relative(path, cwd)}
        </span>
        {row.stats && <StatsText stats={row.stats} />}
        <Button size="sm" variant="ghost" className="max-md:h-11" onClick={() => onOpen(path)} data-testid="open-in-editor">
          <SquareArrowOutUpRightIcon /> Open in editor
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
        {row.error && <p className="p-2 text-destructive">{row.error}</p>}
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
