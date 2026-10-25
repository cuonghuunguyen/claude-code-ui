// File tree and CodeMirror editor tabs (docs/spec.md "Layout", "Editor"). Files are read and saved through the daemon.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { gotoLine } from "@codemirror/search";
import { keymap, type KeyBinding } from "@codemirror/view";
import { selectLine } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import type { FsMediaResult } from "@claude-ui/protocol";
import { ChevronDownIcon, ChevronRightIcon, ChevronsDownUpIcon, LocateFixedIcon, Maximize2Icon, RotateCwIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { useNarrow } from "@/lib/use-narrow.ts";
import { useContainerWidth } from "@/lib/use-container-width.ts";
import { cn } from "@/lib/utils";
import { trapTab } from "./focus-trap.ts";
import type { connect, ConnectionStatus } from "./client.ts";
import { matchesKey } from "./shortcuts.ts";
import { useDark } from "./theme.ts";
import { loadLanguage, syntaxStyle } from "./code-theme.ts";
import { baseName, inDir, relPath } from "./paths.ts";
import type { RepoList } from "./repo-choice.ts";
import { MediaView } from "./media-view.tsx";
import { FileIcon } from "./file-icon.tsx";
import { FILE_LINK_PROPS, FileBaseContext, FileImageContext, FileLinkContext } from "./file-links.tsx";
import { FileTree, type FileTreeHandle } from "./file-tree.tsx";
import { ListResizer, loadListWidth, saveListWidth } from "./changes-panel.tsx";
import { docText, isDirty, isMarkdown, lineBreaks, loadMdView, mediaKind, pin, fileMention, replaceDoc, saveMdView, selectionMention, type MdView } from "./files.ts";
import { createEditorStore, useEditorStore, useEditorSync, type EditorStore } from "./editor-store.ts";

type Client = ReturnType<typeof connect>;

/** Panel width from which the tree sits beside the editor (Tailwind's `@2xl`, the Changes tab's list rule); below it the tree is a drawer. */
export const TREE_BESIDE_PX = 672;
const TREE_WIDTH_KEY = "claude-ui.filesTreeWidth";

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
  onCopy,
  onViewer,
  onShowChanges,
  repos,
  onShowGraph,
  openPath,
  openLine,
  onOpened,
  watch = [],
  showTree,
  onToggleTree,
  gitStamp,
  visible = true,
  editors,
  surface = "panel",
  suspended,
  onPopOut,
  onOpenInFiles,
  headerEnd,
}: {
  client: Client;
  status: ConnectionStatus;
  cwd: string;
  onSend: (mention: string) => void;
  /** File tree menu: Copy path / Copy relative path. */
  onCopy?: (text: string, what: string) => void;
  /** File tree menu: Open in file dialog. */
  onViewer?: (path: string) => void;
  /** File tree menu: Show changes. */
  onShowChanges?: (path: string) => void;
  /** The repositories of the cwd: the tree marks each file with its own repository's status. */
  repos?: RepoList;
  /** Show graph on a repository folder (the tree sets the repository selector first). */
  onShowGraph?: () => void;
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
  /** The shared editor state (tabs, drafts, cursor); App owns one so the Files tab and the file dialog show the same. Default: the panel's own. */
  editors?: EditorStore;
  /** "dialog": the file dialog's body (lists tabs of files outside `cwd` too, no sync, no Pop out). */
  surface?: "panel" | "dialog";
  /** The file dialog is open: the tabs show but no editor mounts, so a tab has one EditorView at a time. */
  suspended?: boolean;
  /** Pop out: the file dialog opens on the shared state. */
  onPopOut?: () => void;
  /** Open in editor (dialog only, for a file inside `cwd`): close the dialog and show the Files tab. */
  onOpenInFiles?: () => void;
  headerEnd?: ReactNode;
}) {
  const [own] = useState(() => (editors ? undefined : createEditorStore(() => client)));
  const store = (editors ?? own)!;
  const { tabs, activePath, gitNudge, sourceOnly, error, loading, goto } = useEditorStore(store);
  const [treeKey, setTreeKey] = useState(0);
  const [filtering, setFiltering] = useState(false);
  const tree = useRef<FileTreeHandle>(undefined);
  const [mdView, setMdView] = useState<MdView>(loadMdView);
  const narrow = useNarrow();
  const editor = store.view;
  const dialog = surface === "dialog";
  const update = store.update;
  const save = store.save;
  const close = store.close;
  const open = (path: string, opts: { preview?: boolean; line?: number; focusEditor?: boolean } = {}) => store.open(path, { cwd, ...opts });

  useEffect(() => {
    if (!openPath) return;
    void open(openPath, { line: openLine });
    onOpened?.();
  }, [openPath]);

  const paths = Object.keys(tabs);
  useEditorSync(store, client, status, watch, !dialog);

  const openRef = useRef(open);
  openRef.current = open;
  const openLink = useCallback((path: string, line?: number) => void openRef.current(path, { line }), []);
  const imageUrl = useCallback((path: string) => client.request<FsMediaResult>({ type: "fs.media", path }).then((m) => m.url), [client]);
  const shown = paths.filter((p) => inDir(p, cwd) || (dialog && tabs[p]!.outside));
  const active = activePath && shown.includes(activePath) ? tabs[activePath] : tabs[shown[0]!];
  const rootRef = useRef<HTMLDivElement>(null);
  const treeColumn = useRef<HTMLDivElement>(null);
  const filesButton = useRef<HTMLButtonElement>(null);
  const width = useContainerWidth(rootRef);
  /** Unmeasured counts as wide, like useNarrow without matchMedia. */
  const wide = width === undefined || width >= TREE_BESIDE_PX;
  const [treeWidth, setTreeWidth] = useState(() => loadListWidth(TREE_WIDTH_KEY));
  // Below the threshold the tree is a drawer: open (whatever its state) while no file shows, closed when one appears. The Files button and a change of `showTree` (Toggle file tree, Ctrl+\) flip it; it never writes `showTree`.
  const [drawer, setDrawer] = useState(false);
  const lastShowTree = useRef(showTree);
  const undoing = useRef(false);
  useEffect(() => {
    if (lastShowTree.current === showTree) return;
    lastShowTree.current = showTree;
    if (undoing.current) return void (undoing.current = false);
    if (wide) return;
    setDrawer((d) => !d);
    // The app flipped its kept "tree shown" setting, which is the beside layout's: flip it back (the drawer has its own state).
    undoing.current = true;
    onToggleTree();
  }, [showTree]);
  // Back to the beside layout: the drawer starts closed the next time the panel is narrow.
  useEffect(() => {
    if (wide) setDrawer(false);
  }, [wide]);
  const md = !!active && !active.media && isMarkdown(active.path);
  /** Split needs room: below md it shows Preview. */
  const view: MdView = !md ? "source" : sourceOnly === active!.path ? "source" : mdView === "split" && narrow ? "preview" : mdView;
  const previewDoc = useDeferredValue(active?.draft ?? "");
  const previewBase = useMemo(() => ({ base: active ? active.path.slice(0, Math.max(active.path.length - baseName(active.path).length - 1, 1)) : cwd, root: cwd }), [active?.path, cwd]);
  useEffect(() => editor.current?.requestMeasure(), [view]);
  /** Pop out in the Files tab, Open in editor in the file dialog (for a file inside `cwd`): the file view's way to the other place. */
  const placeButton = !active ? null : dialog ? (
    inDir(active.path, cwd) && onOpenInFiles && (
      <Button size="sm" variant="ghost" onClick={onOpenInFiles} className="max-md:h-11 pointer-coarse:h-11" data-testid="open-in-editor">
        <SquareArrowOutUpRightIcon /> Open in editor
      </Button>
    )
  ) : (
    onPopOut && (
      <Button size="icon-sm" variant="ghost" onClick={onPopOut} title="Pop out" aria-label="Pop out to file dialog" className="max-md:size-11 pointer-coarse:size-11" data-testid="files-popout">
        <Maximize2Icon />
      </Button>
    )
  );
  const refused = active?.notice ? { path: active.path, text: active.notice, hint: active.noticeHint } : undefined;
  // No file open: the tree takes the whole panel (both layouts); with a file it is beside the editor, or a drawer over it when narrow.
  const empty = !refused && !active;
  const treeShown = wide ? showTree : drawer || empty;
  const overlay = treeShown && !wide && !empty;
  const closeDrawer = (refocus?: boolean) => {
    setDrawer(false);
    if (refocus) filesButton.current?.focus();
  };
  const drawerRef = useRef<HTMLDivElement>(null);
  /** A breadcrumb folder opened the drawer: the tree reveals that folder, not the active file. */
  const folderReveal = useRef(false);
  // The first file to show (opened from anywhere) puts the drawer away: it is open on its own only while no file shows.
  useEffect(() => {
    if (!empty) setDrawer(false);
  }, [empty]);
  useEffect(() => {
    if (!overlay) return;
    drawerRef.current?.focus();
    if (folderReveal.current) folderReveal.current = false;
    else if (activePath) void tree.current?.reveal(activePath, true);
  }, [overlay]);
  const toggleTree = () => (wide ? onToggleTree() : setDrawer((d) => !d));

  /** Breadcrumb folder: show the tree, then reveal the folder in it. */
  function revealFolder(dir: string) {
    if (!wide) {
      folderReveal.current = true;
      setDrawer(true);
    } else if (!showTree) onToggleTree();
    requestAnimationFrame(() => void tree.current?.reveal(dir, true, true));
  }

  const treeNav = (
    <nav
          className="flex min-h-0 flex-1 flex-col overflow-auto py-1 font-mono text-xs"
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
            visible={visible && !suspended && treeShown}
            gitNudge={gitNudge}
            handleRef={tree}
            onFilter={setFiltering}
            onCopy={onCopy}
            onViewer={dialog ? undefined : onViewer}
            onShowChanges={onShowChanges}
            repos={repos}
            onShowGraph={onShowGraph}
            onMention={(p) => onSend(fileMention(p, cwd))}
            onReload={() => setTreeKey((k) => k + 1)}
            onChanged={store.nudge}
            onMoved={store.moved}
            onDeleted={store.deleted}
            dirtyUnder={(path) => Object.values(store.get().tabs).filter((t) => isDirty(t) && inDir(t.path, path)).length}
            onOpen={(path, o) => (overlay && setDrawer(false), void open(path, { preview: !o.pinned, focusEditor: o.focusEditor }))}
          />
        </nav>
  );

  return (
    <div ref={rootRef} className="@container flex min-h-0 flex-1 flex-col" data-testid="files-panel" data-layout={wide ? "beside" : "drawer"}>
      <div className="flex items-center gap-1 border-b px-2 py-1 text-xs">
        <Button
          ref={filesButton}
          size="xs"
          variant="ghost"
          onClick={toggleTree}
          className="max-md:h-11 pointer-coarse:h-11"
          aria-expanded={treeShown}
          aria-controls="file-tree"
          data-testid="toggle-tree"
        >
          {treeShown ? <ChevronDownIcon /> : <ChevronRightIcon />} Files
        </Button>
        {treeShown && (
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
          className={`${treeShown ? "" : "ml-auto "}max-md:size-11 pointer-coarse:size-11`}
          onClick={() => setTreeKey((k) => k + 1)}
          title="Reload the file tree"
          aria-label="Reload the file tree"
        >
          <RotateCwIcon />
        </Button>
        {headerEnd}
      </div>
      {error && <p className="px-2 py-1 text-destructive text-xs">{error}</p>}
      <div className={cn("relative flex min-h-0 flex-1", empty && treeShown ? "flex-col" : "flex-row")}>
      {wide && treeShown && (
        <div
          ref={treeColumn}
          className={cn("flex min-h-0 flex-col", empty ? "flex-1" : cn("shrink-0 border-r", !treeWidth && "w-50 @2xl:w-60"))}
          style={!empty && treeWidth ? { width: `min(${treeWidth}px, calc(100% - 240px))` } : undefined}
        >
          {treeNav}
        </div>
      )}
      {wide && treeShown && !empty && (
        <ListResizer list={treeColumn} width={treeWidth} onResize={(w) => (setTreeWidth(w), saveListWidth(w, TREE_WIDTH_KEY))} label="Resize file tree" testId="files-tree-resizer" />
      )}
      {overlay && <div className="absolute inset-0 z-10 bg-overlay/40" onClick={() => closeDrawer(true)} data-testid="file-tree-scrim" />}
      {/* Narrow: one container, so the tree keeps its folders and filter while the drawer is closed (hidden, not unmounted) or no file is open (it then fills the panel). */}
      {!wide && (
        <div
          ref={drawerRef}
          hidden={!treeShown}
          tabIndex={empty ? undefined : -1}
          role={empty ? undefined : "region"}
          aria-label={empty ? undefined : "File tree"}
          className={cn("flex flex-col outline-none", empty ? "min-h-0 flex-1" : "absolute inset-y-0 left-0 z-20 w-[min(320px,85%)] border-r bg-card shadow-floating")}
          data-testid={empty ? undefined : "file-tree-drawer"}
          onKeyDown={(e) => {
            if (!overlay) return;
            if (e.key === "Escape" && !e.defaultPrevented) return (e.preventDefault(), closeDrawer(true));
            trapTab(e);
          }}
        >
          {treeNav}
        </div>
      )}
      <div inert={overlay} className={cn("flex min-h-0 min-w-0 flex-col", empty && treeShown ? "flex-none" : "flex-1")}>
      {shown.length > 0 && (
        <div className="flex h-9 shrink-0 overflow-x-auto border-b bg-card text-xs max-md:h-auto" role="tablist" aria-label="Editor tabs">
          {shown.map((p) => {
            const t = tabs[p]!;
            return (
              <div
                key={p}
                role="tab"
                aria-selected={t === active}
                data-testid="editor-tab"
                className={cn("flex shrink-0 items-center gap-1.5 pl-2 text-muted-foreground hover:bg-accent hover:text-foreground", t === active && "bg-secondary text-foreground")}
                title={p}
              >
                <button
                  className={cn("flex items-center gap-1.5 py-1.5 max-md:min-h-11 max-md:min-w-11", t.preview && "italic")}
                  aria-label={t.preview ? `${baseName(p)}, preview` : undefined}
                  onClick={() => store.setActive(p)}
                  onDoubleClick={() => update(p, pin)}
                  onAuxClick={(e) => e.button === 1 && (e.preventDefault(), close(p))}
                >
                  <FileIcon path={p} className="size-4 shrink-0" />
                  <span>
                    {baseName(p)}
                    {isDirty(t) && <span aria-label="unsaved"> ●</span>}
                    {t.conflict && <span className="text-warning"> !</span>}
                  </span>
                </button>
                <button
                  className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground max-md:size-11 pointer-coarse:size-11"
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
      {suspended ? (
        <p className="m-auto p-4 text-muted-foreground text-sm" role="status" data-testid="files-suspended">
          Open in the file dialog
        </p>
      ) : loading && !active ? (
        <p className="m-auto p-4 text-muted-foreground text-sm" role="status" data-testid="file-loading">
          Loading file…
        </p>
      ) : refused ? (
        <>
        {placeButton && <div className="flex min-h-10 shrink-0 items-center justify-end border-b px-3 py-1" data-testid="file-path-header">{placeButton}</div>}
        <div className="m-auto flex max-w-full flex-col items-center gap-1 p-4 text-center" data-testid="file-notice" role="status">
          <FileIcon path={refused.path} className="mb-1 size-8" />
          <div className="w-full max-w-full text-xs">
            <Breadcrumb path={refused.path} cwd={cwd} onFolder={revealFolder} />
          </div>
          <span className="text-foreground text-sm">{refused.text}</span>
          {refused.hint && <span className="text-muted-foreground text-xs">{refused.hint}</span>}
        </div>
        </>
      ) : active ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {active.conflict && (
            <div
              className="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-2 py-1.5 text-xs"
              role="alert"
              data-testid="editor-conflict"
            >
              <span className="flex-1">Changed on disk while you have unsaved edits.</span>
              <Button size="xs" variant="outline" className="max-md:h-11 pointer-coarse:h-11" onClick={() => store.reload(active.path)}>
                Reload from disk
              </Button>
              <Button size="xs" variant="outline" className="max-md:h-11 pointer-coarse:h-11" onClick={() => void save(active.path, true)}>
                Overwrite with mine
              </Button>
            </div>
          )}
          {active.error && <p className="border-b px-2 py-1 text-destructive text-xs">{active.error}</p>}
          {active.media ? (
            <>
              {placeButton && <div className="flex min-h-10 shrink-0 items-center justify-end border-b px-3 py-1" data-testid="file-path-header">{placeButton}</div>}
              <MediaView
                key={active.media.url}
                path={active.path}
                media={active.media}
                onShowSource={mediaKind(active.path) === "svg" ? () => void store.switchView(active.path, true) : undefined}
              />
            </>
          ) : (
            <>
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1 text-xs" data-testid="file-path-header">
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
                    onClick={() => (store.setSourceOnly(undefined), setMdView(m), saveMdView(m))}
                    data-testid={`md-view-${m}`}
                  >
                    {m === "source" ? "Source" : m === "preview" ? "Preview" : "Split"}
                  </Button>
                ))}
              </div>
            )}
            {mediaKind(active.path) === "svg" && (
              <Button size="xs" variant="outline" disabled={isDirty(active)} onClick={() => void store.switchView(active.path, false)} className="max-md:h-11 pointer-coarse:h-11">
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
            {placeButton}
          </div>
          <div className="flex min-h-0 flex-1">
            <div className={`min-h-0 min-w-0 flex-1 flex-col ${view === "preview" ? "hidden" : "flex"}`}>
          <CodeEditor
            key={active.path}
            store={store}
            path={active.path}
            doc={active.draft}
            viewRef={editor}
            onSend={(state) => onSend(selectionMention(state, active.path, cwd))}
            onChange={(draft) => update(active.path, (t) => ({ ...pin(t), draft }))}
            goto={goto?.path === active.path ? goto : undefined}
            onGoto={store.clearGoto}
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
        !treeShown && <p className="m-auto p-4 text-muted-foreground text-sm" data-testid="files-empty">Open a file from the tree.</p>
      )}
      </div>
      </div>
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

/** Editor chrome on the app tokens (the panel is a card); `darkTheme` still drives CodeMirror's base theme for what is not listed here (search matches). */
export const chromeTheme = {
  "&": { height: "100%", color: "var(--foreground)", backgroundColor: "var(--card)" },
  // The diff's text metrics (@pierre/diffs: 13px mono on 20px lines, 8px above and below, tab size 2). Below lg 16px / 24px stays: iOS zooms into smaller focused text.
  ".cm-scroller": { fontFamily: "var(--font-mono, monospace)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0", tabSize: "2" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  // Gutter like the diff's: no rule, line numbers in --diffs-fg-number's mix, numbers 1ch apart from the code and at least 3ch wide.
  ".cm-gutters": { backgroundColor: "var(--card)", color: "color-mix(in lab, var(--foreground) 65%, var(--card))", borderRight: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 1ch", minWidth: "3ch" },
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
  "@media (width < 64rem)": { ".cm-scroller": { lineHeight: "24px" } },
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

const languageC = new Compartment();
const darkC = new Compartment();
const wiringC = new Compartment();

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
  store,
}: {
  path: string;
  doc: string;
  /** The shared editor store: the view parks its state (cursor, undo history) here on unmount and takes it back on mount. */
  store?: EditorStore;
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

  useEffect(() => {
    // One state per tab outlives its views: Files tab and file dialog share it through the store. The compartments are module-level
    // because a parked state holds them; the wiring (keys, change listener) is reconfigured to this mount's callbacks.
    const wiring = () => [
      Prec.high(keymap.of(editorKeys({ onSave: () => cb.current.onSave(), onSend: (s) => cb.current.onSend(s) }))),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        reported.current = docText(u.state);
        cb.current.onChange(reported.current);
      }),
    ];
    const parkedState = readOnly ? undefined : store?.takeParked(path);
    const v = new EditorView({
      parent: host.current!,
      ...(parkedState
        ? { state: parkedState }
        : {
            doc,
            extensions: [
              basicSetup,
              lineBreaks(doc),
              wiringC.of(wiring()),
              languageC.of([]),
              chrome,
              darkC.of(EditorView.darkTheme.of(dark)),
              readOnly ? EditorState.readOnly.of(true) : [],
              tabbable ? EditorView.contentAttributes.of({ tabindex: "0", "aria-label": `${baseName(path)}, read-only` }) : [],
            ],
          }),
    });
    // The restored view starts at line 1: scroll to the restored cursor.
    if (parkedState) v.dispatch({ effects: [wiringC.reconfigure(wiring()), darkC.reconfigure(EditorView.darkTheme.of(dark)), EditorView.scrollIntoView(v.state.selection.main.head, { y: "center" })] });
    view.current = viewRef.current = v;
    if (line && !parkedState) {
      const l = v.state.doc.line(Math.min(line, v.state.doc.lines));
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start" }) });
    }
    let live = true;
    loadLanguage(path)?.then((l) => live && v.dispatch({ effects: languageC.reconfigure(l) }));
    return () => {
      live = false;
      if (!readOnly) store?.park(path, v.state);
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

  useEffect(() => view.current?.dispatch({ effects: darkC.reconfigure(EditorView.darkTheme.of(dark)) }), [dark]);

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
