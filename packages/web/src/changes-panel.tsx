// Changes tab (docs/spec.md "Layout"): files changed in the session, each with its diff, like OpenCode's review panel.
import { useEffect, useMemo, useState } from "react";
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
type Disk = { content?: string; error?: string };
type Row = { change: FileChange; before?: string; after?: string; error?: string; stats?: Stats };

const baseName = (path: string) => path.split("/").at(-1) ?? path;
const relative = (path: string, cwd: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

/**
 * Re-reads the files whenever a call changes one, so the diffs follow Claude live.
 * ponytail: no fs.watch (the files panel owns this connection's watch list); a change made outside the session shows after ↻.
 */
export function ChangesPanel({ client, view, cwd, onOpen }: { client: Client; view: SessionView; cwd: string; onOpen: (path: string) => void }) {
  const changes = useMemo(() => sessionChanges(view), [view.parts]);
  const [disk, setDisk] = useState<Record<string, Disk>>({});
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [style, setStyle] = useState<DiffStyle>("unified");

  const key = changes.map((c) => `${c.path}\n${c.calls.length}`).join("\n");
  useEffect(() => {
    let live = true;
    for (const { path } of changes)
      client
        .request<FsReadResult>({ type: "fs.read", path })
        .then((r): Disk => ({ content: r.content }))
        .catch((e: RequestError): Disk => (/ENOENT/.test(e.message) ? { content: "" } : { error: e.message }))
        .then((d) => live && setDisk((x) => ({ ...x, [path]: d })));
    return () => void (live = false);
  }, [key, reload]);

  const rows = useMemo(
    () =>
      changes.map((change): Row => {
        const d = disk[change.path];
        if (d?.content === undefined) return { change, error: d?.error, stats: callStats(change) };
        const before = baseline(d.content, change);
        return before === undefined
          ? { change, after: d.content, stats: callStats(change) }
          : { change, before, after: d.content, stats: fileStats(before, d.content, change.path) };
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
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" className="max-md:size-11" onClick={() => setReload((n) => n + 1)} title="Reload from disk" aria-label="Reload from disk">
            <RotateCwIcon />
          </Button>
          <div className="flex rounded-md bg-secondary p-0.5" role="radiogroup" aria-label="Diff view">
            {(["unified", "split"] as const).map((s) => (
              <Button
                key={s}
                size="icon-sm"
                variant="ghost"
                role="radio"
                aria-checked={style === s}
                aria-label={s === "unified" ? "Unified diff" : "Split diff"}
                title={s === "unified" ? "Unified diff" : "Split diff"}
                className={cn("max-md:size-11", style === s && "bg-card shadow-xs hover:bg-card")}
                onClick={() => setStyle(s)}
                data-testid={`diff-${s}`}
              >
                {s === "unified" ? <Rows2Icon /> : <Columns2Icon />}
              </Button>
            ))}
          </div>
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
      {active && <FileDiff row={active} cwd={cwd} style={style} onOpen={onOpen} />}
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

function FileDiff({ row, cwd, style, onOpen }: { row: Row; cwd: string; style: DiffStyle; onOpen: (path: string) => void }) {
  const { path } = row.change;
  const dark = useDark();
  const options = useMemo(() => ({ ...DIFF_OPTIONS, diffStyle: style, themeType: dark ? ("dark" as const) : ("light" as const) }), [style, dark]);
  const files = useMemo(
    () => (row.before === undefined || row.after === undefined ? undefined : { old: { name: path, contents: row.before }, new: { name: path, contents: row.after } }),
    [path, row.before, row.after],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-diff">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 max-md:h-14">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs" title={path}>
          {relative(path, cwd)}
        </span>
        <Button size="sm" variant="ghost" className="max-md:h-11" onClick={() => onOpen(path)} data-testid="open-in-editor">
          <SquareArrowOutUpRightIcon /> Open in editor
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
        {row.error && <p className="p-2 text-destructive">{row.error}</p>}
        {files ? (
          <MultiFileDiff oldFile={files.old} newFile={files.new} options={options} />
        ) : (
          !row.error &&
          row.after !== undefined && (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">The file before this session is unknown (restored session): each edit is shown.</p>
              {row.change.calls.map((c) => (
                <InputDiff key={c.id} tool={c.tool} input={c.input} diffStyle={style} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
