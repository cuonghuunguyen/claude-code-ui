// Timeline (docs/spec.md "Editor"): the Local history entries and the commits of the active file, below the file tree.
import { useEffect, useMemo, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { FsReadResult, GitCommit, GitLogResult, HistoryEntry, HistoryListResult } from "@claude-ui/protocol";
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon, GitCommitHorizontalIcon, HistoryIcon, ListFilterIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { repoOfPath } from "./file-tree-model.ts";
import { t, useT, type Key } from "./i18n.ts";
import { relPath, repoDir } from "./paths.ts";
import type { RepoList } from "./repo-choice.ts";
import { ConfirmDialog, POPUP } from "./session-actions.tsx";
import { timeAgo } from "./sessions.ts";
import { MenuEntries } from "./sidebar-menus.tsx";
import type { MenuEntry } from "./sidebar-menus.ts";
import { previousOf, timelineRows, visibleRows, type TimelineFilter, type TimelineRow } from "./timeline.ts";
import { ViewerDialog } from "./viewer-dialog.tsx";
import type { ViewerTarget } from "./viewer.ts";

type Client = ReturnType<typeof connect>;
type Compare = Extract<ViewerTarget, { kind: "compare" }>;
type Data = { path: string; entries: HistoryEntry[]; commits: GitCommit[]; error?: string };

const OPEN_KEY = "claude-ui.timeline.open";
const FILTER_KEY = "claude-ui.timeline.filter";
const noop = () => {};

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function loadFilter(): TimelineFilter {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null") as Partial<TimelineFilter> | null;
    return { history: f?.history !== false, git: f?.git !== false };
  } catch {
    return { history: true, git: true };
  }
}
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

const titleOf = (r: TimelineRow) => (r.source === "git" ? r.commit.subject : (r.entry.label ?? t(`files.timeline.reason.${r.entry.reason}` as Key)));
const timeText = (r: TimelineRow) => new Date(r.time).toLocaleString();
const sideLabel = (r: TimelineRow) => `${titleOf(r)} · ${timeText(r)}`;

/**
 * `path`: the active file. `stamp`: changes when the file or the repository may have changed (save, disk change, refs): the list reloads.
 * `dirty`: the tab has unsaved edits (Restore is refused); `mtime`: its disk version, the base of a restore.
 */
export function TimelinePanel({ client, cwd, path, repos, stamp, dirty, mtime }: { client: Client; cwd: string; path: string | undefined; repos?: RepoList; stamp: string; dirty: boolean; mtime: number | undefined }) {
  const tr = useT();
  const [open, setOpen] = useState(loadOpen);
  const [filter, setFilter] = useState(loadFilter);
  const [data, setData] = useState<Data>();
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [compare, setCompare] = useState<Compare>();
  const [dialog, setDialog] = useState<{ kind: "rename" | "delete"; row: Extract<TimelineRow, { source: "history" }> } | { kind: "create" }>();
  const [name, setName] = useState("");

  // The file's own repository (git.log asks the top and a path relative to it); none: no git rows.
  const repo = path && repos?.list ? repoOfPath(path, repos.list, cwd) : undefined;
  const top = repo ? repoDir(cwd, repo.rel) : undefined;
  const rel = path && top ? relPath(path, top).replaceAll("\\", "/") : undefined;

  useEffect(() => {
    if (!open || !path) return;
    let live = true;
    const git = top && rel ? client.request<GitLogResult>({ type: "git.log", cwd: top, exact: true, path: rel }).then((r) => r.log?.commits ?? [], () => [] as GitCommit[]) : Promise.resolve([] as GitCommit[]);
    const history = client.request<HistoryListResult>({ type: "history.list", path }).then(
      (r): { entries: HistoryEntry[]; error?: string } => ({ entries: r.entries }),
      (e: Error) => ({ entries: [], error: e.message }),
    );
    void Promise.all([history, git]).then(([h, commits]) => live && setData({ path, entries: h.entries, commits, error: h.error }));
    return () => void (live = false);
  }, [open, path, stamp, tick, client, top, rel]);
  // A new file starts with a clean slate.
  useEffect(() => setNotice(undefined), [path]);

  const all = useMemo(() => (data && data.path === path ? timelineRows(data.entries, data.commits) : []), [data, path]);
  const rows = visibleRows(all, filter);

  const toggle = () => {
    save(OPEN_KEY, open ? "0" : "1");
    setOpen(!open);
  };
  const setFilterBy = (f: TimelineFilter) => (save(FILTER_KEY, JSON.stringify(f)), setFilter(f));
  const fail = (e: unknown) => setNotice((e as Error).message);

  const read = (r: TimelineRow): Promise<string> =>
    r.source === "history"
      ? client.request<{ content: string }>({ type: "history.read", path: path!, id: r.entry.id }).then((x) => x.content)
      : // A commit before a rename holds the file under another name: it reads as empty (shortcut: --follow names are not resolved).
        client.request<{ content: string }>({ type: "git.fileAt", cwd: top!, exact: true, hash: r.commit.hash, path: rel! }).then(
          (x) => x.content,
          (e: RequestError) => (e.code === "not_found" ? "" : Promise.reject(e)),
        );
  const current = () => client.request<FsReadResult>({ type: "fs.read", path: path! }).then((x) => x.content);
  const show = (old: { label: string; content: Promise<string> }, next: { label: string; content: Promise<string> }) =>
    Promise.all([old.content, next.content]).then(([a, b]) => (setNotice(undefined), setCompare({ kind: "compare", path: path!, old: { label: old.label, content: a }, new: { label: next.label, content: b } })), fail);
  const compareCurrent = (r: TimelineRow) => show({ label: sideLabel(r), content: read(r) }, { label: tr("files.timeline.current"), content: current() });
  const comparePrevious = (r: TimelineRow) => {
    const p = previousOf(all, r);
    return p && show({ label: sideLabel(p), content: read(p) }, { label: sideLabel(r), content: read(r) });
  };
  const restore = (r: Extract<TimelineRow, { source: "history" }>) => {
    if (dirty) return setNotice(tr("files.timeline.restoreDirty"));
    client.request({ type: "history.restore", path: path!, id: r.entry.id, baseMtime: mtime }).then(() => (setNotice(undefined), setTick((n) => n + 1)), fail);
  };
  const submit = () => {
    const d = dialog;
    const label = name.trim();
    if (!d || d.kind === "delete" || !label) return;
    setDialog(undefined);
    const req = d.kind === "create" ? client.request({ type: "history.create", path: path!, label }) : client.request({ type: "history.rename", path: path!, id: d.row.entry.id, label });
    req.then(() => setTick((n) => n + 1), fail);
  };
  const remove = (r: Extract<TimelineRow, { source: "history" }>) => {
    setDialog(undefined);
    client.request({ type: "history.delete", path: path!, id: r.entry.id }).then(() => setTick((n) => n + 1), fail);
  };

  const menuFor = (r: TimelineRow): MenuEntry[] => [
    { kind: "item", id: "timeline-compare-current", label: tr("files.timeline.compareCurrent"), onSelect: () => void compareCurrent(r) },
    { kind: "item", id: "timeline-compare-previous", label: tr("files.timeline.comparePrevious"), disabled: !previousOf(all, r), onSelect: () => void comparePrevious(r) },
    ...(r.source === "history"
      ? ([
          { kind: "sep" },
          { kind: "item", id: "timeline-restore", label: tr("files.timeline.restore"), onSelect: () => restore(r) },
          { kind: "item", id: "timeline-rename", label: tr("files.timeline.rename"), onSelect: () => (setName(r.entry.label ?? ""), setDialog({ kind: "rename", row: r })) },
          { kind: "item", id: "timeline-delete", label: tr("files.timeline.delete"), destructive: true, onSelect: () => setDialog({ kind: "delete", row: r }) },
        ] satisfies MenuEntry[])
      : []),
  ];
  const filterEntries: MenuEntry[] = [
    { kind: "check", id: "timeline-filter-history", label: tr("files.timeline.history"), checked: filter.history, onChange: (on) => setFilterBy({ ...filter, history: on }) },
    { kind: "check", id: "timeline-filter-git", label: tr("files.timeline.git"), checked: filter.git, onChange: (on) => setFilterBy({ ...filter, git: on }) },
  ];

  const BTN = "grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11 pointer-coarse:size-11 [&_svg]:size-4";
  const dialogOpen = dialog && dialog.kind !== "delete";
  return (
    <section className="flex shrink-0 flex-col border-t font-sans text-xs" aria-label={tr("files.timeline.title")} data-testid="timeline">
      <div className="flex items-center gap-1 px-2 py-1">
        <Button size="xs" variant="ghost" onClick={toggle} className="max-md:h-11 pointer-coarse:h-11" aria-expanded={open} aria-controls="timeline-list" data-testid="toggle-timeline">
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />} {tr("files.timeline.title")}
        </Button>
        {open && (
          <>
            <Menu.Root>
              <Menu.Trigger aria-label={tr("files.timeline.filter")} title={tr("files.timeline.filter")} className={cn(BTN, "ml-auto")} data-testid="timeline-filter">
                <ListFilterIcon aria-hidden />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner align="end" sideOffset={4} className="z-50">
                  <Menu.Popup className={cn(POPUP, "max-w-[calc(100vw-2rem)]")}>
                    <MenuEntries kind="menu" entries={filterEntries} />
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
            <button type="button" className={BTN} disabled={!path} onClick={() => (setName(""), setDialog({ kind: "create" }))} aria-label={tr("files.timeline.create")} title={tr("files.timeline.create")} data-testid="timeline-create">
              <PlusIcon aria-hidden />
            </button>
          </>
        )}
      </div>
      {open && (
        <div id="timeline-list" className="max-h-64 min-h-0 overflow-auto pb-1">
          {notice && (
            <p role="status" className="px-2 pb-1 text-destructive" data-testid="timeline-notice">
              {notice}
            </p>
          )}
          {data?.error && <p className="px-2 pb-1 text-destructive">{data.error}</p>}
          {!path ? (
            <p className="px-2 py-1 text-muted-foreground">{tr("files.timeline.noFile")}</p>
          ) : !data || data.path !== path ? (
            <p className="px-2 py-1 text-muted-foreground">{tr("files.timeline.loading")}</p>
          ) : rows.length === 0 ? (
            <p className="px-2 py-1 text-muted-foreground" data-testid="timeline-empty">
              {tr("files.timeline.empty")}
            </p>
          ) : (
            <ul className="flex flex-col">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center gap-1 pr-1 pl-2" data-testid="timeline-row" data-source={r.source} data-reason={r.source === "history" ? r.entry.reason : undefined}>
                  <button
                    type="button"
                    onClick={() => void compareCurrent(r)}
                    title={`${titleOf(r)} · ${timeText(r)}`}
                    className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
                  >
                    {r.source === "history" ? <HistoryIcon className="size-4 shrink-0 text-faint" aria-label={tr("files.timeline.history")} /> : <GitCommitHorizontalIcon className="size-4 shrink-0 text-faint" aria-label={tr("files.timeline.git")} />}
                    <span className="min-w-0 flex-1 truncate" data-testid="timeline-title">
                      {titleOf(r)}
                    </span>
                    <span className="shrink-0 text-faint">{timeAgo(r.time)}</span>
                  </button>
                  <Menu.Root>
                    <Menu.Trigger aria-label={tr("files.timeline.actionsFor", { title: titleOf(r) })} title={tr("files.timeline.actionsFor", { title: titleOf(r) })} className={BTN} data-testid="timeline-row-menu">
                      <EllipsisIcon aria-hidden />
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Positioner align="end" sideOffset={4} className="z-50">
                        <Menu.Popup className={cn(POPUP, "max-w-[calc(100vw-2rem)]")}>
                          <MenuEntries kind="menu" entries={menuFor(r)} />
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.Root>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!dialogOpen}
        title={dialog?.kind === "create" ? tr("files.timeline.createTitle") : tr("files.timeline.renameTitle")}
        description={dialog?.kind === "create" ? tr("files.timeline.createDesc") : tr("files.timeline.renameDesc")}
        confirm={dialog?.kind === "create" ? tr("files.timeline.createConfirm") : tr("files.timeline.rename")}
        confirmDisabled={!name.trim()}
        onConfirm={submit}
        onCancel={() => setDialog(undefined)}
        testId="timeline-name"
      >
        <input
          autoFocus
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
          aria-label={tr("files.timeline.nameLabel")}
          className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
          data-testid="timeline-name-input"
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        title={tr("files.timeline.deleteTitle")}
        description={tr("files.timeline.deleteDesc")}
        confirm={tr("files.timeline.delete")}
        destructive
        onConfirm={() => dialog?.kind === "delete" && remove(dialog.row)}
        onCancel={() => setDialog(undefined)}
        testId="timeline-delete"
      />
      <ViewerDialog target={compare} client={client} cwd={cwd} onClose={() => setCompare(undefined)} onOpenInEditor={noop} />
    </section>
  );
}
