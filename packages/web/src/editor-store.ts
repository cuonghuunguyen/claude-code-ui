// Shared editor tab state (docs/spec.md "Editor"): the Files tab and the file dialog are two views of one store, so open tabs, unsaved
// drafts, cursor and undo history survive Pop out and the way back. App creates one store; pure tab transitions stay in files.ts.
// Reuse: #399 (a file as a main-area tab) renders one path against this store. #366: the tab list and drafts persist (editor-persist.ts) and restore() reads them back once connected.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { FsMediaResult, FsReadResult, FsWriteResult } from "@claude-ui/protocol";
import type { connect, ConnectionStatus, RequestError } from "./client.ts";
import { baseName, inDir } from "./paths.ts";
import { diskChanged, dropTabs, goneTab, isDirty, isMarkdown, mediaKind, movedPath, moveTabs, opened, openedMedia, pin, placeTab, readFailure, reload, restoredTab, saveBase, saved, type Tab } from "./files.ts";
import { loadSaved, toSaved, writeSaved, type EditorStorage, type SavedTab } from "./editor-persist.ts";

type Client = ReturnType<typeof connect>;

export type EditorSnapshot = {
  /** Keyed by absolute path; insertion order is the tab order. */
  tabs: Record<string, Tab>;
  activePath?: string;
  /** Paths by last activation, most recent first: the Files view of a folder shows its most recent tab (persisted). */
  recent: string[];
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
  /** A file tab (GH-399): the new tab is an item, pinned, and does not take Files' preview slot. */
  item?: boolean;
};

const WRITE_DELAY_MS = 300;
type Pending = { tab: SavedTab; draft?: { draft: string; mtime: number } };

export function createEditorStore(getClient: () => Client | undefined, storage: EditorStorage = { load: loadSaved, write: writeSaved }) {
  const loaded = storage.load();
  /** Saved tabs not read yet. Until restore() has run, nothing is written; entries still pending are merged into every write, so a draft is never erased. */
  const pending = new Map<string, Pending>(loaded.tabs.map((t) => [t.path, { tab: t, draft: loaded.drafts[t.path] }]));
  let restored = false;
  let restoring: Promise<void> | undefined;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  let state: EditorSnapshot = { tabs: {}, recent: loaded.recent, gitNudge: 0 };
  const listeners = new Set<() => void>();
  const parked = new Map<string, EditorState>();
  let openSeq = 0;
  /** The mounted editor (one at a time: the side panel shows none while the file dialog is open). */
  const view: { current: EditorView | undefined } = { current: undefined };

  const flush = () => {
    clearTimeout(writeTimer);
    writeTimer = undefined;
    if (!restored) return;
    const w = toSaved(state);
    for (const [path, p] of pending) {
      if (state.tabs[path]) continue;
      w.tabs.push(p.tab);
      if (p.draft) w.drafts[path] = p.draft;
    }
    w.active ??= pending.size ? loaded.active : undefined;
    w.recent = state.recent.filter((p) => state.tabs[p] || pending.has(p));
    storage.write(w);
  };
  const schedule = () => {
    if (!restored) return;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(flush, WRITE_DELAY_MS);
  };
  if (typeof window !== "undefined") window.addEventListener("pagehide", flush);

  const set = (f: (s: EditorSnapshot) => EditorSnapshot) => {
    let next = f(state);
    if (next === state) return;
    if (next.activePath && next.activePath !== state.activePath) next = { ...next, recent: [next.activePath, ...next.recent.filter((p) => p !== next.activePath)] };
    const persisted = next.tabs !== state.tabs || next.activePath !== state.activePath;
    state = next;
    if (persisted) schedule();
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

  /** `draft`: a saved draft of the file (GH-366). */
  const readTab = async (path: string, draft?: Pending["draft"]) =>
    mediaKind(path) ? openedMedia(path, await client().request<FsMediaResult>({ type: "fs.media", path })) : restoredTab(path, await client().request<FsReadResult>({ type: "fs.read", path }), draft);

  /** A saved entry read back: the tab, "keep" (disconnected: try again), or undefined (dropped). */
  async function readSaved(p: Pending): Promise<Tab | "keep" | undefined> {
    const { path } = p.tab;
    const flags = (t: Tab): Tab => ({ ...t, ...(p.tab.preview ? { preview: true } : {}), ...(p.tab.item ? { item: true } : {}), ...(p.tab.outside ? { outside: true } : {}) });
    try {
      return flags(await readTab(path, p.draft));
    } catch (e) {
      if ((e as Error).message === "disconnected") return "keep";
      const f = readFailure(e as RequestError);
      const code = (e as RequestError).code;
      if (p.draft) return flags(goneTab(path, p.draft, code === "not_found" || code === "path_not_allowed" ? undefined : f.text));
      // A file tab left to its own read (it shows the failure); a Files tab of a gone file is dropped silently.
      if (p.tab.item || !f.notice) return undefined;
      return flags({ path, disk: "", draft: "", mtime: 0, notice: f.text, noticeHint: f.hint });
    }
  }

  /** Once per page load, when connected: reads the saved tabs back (GH-366). Entries that could not be read for lack of a connection stay pending for the next call. */
  function restore(): Promise<void> {
    if (restoring) return restoring;
    if (restored && !pending.size) return Promise.resolve();
    const entries = [...pending.values()];
    const run = async () => {
      const read = await Promise.all(entries.map(async (p) => [p, await readSaved(p)] as const));
      const back: Record<string, Tab> = {};
      for (const [p, t] of read) {
        const { path } = p.tab;
        // Opened meanwhile (take over its draft in open()): not ours any more.
        if (pending.get(path) !== p || t === "keep") continue;
        pending.delete(path);
        if (t) back[path] = t;
      }
      restored = true;
      set((s) => ({
        ...s,
        tabs: { ...back, ...s.tabs },
        activePath: s.activePath ?? (loaded.active && (back[loaded.active] ?? s.tabs[loaded.active]) ? loaded.active : undefined),
      }));
      schedule();
    };
    return (restoring = run().finally(() => (restoring = undefined)));
  }

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
      if ((e as Error).message === "disconnected" || state.tabs[path]?.gone) return;
      const f = readFailure(e as RequestError);
      // A clean tab shows the state instead of its stale text; a dirty one keeps its edits and shows the line.
      update(path, (t) => (f.notice && !isDirty(t) ? { ...t, error: undefined, notice: f.text, noticeHint: f.hint } : { ...t, error: f.text }));
    }
  }

  /** Opens `path` as a preview tab (italic, replaced by the next single-click open) unless `preview` is false. */
  async function open(path: string, o: OpenOptions) {
    const preview = o.item ? false : (o.preview ?? true);
    const scope = (p: string) => inDir(p, o.cwd) || !!state.tabs[p]?.outside;
    set((s) => ({ ...s, error: undefined, sourceOnly: !o.line && s.sourceOnly === path ? undefined : s.sourceOnly }));
    // Answers come back in any order: only the latest open may take the preview slot and the focus.
    const seq = ++openSeq;
    const make = (tab: Tab): Tab => ({ ...tab, ...(o.outside ? { outside: true } : {}), ...(o.item ? { item: true } : {}) });
    // An open tab (say, from another project's Files tab) a Read card now opens from outside this folder is listed by the file dialog.
    if (state.tabs[path]) setTabs((ts) => (ts[path] ? placeTab(o.outside ? { ...ts, [path]: { ...ts[path]!, outside: true } } : ts, o.outside ? { ...ts[path]!, outside: true } : ts[path]!, preview, scope) : ts));
    else {
      const timer = setTimeout(() => set((s) => ({ ...s, loading: path })), 150);
      const saved = pending.get(path);
      pending.delete(path);
      try {
        const tab = make(await readTab(path, saved?.draft));
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
      // A deleted file (restored draft): create it, then write without a base version. If it came back meanwhile, its content meets the draft as a conflict.
      if (t.gone) {
        try {
          await client().request({ type: "fs.create", path });
        } catch (e) {
          if ((e as RequestError).code !== "exists") throw e;
          update(path, (t) => ({ ...t, gone: undefined, error: undefined }));
          return void refresh(path);
        }
      }
      const r = await client().request<FsWriteResult>({ type: "fs.write", path, content, baseMtime: t.gone ? undefined : saveBase(t, overwrite) });
      update(path, (t) => pin(saved({ ...t, gone: undefined }, content, r.mtime)));
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

  /** Drops tabs the caller already confirmed (a file tab closed, GH-399). */
  function discard(paths: string[]) {
    setTabs((ts) => Object.fromEntries(Object.entries(ts).filter(([p]) => !paths.includes(p))));
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
    discard,
    /** GH-399 Open in tab: the file leaves Files for its own tab, keeping draft and parked editor state; Files shows its next tab. */
    toItem(path: string) {
      set((s) => {
        const t = s.tabs[path];
        if (!t) return s;
        const tabs = { ...s.tabs, [path]: { ...pin(t), item: true } };
        const next = s.activePath === path ? Object.keys(tabs).find((p) => p !== path && !tabs[p]!.item) : s.activePath;
        return { ...s, tabs, activePath: next };
      });
    },
    /** Move to Files: the tab is a Files tab again and the active one. */
    toFiles(path: string) {
      set((s) => {
        const t = s.tabs[path];
        if (!t) return s;
        const { item: _, ...rest } = t;
        return { ...s, tabs: { ...s.tabs, [path]: rest }, activePath: path };
      });
    },
    refresh,
    restore,
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
