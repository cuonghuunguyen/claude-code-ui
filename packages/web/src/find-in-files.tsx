// Find in files (Ctrl+Shift+F): content search over the session's project through `fs.grep` (git grep), results grouped by
// file with context lines and highlighted hits. Modal like Quick open; Enter or a click opens the match at its line.
import { useEffect, useRef, useState } from "react";
import { EyeIcon, RegexIcon, SearchIcon } from "lucide-react";
import type { FsGrepResult } from "@claude-ui/protocol";
import type { RequestError } from "./client.ts";
import { FileIcon } from "./file-icon.tsx";
import { type FindEntry, lineSegments, loadFindHistory, matchRows, pushFindHistory, saveFindHistory } from "./find-in-files.ts";
import { useT } from "./i18n.ts";
import { isImeKey } from "./ime.ts";

export type FindQuery = { query: string; regex: boolean; globs: string; includeIgnored?: boolean };
const DEBOUNCE_MS = 250;

const toggle = "grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground pointer-coarse:size-11";

/** `initialQuery` (the editor's selection) is searched at once and selected, so typing replaces it. Esc or opening a match saves the search in the history (Up/Down in the boxes). */
export function FindInFiles({
  connected,
  initialQuery,
  onSearch,
  onOpen,
  onClose,
}: {
  connected: boolean;
  initialQuery?: string;
  /** A blank query only cancels the running search. */
  onSearch: (q: FindQuery) => Promise<FsGrepResult>;
  onOpen: (path: string, line: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [regex, setRegex] = useState(false);
  const [globs, setGlobs] = useState("");
  const [choice, setChoice] = useState<boolean>();
  const [found, setFound] = useState<{ key: string; res: FsGrepResult }>();
  const [error, setError] = useState<{ code?: string; message: string }>();
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const first = useRef(!!initialQuery);
  const searched = useRef(false);
  const history = useRef<FindEntry[]>(loadFindHistory());
  const pos = useRef(-1);
  const draft = useRef<FindEntry>({ query: "", globs: "" });
  const key = JSON.stringify([query, regex, globs, choice]);
  const rows = matchRows(found?.res);
  const ignored = choice ?? found?.res.includeIgnored ?? false;
  const settled = found?.key === key;

  useEffect(() => {
    input.current?.focus();
    if (initialQuery) input.current?.select();
  }, []);
  useEffect(() => {
    const send = (q: FindQuery) => (searched.current = true, onSearch(q));
    if (!connected) return setError({ message: t("app.find.notConnected") });
    if (!query.trim()) {
      if (searched.current) void send({ query: "", regex, globs }).catch(() => {});
      searched.current = false;
      setFound(undefined);
      setError(undefined);
      return setBusy(false);
    }
    let current = true;
    setBusy(true);
    const go = () =>
      send({ query, regex, globs, includeIgnored: choice })
        .then((res) => current && (setFound({ key, res }), setActive(0), setError(undefined)))
        .catch((e: RequestError) => current && (setFound(undefined), setError({ code: e.code, message: e.message })))
        .finally(() => current && setBusy(false));
    if (first.current) {
      first.current = false;
      void go();
      return () => void (current = false);
    }
    const timer = setTimeout(go, DEBOUNCE_MS);
    return () => (current = false, clearTimeout(timer));
  }, [key, connected]);
  // The panel closing stops the running search.
  useEffect(() => () => void (searched.current && onSearch({ query: "", regex: false, globs: "" }).catch(() => {})), []);

  const remember = () => {
    history.current = pushFindHistory(history.current, { query, globs });
    saveFindHistory(history.current);
  };
  const open = (r: { path: string; line: number }) => (remember(), onOpen(r.path, r.line));
  const step = (d: number) => rows.length && setActive((i) => (i + d + rows.length) % rows.length);
  const older = (d: 1 | -1) => {
    const h = history.current;
    const next = Math.min(Math.max(pos.current + d, -1), h.length - 1);
    if (next === pos.current) return;
    if (pos.current === -1) draft.current = { query, globs };
    pos.current = next;
    const e = next === -1 ? draft.current : h[h.length - 1 - next]!;
    setQuery(e.query);
    setGlobs(e.globs);
  };

  // Window capture: the dialog owns these keys wherever focus is, so Esc never reaches SessionPane's interrupt listener.
  const onKeyDown = (e: globalThis.KeyboardEvent) => {
    if (isImeKey(e)) return;
    const target = e.target as HTMLElement;
    const inList = !!list.current?.contains(target);
    const pick = settled ? rows[active] : undefined;
    if (e.key === "Tab" && dialog.current) {
      const f = [...dialog.current.querySelectorAll<HTMLElement>("input, button, [tabindex='0']")];
      const wrap = e.shiftKey ? target === f[0] : target === f[f.length - 1];
      if (wrap) (e.preventDefault(), f[e.shiftKey ? f.length - 1 : 0]?.focus());
      return;
    }
    if (e.key === "Escape") {
      if (query.trim()) remember();
    } else if (e.key === "Enter") {
      if (target.tagName === "BUTTON") return;
      if (pick) open(pick);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const d = e.key === "ArrowDown" ? 1 : -1;
      if (inList) step(d);
      else if (target === input.current || target.dataset.testid === "find-globs") older(d === 1 ? -1 : 1);
    } else return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") onClose();
  };
  const latest = useRef(onKeyDown);
  latest.current = onKeyDown;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => latest.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const res = found?.res;
  const notes = [
    res?.stopped === "matches" || res?.stopped === "files" || res?.stopped === "bytes" ? t("app.find.truncated", { matches: res.matches, files: res.files.length }) : undefined,
    res?.stopped === "time" ? t("app.find.timeout") : undefined,
    res?.cut ? t("app.find.cut") : undefined,
  ].filter(Boolean);
  const status = !connected ? undefined : busy && !res ? t("app.find.searching") : res ? (res.matches ? t("app.find.count", { matches: t("app.find.matchCount", { count: res.matches }), files: t("app.find.fileCount", { count: res.files.length }) }) : t("app.find.none")) : undefined;
  const rowIndex = new Map(rows.map((r, i) => [r.key, i]));

  return (
    <div className="fixed inset-0 z-50 flex justify-center px-3 pt-[max(48px,calc((100dvh-640px)/2))]">
      <div className="absolute inset-0 bg-overlay" onClick={onClose} aria-hidden data-testid="find-in-files-backdrop" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("app.find.title")}
        className="relative flex max-h-[min(100dvh-96px,640px)] min-h-70 w-full max-w-200 flex-col self-start rounded-2xl border bg-popover text-popover-foreground shadow-floating"
        data-testid="find-in-files"
      >
        <div className="flex flex-col gap-1.5 p-1.5">
          <div className="flex h-9 items-center gap-2 rounded-md bg-secondary/60 pl-3 pr-1 focus-within:bg-secondary hover:bg-secondary pointer-coarse:h-11">
            <SearchIcon className="size-4 shrink-0 text-faint" aria-hidden />
            <input
              ref={input}
              aria-label={t("app.find.search")}
              placeholder={t("app.find.search")}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground max-md:text-base"
              value={query}
              onChange={(e) => (setQuery(e.target.value), (pos.current = -1))}
              data-testid="find-query"
            />
            <button type="button" aria-pressed={regex} aria-label={t("app.find.regex")} title={t("app.find.regex")} className={toggle} onClick={() => setRegex(!regex)} data-testid="find-regex">
              <RegexIcon className="size-4" />
            </button>
          </div>
          <div className="flex h-9 items-center gap-2 rounded-md bg-secondary/60 pl-3 pr-1 focus-within:bg-secondary hover:bg-secondary pointer-coarse:h-11">
            <input
              aria-label={t("app.find.globsLabel")}
              placeholder={t("app.find.globs")}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground max-md:text-base"
              value={globs}
              onChange={(e) => (setGlobs(e.target.value), (pos.current = -1))}
              data-testid="find-globs"
            />
            <button type="button" aria-pressed={ignored} aria-label={t("app.find.ignored")} title={t("app.find.ignored")} className={toggle} onClick={() => setChoice(!ignored)} data-testid="find-ignored">
              <EyeIcon className="size-4" />
            </button>
          </div>
        </div>
        <div className="shrink-0 px-3 pb-1.5 text-xs text-muted-foreground" role="status" data-testid="find-status">
          {[status, ...notes].filter(Boolean).join(" · ") || (!connected ? t("app.find.notConnected") : "")}
        </div>
        {error && connected && (
          <p role="alert" className="shrink-0 px-3 pb-2 text-destructive">
            {error.code === "git_missing" ? t("app.find.gitMissing") : t("app.find.failed", { message: error.message })}
          </p>
        )}
        {res?.files.length ? (
          <div
            ref={list}
            role="listbox"
            tabIndex={0}
            aria-label={t("app.find.title")}
            aria-activedescendant={settled && rows.length ? `find-match-${active}` : undefined}
            className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="find-results"
          >
            {res.files.map((f) => {
              const slash = f.path.lastIndexOf("/");
              let prev = 0;
              return (
                <div key={f.path} role="presentation" className="mb-2">
                  <div className="sticky top-0 flex items-center gap-2 bg-popover px-2 py-1 font-sans" data-testid="find-file" data-path={f.path}>
                    <FileIcon path={f.path} className="size-4 shrink-0" />
                    <span className="min-w-0 truncate" title={f.path}>
                      <span className="text-muted-foreground">{f.path.slice(0, slash + 1)}</span>
                      <span className="font-medium">{f.path.slice(slash + 1)}</span>
                    </span>
                  </div>
                  {f.lines.map((l) => {
                    const gap = prev > 0 && l.n > prev + 1;
                    prev = l.n;
                    const k = `${f.path}:${l.n}`;
                    const i = l.ranges ? rowIndex.get(k) : undefined;
                    return (
                      <div key={l.n} role="presentation">
                        {gap && (
                          <div aria-hidden className="pl-2 text-faint">
                            ⋯
                          </div>
                        )}
                        <div
                          {...(i !== undefined
                            ? {
                                id: `find-match-${i}`,
                                role: "option",
                                "aria-selected": i === active,
                                "data-testid": "find-match",
                                "data-path": f.path,
                                "data-line": l.n,
                                ref: (el: HTMLElement | null) => void (i === active && el?.scrollIntoView?.({ block: "nearest" })),
                                onClick: () => open({ path: f.path, line: l.n }),
                                onMouseMove: () => i !== active && setActive(i),
                              }
                            : { role: "presentation" })}
                          className={`flex gap-3 rounded-sm px-2 aria-selected:bg-accent ${l.ranges ? "cursor-pointer" : "text-muted-foreground"}`}
                        >
                          <span className="w-[4ch] shrink-0 select-none text-right text-faint">{l.n}</span>
                          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
                            {lineSegments(l.text, l.ranges).map((s, j) =>
                              s.hit ? (
                                <mark key={j} className="rounded-xs bg-warning/25 text-foreground">
                                  {s.text}
                                </mark>
                              ) : (
                                s.text
                              ),
                            )}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
