// Command palette (Ctrl+K / Ctrl+Shift+P, Cmd on macOS): app actions with their shortcuts and the sessions, like OpenCode's palette.
import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { keyLabels } from "./shortcuts.ts";

export type PaletteItem = {
  id: string;
  group: string;
  title: string;
  description?: string;
  /** Shortcut spec (shortcuts.ts), shown as keybind chips. */
  keys?: string;
  checked?: boolean;
} & ({ run: () => void } | { page: { placeholder: string; items: PaletteItem[] } });

export const matchItems = (items: PaletteItem[], query: string) => {
  const q = query.trim().toLowerCase();
  return items.filter((i) => `${i.title} ${i.description ?? ""}`.toLowerCase().includes(q));
};

/** `start` opens a page directly, e.g. Ctrl+' opens the model page. Choosing an item runs it after the palette closes. */
export function CommandPalette({ items, start, onClose }: { items: PaletteItem[]; start?: string; onClose: () => void }) {
  const initial = items.find((i) => i.id === start);
  const [page, setPage] = useState(initial && "page" in initial ? initial.page : undefined);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = matchItems(page?.items ?? items, query);

  useEffect(() => input.current?.focus(), []);
  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    if ("page" in item) return setPage(item.page), setQuery(""), setActive(0);
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
          <label className="flex h-9 items-center gap-2 rounded-md bg-secondary/60 pl-3 pr-2 focus-within:bg-secondary focus-within:ring-2 focus-within:ring-ring/50 hover:bg-secondary">
            <SearchIcon className="size-4 shrink-0 text-faint" aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={shown.length ? `palette-${active}` : undefined}
              aria-label={page?.placeholder ?? "Search commands and sessions"}
              placeholder={page?.placeholder ?? "Search commands and sessions"}
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
          <div id="palette-list" role="listbox" aria-label={page?.placeholder ?? "Commands"} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1.5 pt-1.5 pb-2">
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
                      ref={(el) => void (i === active && el?.scrollIntoView?.({ block: "nearest" }))}
                      className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md px-3 aria-selected:bg-accent pointer-coarse:h-11"
                      onMouseMove={() => i !== active && setActive(i)}
                      onClick={() => choose(item)}
                    >
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="shrink-0 font-medium">{item.title}</span>
                        {item.description && <span className="truncate text-muted-foreground">{item.description}</span>}
                      </span>
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

/** OpenCode KeybindV2 chips: one 14px chip per key, 11px uppercase. Hidden on touch screens, which have no keyboard. */
function Keybind({ spec }: { spec: string }) {
  return (
    <kbd className="flex shrink-0 gap-0.5 font-sans pointer-coarse:hidden" data-testid="keybind">
      {keyLabels(spec).map((k) => (
        <span key={k} className="grid h-3.5 min-w-3.5 place-items-center rounded-xs bg-muted px-0.5 font-medium text-[11px] text-muted-foreground uppercase leading-none">
          {k}
        </span>
      ))}
    </kbd>
  );
}
