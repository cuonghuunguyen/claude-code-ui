// File tree and CodeMirror editor tabs (docs/spec.md "Layout", "Editor"). Files are read and saved through the daemon.
import { useEffect, useRef, useState, type RefObject } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, type EditorState } from "@codemirror/state";
import { keymap, type KeyBinding } from "@codemirror/view";
import { selectLine } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { styleTags, tags as t } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import type { FsEntry, FsListResult, FsMediaResult, FsReadResult, FsWriteResult } from "@claude-ui/protocol";
import { ChevronDownIcon, ChevronRightIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { connect, ConnectionStatus, RequestError } from "./client.ts";
import { matchesKey } from "./shortcuts.ts";
import { useDark } from "./theme.ts";
import { baseName, inDir } from "./paths.ts";
import { MediaView } from "./media-view.tsx";
import { diskChanged, docText, isDirty, lineBreaks, mediaKind, opened, openedMedia, reload, readFailure, replaceDoc, saveBase, saved, selectionMention, type Tab } from "./files.ts";

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
  onOpened,
  watch = [],
  showTree,
  onToggleTree,
}: {
  client: Client;
  status: ConnectionStatus;
  cwd: string;
  onSend: (mention: string) => void;
  openPath?: string;
  onOpened?: () => void;
  watch?: string[];
  /** The file tree's open state is the app's (Toggle file tree, kept per browser). */
  showTree: boolean;
  onToggleTree: () => void;
}) {
  const [tabs, setTabs] = useState<Record<string, Tab>>({});
  const [activePath, setActivePath] = useState<string>();
  const [treeKey, setTreeKey] = useState(0);
  const [error, setError] = useState<string>();
  /** The last opened file that cannot be shown (binary, too large, not UTF-8); it replaces the editor until a tab is chosen. */
  const [notice, setNotice] = useState<{ path: string; text: string }>();
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
      update(path, (t) => (f.notice && !isDirty(t) ? { ...t, error: undefined, notice: f.text } : { ...t, error: f.text }));
    }
  }

  async function open(path: string) {
    setError(undefined);
    setNotice(undefined);
    if (!tabsRef.current[path]) {
      try {
        const tab = await readTab(path);
        setTabs((ts) => ({ ...ts, [path]: ts[path] ?? tab }));
      } catch (e) {
        const f = readFailure(e as RequestError);
        return f.notice ? setNotice({ path, text: f.text }) : setError(f.text);
      }
    }
    setActivePath(path);
  }

  useEffect(() => {
    if (!openPath) return;
    void open(openPath);
    onOpened?.();
  }, [openPath]);

  async function save(path: string, overwrite = false) {
    const t = tabsRef.current[path];
    if (!t) return;
    const content = t.draft;
    try {
      const r = await client.request<FsWriteResult>({ type: "fs.write", path, content, baseMtime: saveBase(t, overwrite) });
      update(path, (t) => saved(t, content, r.mtime));
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
  useEffect(() => client.onFsChanged((m) => void (tabsRef.current[m.path] && refresh(m.path))), [client]);

  const shown = paths.filter((p) => inDir(p, cwd));
  const active = activePath && shown.includes(activePath) ? tabs[activePath] : tabs[shown[0]!];
  const refused = notice ?? (active?.notice ? { path: active.path, text: active.notice } : undefined);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-panel">
      <div className="flex items-center gap-1 border-b px-2 py-1 text-xs">
        <Button
          size="xs"
          variant="ghost"
          onClick={onToggleTree}
          aria-expanded={showTree}
          aria-controls="file-tree"
          data-testid="toggle-tree"
        >
          {showTree ? <ChevronDownIcon /> : <ChevronRightIcon />} Files
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
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
          <TreeDir key={`${cwd}:${treeKey}`} client={client} path={cwd} depth={0} activePath={active?.path} onOpen={open} />
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
                aria-selected={t === active && !notice}
                data-testid="editor-tab"
                className={`flex shrink-0 items-center gap-1 border-r pl-2 ${t === active && !notice ? "bg-muted" : ""}`}
                title={p}
              >
                <button className="py-1.5" onClick={() => (setNotice(undefined), setActivePath(p))}>
                  {baseName(p)}
                  {isDirty(t) && <span aria-label="unsaved"> ●</span>}
                  {t.conflict && <span className="text-warning"> !</span>}
                </button>
                <button
                  className="px-1.5 py-1.5 text-muted-foreground hover:text-foreground"
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
      {refused ? (
        <p className="m-auto max-w-full p-4 text-center text-muted-foreground text-sm" data-testid="file-notice" role="status">
          <span className="block truncate font-mono text-xs" title={refused.path}>
            {refused.path.slice(cwd.length + 1) || refused.path}
          </span>
          {refused.text}
        </p>
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
          <div className="flex items-center gap-2 border-b px-2 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={active.path}>
              {active.path.slice(cwd.length + 1) || active.path}
            </span>
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
              title="Insert the file and selected lines into the prompt box (Alt+K, Option+K on macOS)"
              data-testid="send-selection"
            >
              Send selection to Claude
            </Button>
            <Button size="xs" disabled={!isDirty(active) || !!active.conflict} onClick={() => void save(active.path)} data-testid="editor-save">
              Save
            </Button>
          </div>
          <CodeEditor
            key={active.path}
            path={active.path}
            doc={active.draft}
            viewRef={editor}
            onSend={(state) => onSend(selectionMention(state, active.path, cwd))}
            onChange={(draft) => update(active.path, (t) => ({ ...t, draft }))}
            onSave={() => void save(active.path)}
          />
            </>
          )}
        </div>
      ) : (
        <p className="m-auto p-4 text-muted-foreground text-sm">Open a file from the tree.</p>
      )}
    </div>
  );
}

/** One directory level, listed when first expanded. */
function TreeDir({
  client,
  path,
  depth,
  activePath,
  onOpen,
}: {
  client: Client;
  path: string;
  depth: number;
  activePath?: string;
  onOpen: (path: string) => void;
}) {
  const [entries, setEntries] = useState<FsEntry[]>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    client
      .request<FsListResult>({ type: "fs.list", path })
      .then((r) => setEntries(r.entries.filter((e) => e.name !== ".git").sort((a, b) => Number(b.isDir) - Number(a.isDir))))
      .catch((e: Error) => setError(e.message));
  }, [path]);

  const pad = { paddingLeft: `${depth * 12 + 8}px` };
  if (error)
    return (
      <p className="text-destructive" style={pad}>
        {error}
      </p>
    );
  if (!entries)
    return (
      <p className="text-muted-foreground" style={pad}>
        …
      </p>
    );
  return (
    <ul>
      {entries.map((e) => (
        <li key={e.path}>
          <button
            className={`flex w-full items-center gap-1 py-1 pr-2 text-left hover:bg-muted ${e.path === activePath ? "bg-muted" : ""}`}
            style={pad}
            data-testid="tree-entry"
            aria-expanded={e.isDir ? !!expanded[e.path] : undefined}
            onClick={() => (e.isDir ? setExpanded((x) => ({ ...x, [e.path]: !x[e.path] })) : onOpen(e.path))}
          >
            {e.isDir ? (
              expanded[e.path] ? <ChevronDownIcon className="size-3.5 shrink-0 text-faint" /> : <ChevronRightIcon className="size-3.5 shrink-0 text-faint" />
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{e.name}</span>
          </button>
          {e.isDir && expanded[e.path] && (
            <TreeDir client={client} path={e.path} depth={depth + 1} activePath={activePath} onOpen={onOpen} />
          )}
        </li>
      ))}
    </ul>
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
  // Touch: 44px targets (the repo's pointer-coarse rule). The close button joins the options row instead of narrowing the search field.
  "@media (pointer: coarse)": {
    ".cm-tooltip.cm-tooltip-autocomplete > ul": { maxHeight: "calc(5 * 44px + 8px)" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { minHeight: "44px", display: "flex", alignItems: "center" },
    ".cm-panel.cm-search .cm-button": { minHeight: "44px", minWidth: "44px" },
    ".cm-panel.cm-search": { paddingRight: "6px" },
    ".cm-panel.cm-search .cm-textfield": { minHeight: "44px", fontSize: "16px", flexBasis: "4em" },
    ".cm-panel.cm-search label": { minHeight: "44px", display: "inline-flex", alignItems: "center" },
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

function CodeEditor({
  path,
  doc,
  viewRef,
  onChange,
  onSave,
  onSend,
}: {
  path: string;
  doc: string;
  viewRef: RefObject<EditorView | undefined>;
  onChange: (doc: string) => void;
  onSave: () => void;
  onSend: (state: EditorState) => void;
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
        keymap.of(editorKeys({ onSave: () => cb.current.onSave(), onSend: (s) => cb.current.onSend(s) })),
        language.of([]),
        chrome,
        darkTheme.of(EditorView.darkTheme.of(dark)),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          reported.current = docText(u.state);
          cb.current.onChange(reported.current);
        }),
      ],
    });
    view.current = viewRef.current = v;
    let live = true;
    loadLanguage(path)?.then((l) => live && v.dispatch({ effects: language.reconfigure(l) }));
    return () => {
      live = false;
      v.destroy();
      if (viewRef.current === v) viewRef.current = undefined;
    };
  }, [path]);

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
