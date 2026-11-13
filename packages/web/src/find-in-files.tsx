// Find in files (Ctrl+Shift+F): content search over the session's project through `fs.grep` (git grep), results grouped by
// file with context lines and highlighted hits. Modal like Quick open; Enter or a click opens the match at its line.
import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, MinusIcon, RegexIcon, ReplaceAllIcon, ReplaceIcon, SearchIcon } from "lucide-react";
import type { FsGrepResult, FsReplaceResult, ReplaceFile, ReplaceLine } from "@claude-ui/protocol";
import type { RequestError } from "./client.ts";
import { FileIcon } from "./file-icon.tsx";
import { fileCheckState, type FindEntry, lineSegments, loadFindHistory, loadReplaceOpen, matchRows, pushFindHistory, replaceRequestFiles, saveFindHistory, saveReplaceOpen, skippedRows, splitUnsaved } from "./find-in-files.ts";
import { useT } from "./i18n.ts";
import { isImeKey } from "./ime.ts";

export type FindQuery = { query: string; regex: boolean; globs: string; includeIgnored?: boolean };
export type FindReplace = { query: string; regex: boolean; replace: string; dryRun: boolean; files: { path: string; lines: number[]; mtime?: number; size?: number }[] };
const DEBOUNCE_MS = 250;
const iconBtn = "grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 pointer-coarse:size-11";

const toggle = "grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground pointer-coarse:size-11";

/** `initialQuery` (the editor's selection) is searched at once and selected, so typing replaces it. Esc or opening a match saves the search in the history (Up/Down in the boxes). */
export function FindInFiles({
  connected,
  initialQuery,
  initialReplace,
  onSearch,
  onReplace,
  onUndo,
  isUnsaved,
  onOpen,
  onClose,
}: {
  connected: boolean;
  initialQuery?: string;
  /** The "Replace in files" command: opens with the replace row shown (and focused when a query is prefilled). */
  initialReplace?: boolean;
  /** Dry run (preview) and apply of `fs.replace`. */
  onReplace: (r: FindReplace) => Promise<FsReplaceResult>;
  /** Undo of an applied replace; `unsaved`: relative paths with unsaved editor edits. */
  onUndo: (id: string, unsaved: string[]) => Promise<FsReplaceResult>;
  /** True when the file (relative path) has an editor tab with unsaved edits. */
  isUnsaved: (path: string) => boolean;
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
  const [replaceOpen, setReplaceOpen] = useState(initialReplace ?? loadReplaceOpen());
  const [replace, setReplace] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ found: FsGrepResult; replace: string; lines: Map<string, ReplaceLine>; files: Map<string, ReplaceFile> }>();
  const [replaceError, setReplaceError] = useState<{ code?: string; message: string }>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [rerun, setRerun] = useState(0);
  const [summary, setSummary] = useState<{ kind: "replaced" | "undone"; res: FsReplaceResult; unsaved: string[]; sent: string[] }>();
  const input = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const lastKey = useRef<string | undefined>(undefined);
  const lastDry = useRef<string | undefined>(undefined);
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
    if (initialReplace && initialQuery) return replaceInput.current?.focus();
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
        .then((res) => {
          if (!current) return;
          if (lastKey.current !== key) setExcluded(new Set());
          lastKey.current = key;
          lastDry.current = undefined;
          setFound({ key, res });
          setActive(0);
          setError(undefined);
        })
        .catch((e: RequestError) => current && (setFound(undefined), setError({ code: e.code, message: e.message })))
        .finally(() => current && setBusy(false));
    if (first.current) {
      first.current = false;
      void go();
      return () => void (current = false);
    }
    const timer = setTimeout(go, DEBOUNCE_MS);
    return () => (current = false, clearTimeout(timer));
  }, [key, connected, rerun]);
  // The preview: a dry run of the replacement over every match line of the settled search (same code that writes).
  useEffect(() => {
    if (!replaceOpen || !connected || !found || found.key !== key) return;
    const res = found.res;
    const all = replaceRequestFiles(res, new Set());
    if (!all.length) return setPreview(undefined);
    let current = true;
    setPreviewBusy(true);
    const go = () => {
      lastDry.current = replace;
      onReplace({ query, regex, replace, dryRun: true, files: all })
        .then((r) => {
          if (!current) return;
          const lines = new Map<string, ReplaceLine>();
          const files = new Map<string, ReplaceFile>();
          for (const f of r.files) {
            files.set(f.path, f);
            for (const l of f.lines ?? []) lines.set(`${f.path}:${l.n}`, l);
          }
          setPreview({ found: res, replace, lines, files });
          setReplaceError(undefined);
        })
        .catch((e: RequestError) => current && (setPreview(undefined), setReplaceError({ code: e.code, message: e.message })))
        .finally(() => current && setPreviewBusy(false));
    };
    if (lastDry.current !== replace && lastDry.current !== undefined) {
      const timer = setTimeout(go, DEBOUNCE_MS);
      return () => (current = false, clearTimeout(timer));
    }
    go();
    return () => void (current = false);
  }, [found, replace, replaceOpen, connected]);
  // The panel closing stops the running search.
  useEffect(() => () => void (searched.current && onSearch({ query: "", regex: false, globs: "" }).catch(() => {})), []);

  const remember = () => {
    history.current = pushFindHistory(history.current, { query, globs });
    saveFindHistory(history.current);
  };
  const toggleReplace = () => {
    saveReplaceOpen(!replaceOpen);
    setReplaceOpen(!replaceOpen);
  };
  const open = (r: { path: string; line: number }) => (remember(), onOpen(r.path, r.line));
  const ready = replaceOpen && settled && !!found && preview?.found === found.res && preview.replace === replace && !previewBusy;
  const pv = ready ? preview : undefined;
  // Lines that cannot be replaced (the JS regex finds nothing, or the file is skipped) are never checked.
  const disabled = new Set<string>();
  if (pv) for (const r of rows) if (pv.lines.get(r.key)?.none || pv.files.get(r.path)?.skipped) disabled.add(r.key);
  const blocked = new Set([...excluded, ...disabled]);
  const checkedCount = replaceRequestFiles(found?.res, blocked);
  const toggleKeys = (keys: string[], on: boolean) =>
    setExcluded((ex) => {
      const n = new Set(ex);
      for (const k of keys) on ? n.delete(k) : n.add(k);
      return n;
    });
  const fileKeys = (path: string) => rows.filter((r) => r.path === path && !disabled.has(r.key)).map((r) => r.key);
  const canApply = connected && ready && !replaceError && !running && checkedCount.length > 0;
  const fail = (e: RequestError) => setReplaceError({ code: e.code, message: e.message });
  const apply = async (file?: string) => {
    if (!found || !ready) return;
    const { send, unsaved } = splitUnsaved(replaceRequestFiles(found.res, blocked, file), isUnsaved);
    const sent = send.map((f) => f.path);
    setRunning(true);
    setReplaceError(undefined);
    try {
      const res: FsReplaceResult = send.length
        ? await onReplace({ query, regex, replace, dryRun: false, files: send.map((f) => ({ ...f, mtime: pv?.files.get(f.path)?.mtime, size: pv?.files.get(f.path)?.size })) })
        : { files: [], changedFiles: 0, changedLines: 0 };
      setSummary({ kind: "replaced", res, unsaved, sent });
      setRerun((n) => n + 1);
    } catch (e) {
      fail(e as RequestError);
    } finally {
      setRunning(false);
    }
  };
  const undo = async () => {
    const id = summary?.res.undoId;
    if (!id) return;
    const unsaved = summary.sent.filter(isUnsaved);
    setRunning(true);
    setReplaceError(undefined);
    try {
      const res = await onUndo(id, unsaved);
      setSummary({ kind: "undone", res, unsaved, sent: [] });
      setRerun((n) => n + 1);
    } catch (e) {
      fail(e as RequestError);
      setSummary(undefined);
    } finally {
      setRunning(false);
    }
  };
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
      const f = [...dialog.current.querySelectorAll<HTMLElement>("input, button:not([tabindex='-1']), [tabindex='0']")];
      const wrap = e.shiftKey ? target === f[0] : target === f[f.length - 1];
      if (wrap) (e.preventDefault(), f[e.shiftKey ? f.length - 1 : 0]?.focus());
      return;
    }
    if (e.key === "Escape") {
      if (query.trim()) remember();
    } else if (e.key === "Enter") {
      if (target.tagName === "BUTTON") return;
      if (replaceOpen && inList && (e.ctrlKey || e.metaKey)) {
        if (pick && canApply) void apply(pick.path);
      } else if (e.ctrlKey || e.metaKey) return;
      else if (pick) open(pick);
    } else if (e.key === " " && replaceOpen && target === list.current) {
      if (pick && !disabled.has(pick.key)) {
        const keys = e.shiftKey ? fileKeys(pick.path) : [pick.key];
        toggleKeys(keys, e.shiftKey ? fileCheckState(res!.files.find((f) => f.path === pick.path)!, excluded, disabled) !== "all" : excluded.has(pick.key));
      }
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
        <div className="flex gap-1 p-1.5">
          <button type="button" aria-expanded={replaceOpen} aria-label={t("app.find.replaceToggle")} title={t("app.find.replaceToggle")} className={`${iconBtn} mt-1`} onClick={toggleReplace} data-testid="find-replace-toggle">
            {replaceOpen ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
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
          {replaceOpen && (
            <div className="flex h-9 items-center gap-2 rounded-md bg-secondary/60 pl-3 pr-1 focus-within:bg-secondary hover:bg-secondary pointer-coarse:h-11">
              <input
                ref={replaceInput}
                aria-label={t("app.find.replace")}
                placeholder={t("app.find.replace")}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground max-md:text-base"
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                data-testid="find-replace"
              />
              <button type="button" aria-label={t("app.find.replaceAll")} title={t("app.find.replaceAll")} disabled={!canApply} className={iconBtn} onClick={() => void apply()} data-testid="find-replace-all">
                <ReplaceAllIcon className="size-4" />
              </button>
            </div>
          )}
          </div>
        </div>
        <div className="shrink-0 px-3 pb-1.5 text-xs text-muted-foreground" role="status" data-testid="find-status">
          {[status, ...notes].filter(Boolean).join(" · ") || (!connected ? t("app.find.notConnected") : "")}
        </div>
        {replaceOpen && pv && checkedCount.length > 0 && !summary && (
          <div className="shrink-0 px-3 pb-1.5 text-xs text-muted-foreground" data-testid="find-preview-count">
            {t("app.find.replaceCount", {
              matches: t("app.find.matchCount", { count: checkedCount.reduce((n, f) => n + f.lines.length, 0) }),
              files: t("app.find.fileCount", { count: checkedCount.length }),
            })}
          </div>
        )}
        {summary && (
          <div role="status" className="shrink-0 px-3 pb-2" data-testid="find-summary">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                {summary.kind === "undone"
                  ? t("app.find.undone", { files: t("app.find.fileCount", { count: summary.res.changedFiles }) })
                  : summary.res.changedFiles
                    ? t("app.find.replaced", { matches: t("app.find.matchCount", { count: summary.res.changedLines }), files: t("app.find.fileCount", { count: summary.res.changedFiles }) })
                    : t("app.find.replacedNone")}
              </span>
              {summary.kind === "replaced" && summary.res.undoId && (
                <button type="button" disabled={running} className="rounded-sm px-2 py-0.5 text-primary underline hover:bg-accent disabled:opacity-40 pointer-coarse:min-h-11" onClick={() => void undo()} data-testid="find-undo">
                  {t("app.find.undo")}
                </button>
              )}
              {summary.kind === "replaced" && summary.res.changedFiles > 0 && !summary.res.undoId && <span className="text-muted-foreground">{t("app.find.cannotUndo")}</span>}
            </p>
            {(() => {
              const rowsSkipped = skippedRows(summary.res, summary.unsaved);
              return rowsSkipped.length ? (
                <div className="mt-1 text-muted-foreground" data-testid="find-skipped">
                  <p>{t("app.find.skipped", { count: rowsSkipped.length })}</p>
                  <ul className="list-disc pl-5">
                    {rowsSkipped.map((r) => (
                      <li key={r.path} className="break-all">
                        {r.path} ({t(`app.find.skip.${r.reason}`)})
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null;
            })()}
          </div>
        )}
        {replaceError && connected && (
          <p role="alert" className="shrink-0 px-3 pb-2 text-destructive" data-testid="find-replace-error">
            {replaceError.code === "regex_timeout" ? t("app.find.regexTimeout") : replaceError.code === "undo_gone" ? t("app.find.undoGone") : t("app.find.replaceFailed", { message: replaceError.message })}
          </p>
        )}
        {error && connected && (
          <p role="alert" className="shrink-0 px-3 pb-2 text-destructive">
            {error.code === "git_missing" ? t("app.find.gitMissing") : error.code === "regex_unsupported" ? t("app.find.regexUnsupported") : t("app.find.failed", { message: error.message })}
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
              const state = fileCheckState(f, excluded, disabled);
              const skippedFile = pv?.files.get(f.path)?.skipped;
              return (
                <div key={f.path} role="presentation" className="mb-2">
                  <div className="sticky top-0 flex items-center gap-2 bg-popover px-2 py-1 font-sans" data-testid="find-file" data-path={f.path}>
                    {replaceOpen && (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={state === "some" ? "mixed" : state === "all"}
                        aria-label={t("app.find.replaceFileCheck", { path: f.path })}
                        tabIndex={-1}
                        disabled={state === "none" && !fileKeys(f.path).length}
                        className="grid size-4 shrink-0 place-items-center rounded-xs border text-primary-foreground aria-checked:bg-primary aria-[checked=mixed]:bg-primary disabled:opacity-40 pointer-coarse:size-11 pointer-coarse:border-0 pointer-coarse:bg-transparent"
                        onClick={() => toggleKeys(fileKeys(f.path), state !== "all")}
                        data-testid="find-file-check"
                      >
                        {state === "all" ? <CheckIcon className="size-3" /> : state === "some" ? <MinusIcon className="size-3" /> : null}
                      </button>
                    )}
                    <FileIcon path={f.path} className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={f.path}>
                      <span className="text-muted-foreground">{f.path.slice(0, slash + 1)}</span>
                      <span className="font-medium">{f.path.slice(slash + 1)}</span>
                    </span>
                    {replaceOpen && skippedFile && <span className="shrink-0 text-xs text-muted-foreground">{t(`app.find.skip.${skippedFile}`)}</span>}
                    {replaceOpen && (
                      <button type="button" aria-label={t("app.find.replaceFile")} title={t("app.find.replaceFileTitle")} tabIndex={-1} disabled={!canApply || !fileKeys(f.path).some((k) => !excluded.has(k))} className={iconBtn} onClick={() => void apply(f.path)} data-testid="find-replace-file">
                        <ReplaceIcon className="size-4" />
                      </button>
                    )}
                  </div>
                  {f.lines.map((l) => {
                    const gap = prev > 0 && l.n > prev + 1;
                    prev = l.n;
                    const k = `${f.path}:${l.n}`;
                    const i = l.ranges ? rowIndex.get(k) : undefined;
                    const pl = l.ranges && pv ? pv.lines.get(k) : undefined;
                    const off = excluded.has(k) || disabled.has(k);
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
                                ...(replaceOpen ? { "aria-checked": !off } : {}),
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
                          {replaceOpen && l.ranges && (
                            <span
                              aria-hidden
                              className="grid shrink-0 place-items-center pointer-coarse:size-11"
                              onClick={(e) => (e.stopPropagation(), !disabled.has(k) && toggleKeys([k], excluded.has(k)))}
                              data-testid="find-match-check"
                            >
                              <span className={`grid size-4 place-items-center rounded-xs border text-primary-foreground ${off ? "" : "bg-primary"} ${disabled.has(k) ? "opacity-40" : ""}`}>{off ? null : <CheckIcon className="size-3" />}</span>
                            </span>
                          )}
                          <span className="w-[4ch] shrink-0 select-none text-right text-faint">{l.n}</span>
                          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
                            {lineSegments(l.text, l.ranges).map((s, j) =>
                              s.hit ? (
                                replaceOpen ? (
                                  <del key={j} className="rounded-xs bg-destructive/15 text-foreground line-through">
                                    {s.text}
                                  </del>
                                ) : (
                                  <mark key={j} className="rounded-xs bg-warning/25 text-foreground">
                                    {s.text}
                                  </mark>
                                )
                              ) : (
                                s.text
                              ),
                            )}
                            {pl?.after !== undefined && (
                              <span className="block" data-testid="find-after">
                                {lineSegments(pl.after, pl.ranges).map((s, j) =>
                                  s.hit ? (
                                    <ins key={j} className="rounded-xs bg-success/20 text-foreground no-underline">
                                      {s.text}
                                    </ins>
                                  ) : (
                                    s.text
                                  ),
                                )}
                              </span>
                            )}
                            {pl?.none && <span className="block font-sans text-muted-foreground">{t("app.find.replaceNone")}</span>}
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
