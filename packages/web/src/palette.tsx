// Command palette (Ctrl+K / Ctrl+Shift+P, Cmd on macOS): app actions with their shortcuts and the sessions, like OpenCode's palette.
import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon, FileIcon, SearchIcon } from "lucide-react";
import { keyLabels } from "./shortcuts.ts";
import { ProjectAvatar } from "./tabs-bar.tsx";

export type PaletteItem = {
  id: string;
  group: string;
  title: string;
  description?: string;
  /** Shortcut spec (shortcuts.ts), shown as keybind chips. */
  keys?: string;
  checked?: boolean;
  /** Listed only for a typed query, e.g. sessions older than the recent ones. */
  searchOnly?: boolean;
  /** Session rows, like OpenCode's: project avatar, open-tab marker, relative time. */
  cwd?: string;
  open?: boolean;
  meta?: string;
  /** File rows: the path, shown as dir + name. */
  path?: string;
} & ({ run: () => void } | { page: { placeholder: string; items: PaletteItem[] } });

/** Rows per group, so a broad query over hundreds of sessions stays a short list (OpenCode asks the server for 50). */
const GROUP_LIMIT = 50;

export const matchItems = (items: PaletteItem[], query: string) => {
  const q = query.trim().toLowerCase();
  const count: Record<string, number> = {};
  return items.filter(
    (i) => (q || !i.searchOnly) && `${i.title} ${i.description ?? ""}`.toLowerCase().includes(q) && (count[i.group] = (count[i.group] ?? 0) + 1) <= GROUP_LIMIT,
  );
};

/** On an option page the current value is the active row, so Enter keeps it. */
const startRow = (items: PaletteItem[]) => Math.max(0, items.findIndex((i) => i.checked));

/** Folders are for @-mentions; the palette opens files (quick open does the same). */
const fileItems = (paths: string[], open: (path: string) => void): PaletteItem[] =>
  paths
    .filter((p) => !p.endsWith("/"))
    .map((p) => ({ id: `file:${p}`, group: "Files", title: p, path: p, run: () => open(p) }));

/**
 * The list is the one the palette opened with: a row does not vanish under the cursor when, e.g., the turn ends (Stop).
 * `start` opens a page directly, e.g. Ctrl+' opens the model page. Choosing an item runs it after the palette closes.
 * `files`: with a shown session a query also searches its files (`fs.search`), like OpenCode's session palette.
 */
export function CommandPalette({
  items: openedWith,
  start,
  files,
  more,
  onClose,
}: {
  items: PaletteItem[];
  start?: string;
  files?: { search: (query: string) => Promise<string[]>; open: (path: string) => void };
  /** Rows fetched once the first query is typed (they are search-only), e.g. the project's MCP servers. */
  more?: () => Promise<PaletteItem[]>;
  onClose: () => void;
}) {
  const [opened] = useState(openedWith);
  const [fetched, setFetched] = useState<PaletteItem[]>([]);
  // Before the sessions, which a broad query fills up.
  const at = opened.findIndex((i) => i.group === "Sessions");
  const items = fetched.length ? (at < 0 ? [...opened, ...fetched] : [...opened.slice(0, at), ...fetched, ...opened.slice(at)]) : opened;
  const initial = items.find((i) => i.id === start);
  const [page, setPage] = useState(initial && "page" in initial ? initial.page : undefined);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(() => (page ? startRow(page.items) : 0));
  const [found, setFound] = useState<{ query: string; paths: string[] }>();
  const input = useRef<HTMLInputElement>(null);
  const q = query.trim();
  const shown = [...matchItems(page?.items ?? items, query), ...(!page && files && q && found?.query === q ? fileItems(found.paths, files.open) : [])];
  const placeholder = page?.placeholder ?? (files ? "Search files, commands, and sessions" : "Search commands and sessions");

  useEffect(() => input.current?.focus(), []);
  const asked = useRef(false);
  useEffect(() => {
    if (!q || !more || asked.current) return;
    asked.current = true;
    // A failed fetch leaves those rows out.
    more().then(setFetched, () => {});
  }, [q]);
  useEffect(() => {
    if (page || !files || !q) return;
    let current = true;
    // A failed search leaves the Files group out; commands and sessions still show.
    files.search(q).then((paths) => current && setFound({ query: q, paths }), () => {});
    return () => void (current = false);
  }, [q, page]);
  const listRef = useRef<HTMLDivElement>(null);
  // On a move only: the palette re-renders with every session event, which must not scroll the list.
  // void: current Chromium returns a Promise, which React would call as the cleanup.
  useEffect(() => void listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }), [active, page]);
  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    if ("page" in item) return setPage(item.page), setQuery(""), setActive(startRow(item.page.items));
    onClose();
    item.run();
  };

  // Window capture, as in quick open: the palette owns these keys wherever focus is, so Esc never interrupts the turn.
  const onKeyDown = (e: globalThis.KeyboardEvent) => {
    const n = shown.length;
    const keys: Record<string, () => void> = {
      ArrowDown: () => n && setActive((i) => (i + 1) % n),
      ArrowUp: () => n && setActive((i) => (i - 1 + n) % n),
      Enter: () => choose(shown[active]),
      Escape: onClose,
      Tab: () => {},
      // Back from a page to the commands.
      ...(page && !query && !initial && { Backspace: () => (setPage(undefined), setActive(0)) }),
    };
    if (!keys[e.key]) return e.target !== input.current && input.current?.focus();
    e.preventDefault();
    e.stopPropagation();
    keys[e.key]!();
  };
  const latest = useRef(onKeyDown);
  latest.current = onKeyDown;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => latest.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const groups = [...new Set(shown.map((i) => i.group))];
  return (
    <div className="fixed inset-0 z-50 flex justify-center px-3 pt-[max(48px,calc((100dvh-480px)/2))]">
      <div className="absolute inset-0 bg-overlay" onClick={onClose} aria-hidden data-testid="palette-backdrop" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative flex max-h-[min(100dvh-96px,480px)] min-h-70 w-full max-w-160 flex-col self-start rounded-2xl bg-popover text-popover-foreground shadow-floating"
        data-testid="palette"
        onMouseDown={(e) => e.target !== input.current && e.preventDefault()}
      >
        <div className="p-1.5">
          <label className="flex h-9 items-center gap-2 rounded-md bg-secondary/60 pl-3 pr-2 focus-within:bg-secondary hover:bg-secondary">
            <SearchIcon className="size-4 shrink-0 text-faint" aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={shown.length ? `palette-${active}` : undefined}
              aria-label={placeholder}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground max-md:text-base"
              value={query}
              onChange={(e) => (setQuery(e.target.value), setActive(0))}
              data-testid="palette-input"
            />
          </label>
        </div>
        {!shown.length ? (
          <p className="grid min-h-30 flex-1 place-items-center text-muted-foreground" role="status">
            No results
          </p>
        ) : (
          <div ref={listRef} id="palette-list" role="listbox" aria-label={page?.placeholder ?? "Commands"} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1.5 pt-1.5 pb-2 leading-4 [scrollbar-width:none]">
            {groups.map((g) => (
              <div key={g} role="group" aria-label={g} className="flex flex-col gap-px">
                <div role="presentation" className="my-1.5 px-3 text-muted-foreground">
                  {g}
                </div>
                {shown.map((item, i) =>
                  item.group !== g ? null : (
                    <div
                      key={item.id}
                      id={`palette-${i}`}
                      role="option"
                      aria-selected={i === active}
                      data-id={item.id}
                      title={item.title}
                      className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md px-3 aria-selected:bg-accent pointer-coarse:h-11"
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={() => choose(item)}
                    >
                      {item.cwd && (
                        <span className="relative shrink-0">
                          {item.open && <span className="-translate-y-1/2 absolute top-1/2 right-[calc(100%+4px)] h-3 w-0.5 rounded-[2px] bg-border" data-testid="open-marker" aria-label="open in a tab" />}
                          <ProjectAvatar cwd={item.cwd} />
                        </span>
                      )}
                      {item.path ? (
                        <>
                          <FileIcon className="size-4 shrink-0 text-faint" aria-hidden />
                          <span className="flex min-w-0 flex-1">
                            <span className="truncate text-muted-foreground">{item.path.slice(0, item.path.lastIndexOf("/") + 1)}</span>
                            <span className="shrink-0 font-medium">{item.path.slice(item.path.lastIndexOf("/") + 1)}</span>
                          </span>
                        </>
                      ) : (
                        // A long title truncates before the description gives up all its room.
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="min-w-0 truncate font-medium" data-testid="palette-title">
                            {item.title}
                          </span>
                          {item.description && <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{item.description}</span>}
                        </span>
                      )}
                      {item.meta && (
                        <span className="shrink-0 text-muted-foreground tabular-nums" data-testid="palette-meta">
                          {item.meta}
                        </span>
                      )}
                      {item.checked && <CheckIcon className="size-4 shrink-0" aria-label="current" />}
                      {item.keys && <Keybind spec={item.keys} />}
                      {"page" in item && <ChevronRightIcon className="size-4 shrink-0 text-faint" aria-hidden />}
                    </div>
                  ),
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** OpenCode KeybindV2 chips: one 14px chip per key (no padding, 2px apart), 11px uppercase. Hidden on touch screens, which have no keyboard. */
function Keybind({ spec }: { spec: string }) {
  return (
    <kbd className="flex shrink-0 gap-0.5 font-sans pointer-coarse:hidden" data-testid="keybind">
      {keyLabels(spec).map((k) => (
        <span key={k} className="grid h-3.5 min-w-3.5 place-items-center rounded-xs bg-kbd font-medium text-[11px] text-muted-foreground uppercase leading-none">
          {k}
        </span>
      ))}
    </kbd>
  );
}
