// File tree and CodeMirror editor tabs (docs/spec.md "Layout", "Editor"). Files are read and saved through the daemon.
import { useEffect, useRef, useState, type RefObject } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, type EditorState } from "@codemirror/state";
import { keymap, type KeyBinding } from "@codemirror/view";
import { selectLine } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { FsEntry, FsListResult, FsReadResult, FsWriteResult } from "@claude-ui/protocol";
import { ChevronDownIcon, ChevronRightIcon, RotateCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { connect, ConnectionStatus, RequestError } from "./client.ts";
import { matchesKey } from "./shortcuts.ts";
import { baseName, inDir } from "./paths.ts";
import { diskChanged, docText, isDirty, lineBreaks, opened, reload, readFailure, replaceDoc, saveBase, saved, selectionMention, type Tab } from "./files.ts";

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
}: {
  client: Client;
  status: ConnectionStatus;
  cwd: string;
  onSend: (mention: string) => void;
  openPath?: string;
  onOpened?: () => void;
  watch?: string[];
}) {
  const [tabs, setTabs] = useState<Record<string, Tab>>({});
  const [activePath, setActivePath] = useState<string>();
  const [showTree, setShowTree] = useState(true);
  const [treeKey, setTreeKey] = useState(0);
  const [error, setError] = useState<string>();
  /** The last opened file that cannot be shown (binary, too large, not UTF-8); it replaces the editor until a tab is chosen. */
  const [notice, setNotice] = useState<{ path: string; text: string }>();
  const editor = useRef<EditorView>(undefined);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const update = (path: string, f: (t: Tab) => Tab) => setTabs((ts) => (ts[path] ? { ...ts, [path]: f(ts[path]) } : ts));

  async function refresh(path: string) {
    try {
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
        const r = await client.request<FsReadResult>({ type: "fs.read", path });
        setTabs((ts) => ({ ...ts, [path]: ts[path] ?? opened(path, r) }));
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
          onClick={() => setShowTree((s) => !s)}
          aria-expanded={showTree}
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
          <div className="flex items-center gap-2 border-b px-2 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={active.path}>
              {active.path.slice(cwd.length + 1) || active.path}
            </span>
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
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "var(--font-mono, monospace)" } }),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          reported.current = docText(u.state);
          cb.current.onChange(reported.current);
        }),
      ],
    });
    view.current = viewRef.current = v;
    let live = true;
    LanguageDescription.matchFilename(languages, baseName(path))
      ?.load()
      .then((l) => live && v.dispatch({ effects: language.reconfigure(l) }));
    return () => {
      live = false;
      v.destroy();
      if (viewRef.current === v) viewRef.current = undefined;
    };
  }, [path]);

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
