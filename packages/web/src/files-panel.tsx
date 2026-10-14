// File tree and CodeMirror editor tabs (docs/spec.md "Layout", "Editor"). Files are read and saved through the daemon.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { gotoLine } from "@codemirror/search";
import { keymap, type KeyBinding } from "@codemirror/view";
import { selectLine } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { styleTags, tags as t } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import type { FsMediaResult, FsReadResult, FsWriteResult } from "@claude-ui/protocol";
import { ChevronDownIcon, ChevronRightIcon, ChevronsDownUpIcon, LocateFixedIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { useNarrow } from "@/lib/use-narrow.ts";
import type { connect, ConnectionStatus, RequestError } from "./client.ts";
import { matchesKey } from "./shortcuts.ts";
import { useDark } from "./theme.ts";
import { baseName, inDir, relPath } from "./paths.ts";
import { MediaView } from "./media-view.tsx";
import { FileIcon } from "./file-icon.tsx";
import { FILE_LINK_PROPS, FileBaseContext, FileImageContext, FileLinkContext } from "./file-links.tsx";
import { FileTree, type FileTreeHandle, type OpenOptions } from "./file-tree.tsx";
import { diskChanged, docText, isDirty, isMarkdown, lineBreaks, loadMdView, mediaKind, opened, openedMedia, pin, placeTab, reload, readFailure, replaceDoc, saveBase, saved, saveMdView, selectionMention, type MdView, type Tab } from "./files.ts";

type Client = ReturnType<typeof connect>;


/**
 * Tabs are keyed by absolute path and kept across sessions; the panel shows those inside `cwd`. `onSend` gets an `@path#lines` mention.
 * `openPath` (quick open) opens that file in a tab, then `onOpened` clears it.
 * `watch`: more paths for this connection's fs.watch list (fs.watch replaces it), e.g. the changes tab's files.
 */
export function FilesPanel({
  client,
  status,
  cwd,
  onSend,
  openPath,
  openLine,
  onOpened,
  watch = [],
  showTree,
  onToggleTree,
  gitStamp,
  visible = true,
}: {
  client: Client;
  status: ConnectionStatus;
  cwd: string;
  onSend: (mention: string) => void;
  openPath?: string;
  /** With `openPath`: the line to put the cursor on. */
  openLine?: number;
  onOpened?: () => void;
  watch?: string[];
  /** The file tree's open state is the app's (Toggle file tree, kept per browser). */
  showTree: boolean;
  onToggleTree: () => void;
  /** Defined in a git work tree: a new value reads the tree's git marks again. */
  gitStamp?: string;
  /** The panel is on screen (the tree reads git marks only then). */
  visible?: boolean;
}) {
  const [tabs, setTabs] = useState<Record<string, Tab>>({});
  const [activePath, setActivePath] = useState<string>();
  const [treeKey, setTreeKey] = useState(0);
  const [gitNudge, setGitNudge] = useState(0);
  const [filtering, setFiltering] = useState(false);
  const tree = useRef<FileTreeHandle>(undefined);
  const [mdView, setMdView] = useState<MdView>(loadMdView);
  /** A markdown file opened at a line shows its source for that open, whatever view is chosen (not stored). */
  const [sourceOnly, setSourceOnly] = useState<string>();
  const narrow = useNarrow();
  const [error, setError] = useState<string>();
  /** The file being read for longer than 150 ms. */
  const [loading, setLoading] = useState<string>();
  const openSeq = useRef(0);
  /** A line to go to in `path`'s editor once it shows (`key` tells a repeat of the same line apart). */
  const [goto, setGoto] = useState<{ path: string; line: number; key: number }>();
  const editor = useRef<EditorView>(undefined);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const update = (path: string, f: (t: Tab) => Tab) => setTabs((ts) => (ts[path] ? { ...ts, [path]: f(ts[path]) } : ts));

  const readTab = async (path: string) =>
    mediaKind(path) ? openedMedia(path, await client.request<FsMediaResult>({ type: "fs.media", path })) : opened(path, await client.request<FsReadResult>({ type: "fs.read", path }));

  /** SVG: the same file as text (editor) or as image. */
  async function switchView(path: string, toText: boolean) {
    try {
      const tab = toText ? opened(path, await client.request<FsReadResult>({ type: "fs.read", path })) : openedMedia(path, await client.request<FsMediaResult>({ type: "fs.media", path }));
      setTabs((ts) => (ts[path] ? { ...ts, [path]: tab } : ts));
    } catch (e) {
      update(path, (t) => ({ ...t, error: readFailure(e as RequestError).text }));
    }
  }

  async function refresh(path: string) {
    try {
      if (tabsRef.current[path]?.media) {
        const m = await client.request<FsMediaResult>({ type: "fs.media", path });
        return update(path, (t) => ({ ...t, media: m, mtime: m.mtime, error: undefined, notice: undefined }));
      }
      const r = await client.request<FsReadResult>({ type: "fs.read", path });
      update(path, (t) => diskChanged(t, r));
    } catch (e) {
      if ((e as Error).message === "disconnected") return;
      const f = readFailure(e as RequestError);
      // A clean tab shows the state instead of its stale text; a dirty one keeps its edits and shows the line.
      update(path, (t) => (f.notice && !isDirty(t) ? { ...t, error: undefined, notice: f.text, noticeHint: f.hint } : { ...t, error: f.text }));
    }
  }

  /** Opens `path` as a preview tab (italic, replaced by the next single-click open) unless `preview` is false. */
  async function open(path: string, opts: { preview?: boolean; line?: number; focusEditor?: boolean } = {}) {
    const preview = opts.preview ?? true;
    const scope = (p: string) => inDir(p, cwd);
    setError(undefined);
    // Answers come back in any order: only the latest open may take the preview slot and the focus.
    const seq = ++openSeq.current;
    if (!opts.line) setSourceOnly((p) => (p === path ? undefined : p));
    if (tabsRef.current[path]) setTabs((ts) => (ts[path] ? placeTab(ts, ts[path], preview, scope) : ts));
    else {
      const timer = setTimeout(() => setLoading(path), 150);
      try {
        const tab = await readTab(path);
        if (seq !== openSeq.current && preview) return;
        setTabs((ts) => placeTab(ts, ts[path] ?? tab, preview, scope));
      } catch (e) {
        const f = readFailure(e as RequestError);
        if (seq !== openSeq.current && preview) return;
        if (!f.notice) return setError(f.text);
        // A file that cannot be shown still gets a tab (closable, with its breadcrumb) that says why.
        setTabs((ts) => placeTab(ts, ts[path] ?? { path, disk: "", draft: "", mtime: 0, notice: f.text, noticeHint: f.hint }, preview, scope));
        return void setActivePath(path);
      } finally {
        clearTimeout(timer);
        setLoading((l) => (l === path ? undefined : l));
      }
    }
    if (seq === openSeq.current) setActivePath(path);
    if (opts.line && isMarkdown(path)) setSourceOnly(path);
    if (opts.line) setGoto((g) => ({ path, line: opts.line!, key: (g?.key ?? 0) + 1 }));
    if (opts.focusEditor) requestAnimationFrame(() => editor.current?.focus());
  }

  useEffect(() => {
    if (!openPath) return;
    void open(openPath, { line: openLine });
    onOpened?.();
  }, [openPath]);

  async function save(path: string, overwrite = false) {
    const t = tabsRef.current[path];
    if (!t) return;
    const content = t.draft;
    try {
      const r = await client.request<FsWriteResult>({ type: "fs.write", path, content, baseMtime: saveBase(t, overwrite) });
      update(path, (t) => pin(saved(t, content, r.mtime)));
      setGitNudge((n) => n + 1);
    } catch (e) {
      update(path, (t) => ({ ...t, error: (e as Error).message }));
      void refresh(path); // a conflict error means a newer disk version; this shows it as a conflict
    }
  }

  function close(path: string) {
    const t = tabsRef.current[path];
    if (t && isDirty(t) && !confirm(`Discard unsaved changes to ${baseName(path)}?`)) return;
    setTabs(({ [path]: _, ...rest }) => rest);
  }

  // Like an editor: leaving or reloading the page with unsaved edits asks first.
  const dirty = Object.values(tabs).some(isDirty);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const paths = Object.keys(tabs);
  const watchPaths = [...new Set([...paths, ...watch])];
  const watchKey = watchPaths.join("\n");
  const watchedRef = useRef(new Set<string>());
  useEffect(() => {
    if (status !== "connected") return void watchedRef.current.clear();
    // Re-read each newly watched path once the watch is armed: a change between the opening read (or while offline) and the watch baseline is not reported.
    const added = paths.filter((p) => !watchedRef.current.has(p));
    watchedRef.current = new Set(paths);
    client
      .request({ type: "fs.watch", paths: watchPaths })
      .then(() => added.forEach((p) => void refresh(p)))
      .catch(() => {});
  }, [status, watchKey]);
  useEffect(
    () =>
      client.onFsChanged((m) => {
        if (!tabsRef.current[m.path]) return;
        void refresh(m.path);
        setGitNudge((n) => n + 1);
      }),
    [client],
  );

  const openRef = useRef(open);
  openRef.current = open;
  const openLink = useCallback((path: string, line?: number) => void openRef.current(path, { line }), []);
  const imageUrl = useCallback((path: string) => client.request<FsMediaResult>({ type: "fs.media", path }).then((m) => m.url), [client]);
  const shown = paths.filter((p) => inDir(p, cwd));
  const active = activePath && shown.includes(activePath) ? tabs[activePath] : tabs[shown[0]!];
  const md = !!active && !active.media && isMarkdown(active.path);
  /** Split needs room: below md it shows Preview. */
  const view: MdView = !md ? "source" : sourceOnly === active!.path ? "source" : mdView === "split" && narrow ? "preview" : mdView;
  const previewDoc = useDeferredValue(active?.draft ?? "");
  const previewBase = useMemo(() => ({ base: active ? active.path.slice(0, Math.max(active.path.length - baseName(active.path).length - 1, 1)) : cwd, root: cwd }), [active?.path, cwd]);
  useEffect(() => editor.current?.requestMeasure(), [view]);
  const refused = active?.notice ? { path: active.path, text: active.notice, hint: active.noticeHint } : undefined;

  /** Breadcrumb folder: show the tree, then reveal the folder in it. */
  function revealFolder(dir: string) {
    if (!showTree) onToggleTree();
    requestAnimationFrame(() => void tree.current?.reveal(dir, true, true));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-panel">
      <div className="flex items-center gap-1 border-b px-2 py-1 text-xs">
        <Button
          size="xs"
          variant="ghost"
          onClick={onToggleTree}
          className="max-md:h-11 pointer-coarse:h-11"
          aria-expanded={showTree}
          aria-controls="file-tree"
          data-testid="toggle-tree"
        >
          {showTree ? <ChevronDownIcon /> : <ChevronRightIcon />} Files
        </Button>
        {showTree && (
          <>
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto max-md:size-11 pointer-coarse:size-11"
              onClick={() => tree.current?.collapseAll()}
              disabled={filtering}
              title="Collapse all folders"
              aria-label="Collapse all folders"
              data-testid="tree-collapse-all"
            >
              <ChevronsDownUpIcon />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="max-md:size-11 pointer-coarse:size-11"
              onClick={() => active && void tree.current?.reveal(active.path, true)}
              disabled={!active}
              title="Reveal active file in tree"
              aria-label="Reveal active file in tree"
              data-testid="tree-reveal"
            >
              <LocateFixedIcon />
            </Button>
          </>
        )}
        <Button
          size="xs"
          variant="ghost"
          className={`${showTree ? "" : "ml-auto "}max-md:size-11 pointer-coarse:size-11`}
          onClick={() => setTreeKey((k) => k + 1)}
          title="Reload the file tree"
          aria-label="Reload the file tree"
        >
          <RotateCwIcon />
        </Button>
      </div>
      {showTree && (
        <nav
          className="max-h-[40%] shrink-0 overflow-auto border-b py-1 font-mono text-xs"
          id="file-tree"
          data-testid="file-tree"
          aria-label="File tree"
        >
          <FileTree
            key={cwd}
            client={client}
            cwd={cwd}
            activePath={active?.path}
            reloadKey={treeKey}
            gitStamp={gitStamp}
            visible={visible}
            gitNudge={gitNudge}
            handleRef={tree}
            onFilter={setFiltering}
            onOpen={(path, o) => void open(path, { preview: !o.pinned, focusEditor: o.focusEditor })}
          />
        </nav>
      )}
      {error && <p className="px-2 py-1 text-destructive text-xs">{error}</p>}
      {shown.length > 0 && (
        <div className="flex shrink-0 overflow-x-auto border-b text-xs" role="tablist" aria-label="Editor tabs">
          {shown.map((p) => {
            const t = tabs[p]!;
            return (
              <div
                key={p}
                role="tab"
                aria-selected={t === active}
                data-testid="editor-tab"
                className={`flex shrink-0 items-center gap-1 border-r pl-2 ${t === active ? "bg-muted" : ""}`}
                title={p}
              >
                <button
                  className={`py-1.5 max-md:min-h-11 ${t.preview ? "italic" : ""}`}
                  aria-label={t.preview ? `${baseName(p)}, preview` : undefined}
                  onClick={() => setActivePath(p)}
                  onDoubleClick={() => update(p, pin)}
                  onAuxClick={(e) => e.button === 1 && (e.preventDefault(), close(p))}
                >
                  {baseName(p)}
                  {isDirty(t) && <span aria-label="unsaved"> ●</span>}
                  {t.conflict && <span className="text-warning"> !</span>}
                </button>
                <button
                  className="px-1.5 py-1.5 text-muted-foreground hover:text-foreground max-md:min-w-11 max-md:min-h-11"
                  onClick={() => close(p)}
                  aria-label={`Close ${baseName(p)}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      {loading && active && (
        // The editor stays mounted (undo history, cursor, scroll) while another file loads.
        <p className="shrink-0 border-b px-2 py-1 text-muted-foreground text-xs" role="status" data-testid="file-loading">
          Loading file…
        </p>
      )}
      {loading && !active ? (
        <p className="m-auto p-4 text-muted-foreground text-sm" role="status" data-testid="file-loading">
          Loading file…
        </p>
      ) : refused ? (
        <div className="m-auto flex max-w-full flex-col items-center gap-1 p-4 text-center" data-testid="file-notice" role="status">
          <FileIcon path={refused.path} className="mb-1 size-8" />
          <div className="w-full max-w-full text-xs">
            <Breadcrumb path={refused.path} cwd={cwd} onFolder={revealFolder} />
          </div>
          <span className="text-foreground text-sm">{refused.text}</span>
          {refused.hint && <span className="text-muted-foreground text-xs">{refused.hint}</span>}
        </div>
      ) : active ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {active.conflict && (
            <div
              className="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-2 py-1.5 text-xs"
              role="alert"
              data-testid="editor-conflict"
            >
              <span className="flex-1">Changed on disk while you have unsaved edits.</span>
              <Button size="xs" variant="outline" onClick={() => update(active.path, reload)}>
                Reload from disk
              </Button>
              <Button size="xs" variant="outline" onClick={() => void save(active.path, true)}>
                Overwrite with mine
              </Button>
            </div>
          )}
          {active.error && <p className="border-b px-2 py-1 text-destructive text-xs">{active.error}</p>}
          {active.media ? (
            <MediaView
              key={active.media.url}
              path={active.path}
              media={active.media}
              onShowSource={mediaKind(active.path) === "svg" ? () => void switchView(active.path, true) : undefined}
            />
          ) : (
            <>
          <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1 text-xs">
            <Breadcrumb path={active.path} cwd={cwd} onFolder={revealFolder} />
            {md && (
              <div className="flex rounded-md bg-secondary p-0.5" role="group" aria-label="Markdown view">
                {(narrow ? (["source", "preview"] as const) : (["source", "preview", "split"] as const)).map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant="ghost"
                    aria-pressed={view === m}
                    className={`max-md:h-11 pointer-coarse:h-11 ${view === m ? "bg-card shadow-xs hover:bg-card" : ""}`}
                    onClick={() => (setSourceOnly(undefined), setMdView(m), saveMdView(m))}
                    data-testid={`md-view-${m}`}
                  >
                    {m === "source" ? "Source" : m === "preview" ? "Preview" : "Split"}
                  </Button>
                ))}
              </div>
            )}
            {mediaKind(active.path) === "svg" && (
              <Button size="xs" variant="outline" disabled={isDirty(active)} onClick={() => void switchView(active.path, false)} className="max-md:h-11 pointer-coarse:h-11">
                Show preview
              </Button>
            )}
            {/* preventDefault keeps the editor focused, so a desktop selection stays visible; the selection lives in the editor state either way. */}
            <Button
              size="xs"
              variant="outline"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.current && onSend(selectionMention(editor.current.state, active.path, cwd))}
              className="max-md:h-11 pointer-coarse:h-11"
              title="Insert the file and selected lines into the prompt box (Alt+K, Option+K on macOS)"
              data-testid="send-selection"
            >
              Send selection to Claude
            </Button>
            <Button size="xs" className="max-md:h-11 pointer-coarse:h-11" disabled={!isDirty(active) || !!active.conflict} onClick={() => void save(active.path)} data-testid="editor-save">
              Save
            </Button>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className={`min-h-0 min-w-0 flex-1 flex-col ${view === "preview" ? "hidden" : "flex"}`}>
          <CodeEditor
            key={active.path}
            path={active.path}
            doc={active.draft}
            viewRef={editor}
            onSend={(state) => onSend(selectionMention(state, active.path, cwd))}
            onChange={(draft) => update(active.path, (t) => ({ ...pin(t), draft }))}
            goto={goto?.path === active.path ? goto : undefined}
            onGoto={() => setGoto(undefined)}
            onSave={() => void save(active.path)}
          />
            </div>
            {md && view !== "source" && (
              <div
                tabIndex={0}
                aria-label="Markdown preview"
                data-testid="md-preview"
                className={`min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${view === "split" ? "border-l" : ""}`}
              >
                <FileBaseContext value={previewBase}>
                  <FileLinkContext value={openLink}>
                    <FileImageContext value={imageUrl}>
                      <MessageResponse mode="static" {...FILE_LINK_PROPS}>
                        {previewDoc}
                      </MessageResponse>
                    </FileImageContext>
                  </FileLinkContext>
                </FileBaseContext>
              </div>
            )}
          </div>
            </>
          )}
        </div>
      ) : (
        <p className="m-auto p-4 text-muted-foreground text-sm">Open a file from the tree.</p>
      )}
    </div>
  );
}

/** The file's path below `cwd` as folders (a click reveals one in the tree) and the file name. */
function Breadcrumb({ path, cwd, onFolder }: { path: string; cwd: string; onFolder: (dir: string) => void }) {
  const rel = relPath(path, cwd);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const base = rel === path ? "" : path.slice(0, path.length - rel.length);
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const collapse = useNarrow() && parts.length > 4;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 max-md:basis-full md:flex-1" title={path}>
      <ol className="flex min-w-0 items-center font-mono text-muted-foreground">
        {parts.map((part, i) => {
          const last = i === parts.length - 1;
          // A narrow screen keeps the first and last folder and the file; the folders between become one "…".
          if (collapse && i > 0 && i < parts.length - 2)
            return i === 1 ? (
              <li key={i} className="flex shrink-0 items-center" title={parts.slice(1, -2).join(sep)}>
                <span aria-hidden>…</span>
                <ChevronRightIcon className="mx-0.5 size-3 shrink-0 text-faint" aria-hidden />
              </li>
            ) : null;
          return (
            <li key={i} className={`flex items-center ${last ? "min-w-[6ch] shrink" : "min-w-0 shrink-[1000] overflow-hidden"}`}>
              {last ? (
                <span className="flex min-w-0 items-center gap-1 text-foreground" aria-current="page">
                  <FileIcon path={path} className="size-4 shrink-0" />
                  <span className="truncate">{part}</span>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="min-w-0 max-w-[16ch] truncate rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11"
                    onClick={() => onFolder(base + parts.slice(0, i + 1).join(sep))}
                  >
                    {part}
                  </button>
                  <ChevronRightIcon className="mx-0.5 size-3 shrink-0 text-faint" aria-hidden />
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Keys the editor owns: handled here, so the app's shortcuts (defaultPrevented) leave them alone. */
export const editorKeys = ({ onSave, onSend }: { onSave: () => void; onSend: (state: EditorState) => void }): KeyBinding[] => [
  // Not key: "Mod-s": CodeMirror drops Shift for a letter key, so Ctrl+Shift+S typed as "s" (Caps Lock) would save instead of New session.
  { any: (_, e) => matchesKey("mod+s", e) && (e.preventDefault(), onSave(), true) },
  // VS Code's Ctrl+L, also on Linux and Windows (CodeMirror has Alt-L there); without it Ctrl+L would be the app's Focus prompt.
  { key: "Mod-l", preventDefault: true, run: selectLine },
  // Claude Code's shortcut for inserting an @-mention of the selection.
  { key: "Alt-k", preventDefault: true, run: (v) => (onSend(v.state), true) },
  // VS Code's Go to Line, also on Linux and Windows where basicSetup's Ctrl+G is find next (still F3); on macOS Cmd+G stays find next.
  { key: "Ctrl-g", preventDefault: true, run: gotoLine },
];

/** Uncontrolled CodeMirror view: `doc` replaces the content only when it is not what the editor itself reported. */
/** Syntax colors: the --syntax-* tokens (index.css), so light and dark switch with `.dark`. Scopes follow OpenCode's Shiki theme (marked-theme.tsx). */
export const syntaxStyle = HighlightStyle.define([
  { tag: t.comment, color: "var(--syntax-comment)" },
  { tag: [t.keyword, t.modifier, t.function(t.variableName), t.function(t.propertyName), t.standard(t.name)], color: "var(--syntax-keyword)" },
  { tag: [t.string, t.special(t.string), t.tagName], color: "var(--syntax-string)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syntax-property)" },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.variableName)], color: "var(--syntax-type)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name), t.self, t.escape], color: "var(--syntax-constant)" },
  { tag: t.invalid, color: "var(--syntax-critical)" },
  // Markdown: OpenCode markup.heading/markup.quote are --syntax-info (= our --syntax-constant in dark, near it in light); marks are punctuation (muted).
  { tag: t.heading, color: "var(--syntax-constant)", fontWeight: "bold" },
  { tag: t.quote, color: "var(--syntax-constant)" },
  { tag: [t.processingInstruction, t.contentSeparator], color: "var(--syntax-comment)" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.strikethrough, textDecoration: "line-through" },
]);

/** Editor chrome on the app tokens (the panel is a card); `darkTheme` still drives CodeMirror's base theme for what is not listed here (search matches). */
export const chromeTheme = {
  "&": { height: "100%", color: "var(--foreground)", backgroundColor: "var(--card)" },
  ".cm-scroller": { fontFamily: "var(--font-mono, monospace)" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": { backgroundColor: "var(--card)", color: "var(--muted-foreground)", borderRight: "1px solid var(--border)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--accent)" },
  ".cm-activeLineGutter": { color: "var(--foreground)" },
  // Autocomplete and other tooltips: the look of the prompt's command picker (bg-popover, border, shadow-md, rounded rows). Selected row: OpenCode's raised-hover background as --secondary plus a --foreground left bar, so keyboard selection reaches 3:1.
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { padding: "4px", fontFamily: "var(--font-mono, monospace)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 6px", borderRadius: "6px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--secondary)", color: "var(--secondary-foreground)", boxShadow: "inset 2px 0 0 var(--foreground)", borderRadius: "0 6px 6px 0" },
  ".cm-completionDetail": { color: "var(--muted-foreground)" },
  // Search panel (Ctrl+F): rows search + buttons / options / replace + buttons, the field shrinks first, down to the 280px panel minimum.
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel.cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    paddingRight: "20px",
    accentColor: "var(--foreground)",
    "&::before, &::after": { content: '""', flexBasis: "100%", order: "1" },
    "&::after": { order: "3" },
    "& br": { display: "none" },
    "& label": { order: "2" },
    "& [name=replace], & [name=replaceAll]": { order: "4" },
    "& .cm-textfield": { flex: "1 1 6em", minWidth: "0" },
  },
  ".cm-textfield": { backgroundColor: "transparent", color: "inherit", border: "1px solid var(--input)", borderRadius: "4px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--secondary)", color: "var(--secondary-foreground)", border: "1px solid var(--border)", borderRadius: "4px" },
  // Go to line (Ctrl+G) dialog.
  ".cm-dialog": { backgroundColor: "var(--card)", color: "var(--foreground)", borderTop: "1px solid var(--border)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px" },
  // Touch: 44px targets (the repo's pointer-coarse rule). The close button joins the options row instead of narrowing the search field.
  "@media (pointer: coarse)": {
    ".cm-tooltip.cm-tooltip-autocomplete > ul": { maxHeight: "calc(5 * 44px + 8px)" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { minHeight: "44px", display: "flex", alignItems: "center" },
    ".cm-panel.cm-search .cm-button": { minHeight: "44px", minWidth: "44px" },
    ".cm-panel.cm-search": { paddingRight: "6px" },
    ".cm-panel.cm-search .cm-textfield": { minHeight: "44px", fontSize: "16px", flexBasis: "4em" },
    ".cm-panel.cm-search label": { minHeight: "44px", display: "inline-flex", alignItems: "center" },
    ".cm-dialog .cm-textfield": { minHeight: "44px", fontSize: "16px" },
    ".cm-dialog .cm-button, .cm-dialog-close": { minHeight: "44px", minWidth: "44px" },
    ".cm-panel.cm-search [name=close]": { position: "static", order: "2", marginLeft: "auto", minWidth: "44px", minHeight: "44px" },
  },
};

const chrome = [
  EditorView.theme(chromeTheme),
  syntaxHighlighting(syntaxStyle),
];

/** Language of a file by name. language-data's Markdown is plain CommonMark; OpenCode (Shiki) shows GFM with fenced code in its own language. */
export function loadLanguage(path: string) {
  const lang = LanguageDescription.matchFilename(languages, baseName(path));
  if (lang?.name !== "Markdown") return lang?.load();
  // GFM tags table headers as headings and pipes as marks; OpenCode's theme has no table scope, so both keep the text color.
  const table = { props: [styleTags({ "TableHeader/...": t.content, TableDelimiter: t.content })] };
  return import("@codemirror/lang-markdown").then((m) => m.markdown({ base: m.markdownLanguage, codeLanguages: languages, extensions: table }));
}

/** `readOnly`, `tabbable` (content reachable by Tab) and `line` (first line shown) serve the popup viewer; the files tab sets none. */
export function CodeEditor({
  path,
  doc,
  viewRef,
  onChange,
  onSave,
  onSend,
  readOnly,
  tabbable,
  line,
  goto,
  onGoto,
}: {
  path: string;
  doc: string;
  viewRef: RefObject<EditorView | undefined>;
  onChange: (doc: string) => void;
  onSave: () => void;
  onSend: (state: EditorState) => void;
  readOnly?: boolean;
  tabbable?: boolean;
  line?: number;
  /** The cursor goes to this line when `key` changes (or on mount); `onGoto` then clears it. */
  goto?: { line: number; key: number };
  onGoto?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const reported = useRef(doc);
  const cb = useRef({ onChange, onSave, onSend });
  cb.current = { onChange, onSave, onSend };

  const dark = useDark();
  const darkTheme = useRef(new Compartment()).current;

  useEffect(() => {
    const language = new Compartment();
    const v = new EditorView({
      parent: host.current!,
      doc,
      extensions: [
        basicSetup,
        lineBreaks(doc),
        Prec.high(keymap.of(editorKeys({ onSave: () => cb.current.onSave(), onSend: (s) => cb.current.onSend(s) }))),
        language.of([]),
        chrome,
        darkTheme.of(EditorView.darkTheme.of(dark)),
        readOnly ? EditorState.readOnly.of(true) : [],
        tabbable ? EditorView.contentAttributes.of({ tabindex: "0", "aria-label": `${baseName(path)}, read-only` }) : [],
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          reported.current = docText(u.state);
          cb.current.onChange(reported.current);
        }),
      ],
    });
    view.current = viewRef.current = v;
    if (line) {
      const l = v.state.doc.line(Math.min(line, v.state.doc.lines));
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start" }) });
    }
    let live = true;
    loadLanguage(path)?.then((l) => live && v.dispatch({ effects: language.reconfigure(l) }));
    return () => {
      live = false;
      v.destroy();
      if (viewRef.current === v) viewRef.current = undefined;
    };
  }, [path]);

  useEffect(() => {
    const v = view.current;
    if (!v || !goto) return;
    const l = v.state.doc.line(Math.max(1, Math.min(goto.line, v.state.doc.lines)));
    v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
    v.focus();
    onGoto?.();
  }, [goto?.key]);

  useEffect(() => view.current?.dispatch({ effects: darkTheme.reconfigure(EditorView.darkTheme.of(dark)) }), [dark]);

  // A reload from disk (clean tab or "Reload from disk").
  useEffect(() => {
    const v = view.current;
    if (!v || doc === reported.current) return;
    reported.current = doc;
    v.dispatch(replaceDoc(v.state, doc));
  }, [doc]);

  // 16px on narrow screens: iOS zooms into smaller focused text.
  return <div ref={host} className="min-h-0 flex-1 overflow-hidden text-base lg:text-[13px]" data-testid="code-editor" />;
}
