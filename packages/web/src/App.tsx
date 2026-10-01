import { Activity, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { CheckIcon, CopyIcon, MenuIcon, MonitorIcon, MoonIcon, RotateCcwIcon, SearchIcon, SquareIcon, SunIcon } from "lucide-react";
import type {
  CreateResult,
  Effort,
  Event,
  FsEntry,
  FsListResult,
  FsSearchResult,
  ListResult,
  ModelInfo,
  ModelsResult,
  Part,
  PermissionMode,
  RewindMode,
  RewindPreview,
  RespondResult,
  SessionInfo,
  SessionListItem,
  SetModelResult,
  SubscribeResult,
  UploadResult,
} from "@claude-ui/protocol";
import { isPromptImage, MAX_UPLOAD_BYTES } from "@claude-ui/protocol";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { connect, type ConnectionStatus, type Request, type RequestError } from "./client.ts";
import { ImageStrip, readDataUrl, readImages } from "./images.tsx";
import { nextMode, PromptToolbar } from "./toolbar.tsx";
import { choose, matchCommands } from "./commands.ts";
import { activeMention, insertAtCaret, insertMention, mentionPath } from "./mentions.ts";
import { SessionList } from "./sidebar.tsx";
import { rewindOptions } from "./rewind.ts";
import { useSmoothText } from "./smooth.ts";
import { disablePush, enablePush, pushSubscription, pushSupported, sendSubscription } from "./push.ts";
import { isUnread, loadSeen, saveSeen, seenNow, tabTitle, type Seen } from "./unread.ts";
import { PermissionPanel, type PermissionAnswer } from "./permission.tsx";
import { QuestionMarker, QuestionPanel } from "./question.tsx";
import { applyEvent, awaitingPermission, emptySession, pendingPermission, pendingQuestion, timeline, withEpoch, type SessionView, type ToolCall } from "./store.ts";
import { ContextGroup, CwdContext, SubagentGroup, TodoList, ToolCard } from "./tool-card.tsx";
import { relPath } from "./tools.ts";
import { FilesPanel } from "./files-panel.tsx";
import { QuickOpen, isQuickOpenKey, quickOpenLabel } from "./quick-open.tsx";
import { NEW_TAB, avatarColors, closeTab, loadTabs, moveTab, openTab, projectName, replaceTab, saveTabs, staleTabs, tabFromHash, tabHash } from "./tabs.ts";
import { AvatarColors, IconButton, ProjectAvatar, TabsBar } from "./tabs-bar.tsx";
import { applyTheme, loadPref, nextPref, type ThemePref } from "./theme.ts";

type Client = ReturnType<typeof connect>;

// The active tab lives in the URL hash, so a reload reopens it.
const hashTab = () => tabFromHash(location.hash);
const hashId = () => (hashTab() === NEW_TAB ? undefined : hashTab());

const pageFocused = () => document.visibilityState === "visible" && document.hasFocus();

/** True while this tab is visible and has focus: the only case in which a session counts as seen. */
function usePageFocused() {
  const [focused, setFocused] = useState(pageFocused);
  useEffect(() => {
    const update = () => setFocused(pageFocused());
    const events = ["focus", "blur", "visibilitychange"] as const;
    events.forEach((e) => window.addEventListener(e, update));
    return () => events.forEach((e) => window.removeEventListener(e, update));
  }, []);
  return focused;
}

export function App() {
  const [list, setList] = useState<SessionListItem[]>([]);
  const [views, setViews] = useState<Record<string, SessionView>>({});
  // Active tab: a session id or NEW_TAB.
  const [activeId, setActiveId] = useState(hashTab);
  const [tabs, setTabs] = useState(() => {
    const h = hashTab();
    return h ? openTab(loadTabs(), h) : loadTabs();
  });
  const [theme, setTheme] = useState<ThemePref>(loadPref);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<ConnectionStatus>("reconnecting");
  const [drawer, setDrawer] = useState(false);
  // Wide screens: the Home button shows or hides the sessions sidebar.
  const [sidebar, setSidebar] = useState(true);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // Replies to subscribe / create / setModel: the freshest SessionInfo, incl. model.
  const [infos, setInfos] = useState<Record<string, SessionInfo>>({});
  const [seen, setSeen] = useState<Record<string, Seen>>(loadSeen);
  const [pushOn, setPushOn] = useState(false);
  // Per session, bumped by a notification click: remounts its conversation, which starts scrolled to the bottom.
  const [scrollKeys, setScrollKeys] = useState<Record<string, number>>({});
  const focused = usePageFocused();
  // Narrow screens show one pane; wide screens show the session plus a side panel with changes or files.
  // Per session tab, so switching tabs keeps each one's pane.
  const [panes, setPanes] = useState<Record<string, Pane>>({});
  const pane = (activeId && panes[activeId]) || "session";
  const setPane = (p: Pane) => activeId && setPanes((x) => ({ ...x, [activeId]: p }));
  const [panelWidth, setPanelWidth] = useState(480);
  // A mention from "Send selection to Claude", waiting for the prompt box to take it.
  const [insert, setInsert] = useState<string>();
  // Quick open, and the file it asks the files panel to open (absolute path).
  const [quickOpen, setQuickOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string>();
  const quickOpener = useRef<Element>(null);
  const client = useRef<Client>(undefined);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const requested = useRef(new Set<string>());
  // Tabs restored from storage, checked against the first session list: a stale one would show "Untitled".
  const restored = useRef<string[] | undefined>(tabs);

  async function refreshList() {
    try {
      const { sessions } = await client.current!.request<ListResult>({ type: "session.list" });
      setList(sessions);
      if (restored.current) {
        for (const id of staleTabs(restored.current, new Set(sessions.map((s) => s.id)))) forget(id);
        restored.current = undefined;
      }
      // Live sessions are followed so their unread markers update without opening them.
      // ponytail: replays every live session's log into this tab; follow state only if that gets heavy.
      for (const s of sessions)
        if (s.state !== "closed" && !viewsRef.current[s.id] && !requested.current.has(s.id)) requested.current.add(s.id), void subscribe(s.id);
    } catch (e) {
      if ((e as Error).message !== "disconnected") setError((e as Error).message);
    }
  }

  // Replays events after the view's last seq, or everything when the daemon restarted (new logEpoch).
  // A session that is not live in the daemon is rebuilt from its transcript and resumes with the same ID on the next prompt.
  async function subscribe(sessionId: string) {
    const view = viewsRef.current[sessionId];
    try {
      const r = await client.current!.request<SubscribeResult>({
        type: "session.subscribe",
        sessionId,
        sinceSeq: view?.lastSeq ?? 0,
        logEpoch: view?.logEpoch,
      });
      // Runs before the replayed events: the reply precedes them on the socket and this continuation is a microtask.
      setViews((v) => ({ ...v, [sessionId]: withEpoch(v[sessionId] ?? emptySession(), r.logEpoch) }));
      setInfos((i) => ({ ...i, [sessionId]: r.session }));
    } catch (e) {
      // Gone from the daemon, e.g. never prompted before a daemon restart (no transcript): drop it from this tab.
      if ((e as RequestError).code === "unknown_session") return forget(sessionId);
      if ((e as Error).message !== "disconnected") setError((e as Error).message); // else resubscribed on reconnect
    }
  }

  function forget(sessionId: string) {
    const without = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([id]) => id !== sessionId));
    setViews(without);
    setInfos(without);
    requested.current.delete(sessionId);
    setList((l) => l.filter((s) => s.id !== sessionId));
    setTabs((t) => t.filter((id) => id !== sessionId));
    if (hashId() === sessionId) {
      setActiveId(undefined);
      history.replaceState(null, "", location.pathname + location.search);
      setError("That session no longer exists in the daemon.");
    }
  }

  /** Opens or focuses a tab; `undefined` shows no tab. Only a session tab goes into the URL hash. */
  function open(id: string | undefined) {
    setError(undefined);
    setActiveId(id);
    setDrawer(false);
    if (!id) return;
    setTabs((t) => openTab(t, id));
    history.replaceState(null, "", tabHash(id));
    if (id !== NEW_TAB && !viewsRef.current[id]) void subscribe(id);
  }

  /** Closes the tab only: the session keeps running and stays in the sidebar. */
  function close(id: string) {
    const r = closeTab(tabs, id, activeId);
    setTabs(r.tabs);
    if (r.active === activeId) return;
    open(r.active);
    if (!r.active) history.replaceState(null, "", location.pathname + location.search);
  }

  useEffect(() => {
    const c = connect({
      onEvent: (e: Event) => {
        setViews((v) => ({ ...v, [e.sessionId]: applyEvent(v[e.sessionId] ?? emptySession(), e) }));
        // New titles and last activity come from the transcript; refresh when a session changes state.
        if (e.part.type === "session_state") void refreshList();
      },
      onOpen: () => {
        void refreshList();
        const ids = new Set(Object.keys(viewsRef.current));
        const h = hashId();
        if (h) ids.add(h);
        ids.forEach((id) => void subscribe(id));
        c.request<ModelsResult>({ type: "models.list" }).then(
          (r) => setModels(r.models),
          (e: Error) => e.message !== "disconnected" && setError(`models: ${e.message}`),
        );
        void pushSubscription().then((sub) => {
          setPushOn(!!sub);
          if (sub) sendSubscription(c, sub).catch(() => {});
        });
      },
      onStatus: setStatus,
    });
    client.current = c;
    // Picks up sessions started in the terminal CLI meanwhile.
    const onFocus = () => void refreshList();
    window.addEventListener("focus", onFocus);
    // Notification click (sw.js): open the session at the bottom.
    const onWorkerMessage = (e: MessageEvent) => {
      if (e.data?.type !== "open" || typeof e.data.sessionId !== "string") return;
      const id: string = e.data.sessionId;
      open(id);
      setScrollKeys((k) => ({ ...k, [id]: (k[id] ?? 0) + 1 }));
    };
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    return () => {
      window.removeEventListener("focus", onFocus);
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
      c.close();
    };
  }, []);

  // The daemon suppresses pushes for the session a focused, visible tab shows; resent after every reconnect.
  useEffect(() => {
    if (status !== "connected") return;
    const sessionId = focused && activeId !== NEW_TAB ? activeId : undefined;
    client.current!.request(sessionId ? { type: "push.focus", sessionId } : { type: "push.focus" }).catch(() => {});
  }, [status, focused, activeId]);

  const activeView = activeId ? views[activeId] : undefined;
  useEffect(() => {
    if (!focused || !activeId || !activeView || !isUnread(activeView, seen[activeId])) return;
    const next = { ...seen, [activeId]: seenNow(activeView) };
    setSeen(next);
    saveSeen(next);
  }, [focused, activeId, activeView?.lastSeq]);

  useEffect(() => saveTabs(tabs), [tabs]);
  useEffect(() => applyTheme(theme), [theme]);

  const unread = new Set(list.filter((s) => views[s.id] && isUnread(views[s.id]!, seen[s.id])).map((s) => s.id));
  useEffect(() => void (document.title = tabTitle(unread.size)), [unread.size]);

  async function togglePush() {
    setError(undefined);
    try {
      if (pushOn) await disablePush();
      else await enablePush(client.current!);
      setPushOn(!pushOn);
    } catch (e) {
      setError(`notifications: ${(e as Error).message}`);
    }
  }

  async function createSession(cwd: string, model: string) {
    setError(undefined);
    try {
      const { session } = await client.current!.request<CreateResult>({ type: "session.create", cwd, model });
      setInfos((i) => ({ ...i, [session.id]: session }));
      setTabs((t) => replaceTab(t, NEW_TAB, session.id));
      open(session.id);
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** session.setModel, session.setPermissionMode, session.setEffort: the reply carries the new SessionInfo. */
  async function configure(msg: Extract<Request, { type: "session.setModel" | "session.setPermissionMode" | "session.setEffort" }>) {
    setError(undefined);
    try {
      const { session } = await client.current!.request<SetModelResult>(msg);
      setInfos((i) => ({ ...i, [session.id]: session }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // The daemon's settlement event updates every tab; `settled: false` means another tab answered first.
  async function respond(requestId: string, answer: PermissionAnswer) {
    setError(undefined);
    try {
      await client.current!.request<RespondResult>({ type: "permission.respond", requestId, ...answer });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function answer(requestId: string, answers: Record<string, string>) {
    setError(undefined);
    try {
      await client.current!.request<RespondResult>({ type: "question.respond", requestId, answers });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const sessionOf = (id: string): SessionInfo | undefined => infos[id] ?? list.find((s) => s.id === id);
  const active = activeId && activeId !== NEW_TAB ? sessionOf(activeId) : undefined;
  const view = activeId ? views[activeId] : undefined;
  const shown = active && view ? active : undefined;
  // The side panel stays mounted while the new-session tab or no tab shows, so its open files survive.
  const lastShown = useRef<SessionInfo>(undefined);
  if (shown) lastShown.current = shown;
  const panelSession = shown ?? lastShown.current;
  const colors = useMemo(() => avatarColors(list.map((s) => s.cwd)), [list]);
  const card = "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-raised";
  const ThemeIcon = { system: MonitorIcon, light: SunIcon, dark: MoonIcon }[theme];
  const search = (cwd: string) => (query: string) =>
    client.current!.request<FsSearchResult>({ type: "fs.search", cwd, query }).then((r) => r.paths);
  const canQuickOpen = !!shown && status !== "unauthorized";
  const showQuickOpen = () => {
    if (!quickOpen) quickOpener.current = document.activeElement;
    setQuickOpen(true);
  };
  const hideQuickOpen = (restoreFocus: boolean) => {
    setQuickOpen(false);
    if (restoreFocus && quickOpener.current instanceof HTMLElement) quickOpener.current.focus();
  };
  // Ctrl+P / Cmd+P while a session shows; the browser's print dialog stays on Ctrl+P elsewhere.
  useEffect(() => {
    if (!canQuickOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => isQuickOpenKey(e) && (e.preventDefault(), showQuickOpen());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canQuickOpen, quickOpen]);

  return (
    <AvatarColors value={colors}>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <header className="flex h-9 shrink-0 items-center gap-1.5 px-2 max-md:h-11 max-md:gap-2 md:pr-3" data-testid="titlebar">
          <IconButton className="md:hidden" label="Sessions" onClick={() => setDrawer(true)} testId="open-drawer">
            <MenuIcon />
          </IconButton>
          {status !== "unauthorized" && (
            <TabsBar
              tabs={tabs}
              activeId={activeId}
              info={(id) => {
                const s = sessionOf(id);
                if (id === NEW_TAB) return { title: "New session", unread: false };
                return { title: list.find((l) => l.id === id)?.title || "Untitled", cwd: s?.cwd, state: views[id]?.state ?? s?.state, unread: unread.has(id) };
              }}
              onSelect={open}
              onClose={close}
              onMove={(from, to) => setTabs((t) => moveTab(t, from, to))}
              onNew={() => open(NEW_TAB)}
              home={sidebar}
              onHome={() => setSidebar((v) => !v)}
            />
          )}
          {canQuickOpen && (
            <IconButton className="ml-auto" label={quickOpenLabel} onClick={showQuickOpen} testId="quick-open-button">
              <SearchIcon />
            </IconButton>
          )}
          <IconButton className={canQuickOpen ? "" : "ml-auto"} label={`Theme: ${theme} (click to change)`} onClick={() => setTheme(nextPref)} testId="theme-toggle">
            <ThemeIcon />
          </IconButton>
        </header>
        <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
          {drawer && <div className="fixed inset-0 z-30 bg-overlay md:hidden" onClick={() => setDrawer(false)} aria-hidden />}
          <aside
            data-testid="sidebar"
            className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col gap-3 bg-card p-3 shadow-floating transition-transform md:static md:translate-x-0 md:bg-transparent md:p-1 md:shadow-none ${sidebar ? "" : "md:hidden"} ${drawer ? "translate-x-0" : "-translate-x-full"}`}
          >
            <ConnectionBadge status={status} />
            <label
              className="flex items-center gap-2"
              title={pushSupported() ? "Push notification when a session needs input or finishes" : "Push needs HTTPS or localhost and a browser with Web Push"}
            >
              <input type="checkbox" checked={pushOn} disabled={!pushSupported()} onChange={togglePush} data-testid="push-toggle" />
              Notifications
            </label>
            <Button onClick={() => open(NEW_TAB)}>New session</Button>
            {error && <p className="text-destructive">{error}</p>}
            {status !== "unauthorized" && <SessionList list={list} state={(s) => views[s.id]?.state ?? s.state} unread={unread} activeId={activeId} onOpen={open} />}
          </aside>
          <main className="flex min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:gap-0">
            {status === "unauthorized" ? (
              // Also over an open session: nothing works until the browser is paired again (e.g. the token was rotated).
              <div className={`${card} flex-1`}>
                <div className="m-auto max-w-sm p-4 text-center" role="alert" data-testid="pairing-needed">
                  The daemon rejected this browser: it is not paired. Open the pairing URL the daemon printed (…/#token=…).
                </div>
              </div>
            ) : (
              <>
                {shown && (
                  <div className="flex items-center gap-1 lg:hidden">
                    <PaneTabs panes={["session", "changes", "files"]} value={pane} onChange={setPane} />
                  </div>
                )}
                {/* Every visited session tab stays mounted (hidden), so it keeps its scroll position and draft prompt. */}
                <div className={`${card} flex-1 ${shown && pane === "session" ? "" : shown ? "hidden lg:flex" : "hidden"}`}>
                  {tabs.map((id) => {
                    const s = id === NEW_TAB ? undefined : sessionOf(id);
                    const v = views[id];
                    if (!s || !v) return null;
                    return (
                      <Activity key={id} mode={id === activeId ? "visible" : "hidden"}>
                        <SessionPane
                          scrollKey={scrollKeys[id] ?? 0}
                          insert={id === activeId ? insert : undefined}
                          onInserted={() => setInsert(undefined)}
                          session={s}
                          view={v}
                          models={models}
                          onModel={(model) => configure({ type: "session.setModel", sessionId: s.id, model })}
                          onMode={(mode) => configure({ type: "session.setPermissionMode", sessionId: s.id, mode })}
                          onEffort={(effort) => configure({ type: "session.setEffort", sessionId: s.id, effort })}
                          onUpload={async (file) => {
                            const data = (await readDataUrl(file)).replace(/^data:[^,]*,/, "");
                            return (await client.current!.request<UploadResult>({ type: "fs.upload", name: file.name, data })).path;
                          }}
                          onPrompt={(text, images) =>
                            // Offline, a request would wait for the reconnect with no feedback; the prompt box keeps the text instead.
                            status === "connected"
                              ? client.current!.request({ type: "session.prompt", sessionId: s.id, text, images })
                              : Promise.reject(new Error(`the daemon is ${status}`))
                          }
                          onInterrupt={() =>
                            client.current!.request({ type: "session.interrupt", sessionId: s.id }).catch((e) => setError((e as Error).message))
                          }
                          onRewindPreview={(userMessageId) =>
                            client.current!.request<RewindPreview>({ type: "session.rewindPreview", sessionId: s.id, userMessageId })
                          }
                          onRewind={(userMessageId, mode) =>
                            client.current!.request({ type: "session.rewind", sessionId: s.id, userMessageId, mode })
                          }
                          onRespond={respond}
                          onSearch={search(s.cwd)}
                          onAnswer={answer}
                          connected={status === "connected"}
                        />
                      </Activity>
                    );
                  })}
                </div>
                {shown && <PanelResizer width={panelWidth} onResize={setPanelWidth} />}
                {panelSession && (
                  <section
                    className={`${card} flex-1 lg:w-(--panel-w) lg:flex-none ${!shown ? "hidden" : pane === "session" ? "hidden lg:flex" : ""}`}
                    style={{ "--panel-w": `${panelWidth}px` } as CSSProperties}
                    data-testid="side-panel"
                  >
                    <div className="hidden border-b px-2 py-1 lg:flex">
                      <PaneTabs panes={["changes", "files"]} value={pane === "changes" ? "changes" : "files"} onChange={setPane} />
                    </div>
                    <div className={`min-h-0 flex-1 flex-col ${pane === "changes" ? "hidden" : "flex"}`}>
                      <FilesPanel
                        client={client.current!}
                        status={status}
                        cwd={panelSession.cwd}
                        onSend={(mention) => (setInsert(mention), setPane("session"))}
                        openPath={openFile}
                        onOpened={() => setOpenFile(undefined)}
                      />
                    </div>
                    {pane === "changes" && <p className="m-auto p-4 text-muted-foreground">No changes view yet.</p>}
                  </section>
                )}
                {activeId === NEW_TAB ? (
                  <div className={`${card} flex-1 items-center justify-center p-4`} data-testid="new-session-tab">
                    <div className="flex w-full max-w-md flex-col gap-3">
                      <h1 className="font-medium text-base">New session</h1>
                      {/* Lists the roots on mount: after a reload with this tab active, only once the socket is open. */}
                      {status === "connected" ? (
                        <DirPicker client={client.current!} models={models} onPick={createSession} onCancel={() => close(NEW_TAB)} />
                      ) : (
                        <p className="text-muted-foreground">Connecting…</p>
                      )}
                    </div>
                  </div>
                ) : (
                  !shown && (
                    <div className={`${card} flex-1`}>
                      <div className="m-auto text-muted-foreground">Open or create a session to start.</div>
                    </div>
                  )
                )}
              </>
            )}
          </main>
        </div>
        {quickOpen && shown && (
          <QuickOpen
            onSearch={search(shown.cwd)}
            onOpen={(p) => {
              hideQuickOpen(false);
              setOpenFile(`${shown.cwd.replace(/\/$/, "")}/${p}`);
              setPane("files");
            }}
            onMention={(p) => {
              hideQuickOpen(false);
              setInsert(mentionPath(p));
              setPane("session");
            }}
            onClose={() => hideQuickOpen(true)}
          />
        )}
      </div>
    </AvatarColors>
  );
}

type Pane = "session" | "changes" | "files";

function PaneTabs({ panes, value, onChange }: { panes: Pane[]; value: Pane; onChange: (p: Pane) => void }) {
  return (
    <div className="flex gap-1" role="tablist" aria-label="Panes">
      {panes.map((p) => (
        <Button
          key={p}
          size="sm"
          variant={p === value ? "secondary" : "ghost"}
          role="tab"
          aria-selected={p === value}
          onClick={() => onChange(p)}
          data-testid={`pane-${p}`}
        >
          {p}
        </Button>
      ))}
    </div>
  );
}

/** Drag handle (or arrow keys) between the session and the side panel on wide screens. */
function PanelResizer({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const clamp = (w: number) => Math.round(Math.max(280, Math.min(w, window.innerWidth - 480)));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuenow={width}
      tabIndex={0}
      className="hidden w-1.5 shrink-0 cursor-col-resize touch-none border-l bg-border/40 hover:bg-primary/30 focus-visible:bg-primary/30 lg:block"
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && onResize(clamp(window.innerWidth - e.clientX))}
      onKeyDown={(e) => {
        const d = { ArrowLeft: 32, ArrowRight: -32 }[e.key];
        if (d) onResize(clamp(width + d));
      }}
    />
  );
}

const STATUS_STYLE: Record<ConnectionStatus, string> = {
  connected: "bg-success",
  reconnecting: "bg-warning animate-pulse motion-reduce:animate-none",
  offline: "bg-destructive",
  unauthorized: "bg-destructive",
};

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs" data-testid="connection-status" role="status">
      <span className={`size-2 rounded-full ${STATUS_STYLE[status]}`} aria-hidden />
      {status === "unauthorized" ? "not paired" : status}
    </div>
  );
}

/** Browses directories inside the allowlisted roots; the daemon refuses anything outside them. */
function DirPicker({
  client,
  models,
  onPick,
  onCancel,
}: {
  client: Client;
  models: ModelInfo[];
  onPick: (cwd: string, model: string) => void;
  onCancel: () => void;
}) {
  const [model, setModel] = useState("default");
  // Visited directories; empty = the roots.
  const [trail, setTrail] = useState<string[]>([]);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [error, setError] = useState<string>();
  const path = trail.at(-1);

  useEffect(() => {
    let stale = false;
    setError(undefined);
    client
      .request<FsListResult>(path ? { type: "fs.list", path } : { type: "fs.list" })
      .then((r) => !stale && setEntries(r.entries.filter((e) => e.isDir && (!path || !e.name.startsWith(".")))))
      .catch((e) => !stale && setError((e as Error).message));
    return () => void (stale = true);
  }, [path]);

  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-md border p-2" data-testid="dir-picker">
      <div className="truncate font-mono text-xs" title={path}>
        {path ?? "Allowlisted roots"}
      </div>
      <ul className="flex max-h-60 flex-col overflow-y-auto text-sm">
        {path && (
          <li>
            <button className="w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => setTrail((t) => t.slice(0, -1))}>
              ..
            </button>
          </li>
        )}
        {entries.map((e) => (
          <li key={e.path}>
            <button
              className="w-full truncate rounded px-2 py-1 text-left font-mono hover:bg-muted"
              onClick={() => setTrail((t) => [...t, e.path])}
            >
              {path ? e.name : e.path}/
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="text-destructive text-xs">{error}</p>}
      <label className="font-medium text-xs" htmlFor="new-model">
        Model
      </label>
      <ModelSelect id="new-model" models={models} value={model} onChange={setModel} className="py-1 text-sm" />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" disabled={!path} onClick={() => path && onPick(path, model)}>
          Start here
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ModelSelect({
  models,
  value,
  onChange,
  ...rest
}: { models: ModelInfo[]; value: string; onChange: (model: string) => void; id?: string; className?: string; "aria-label"?: string }) {
  // Keep the current value selectable while the list loads or if it is not in the list.
  const options = models.some((m) => m.value === value) ? models : [{ value, displayName: value, description: "" }, ...models];
  return (
    <select
      {...rest}
      className={`rounded-md border bg-background px-2 ${rest.className ?? ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((m) => (
        <option key={m.value} value={m.value} title={m.description}>
          {m.displayName}
        </option>
      ))}
    </select>
  );
}

export function SessionPane({
  scrollKey,
  insert,
  onInserted,
  session,
  view,
  models,
  onModel,
  onMode,
  onEffort,
  onUpload,
  onPrompt,
  onSearch,
  onInterrupt,
  onRewindPreview,
  onRewind,
  onRespond,
  onAnswer,
  connected,
}: {
  scrollKey: number;
  insert?: string;
  onInserted: () => void;
  session: SessionInfo;
  view: SessionView;
  models: ModelInfo[];
  onModel: (model: string) => void;
  onMode: (mode: PermissionMode) => void;
  onEffort: (effort: Effort) => void;
  /** Stores a non-image attachment in the daemon; resolves to its absolute path. */
  onUpload: (file: File) => Promise<string>;
  /** Rejects when the prompt was not taken; the prompt box then gets the text back. */
  onPrompt: (text: string, images: string[]) => Promise<unknown>;
  onSearch: (query: string) => Promise<string[]>;
  onInterrupt: () => void;
  onRewindPreview: (userMessageId: string) => Promise<RewindPreview>;
  onRewind: (userMessageId: string, mode: RewindMode) => Promise<unknown>;
  onRespond: (requestId: string, answer: PermissionAnswer) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  /** The daemon is reachable; otherwise the send button is disabled. */
  connected: boolean;
}) {
  const permission = pendingPermission(view);
  const question = pendingQuestion(view);
  // Waiting for a permission answer is part of the running turn.
  const turnRunning = view.state === "running" || view.state === "needs_input";
  // Esc stops the turn, like Claude Code; the command picker handles its own Esc first (preventDefault), and an open modal dialog owns Esc.
  useEffect(() => {
    if (!turnRunning) return;
    const onEsc = (e: globalThis.KeyboardEvent) =>
      e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]') && onInterrupt();
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [turnRunning, onInterrupt]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [rewinding, setRewinding] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [found, setFound] = useState<{ query: string; paths: string[] }>();
  const [sendError, setSendError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const matches = dismissed ? undefined : matchCommands(view.commands, text);
  const mention = dismissed || matches ? undefined : activeMention(text, caret);
  // Only results for the query being typed, so Enter never picks a stale path.
  const paths = mention && found?.query === mention.query ? found.paths : [];
  const pickerOpen = !!matches?.length || paths.length > 0;
  const rows = matches?.length ? matches.length : paths.length;
  useEffect(() => {
    if (mention === undefined) return;
    let current = true;
    onSearch(mention.query)
      .then((p) => current && setFound({ query: mention.query, paths: p }))
      .catch(() => current && setFound({ query: mention.query, paths: [] }));
    return () => void (current = false);
  }, [mention?.query]);
  // Keeps the caret after an inserted mention (a controlled textarea moves it to the end).
  useLayoutEffect(() => void input.current?.setSelectionRange(caret, caret), [text]);
  const edit = (t: string, c = t.length) => {
    setText(t);
    setCaret(c);
    setSelected(0);
    setDismissed(false);
  };
  useEffect(() => {
    if (!insert) return;
    const r = insertAtCaret(text, caret, insert);
    edit(r.text, r.caret);
    onInserted();
    input.current?.focus();
  }, [insert]);
  const send = (t = text) => {
    if (!t.trim() && !images.length) return;
    const sent = images;
    setSendError(undefined);
    onPrompt(t, sent).catch((e: Error) => {
      // Back into the prompt box, before anything typed since.
      setText((cur) => (cur ? `${t}\n${cur}` : t));
      setCaret(t.length);
      setImages((cur) => [...sent, ...cur]);
      setSendError(`Prompt not sent: ${e.message}`);
    });
    edit("");
    setImages([]);
  };
  const pick = (i: number) => {
    if (!matches?.length) {
      const r = insertMention(text, mention!, paths[i]!);
      return edit(r.text, r.caret);
    }
    const r = choose(matches[i]!);
    "send" in r ? send(r.send) : edit(r.text);
  };
  const mode = view.permissionMode ?? session.permissionMode;
  /** Images go with the prompt; other files are uploaded and become `@path` mentions. */
  const attach = async (files: Iterable<File>) => {
    const all = [...files];
    // Checked before reading: a big file would be held in memory as base64 and could exceed the daemon's frame limit.
    const big = all.find((f) => f.size > MAX_UPLOAD_BYTES);
    if (big) return setSendError(`Attach failed: ${big.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const others = all.filter((f) => !isPromptImage(f.type));
    const added = await readImages(all);
    setImages((i) => [...i, ...added]);
    try {
      const paths = await Promise.all(others.map(onUpload));
      if (!paths.length) return;
      setText((t) => {
        const r = insertAtCaret(t, Math.min(caret, t.length), paths.map(mentionPath).join(" "));
        setCaret(r.caret);
        return r.text;
      });
    } catch (e) {
      setSendError(`Attach failed: ${(e as Error).message}`);
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    if (![...e.clipboardData.files].some((f) => f.type.startsWith("image/"))) return;
    e.preventDefault();
    void attach(e.clipboardData.files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void attach(e.dataTransfer.files);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // Claude Code: Shift+Tab cycles the permission mode.
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const next = nextMode(session.permissionModes, mode);
      return next !== mode && onMode(next);
    }
    if (pickerOpen) {
      const n = rows;
      const keys: Record<string, () => void> = {
        ArrowDown: () => setSelected((i) => (i + 1) % n),
        ArrowUp: () => setSelected((i) => (i - 1 + n) % n),
        Enter: () => pick(selected),
        Tab: () => (matches?.length ? edit(`/${matches[selected]!.name} `) : pick(selected)),
        Escape: () => setDismissed(true),
      };
      // Shift+Enter still inserts a newline.
      if (keys[e.key] && !(e.key === "Enter" && e.shiftKey)) {
        e.preventDefault();
        return keys[e.key]!();
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <CwdContext value={session.cwd}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <ProjectAvatar cwd={session.cwd} />
        <span className="shrink-0 font-medium" title={session.cwd} data-testid="session-project">
          {projectName(session.cwd)}
        </span>
        <span className="hidden min-w-0 truncate text-muted-foreground sm:inline" title={session.cwd}>
          {session.cwd}
        </span>
        <span className="ml-auto rounded bg-muted px-2 py-0.5 text-xs" data-testid="session-state">
          {view.state}
        </span>
        {turnRunning && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" title="Stop (Esc)" data-testid="stop" onClick={onInterrupt}>
            <SquareIcon className="size-3 fill-current" />
            Stop
          </Button>
        )}
      </header>
      <Conversation key={scrollKey} className="flex-1">
        <ConversationContent className="timeline mx-auto w-full max-w-[800px] 2xl:max-w-[1000px]">
          {timeline(view).map((item) =>
            item.kind === "context" ? (
              <ContextGroup key={item.id} calls={item.calls} result={(c) => resultOf(view, c)} awaiting={(c) => awaitingPermission(view).has(c.toolUseId)} />
            ) : item.part.type === "user_text" ? (
              // 12px timeline gap + 12px = OpenCode 24px turn gap.
              <div key={item.part.id} className="group flex flex-col gap-1 not-first:mt-3" data-testid="user-message">
                <PartView part={item.part} view={view} />
                {/* Shown on hover or keyboard focus (OpenCode user bubble). */}
                <MessageActions className="ml-auto opacity-0 transition-opacity motion-reduce:transition-none group-focus-within:opacity-100 group-hover:opacity-100">
                  <CopyAction text={item.part.text} />
                  {/* No tooltip prop: its trigger renders a button around this button. */}
                  <MessageAction
                    title="Rewind"
                    label="Rewind to before this message"
                    disabled={turnRunning}
                    onClick={() => setRewinding(rewinding === item.part.id ? undefined : item.part.id)}
                  >
                    <RotateCcwIcon />
                  </MessageAction>
                </MessageActions>
                {/* Closed while a turn runs: the daemon rejects a rewind until the session is idle. */}
                {rewinding === item.part.id && !turnRunning && (
                  <RewindPanel
                    cwd={session.cwd}
                    preview={() => onRewindPreview(item.part.id)}
                    rewind={async (mode) => {
                      const prompt = item.part as Extract<Part, { type: "user_text" }>;
                      await onRewind(prompt.id, mode);
                      setRewinding(undefined);
                      // Conversation modes: the original prompt goes back into the prompt box.
                      if (mode !== "code") edit(prompt.text), setImages(prompt.images);
                    }}
                    onCancel={() => setRewinding(undefined)}
                  />
                )}
              </div>
            ) : (
              <PartView key={item.part.id} part={item.part} view={view} />
            ),
          )}
          {/* Reasoning text stays hidden (OpenCode default); this row shows the turn is working. */}
          {view.state === "running" && (
            <div data-testid="thinking">
              <Shimmer as="span" className="font-medium text-sm">
                Thinking
              </Shimmer>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div
        className="relative mx-auto flex w-full max-w-3xl flex-col gap-2 p-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        {(view.state === "running" || view.state === "needs_input") && view.todos.length > 0 && <TodoList items={view.todos} />}
        {permission ? (
          <PermissionPanel key={permission.id} part={permission} onRespond={(a) => onRespond(permission.requestId, a)} />
        ) : question ? (
          <QuestionPanel key={question.id} part={question} onAnswer={(a) => onAnswer(question.requestId, a)} onDismiss={onInterrupt} />
        ) : (
          <>
            {sendError && (
              <p className="text-destructive text-sm" role="alert" data-testid="prompt-error">
                {sendError}
              </p>
            )}
            <ImageStrip images={images} onRemove={(i) => setImages((all) => all.filter((_, j) => j !== i))} />
            {pickerOpen && !matches?.length && (
              <ul
                id="command-picker"
                role="listbox"
                aria-label="Files"
                data-testid="mention-picker"
                className="absolute inset-x-4 bottom-full max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 font-mono text-sm shadow-md"
              >
                {paths.map((p, i) => (
                  <li
                    key={p}
                    id={`command-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    ref={(el) => void (i === selected && el?.scrollIntoView({ block: "nearest" }))}
                    className={`cursor-pointer truncate rounded-md px-2 py-1.5 ${i === selected ? "bg-muted" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => pick(i)}
                  >
                    @{p}
                  </li>
                ))}
              </ul>
            )}
            {!!matches?.length && (
              <ul
                id="command-picker"
                role="listbox"
                aria-label="Commands and skills"
                className="absolute inset-x-4 bottom-full max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 text-sm shadow-md"
              >
                {matches.map((c, i) => (
                  <li
                    key={c.name}
                    id={`command-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    ref={(el) => void (i === selected && el?.scrollIntoView({ block: "nearest" }))}
                    className={`flex cursor-pointer gap-2 rounded-md px-2 py-1.5 ${i === selected ? "bg-muted" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => pick(i)}
                  >
                    <span className="shrink-0 font-mono">
                      /{c.name}
                      {c.argumentHint && <span className="ml-1 text-muted-foreground">{c.argumentHint}</span>}
                    </span>
                    <span className="truncate text-muted-foreground">{c.description}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col rounded-xl border bg-card shadow-sm focus-within:ring-2 focus-within:ring-ring/50" data-testid="prompt-box">
              <textarea
                role="combobox"
                aria-expanded={pickerOpen}
                aria-controls="command-picker"
                aria-activedescendant={pickerOpen ? `command-${selected}` : undefined}
                aria-label="Prompt"
                className="max-h-45 min-h-15 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-sm outline-none pointer-coarse:text-base"
                rows={2}
                placeholder={
                  turnRunning
                    ? "Claude is working… (Enter to steer, Esc to stop)"
                    : "Ask Claude… (Enter to send, Shift+Enter for newline, paste or drop images)"
                }
                value={text}
                ref={input}
                onChange={(e) => edit(e.target.value, e.target.selectionStart)}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
              />
              <PromptToolbar
                models={models}
                model={view.model ?? session.model}
                onModel={onModel}
                effort={view.effort ?? session.effort}
                onEffort={onEffort}
                mode={mode}
                modes={session.permissionModes}
                onMode={onMode}
                onAttach={(f) => void attach(f)}
                state={connected ? (turnRunning ? (view.state as "running" | "needs_input") : "idle") : "disconnected"}
                hasInput={!!text.trim() || images.length > 0}
                onSend={() => send()}
                onStop={onInterrupt}
              />
            </div>
          </>
        )}
      </div>
    </CwdContext>
  );
}

/** Top-level parts, or with `parentId` the child parts of that subagent. */
function Timeline({ view, parentId }: { view: SessionView; parentId?: string }) {
  return timeline(view, parentId).map((item) =>
    item.kind === "context" ? (
      <ContextGroup key={item.id} calls={item.calls} result={(c) => resultOf(view, c)} awaiting={(c) => awaitingPermission(view).has(c.toolUseId)} />
    ) : (
      <PartView key={item.part.id} part={item.part} view={view} />
    ),
  );
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  // navigator.clipboard is undefined on a non-secure origin (http://<LAN IP>), so Copy does nothing there.
  const copy = () =>
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  return (
    <MessageAction title="Copy" label="Copy message" onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </MessageAction>
  );
}

const resultOf = (view: SessionView, call: { toolUseId: string }) => {
  const p = view.parts.get(`${call.toolUseId}:result`);
  return p?.type === "tool_result" ? p : undefined;
};

function RewindPanel(props: {
  cwd: string;
  preview: () => Promise<RewindPreview>;
  rewind: (mode: RewindMode) => Promise<void>;
  onCancel: () => void;
}) {
  const [preview, setPreview] = useState<RewindPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => void props.preview().then(setPreview, (e: Error) => setError(e.message)), []);
  const run = async (mode: RewindMode) => {
    setBusy(true);
    setError(undefined);
    try {
      await props.rewind(mode);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const options = preview ? rewindOptions(preview) : [];

  return (
    <div className="ml-auto flex w-full max-w-md flex-col gap-2 rounded-lg border p-3 text-sm" data-testid="rewind-panel">
      {!preview && !error && <p className="text-muted-foreground">Checking file changes…</p>}
      {preview && preview.filesChanged.length > 0 && (
        <div>
          <p className="text-muted-foreground text-xs">
            Restore code changes {preview.filesChanged.length} file(s), +{preview.insertions} −{preview.deletions}:
          </p>
          <ul className="font-mono text-xs" data-testid="rewind-files">
            {preview.filesChanged.map((f) => (
              <li key={f} className="truncate" title={f}>
                {relPath(f, props.cwd)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview && !options.length && <p className="text-muted-foreground">Nothing to rewind: first message and no file changes.</p>}
      {error && <p className="text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Button key={o.mode} size="sm" variant={o.mode === "both" ? "default" : "outline"} disabled={busy} onClick={() => run(o.mode)}>
            {o.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PartView({ part, view }: { part: Part; view: SessionView }) {
  switch (part.type) {
    case "user_text":
      return (
        <Message from="user">
          <MessageContent>
            <ImageStrip images={part.images} />
            {part.text}
          </MessageContent>
        </Message>
      );
    case "assistant_text":
      return <AssistantText text={part.text} streaming={part.streaming} />;
    case "tool_call":
      return <ToolCard call={part} result={resultOf(view, part)} awaiting={awaitingPermission(view).has(part.toolUseId)} />;
    case "subagent":
      return (
        <SubagentGroup part={part} result={resultOf(view, part)} awaiting={awaitingPermission(view).has(part.id)}>
          <Timeline view={view} parentId={part.id} />
        </SubagentGroup>
      );
    case "question":
      return <QuestionMarker part={part} />;
    case "turn_result":
      return <TurnFooter part={part} />;
    case "turn_interrupted":
      return (
        <div className="text-muted-foreground text-xs" data-testid="turn-interrupted">
          Interrupted by user
        </div>
      );
    case "raw":
      return (
        // Collapsed: an SDK message the adapter does not know yet, useful only when debugging.
        <details className="rounded bg-muted p-2 text-xs" data-testid="raw-part">
          <summary className="cursor-pointer text-muted-foreground">{rawLabel(part.message)}</summary>
          <pre className="overflow-x-auto">{JSON.stringify(part.message, null, 2)}</pre>
        </details>
      );
    default:
      return null;
  }
}

/** "type/subtype" of an SDK message, e.g. "system/compact_boundary". */
function rawLabel(m: unknown) {
  const { type, subtype } = (m ?? {}) as { type?: unknown; subtype?: unknown };
  return [type, subtype].filter((v) => typeof v === "string").join("/") || "SDK message";
}

function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useSmoothText(text, streaming);
  const revealing = streaming || shown.length < text.length;
  return (
    // OpenCode text part margin-top 24px, on top of the 12px timeline gap.
    <Message from="assistant" className="mt-6" data-testid="assistant-text">
      <MessageContent>
        <MessageResponse mode={revealing ? "streaming" : "static"} isAnimating={revealing}>
          {shown}
        </MessageResponse>
      </MessageContent>
    </Message>
  );
}

function TurnFooter({ part }: { part: Extract<Part, { type: "turn_result" }> }) {
  const { usage } = part;
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <div className="text-muted-foreground text-xs" data-testid="turn-result">
      {part.isError && <span className="mr-2 text-destructive">error</span>}
      {(part.durationMs / 1000).toFixed(1)}s · {fmt(input)} in / {fmt(usage.outputTokens)} out tokens
      {part.costUsd !== undefined && ` · $${part.costUsd.toFixed(4)}`}
    </div>
  );
}
