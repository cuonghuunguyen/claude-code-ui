// "Open project" dialog (OpenCode dialog-select-directory): browse folders inside the allowlisted roots with type-ahead.
// Click a folder to list its subfolders, Enter or "Open" picks it; the daemon remembers it as a project.
// WSL distros and Docker containers: a kind row (machine, WSL, Docker) with a distro or container dropdown above the browser picks
// whose folders it lists (VS Code's "Connect to WSL", then the folder); Docker lists the containers first.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { BoxIcon, FolderIcon, LoaderCircleIcon, SearchIcon, XIcon } from "lucide-react";
import { LOCAL_SIDE, type FsEntry, type RecentProject, type SideInfo } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { trapTab } from "./focus-trap.ts";
import { browse, matchFolders } from "./folders.ts";
import { sepOf, withSep } from "./paths.ts";
import { isImeKey } from "./ime.ts";
import { timeAgo } from "./sessions.ts";
import { projectName } from "./tabs.ts";
import { defaultTarget, fromMnt, fromWslUnc, kindsOf, loadSide, loadSideFor, localIsWindows, saveSide, saveSideFor, SideBadge, sideKind, sideName, type SideKind } from "./sides.tsx";

/**
 * `list()`: the roots; `list(path)`: the entries of a directory inside them; `side`: of that side. `onPick` rejects when the
 * daemon refuses. `sides`: every side (more than one shows the chooser); `onStartSide` sets one up, rejecting with the next step.
 */
export function OpenProjectDialog({
  open,
  onOpenChange,
  list,
  onPick,
  recent,
  finalFocus,
  sides,
  onStartSide,
  sideOf = () => LOCAL_SIDE,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  list: (path?: string, side?: string) => Promise<FsEntry[]>;
  onPick: (cwd: string, side?: string) => Promise<unknown>;
  sides?: SideInfo[];
  onStartSide?: (side: string) => Promise<unknown>;
  /** Side of a recent project. */
  sideOf?: (cwd: string) => string;
  /** Projects that are not added but have sessions, newest first: offered above the folders (OpenCode's "Recent projects"). */
  recent?: RecentProject[];
  /** Gets the focus when the dialog closes after a pick, when it exists; a cancel gives it back to the opener. */
  finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  const input = useRef<HTMLInputElement>(null);
  // Set when a pick starts: the parent closes the dialog before onPick resolves.
  const picked = useRef(false);
  useEffect(() => void (open && (picked.current = false)), [open]);
  const pick = async (cwd: string, side?: string) => {
    picked.current = true;
    try {
      await (side ? onPick(cwd, side) : onPick(cwd));
    } catch (e) {
      picked.current = false;
      throw e;
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Popup
          initialFocus={input}
          finalFocus={() => (picked.current && finalFocus?.current) || true}
          onKeyDown={trapTab}
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
          {sides && sides.length > 1 ? (
            <SidePicker input={input} list={list} onPick={pick} recent={recent} sides={sides} onStartSide={onStartSide} sideOf={sideOf} />
          ) : (
            <Browser input={input} list={list} onPick={pick} recent={recent} />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The side chooser (kind row, distro or container dropdown) and the browser of the chosen side (default: the last used). A side
 * that is not running starts when chosen: "Setting up" until it is ready, or what to do and Retry. Docker asks for the container
 * first and sets up nothing until one is picked. A typed path of another side switches to it.
 */
function SidePicker({
  input,
  list,
  onPick,
  recent = [],
  sides,
  onStartSide,
  sideOf,
}: {
  input: React.RefObject<HTMLInputElement | null>;
  list: (path?: string, side?: string) => Promise<FsEntry[]>;
  onPick: (cwd: string, side?: string) => Promise<unknown>;
  recent?: RecentProject[];
  sides: SideInfo[];
  onStartSide?: (side: string) => Promise<unknown>;
  sideOf: (cwd: string) => string;
}) {
  // The chosen kind and, for WSL and Docker, its side; Docker without one shows the container list.
  const [chosen, setChosen] = useState<{ kind: SideKind; target?: string }>(() => {
    const last = loadSide();
    return last && sides.some((x) => x.id === last) ? { kind: sideKind(last), target: last } : { kind: "local" };
  });
  // Browser start value after a switch by a typed path; `n` remounts it.
  const [start, setStart] = useState<{ value?: string; n: number }>({ n: 0 });
  // Started here: ready before the next session list says so.
  const [started, setStarted] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<{ side: string; error?: string }>();
  const kinds = kindsOf(sides);
  // A kind or container that left the list falls back: the machine itself, or the container list.
  const info = chosen.kind === "local" ? sides.find((s) => s.id === LOCAL_SIDE) : sides.find((s) => s.id === chosen.target && sideKind(s.id) === chosen.kind);
  const kind: SideKind = kinds.includes(chosen.kind) && (info || chosen.kind === "docker") ? chosen.kind : "local";
  const current = kind === chosen.kind ? info : sides.find((s) => s.id === LOCAL_SIDE);
  const side = current?.id;
  const isReady = (s: SideInfo) => s.id === LOCAL_SIDE || started.has(s.id) || s.state === "ready";
  const ready = !!current && isReady(current);
  const choose = async (id: string, value?: string) => {
    const k = sideKind(id);
    setChosen({ kind: k, target: id });
    saveSide(id);
    if (k !== "local") saveSideFor(k, id);
    setStart((s) => ({ value, n: s.n + 1 }));
    const to = sides.find((s) => s.id === id);
    if (id === LOCAL_SIDE || started.has(id) || to?.state === "ready" || !onStartSide) return setStatus(undefined);
    setStatus({ side: id });
    try {
      await onStartSide(id);
      setStarted((s) => new Set(s).add(id));
      setStatus((s) => (s?.side === id ? undefined : s));
    } catch (e) {
      setStatus((s) => (s?.side === id ? { side: id, error: (e as Error).message } : s));
    }
  };
  const chooseKind = (k: SideKind) => {
    if (k === kind) return;
    if (k === "local") return void choose(LOCAL_SIDE);
    const to = defaultTarget(k, sides, loadSideFor(k));
    if (to) return void choose(to.id);
    // Docker: the user picks the container, nothing starts.
    setChosen({ kind: k });
    setStatus(undefined);
  };
  // The side used before per-kind memory existed becomes its kind's remembered one (leaving it for another kind keeps it).
  useEffect(() => void (current && kind !== "local" && saveSideFor(kind, current.id)), []);
  // The last used side, not running: start it (a failed one waits for Retry).
  useEffect(() => void (current && !ready && current.state !== "error" && choose(current.id)), []);
  const shown = !current ? undefined : status?.side === side ? status : !ready && current.state === "error" ? { side: current.id, error: current.message ?? `${current.label} is not running.` } : undefined;
  const winLocal = localIsWindows(sides);
  /** A path of another side: switch to it with the path typed (Windows hub only: there is no Docker path syntax). */
  const onTyped = (v: string) => {
    const unc = fromWslUnc(v);
    if (unc && sides.some((s) => s.id === unc.side)) return void choose(unc.side, unc.path), true;
    if (winLocal && /^[a-z]:/i.test(v) && kind !== "local") return void choose(LOCAL_SIDE, v), true;
    if (winLocal && v.startsWith("/") && kind === "local") {
      // A WSL distro first (remembered, else ready, else first), else a container the user chose before or one already running.
      const to = defaultTarget("wsl", sides, loadSideFor("wsl")) ?? sides.find((s) => s.id === loadSideFor("docker") && sideKind(s.id) === "docker") ?? sides.find((s) => sideKind(s.id) === "docker" && s.state === "ready");
      if (to) return void choose(to.id, v), true;
    }
    return false;
  };
  const hint = (typed: string) => {
    const win = kind === "wsl" ? fromMnt(typed) : undefined;
    if (!win) return null;
    return (
      <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-md bg-secondary/60 px-3 py-2 text-sm" data-testid="mnt-hint">
        <span className="min-w-0 flex-1">This is a Windows folder. Its sessions belong to Windows, where the Windows CLI and VS Code see them.</span>
        <Button size="sm" variant="outline" className="max-md:h-11" onClick={() => choose(LOCAL_SIDE, win)} data-testid="open-as-windows">
          Open {win} on Windows
        </Button>
      </div>
    );
  };
  const members = sides.filter((s) => sideKind(s.id) === kind);
  const stateWord = (s: SideInfo) => (isReady(s) ? undefined : status?.side === s.id ? (status.error ? "Error" : "Setting up…") : s.state === "error" ? "Error" : s.state === "starting" ? "Setting up…" : "Not set up");
  const kindLabel = (k: SideKind) => (k === "local" ? (sides.find((s) => s.id === LOCAL_SIDE)?.label ?? "This machine") : k === "wsl" ? "WSL" : "Docker");
  return (
    <>
      <div className="flex items-center gap-1 px-3 pb-2 max-md:flex-wrap">
        <KindRow kinds={kinds} kind={kind} label={kindLabel} onChoose={chooseKind} />
        {kind !== "local" && (
          <Select value={side ?? null} onValueChange={(id) => id && choose(id)}>
            <SelectTrigger aria-label={kind === "wsl" ? "WSL distro" : "Docker container"} size="sm" className="min-w-0 max-w-full max-md:h-11! max-md:flex-1" data-testid="side-target">
              <span className={cn("truncate", !current && "text-muted-foreground")}>{current ? sideName(current) : "Choose container"}</span>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} side="bottom" align="start" className="w-auto min-w-56 max-w-[calc(100vw-2rem)] rounded-md p-0.5">
              {members.map((s) => (
                <SelectItem key={s.id} value={s.id} className="h-8 max-md:h-11" data-testid="side-target-item">
                  <span className="min-w-0 flex-1 truncate">{sideName(s)}</span>
                  {stateWord(s) && <span className="text-muted-foreground text-xs leading-none">{stateWord(s)}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {!current ? (
        <ContainerStep input={input} containers={members} stateWord={stateWord} isReady={isReady} onPick={(id) => void choose(id)} />
      ) : shown ? (
        <div className="flex min-h-30 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center text-sm" role={shown.error ? "alert" : "status"} data-testid="side-status">
          {shown.error ? (
            <>
              <p className="max-w-md text-destructive">{shown.error}</p>
              <Button size="sm" onClick={() => choose(current.id)} className="max-md:h-11" data-testid="side-retry">
                Retry
              </Button>
            </>
          ) : (
            <p className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Setting up {current.label}…
            </p>
          )}
        </div>
      ) : (
        <Browser
          key={`${side}:${start.n}`}
          input={input}
          list={(path) => list(path, side)}
          onPick={(cwd) => onPick(cwd, side)}
          onPickRecent={(cwd) => onPick(cwd, sideOf(cwd))}
          recent={recent}
          initial={start.value}
          onTyped={onTyped}
          hint={hint}
        />
      )}
    </>
  );
}

/** One chip per kind (the machine, WSL, Docker). Arrows move the focus between them, Enter or Space picks: moving never sets a side up. */
function KindRow({ kinds, kind, label, onChoose }: { kinds: SideKind[]; kind: SideKind; label: (k: SideKind) => string; onChoose: (k: SideKind) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? kinds.length - 1 : undefined;
    if (to === undefined) return;
    e.preventDefault();
    refs.current[(to + kinds.length) % kinds.length]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Side" className="flex shrink-0 gap-1" data-testid="side-chooser">
      {kinds.map((k, i) => (
        <button
          key={k}
          ref={(el) => void (refs.current[i] = el)}
          role="radio"
          aria-checked={k === kind}
          tabIndex={k === kind ? 0 : -1}
          onClick={() => onChoose(k)}
          onKeyDown={(e) => onKeyDown(e, i)}
          className={cn(
            "h-7 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11",
            k === kind ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
          )}
          data-testid="side-kind"
        >
          {label(k)}
        </button>
      ))}
    </div>
  );
}

/** The Docker container list: filter by name, pick one (Enter on the highlighted row). Nothing is set up until then. */
function ContainerStep({
  input,
  containers,
  stateWord,
  isReady,
  onPick,
}: {
  input: React.RefObject<HTMLInputElement | null>;
  containers: SideInfo[];
  stateWord: (s: SideInfo) => string | undefined;
  isReady: (s: SideInfo) => boolean;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  // The first match is highlighted: with a single container Enter confirms it, it never starts on its own.
  const [at, setAt] = useState(0);
  useEffect(() => input.current?.focus(), []);
  const q = query.trim().toLowerCase();
  const rows = [...containers.filter((c) => isReady(c)), ...containers.filter((c) => !isReady(c))].filter((c) => sideName(c).toLowerCase().includes(q));
  const selected = Math.min(at, rows.length - 1);
  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e.nativeEvent)) return;
    const keys: Record<string, (() => unknown) | undefined> = {
      ArrowDown: rows.length ? () => setAt((selected + 1) % rows.length) : undefined,
      ArrowUp: rows.length ? () => setAt(selected <= 0 ? rows.length - 1 : selected - 1) : undefined,
      Enter: rows[selected] ? () => onPick(rows[selected]!.id) : undefined,
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
            aria-controls="container-list"
            aria-activedescendant={rows[selected] ? `container-${selected}` : undefined}
            aria-label="Filter containers; Enter to pick the highlighted one"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => (setQuery(e.target.value), setAt(0))}
            onKeyDown={onKeyDown}
            placeholder="Filter containers"
            className="h-9 w-full rounded-md bg-secondary/60 pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 max-md:text-base"
            data-testid="container-filter"
          />
        </label>
      </div>
      <div className="flex min-h-30 flex-1 flex-col overflow-y-auto px-1.5 pt-1.5 pb-2">
        <ul id="container-list" role="listbox" aria-label="Running containers" className="flex flex-col gap-px" data-testid="container-list">
          {rows.map((c, i) => (
            <li
              key={c.id}
              id={`container-${i}`}
              role="option"
              aria-selected={i === selected}
              ref={(el) => void (i === selected && el?.scrollIntoView?.({ block: "nearest" }))}
              onMouseDown={(ev) => ev.preventDefault()}
              onMouseMove={() => setAt(i)}
              onClick={() => onPick(c.id)}
              className={cn("flex h-9 cursor-pointer items-center gap-2 rounded-md px-3 text-sm max-md:h-11", i === selected && "bg-secondary")}
              data-testid="container-row"
            >
              <BoxIcon className="size-4 shrink-0 text-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{sideName(c)}</span>
              {stateWord(c) && <span className="shrink-0 text-muted-foreground text-xs">{stateWord(c)}</span>}
            </li>
          ))}
        </ul>
        {!rows.length && <p className="m-auto py-6 text-muted-foreground text-sm">No running container matches</p>}
      </div>
    </>
  );
}

/** Recent projects shown while nothing is typed; a typed name shows every match. */
const RECENT_SHOWN = 5;
const ago = (ms: number) => ((t) => (t === "now" ? "Just now" : `${t} ago`))(timeAgo(ms));

/** `initial`: start value instead of the only root. `onTyped`: true when it took the typed value (another side's path). */
function Browser({
  input,
  list,
  onPick,
  onPickRecent = onPick,
  recent = [],
  initial,
  onTyped,
  hint,
}: {
  input: React.RefObject<HTMLInputElement | null>;
  list: (path?: string) => Promise<FsEntry[]>;
  onPick: (cwd: string) => Promise<unknown>;
  onPickRecent?: (cwd: string) => Promise<unknown>;
  recent?: RecentProject[];
  initial?: string;
  onTyped?: (value: string) => boolean;
  /** Shown above the footer for the typed value. */
  hint?: (value: string) => ReactNode;
}) {
  const [roots, setRoots] = useState<FsEntry[]>();
  const [value, setValue] = useState(initial ?? "");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  // Undefined: follows the typing: nothing highlighted (Enter opens the listed folder itself), or the best matching folder.
  const [picked, setPicked] = useState<number>();
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
  // Recent projects belong to the start level: inside the only root, or the list of roots.
  const atStart = rootPaths.length === 1 ? dir === rootPaths[0]!.replace(/(.)\/$/, "$1") : !dir;

  useEffect(() => {
    list().then(
      (r) => {
        setRoots(r);
        // One root: start inside it, so no absolute path needs typing.
        if (initial) (toEnd.current = true), input.current?.focus();
        else if (r.length === 1) (toEnd.current = true), setValue(withSep(r[0]!.path));
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

  // Only at the start level; the typed text filters them by name. They never take Tab or Enter from the typed folder (below).
  const q = prefix.toLowerCase();
  const recents = atStart ? recent.filter((r) => projectName(r.cwd).toLowerCase().includes(q)).slice(0, prefix ? undefined : RECENT_SHOWN) : [];
  // Idle: a recent project is not listed again as a folder. Typed: the folder row stays, it is what Tab and Enter act on.
  const folders = matchFolders(entries, prefix).filter((e) => prefix || !recents.some((r) => r.cwd === e.path));
  // One keyboard list: recent projects first, then folders.
  const rows: { path: string; recent?: RecentProject; entry?: FsEntry }[] = [...recents.map((r) => ({ path: r.cwd, recent: r })), ...folders.map((e) => ({ path: e.path, entry: e }))];
  // Typing a filter highlights the best matching folder, never a recent project.
  const selected = picked ?? (prefix ? rows.findIndex((r) => r.entry) : -1);
  const edit = (v: string) => {
    if (onTyped?.(v)) return;
    setValue(v);
    setPicked(undefined);
    setError(undefined);
  };
  const descend = (e: Pick<FsEntry, "path">) => {
    toEnd.current = true;
    edit(withSep(e.path));
    input.current?.focus();
  };
  const pick = async (cwd: string, recent = false) => {
    setBusy(true);
    setError(undefined);
    try {
      await (recent ? onPickRecent : onPick)(cwd);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e.nativeEvent)) return;
    const row = rows[selected];
    // Nothing selected: the first folder, never a recent project.
    const tabTo = row ?? rows.find((r) => r.entry);
    const keys: Record<string, (() => unknown) | undefined> = {
      ArrowDown: rows.length ? () => setPicked((selected + 1) % rows.length) : undefined,
      ArrowUp: rows.length ? () => setPicked(selected <= 0 ? rows.length - 1 : selected - 1) : undefined,
      Tab: tabTo && !e.shiftKey ? () => descend(tabTo) : undefined,
      Enter: row ? () => pick(row.path, !!row.recent) : dir ? () => pick(dir) : undefined,
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
        <ul id="folder-list" role="listbox" aria-label="Recent projects and folders" className="flex flex-col gap-px" data-testid="folder-list">
          {rows.map((row, i) => {
            const common = {
              id: `folder-${i}`,
              role: "option",
              "aria-selected": i === selected,
              ref: (el: HTMLElement | null) => void (i === selected && el?.scrollIntoView?.({ block: "nearest" })),
              onMouseDown: (ev: React.MouseEvent) => ev.preventDefault(),
              onMouseMove: () => setPicked(i),
            };
            const heading = (text: string, id: string) => (
              <li role="presentation" id={id} className="mt-1.5 mb-1.5 px-3 text-muted-foreground text-sm">
                {text}
              </li>
            );
            return (
              <Fragment key={`${row.recent ? "recent" : "folder"}:${row.path}`}>
                {i === 0 && row.recent && heading("Recent projects", "recent-label")}
                {i === recents.length && row.entry && heading(dir ? `Folders in ${projectName(dir)}` : "Allowlisted roots", "folder-list-label")}
                {row.recent ? (
                  <li
                    {...common}
                    className={cn("flex h-9 cursor-pointer items-center gap-2 rounded-md px-3 text-sm max-md:h-11", i === selected && "bg-secondary")}
                    title={`${row.path}\nClick to add it`}
                    onClick={() => pick(row.path, true)}
                    data-testid="recent-row"
                  >
                    <FolderIcon className="size-4 shrink-0 text-faint" aria-hidden />
                    <span className="min-w-0 truncate font-medium max-md:flex-1">{projectName(row.path)}</span>
                    <SideBadge cwd={row.path} />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground max-md:hidden">{row.path}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {row.recent.sessionCount} {row.recent.sessionCount === 1 ? "session" : "sessions"} · {ago(row.recent.lastActivity)}
                    </span>
                  </li>
                ) : (
                  <li
                    {...common}
                    className={cn("flex h-9 cursor-pointer items-center gap-2 rounded-md px-3 text-sm max-md:h-11", i === selected && "bg-secondary")}
                    title={`${row.path}\nClick to list its subfolders, double click to open`}
                    onClick={() => descend(row.entry!)}
                    onDoubleClick={() => pick(row.path)}
                    data-testid="folder-row"
                  >
                    <FolderIcon className="size-4 shrink-0 text-faint" aria-hidden />
                    <span className="truncate font-medium">
                      {dir ? row.entry!.name : row.path}
                      <span className="font-normal text-faint">{sepOf(row.path)}</span>
                    </span>
                  </li>
                )}
              </Fragment>
            );
          })}
        </ul>
        {roots && !rows.length && <p className="m-auto py-6 text-muted-foreground text-sm">No folder matches "{prefix}"</p>}
      </div>
      {hint?.(value)}
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
