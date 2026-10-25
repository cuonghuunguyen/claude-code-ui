// Repository selector of the Changes toolbar (docs/spec.md "Repository selector"): a button with the selected repository, opening a tree of
// every repository of the project (own > submodules > nested). A popover on wide screens, a full-width bottom sheet below md.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { ArchiveIcon, BookMarkedIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { repoTree, type GitRepo, type GitReposResult } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/lib/use-narrow.ts";
import { baseName } from "./paths.ts";
import { repoMove, repoRows, repoTypeAhead, truncationNotes, type RepoRow } from "./repo-selector-model.ts";

/** Above this many entries the tree has a filter. */
const FILTER_ABOVE = 10;
const TYPE_AHEAD_MS = 500;

/** The VS Code Repositories view's icons: an archive for a submodule, a repo glyph otherwise. */
export function RepoIcon({ kind, className }: { kind: GitRepo["kind"]; className?: string }) {
  const Icon = kind === "submodule" ? ArchiveIcon : BookMarkedIcon;
  return <Icon className={cn("size-4 shrink-0", className)} data-icon={kind === "submodule" ? "archive" : "repo"} aria-hidden />;
}

const rowClass = "flex h-7 w-full cursor-pointer items-center gap-1.5 pr-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:h-11 pointer-coarse:h-11";

function RepoTree({ list, truncated, selected, onSelect, limit, close }: { list: GitRepo[]; truncated?: GitReposResult["truncated"]; selected?: GitRepo; onSelect: (rel: string) => void; limit: number; close: () => void }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | undefined>(selected?.path);
  const tree = useMemo(() => repoTree(list), [list]);
  const rows = useMemo(() => repoRows(tree, collapsed, query), [tree, collapsed, query]);
  const filtered = list.length > FILTER_ABOVE;
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const buffer = useRef({ text: "", at: 0 });
  // Roving tabindex: the focused row, else the selected one, else the first.
  const index = Math.max(0, rows.findIndex((r) => r.repo.path === (focus ?? selected?.path)));
  const rowEl = (path: string) => [...(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])].find((e) => e.dataset.path === path);
  const goTo = (path: string) => {
    setFocus(path);
    rowEl(path)?.focus();
  };
  useEffect(() => {
    // Opened: the filter when shown, else the selected row.
    (filterRef.current ?? rowEl(rows[index]?.repo.path ?? ""))?.focus();
  }, []);
  const choose = (r: RepoRow) => {
    if (r.repo.outsideRoots) return;
    onSelect(r.repo.rel);
    close();
  };
  const toggle = (path: string, open: boolean) => setCollapsed((c) => (open ? new Set([...c].filter((p) => p !== path)) : new Set(c).add(path)));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const row = rows[index];
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (row) choose(row);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      const m = repoMove(rows, index, e.key);
      if (m.expand) toggle(m.expand, true);
      else if (m.collapse) toggle(m.collapse, false);
      else if (m.index !== undefined && rows[m.index]) goTo(rows[m.index]!.repo.path);
      return;
    }
    if (e.key.length === 1) {
      const now = Date.now();
      const b = buffer.current;
      b.text = now - b.at > TYPE_AHEAD_MS ? e.key : b.text + e.key;
      b.at = now;
      const j = repoTypeAhead(rows, index, b.text);
      if (j >= 0) goTo(rows[j]!.repo.path);
    }
  };
  const notes = truncationNotes(truncated, list, limit);
  return (
    <div className="flex min-h-0 flex-col" data-testid="repo-selector-content">
      {filtered && (
        <label className="relative flex items-center px-2 pt-2 pb-1">
          <SearchIcon className="pointer-events-none absolute left-4 size-4 text-faint" aria-hidden />
          <input
            ref={filterRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && rows[0]) (e.preventDefault(), goTo(rows[Math.min(index, rows.length - 1)]!.repo.path));
              else e.stopPropagation();
            }}
            placeholder="Filter repositories"
            aria-label="Filter repositories"
            className="h-8 w-full rounded-md bg-secondary/60 pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
            data-testid="repo-filter"
          />
        </label>
      )}
      <div ref={treeRef} role="tree" aria-label="Repositories" className="min-h-0 overflow-auto py-1" onKeyDown={onKeyDown} data-testid="repo-tree">
        {rows.length === 0 && <p className="px-3 py-2 text-muted-foreground text-sm">No repositories match.</p>}
        {rows.map((r, i) => {
          const disabled = !!r.repo.outsideRoots;
          const isSelected = r.repo.path === selected?.path;
          return (
            <div
              key={r.repo.path}
              role="treeitem"
              data-path={r.repo.path}
              data-rel={r.repo.rel}
              aria-level={r.depth + 1}
              aria-posinset={r.posinset}
              aria-setsize={r.setsize}
              aria-selected={isSelected}
              aria-disabled={disabled || undefined}
              aria-expanded={r.hasChildren ? r.expanded : undefined}
              tabIndex={i === index ? 0 : -1}
              className={cn(rowClass, isSelected && "bg-secondary", disabled && "cursor-not-allowed text-muted-foreground")}
              style={{ paddingLeft: `${r.depth * 12 + 8}px` }}
              onClick={() => (setFocus(r.repo.path), choose(r))}
              onFocus={() => setFocus(r.repo.path)}
              data-testid="repo-row"
            >
              {r.hasChildren ? (
                <span
                  className="grid size-4 shrink-0 place-items-center text-faint"
                  data-testid="repo-chevron"
                  onClick={(e) => (e.stopPropagation(), toggle(r.repo.path, !r.expanded))}
                  aria-hidden
                >
                  {r.expanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
                </span>
              ) : (
                <span className="size-4 shrink-0" aria-hidden />
              )}
              <RepoIcon kind={r.repo.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{r.label}</span>
                {disabled && <span className="block text-muted-foreground text-xs">outside the allowed folders</span>}
              </span>
              {r.repo.branch && <span className="max-w-24 shrink truncate font-mono text-muted-foreground text-xs">{r.repo.branch}</span>}
              {isSelected && <CheckIcon className="size-4 shrink-0" aria-hidden />}
            </div>
          );
        })}
      </div>
      {notes.length > 0 && (
        <div className="border-t px-3 py-2 text-muted-foreground text-xs" data-testid="repo-truncated">
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/** `selected`: the resolved repository (undefined while none is usable). `submoduleLimit`: the daemon's per-repository submodule limit, for the truncation note. */
export function RepoSelector({ list, truncated, selected, onSelect, submoduleLimit = 10 }: { list: GitRepo[]; truncated?: GitReposResult["truncated"]; selected?: GitRepo; onSelect: (rel: string) => void; submoduleLimit?: number }) {
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const name = selected ? baseName(selected.path) : "No repository";
  const trigger = cn(
    "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-transparent px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent",
    narrow ? "h-11 w-full" : "h-7 max-w-56 shrink-0",
  );
  const inner = (
    <>
      <RepoIcon kind={selected?.kind ?? "main"} className="text-muted-foreground" />
      <span className="truncate">{name}</span>
      {selected?.branch && <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">{selected.branch}</span>}
      <ChevronDownIcon className="ml-auto size-4 shrink-0 text-faint" aria-hidden />
    </>
  );
  const label = `Repository: ${name}${selected?.branch ? `, branch ${selected.branch}` : ""}`;
  const content = <RepoTree list={list} truncated={truncated} selected={selected} onSelect={onSelect} limit={submoduleLimit} close={() => setOpen(false)} />;
  if (narrow)
    return (
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger className={trigger} aria-label={label} aria-haspopup="tree" data-testid="repo-selector">
          {inner}
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
          <Dialog.Popup
            aria-modal="true"
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col rounded-t-xl bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground shadow-floating outline-none"
            data-testid="repo-sheet"
          >
            <Dialog.Title className="px-4 py-3 font-medium text-[15px]">Repositories</Dialog.Title>
            {open && content}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={trigger} aria-label={label} aria-haspopup="tree" data-testid="repo-selector">
        {inner}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Popover.Popup
            initialFocus={false}
            className="flex max-h-[min(60vh,420px)] w-80 max-w-[calc(100vw-32px)] origin-(--transform-origin) flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground text-sm shadow-floating outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
            data-testid="repo-popup"
          >
            {open && content}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
