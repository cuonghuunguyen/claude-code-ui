// Shared editor tab state (docs/spec.md "Editor"): the Files tab and the file dialog are two views of one store, so open tabs, unsaved
// drafts, cursor and undo history survive Pop out and the way back. App creates one store; pure tab transitions stay in files.ts.
// Reuse: #399 (a file as a main-area tab) renders one path against this store; #366 (persist editor tabs) saves {paths, active, preview} from get().
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { FsMediaResult, FsReadResult, FsWriteResult } from "@claude-ui/protocol";
import type { connect, ConnectionStatus, RequestError } from "./client.ts";
import { baseName, inDir } from "./paths.ts";
import { diskChanged, dropTabs, isDirty, isMarkdown, mediaKind, movedPath, moveTabs, opened, openedMedia, pin, placeTab, readFailure, reload, saveBase, saved, type Tab } from "./files.ts";

type Client = ReturnType<typeof connect>;

export type EditorSnapshot = {
  /** Keyed by absolute path; insertion order is the tab order. */
  tabs: Record<string, Tab>;
  activePath?: string;
  /** A line to go to in `path`'s editor once it shows (`key` tells a repeat of the same line apart). */
  goto?: { path: string; line: number; key: number };
  /** A markdown file opened at a line shows its source for that open, whatever view is chosen (not stored). */
  sourceOnly?: string;
  /** The file being read for longer than 150 ms. */
  loading?: string;
  /** A failed open that is not a notice. */
  error?: string;
  /** Bumped after a save or an fs.changed: the file tree reads git marks again. */
  gitNudge: number;
};

export type OpenOptions = {
  cwd: string;
  preview?: boolean;
  line?: number;
  focusEditor?: boolean;
  /** A file outside the session folder: the file dialog lists it, the Files tab does not. */
  outside?: boolean;
};

export function createEditorStore(getClient: () => Client | undefined) {
  let state: EditorSnapshot = { tabs: {}, gitNudge: 0 };
  const listeners = new Set<() => void>();
  const parked = new Map<string, EditorState>();
  let openSeq = 0;
  /** The mounted editor (one at a time: the side panel shows none while the file dialog is open). */
  const view: { current: EditorView | undefined } = { current: undefined };

  const set = (f: (s: EditorSnapshot) => EditorSnapshot) => {
    const next = f(state);
    if (next === state) return;
    state = next;
    listeners.forEach((l) => l());
  };
  const client = () => {
    const c = getClient();
    if (!c) throw new Error("disconnected");
    return c;
  };
  const prune = () => {
    for (const p of [...parked.keys()]) if (!state.tabs[p]) parked.delete(p);
  };

  const update = (path: string, f: (t: Tab) => Tab) => set((s) => (s.tabs[path] ? { ...s, tabs: { ...s.tabs, [path]: f(s.tabs[path]) } } : s));
  const setTabs = (f: (tabs: Record<string, Tab>) => Record<string, Tab>) => set((s) => ({ ...s, tabs: f(s.tabs) }));

  const readTab = async (path: string) =>
    mediaKind(path) ? openedMedia(path, await client().request<FsMediaResult>({ type: "fs.media", path })) : opened(path, await client().request<FsReadResult>({ type: "fs.read", path }));

  /** SVG: the same file as text (editor) or as image. */
  async function switchView(path: string, toText: boolean) {
    try {
      const tab = toText ? opened(path, await client().request<FsReadResult>({ type: "fs.read", path })) : openedMedia(path, await client().request<FsMediaResult>({ type: "fs.media", path }));
      parked.delete(path);
      setTabs((ts) => (ts[path] ? { ...ts, [path]: ts[path]!.outside ? { ...tab, outside: true } : tab } : ts));
    } catch (e) {
      update(path, (t) => ({ ...t, error: readFailure(e as RequestError).text }));
    }
  }

  async function refresh(path: string) {
    try {
      if (state.tabs[path]?.media) {
        const m = await client().request<FsMediaResult>({ type: "fs.media", path });
        return update(path, (t) => ({ ...t, media: m, mtime: m.mtime, error: undefined, notice: undefined }));
      }
      const r = await client().request<FsReadResult>({ type: "fs.read", path });
      const before = state.tabs[path]?.draft;
      update(path, (t) => diskChanged(t, r));
      // The draft was replaced by the disk version: a parked state would hold the old document.
      if (state.tabs[path]?.draft !== before) parked.delete(path);
    } catch (e) {
      if ((e as Error).message === "disconnected") return;
      const f = readFailure(e as RequestError);
      // A clean tab shows the state instead of its stale text; a dirty one keeps its edits and shows the line.
      update(path, (t) => (f.notice && !isDirty(t) ? { ...t, error: undefined, notice: f.text, noticeHint: f.hint } : { ...t, error: f.text }));
    }
  }

  /** Opens `path` as a preview tab (italic, replaced by the next single-click open) unless `preview` is false. */
  async function open(path: string, o: OpenOptions) {
    const preview = o.preview ?? true;
    const scope = (p: string) => inDir(p, o.cwd) || !!state.tabs[p]?.outside;
    set((s) => ({ ...s, error: undefined, sourceOnly: !o.line && s.sourceOnly === path ? undefined : s.sourceOnly }));
    // Answers come back in any order: only the latest open may take the preview slot and the focus.
    const seq = ++openSeq;
    const make = (tab: Tab): Tab => (o.outside ? { ...tab, outside: true } : tab);
    if (state.tabs[path]) setTabs((ts) => (ts[path] ? placeTab(ts, ts[path], preview, scope) : ts));
    else {
      const timer = setTimeout(() => set((s) => ({ ...s, loading: path })), 150);
      try {
        const tab = make(await readTab(path));
        if (seq !== openSeq && preview) return;
        setTabs((ts) => placeTab(ts, ts[path] ?? tab, preview, scope));
      } catch (e) {
        if ((e as Error).message === "disconnected") return void set((s) => ({ ...s, error: "Not connected" }));
        const f = readFailure(e as RequestError);
        if (seq !== openSeq && preview) return;
        if (!f.notice) return set((s) => ({ ...s, error: f.text }));
        // A file that cannot be shown still gets a tab (closable, with its breadcrumb) that says why.
        setTabs((ts) => placeTab(ts, ts[path] ?? make({ path, disk: "", draft: "", mtime: 0, notice: f.text, noticeHint: f.hint }), preview, scope));
        return void set((s) => ({ ...s, activePath: path }));
      } finally {
        clearTimeout(timer);
        set((s) => (s.loading === path ? { ...s, loading: undefined } : s));
      }
    }
    set((s) => ({
      ...s,
      activePath: seq === openSeq ? path : s.activePath,
      sourceOnly: o.line && isMarkdown(path) ? path : s.sourceOnly,
      goto: o.line ? { path, line: o.line, key: (s.goto?.key ?? 0) + 1 } : s.goto,
    }));
    if (o.focusEditor) requestAnimationFrame(() => view.current?.focus());
  }

  async function save(path: string, overwrite = false) {
    const t = state.tabs[path];
    if (!t) return;
    const content = t.draft;
    try {
      const r = await client().request<FsWriteResult>({ type: "fs.write", path, content, baseMtime: saveBase(t, overwrite) });
      update(path, (t) => pin(saved(t, content, r.mtime)));
      set((s) => ({ ...s, gitNudge: s.gitNudge + 1 }));
    } catch (e) {
      update(path, (t) => ({ ...t, error: (e as Error).message }));
      void refresh(path); // a conflict error means a newer disk version; this shows it as a conflict
    }
  }

  function close(path: string) {
    const t = state.tabs[path];
    if (t && isDirty(t) && !confirm(`Discard unsaved changes to ${baseName(path)}?`)) return;
    setTabs(({ [path]: _, ...rest }) => rest);
    prune();
  }

  return {
    get: () => state,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    view,
    open,
    save,
    close,
    refresh,
    switchView,
    update,
    /** "Reload from disk" of a conflict. */
    reload(path: string) {
      update(path, reload);
      parked.delete(path);
    },
    setActive: (path: string) => set((s) => (s.activePath === path ? s : { ...s, activePath: path })),
    pin: (path: string) => update(path, pin),
    nudge: () => set((s) => ({ ...s, gitNudge: s.gitNudge + 1 })),
    setSourceOnly: (path: string | undefined) => set((s) => (s.sourceOnly === path ? s : { ...s, sourceOnly: path })),
    moved(from: string, to: string) {
      const entries = [...parked].map(([k, v]) => [movedPath(k, from, to), v] as const);
      parked.clear();
      entries.forEach(([k, v]) => parked.set(k, v));
      set((s) => ({ ...s, tabs: moveTabs(s.tabs, from, to), activePath: s.activePath && movedPath(s.activePath, from, to), goto: s.goto && { ...s.goto, path: movedPath(s.goto.path, from, to) } }));
      prune();
    },
    deleted(path: string) {
      setTabs((ts) => dropTabs(ts, path));
      prune();
    },
    clearGoto: () => set((s) => (s.goto ? { ...s, goto: undefined } : s)),
    clearError: () => set((s) => (s.error ? { ...s, error: undefined } : s)),
    /** A view that unmounts hands its editor state over (cursor, undo history); the tab's other view takes it on mount. */
    park(path: string, st: EditorState) {
      if (state.tabs[path]) parked.set(path, st);
    },
    /** The parked state of `path`, only while its document is still the tab's draft. */
    takeParked(path: string): EditorState | undefined {
      const st = parked.get(path);
      parked.delete(path);
      return st && st.sliceDoc() === state.tabs[path]?.draft ? st : undefined;
    },
  };
}

export type EditorStore = ReturnType<typeof createEditorStore>;

export const useEditorStore = (store: EditorStore): EditorSnapshot => useSyncExternalStore(store.subscribe, store.get);

/** The fs.watch list, fs.changed re-reads and the unsaved-edits unload warning; called by one mounted view (the Files tab). */
export function useEditorSync(store: EditorStore, client: Client, status: ConnectionStatus, watch: string[], enabled = true) {
  const { tabs } = useEditorStore(store);
  const paths = Object.keys(tabs);
  const watchPaths = [...new Set([...paths, ...watch])];
  const watchKey = watchPaths.join("\n");
  const watched = useRef(new Set<string>());
  const dirty = Object.values(tabs).some(isDirty);
  // Like an editor: leaving or reloading the page with unsaved edits asks first.
  useEffect(() => {
    if (!enabled || !dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, enabled]);
  useEffect(() => {
    if (!enabled) return;
    if (status !== "connected") return void watched.current.clear();
    // Re-read each newly watched path once the watch is armed: a change between the opening read (or while offline) and the watch baseline is not reported.
    const added = paths.filter((p) => !watched.current.has(p));
    watched.current = new Set(paths);
    client
      .request({ type: "fs.watch", paths: watchPaths })
      .then(() => added.forEach((p) => void store.refresh(p)))
      .catch(() => {});
  }, [status, watchKey, enabled]);
  useEffect(
    () =>
      enabled
        ? client.onFsChanged((m) => {
            if (!store.get().tabs[m.path]) return;
            void store.refresh(m.path);
            store.nudge();
          })
        : undefined,
    [client, enabled],
  );
}
