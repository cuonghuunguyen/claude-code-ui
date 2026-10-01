// Quick open (Ctrl+P / Cmd+P): fuzzy file search over the session's project through `fs.search`, like OpenCode's file dialog.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AtSignIcon, FileIcon, SearchIcon } from "lucide-react";

/** Ctrl+P or Cmd+P, without Shift or Alt. */
export const isQuickOpenKey = (e: globalThis.KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p";

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
export const quickOpenLabel = `Search files (${mod}P)`;

/** Paths are relative to the session cwd, best first. Enter opens the active file; Ctrl/Cmd+Enter or a row's @ button inserts `@path`. */
export function QuickOpen({
  onSearch,
  onOpen,
  onMention,
  onClose,
}: {
  onSearch: (query: string) => Promise<string[]>;
  onOpen: (path: string) => void;
  onMention: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; paths: string[] }>();
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // Folders are for @-mentions; quick open opens files.
  const paths = found?.paths.filter((p) => !p.endsWith("/")) ?? [];

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    let current = true;
    onSearch(query)
      .then((p) => current && (setFound({ query, paths: p }), setActive(0)))
      .catch(() => current && setFound({ query, paths: [] }));
    return () => void (current = false);
  }, [query]);

  const onKeyDown = (e: KeyboardEvent) => {
    const n = paths.length;
    // Only results for the typed query, so Enter never acts on a path the user has typed past.
    const pick = found?.query === query ? paths[active] : undefined;
    const keys: Record<string, () => void> = {
      ArrowDown: () => n && setActive((i) => (i + 1) % n),
      ArrowUp: () => n && setActive((i) => (i - 1 + n) % n),
      Enter: () => pick && (e.ctrlKey || e.metaKey ? onMention(pick) : onOpen(pick)),
      Escape: onClose,
      Tab: () => {}, // the search box is the only focus stop
    };
    if (!keys[e.key]) return;
    e.preventDefault();
    keys[e.key]!();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center px-3 pt-[max(48px,calc((100dvh-480px)/2))]">
      <div className="absolute inset-0 bg-overlay" onClick={onClose} aria-hidden data-testid="quick-open-backdrop" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick open"
        className="relative flex max-h-[min(100dvh-96px,480px)] self-start min-h-70 w-full max-w-160 flex-col rounded-2xl bg-popover text-popover-foreground shadow-floating"
        data-testid="quick-open"
      >
        <div className="p-1.5">
          <label className="flex h-9 items-center gap-2 rounded-md bg-secondary/60 pl-3 pr-2 focus-within:bg-secondary focus-within:ring-2 focus-within:ring-ring/50 hover:bg-secondary">
            <SearchIcon className="size-4 shrink-0 text-faint" aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-expanded="true"
              aria-controls="quick-open-list"
              aria-activedescendant={paths.length ? `quick-open-${active}` : undefined}
              aria-label="Search files"
              placeholder="Search files"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground max-md:text-base"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              data-testid="quick-open-input"
            />
          </label>
        </div>
        {!found || !paths.length ? (
          <p className="grid min-h-30 flex-1 place-items-center text-muted-foreground" role="status">
            {found ? "No files found" : "Searching…"}
          </p>
        ) : (
          <ul id="quick-open-list" role="listbox" aria-labelledby="quick-open-group" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pt-1.5 pb-2">
            <li id="quick-open-group" role="presentation" className="my-1.5 shrink-0 px-3 text-muted-foreground">
              Files
            </li>
            {paths.map((p, i) => {
              const slash = p.lastIndexOf("/");
              return (
                <li
                  key={p}
                  id={`quick-open-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-label={p}
                  data-path={p}
                  title={p}
                  ref={(el) => void (i === active && el?.scrollIntoView?.({ block: "nearest" }))}
                  className="group flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md pl-3 pr-1 aria-selected:bg-accent pointer-coarse:h-11"
                  // Mouse movement, not a row scrolling under a still pointer, picks the active row.
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => onOpen(p)}
                >
                  <FileIcon className="size-4 shrink-0 text-faint" aria-hidden />
                  <span className="flex min-w-0 flex-1">
                    <span className="truncate text-muted-foreground">{p.slice(0, slash + 1)}</span>
                    <span className="shrink-0 font-medium">{p.slice(slash + 1)}</span>
                  </span>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Insert @${p} in the prompt`}
                    title={`Insert @${p} in the prompt (${mod}Enter)`}
                    className="grid size-7 shrink-0 place-items-center rounded-sm text-faint opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 group-aria-selected:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
                    onClick={(e) => (e.stopPropagation(), onMention(p))}
                    data-testid="quick-open-mention"
                  >
                    <AtSignIcon className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="flex gap-3 border-t px-3 py-1.5 text-muted-foreground text-xs pointer-coarse:hidden" aria-hidden>
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>{mod}↵ insert @path</span>
          <span>Esc close</span>
        </p>
      </div>
    </div>
  );
}
