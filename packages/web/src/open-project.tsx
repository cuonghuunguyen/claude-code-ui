// "Open project" dialog (OpenCode dialog-select-directory): browse folders inside the allowlisted roots with type-ahead.
// Click a folder to list its subfolders, Enter or "Open" picks it; the daemon remembers it as a project.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { FolderIcon, SearchIcon, XIcon } from "lucide-react";
import type { FsEntry } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { browse, matchFolders } from "./folders.ts";
import { projectName } from "./tabs.ts";

/** `list()`: the roots; `list(path)`: the entries of a directory inside them. `onPick` rejects when the daemon refuses. */
export function OpenProjectDialog({
  open,
  onOpenChange,
  list,
  onPick,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  list: (path?: string) => Promise<FsEntry[]>;
  onPick: (cwd: string) => Promise<unknown>;
  /** Gets the focus when the dialog closes, when it exists; else the opener does. */
  finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Popup
          initialFocus={input}
          finalFocus={() => finalFocus?.current ?? true}
          className="-translate-x-1/2 fixed top-[max(48px,calc((100dvh-480px)/2))] left-1/2 z-50 flex max-h-[min(100dvh-96px,480px)] w-[min(100vw-24px,640px)] flex-col rounded-xl bg-card text-foreground shadow-floating outline-none"
          data-testid="open-project-dialog"
          // App shortcuts and Esc (stop turn) skip while an aria-modal dialog shows; Base UI does not set it.
          aria-modal="true"
        >
          <div className="flex items-center gap-2 py-2 pr-2 pl-4">
            <Dialog.Title className="flex-1 font-medium text-[15px] tracking-[-0.13px]">Open project</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="grid size-7 place-items-center rounded-md text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11"
            >
              <XIcon className="size-4" />
            </Dialog.Close>
          </div>
          <Browser input={input} list={list} onPick={onPick} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Browser({ input, list, onPick }: { input: React.RefObject<HTMLInputElement | null>; list: (path?: string) => Promise<FsEntry[]>; onPick: (cwd: string) => Promise<unknown> }) {
  const [roots, setRoots] = useState<FsEntry[]>();
  const [value, setValue] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  // -1: no row highlighted, Enter opens the listed folder itself. Typing a filter highlights the best match.
  const [selected, setSelected] = useState(-1);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const rootPaths = roots?.map((r) => r.path) ?? [];
  // A path set by the browser (start, Tab, click) shows its end: the caret moves there and the input scrolls to it.
  const toEnd = useRef(false);
  useLayoutEffect(() => {
    const el = input.current;
    if (!toEnd.current || !el) return;
    toEnd.current = false;
    el.setSelectionRange(value.length, value.length);
    el.scrollLeft = el.scrollWidth;
  }, [value]);
  const { dir, prefix } = browse(value, rootPaths);

  useEffect(() => {
    list().then(
      (r) => {
        setRoots(r);
        // One root: start inside it, so no absolute path needs typing.
        if (r.length === 1) (toEnd.current = true), setValue(`${r[0]!.path.replace(/\/$/, "")}/`);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    if (!dir) return void setEntries(roots ?? []);
    let stale = false;
    list(dir).then(
      (r) => !stale && setEntries(r),
      // A typed path that does not exist lists nothing.
      () => !stale && setEntries([]),
    );
    return () => void (stale = true);
  }, [dir, roots]);

  const rows = matchFolders(entries, prefix);
  const edit = (v: string) => {
    setValue(v);
    setSelected(browse(v, rootPaths).prefix ? 0 : -1);
    setError(undefined);
  };
  const descend = (e: FsEntry) => {
    toEnd.current = true;
    edit(`${e.path.replace(/\/$/, "")}/`);
    input.current?.focus();
  };
  const pick = async (cwd: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await onPick(cwd);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const row = rows[selected];
    const tabTo = rows[Math.max(selected, 0)];
    const keys: Record<string, (() => unknown) | undefined> = {
      ArrowDown: rows.length ? () => setSelected((i) => (i + 1) % rows.length) : undefined,
      ArrowUp: rows.length ? () => setSelected((i) => (i <= 0 ? rows.length - 1 : i - 1)) : undefined,
      Tab: tabTo && !e.shiftKey ? () => descend(tabTo) : undefined,
      Enter: row ? () => pick(row.path) : dir ? () => pick(dir) : undefined,
    };
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  };

  return (
    <>
      <div className="px-1.5">
        <label className="relative flex items-center">
          <SearchIcon className="pointer-events-none absolute left-3 size-4 text-faint" aria-hidden />
          <input
            ref={input}
            role="combobox"
            aria-expanded
            aria-controls="folder-list"
            aria-activedescendant={rows[selected] ? `folder-${selected}` : undefined}
            aria-label="Folder path; type to filter, Tab to open a folder's subfolders, Enter to pick"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a folder name"
            className="h-9 w-full rounded-md bg-secondary/60 pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 max-md:text-base"
            data-testid="folder-input"
          />
        </label>
      </div>
      <div className="flex min-h-30 flex-1 flex-col overflow-y-auto px-1.5 pt-1.5 pb-2">
        <p className="my-1.5 px-3 text-muted-foreground text-sm" id="folder-list-label">
          {dir ? `Folders in ${projectName(dir)}` : "Allowlisted roots"}
        </p>
        <ul id="folder-list" role="listbox" aria-labelledby="folder-list-label" className="flex flex-col gap-px" data-testid="folder-list">
          {rows.map((e, i) => (
            <li
              key={e.path}
              id={`folder-${i}`}
              role="option"
              aria-selected={i === selected}
              ref={(el) => void (i === selected && el?.scrollIntoView?.({ block: "nearest" }))}
              className={cn("flex h-9 cursor-pointer items-center gap-2 rounded-md px-3 text-sm max-md:h-11", i === selected && "bg-secondary")}
              title={`${e.path}\nClick to list its subfolders, double click to open`}
              onMouseDown={(ev) => ev.preventDefault()}
              onMouseMove={() => setSelected(i)}
              onClick={() => descend(e)}
              onDoubleClick={() => pick(e.path)}
              data-testid="folder-row"
            >
              <FolderIcon className="size-4 shrink-0 text-faint" aria-hidden />
              <span className="truncate font-medium">
                {dir ? e.name : e.path}
                <span className="font-normal text-faint">/</span>
              </span>
            </li>
          ))}
        </ul>
        {roots && !rows.length && <p className="m-auto py-6 text-muted-foreground text-sm">No folder matches "{prefix}"</p>}
      </div>
      <div className="flex items-center gap-2 border-t px-4 py-2">
        <p className="min-w-0 flex-1 truncate text-sm" role={error ? "alert" : undefined}>
          {error ? <span className="text-destructive">{error}</span> : <span className="text-muted-foreground">{dir}</span>}
        </p>
        <Button size="sm" disabled={!dir || busy} onClick={() => dir && pick(dir)} data-testid="open-folder" className="max-md:h-11">
          {dir ? `Open ${projectName(dir)}` : "Open"}
        </Button>
      </div>
    </>
  );
}
