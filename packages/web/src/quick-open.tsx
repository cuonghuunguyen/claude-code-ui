// Quick open (Ctrl+P / Cmd+P): fuzzy file search over the session's project through `fs.search`, like OpenCode's file dialog.
import { useEffect, useRef, useState } from "react";
import { AtSignIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileIcon } from "./file-icon.tsx";
import { isImeKey } from "./ime.ts";

const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
export const quickOpenLabel = `Search files (${mod}P)`;

/** Paths are relative to the session cwd, best first. Enter opens the active file; Ctrl/Cmd+Enter or a row's @ button inserts `@path`.
 * Not `connected`, it says so and searches once the daemon is back; a failed search offers Retry (button or Enter). */
export function QuickOpen({
  connected,
  onSearch,
  onOpen,
  onMention,
  onClose,
}: {
  connected: boolean;
  onSearch: (query: string) => Promise<string[]>;
  onOpen: (path: string) => void;
  onMention: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; paths: string[]; error?: string }>();
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const retry = () => (setFound(undefined), setAttempt((n) => n + 1));
  const input = useRef<HTMLInputElement>(null);
  // Folders are for @-mentions; quick open opens files.
  const paths = found?.paths.filter((p) => !p.endsWith("/")) ?? [];

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (!connected) return setFound({ query, paths: [], error: "Not connected to the daemon. Search resumes when it reconnects." });
    let current = true;
    onSearch(query)
      .then((p) => current && (setFound({ query, paths: p }), setActive(0)))
      .catch((err: Error) => current && setFound({ query, paths: [], error: `Search failed: ${err.message}` }));
    return () => void (current = false);
  }, [query, connected, attempt]);
  const canRetry = connected && !!found?.error;

  // Window capture: the dialog owns these keys wherever focus is (a click on the title or empty space moves it to body),
  // so Esc never reaches SessionPane's interrupt listener while quick open is shown.
  const onKeyDown = (e: globalThis.KeyboardEvent) => {
    if (isImeKey(e)) return;
    const n = paths.length;
    // Only results for the typed query, so Enter never acts on a path the user has typed past.
    const pick = found?.query === query ? paths[active] : undefined;
    const keys: Record<string, () => void> = {
      ArrowDown: () => n && setActive((i) => (i + 1) % n),
      ArrowUp: () => n && setActive((i) => (i - 1 + n) % n),
      Enter: () => (pick ? (e.ctrlKey || e.metaKey ? onMention(pick) : onOpen(pick)) : canRetry && retry()),
      Escape: onClose,
      Tab: () => {}, // the search box is the only focus stop
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

  return (
    <div className="fixed inset-0 z-50 flex justify-center px-3 pt-[max(48px,calc((100dvh-480px)/2))]">
      <div className="absolute inset-0 bg-overlay" onClick={onClose} aria-hidden data-testid="quick-open-backdrop" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick open"
        className="relative flex max-h-[min(100dvh-96px,480px)] self-start min-h-70 w-full max-w-160 flex-col rounded-2xl bg-popover text-popover-foreground shadow-floating"
        data-testid="quick-open"
        // The search box is the only focus stop: a click elsewhere in the dialog leaves focus there.
        onMouseDown={(e) => e.target !== input.current && e.preventDefault()}
      >
        <div className="p-1.5">
          <label className="flex h-9 items-center gap-2 rounded-md bg-secondary/60 pl-3 pr-2 focus-within:bg-secondary hover:bg-secondary">
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
              data-testid="quick-open-input"
            />
          </label>
        </div>
        {!found || !paths.length ? (
          <div className="flex min-h-30 flex-1 flex-col items-center justify-center gap-2 px-3 text-center text-muted-foreground" role="status">
            <p>{found ? (found.error ?? "No files found") : "Searching…"}</p>
            {canRetry && (
              <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={retry}>
                Retry
              </Button>
            )}
          </div>
        ) : (
          <ul id="quick-open-list" role="listbox" aria-labelledby="quick-open-group" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pt-1.5 pb-2">
            <li id="quick-open-group" role="presentation" className="my-1.5 shrink-0 px-3 leading-4 font-normal text-muted-foreground">
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
                  <FileIcon path={p} className="size-4 shrink-0" />
                  <span className="flex min-w-0 flex-1 leading-4 font-normal">
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
      </div>
    </div>
  );
}
