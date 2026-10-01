import { Activity, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ComponentProps, type CSSProperties, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import { CheckIcon, ChevronDownIcon, CopyIcon, FolderPlusIcon, MenuIcon, MonitorIcon, MoonIcon, RotateCcwIcon, SearchIcon, SquareIcon, SunIcon } from "lucide-react";
import type {
  ContextUsage,
  CreateResult,
  Effort,
  Event,
  FsListResult,
  FsSearchResult,
  ListResult,
  ModelInfo,
  ModelsResult,
  Part,
  PermissionMode,
  ProjectOpenResult,
  RewindMode,
  RewindPreview,
  RespondResult,
  SessionInfo,
  SessionListItem,
  SetModelResult,
  SlashCommand,
  SubscribeResult,
  TodoItem,
  UploadResult,
} from "@claude-ui/protocol";
import { isPromptImage, MAX_UPLOAD_BYTES, PERMISSION_MODES } from "@claude-ui/protocol";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { connect, type ConnectionStatus, type Request, type RequestError } from "./client.ts";
import { ImageStrip, readDataUrl, readImages } from "./images.tsx";
import { nextMode, PromptToolbar, type SendState } from "./toolbar.tsx";
import { choose, matchCommands } from "./commands.ts";
import { activeMention, insertAtCaret, insertMention, mentionPath } from "./mentions.ts";
import { SessionList } from "./sidebar.tsx";
import { inProject, patchSession } from "./sessions.ts";
import { rewindOptions } from "./rewind.ts";
import { useSmoothText } from "./smooth.ts";
import { disablePush, enablePush, pushSubscription, pushSupported, sendSubscription } from "./push.ts";
import { isUnread, loadSeen, saveSeen, seenNow, tabTitle, type Seen } from "./unread.ts";
import { PermissionPanel, type PermissionAnswer } from "./permission.tsx";
import { QuestionMarker, QuestionPanel } from "./question.tsx";
import { applyEvent, awaitingPermission, emptySession, pendingPermission, pendingQuestion, timeline, withSubscribe, type SessionView, type ToolCall } from "./store.ts";
import { ContextGroup, CwdContext, SubagentGroup, ToolCard } from "./tool-card.tsx";
import { showTodoDock, TodoDock } from "./todo-dock.tsx";
import { relPath } from "./tools.ts";
import { FilesPanel } from "./files-panel.tsx";
import { ChangesPanel } from "./changes-panel.tsx";
import { sessionChanges } from "./changes.ts";
import { QuickOpen, quickOpenLabel } from "./quick-open.tsx";
import { CommandPalette } from "./palette.tsx";
import { appCommands, shortcutFor } from "./app-commands.ts";
import { KEYS, matchesKey } from "./shortcuts.ts";
import { OpenProjectDialog } from "./open-project.tsx";
import { NEW_TAB, avatarColors, closeTab, loadTabs, moveTab, openTab, projectName, replaceTab, saveTabs, staleTabs, tabFromHash, tabHash } from "./tabs.ts";
import { AvatarColors, IconButton, ProjectAvatar, TabsBar } from "./tabs-bar.tsx";
import { DeleteDialog, type SessionAction } from "./session-actions.tsx";
import { applyTheme, loadPref, nextPref, type ThemePref } from "./theme.ts";

type Client = ReturnType<typeof connect>;

// The active tab lives in the URL hash, so a reload reopens it.
const hashTab = () => tabFromHash(location.hash);
const card = "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-raised";
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
  // Known project cwds from the daemon, newest first.
  const [projects, setProjects] = useState<string[]>([]);
  // Project the new-session tab starts in.
  const [draftCwd, setDraftCwd] = useState<string>();
  const [openingProject, setOpeningProject] = useState(false);
  const newPrompt = useRef<HTMLTextAreaElement>(null);
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
  // Wide screens: the side panel can be hidden (Toggle side panel).
  const [panel, setPanel] = useState(true);
  // Command palette, open on its first page or on a command's page (e.g. the model page).
  const [palette, setPalette] = useState<{ start?: string }>();
  // A user message whose rewind panel the palette asked for, waiting for its SessionPane.
  const [rewindTo, setRewindTo] = useState<string>();
  // A mention from "Send selection to Claude", waiting for the prompt box to take it.
  const [insert, setInsert] = useState<string>();
  // Quick open, and the file it asks the files panel to open (absolute path).
  const [quickOpen, setQuickOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string>();
  const quickOpener = useRef<Element>(null);
  // Title editor: in the sidebar row or in the tab the Rename action came from.
  const [renaming, setRenaming] = useState<{ id: string; in: "list" | "tab" }>();
  // Session waiting for the delete confirmation.
  const [deleting, setDeleting] = useState<string>();
  const paletteOpener = useRef<Element>(null);
  const client = useRef<Client>(undefined);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const requested = useRef(new Set<string>());
  // Tabs restored from storage, checked against the first session list: a stale one would show "Untitled".
  const restored = useRef<string[] | undefined>(tabs);

  async function refreshList() {
    try {
      const { sessions, projects } = await client.current!.request<ListResult>({ type: "session.list" });
      setList(sessions);
      setProjects(projects);
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
      setViews((v) => ({ ...v, [sessionId]: withSubscribe(v[sessionId] ?? emptySession(), r) }));
      setInfos((i) => ({ ...i, [sessionId]: r.session }));
    } catch (e) {
      // Gone from the daemon, e.g. never prompted before a daemon restart (no transcript): drop it from this tab.
      if ((e as RequestError).code === "unknown_session") return forget(sessionId);
      if ((e as Error).message !== "disconnected") setError((e as Error).message); // else resubscribed on reconnect
    }
  }

  /** `deleted`: removed on purpose (this or another tab), so no "no longer exists" error. */
  function forget(sessionId: string, deleted = false) {
    const without = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([id]) => id !== sessionId));
    setViews(without);
    setInfos(without);
    requested.current.delete(sessionId);
    setList((l) => l.filter((s) => s.id !== sessionId));
    setTabs((t) => t.filter((id) => id !== sessionId));
    if (hashId() === sessionId) {
      // Deleted like a closed tab: its neighbour becomes active.
      const next = deleted ? closeTab(tabsRef.current, sessionId, sessionId).active : undefined;
      if (next) return open(next);
      setActiveId(undefined);
      history.replaceState(null, "", location.pathname + location.search);
      if (!deleted) setError("That session no longer exists in the daemon.");
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
      onSessionsChanged: (m) => {
        if (m.deleted) forget(m.deleted, true);
        void refreshList();
      },
      onOpen: () => {
        // Models first: the subscribe replays come before later replies, and the toolbar needs the model names and effort levels.
        c.request<ModelsResult>({ type: "models.list" }).then(
          (r) => setModels(r.models),
          (e: Error) => e.message !== "disconnected" && setError(`models: ${e.message}`),
        );
        void refreshList();
        const ids = new Set(Object.keys(viewsRef.current));
        const h = hashId();
        if (h) ids.add(h);
        ids.forEach((id) => void subscribe(id));
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

  /** Creates the session in a known project with the chosen start options and sends its first prompt. Rejects when the session was not created. */
  // A session whose first prompt failed: the retry from the new-session tab sends to it instead of creating another.
  const unprompted = useRef<SessionInfo>(undefined);
  async function createSession(cwd: string, opts: StartOptions, text: string, images: string[]) {
    setError(undefined);
    if (status !== "connected") throw new Error(`the daemon is ${status}`);
    try {
      // The new-session tab (and its draft) stays until the first prompt is taken.
      const session = await startSession(client.current!.request, unprompted, cwd, opts, text, images, (s) => setInfos((i) => ({ ...i, [s.id]: s })));
      setTabs((t) => replaceTab(t, NEW_TAB, session.id));
      open(session.id);
    } finally {
      void refreshList();
    }
  }

  /** The new-session tab, starting in `cwd`: by default the active session's project, else the newest project. */
  function newSession(cwd?: string) {
    setDraftCwd(cwd ?? (activeId && activeId !== NEW_TAB ? sessionOf(activeId)?.cwd : undefined) ?? draftCwd);
    open(NEW_TAB);
  }

  async function openProject(path: string) {
    const { cwd } = await client.current!.request<ProjectOpenResult>({ type: "project.open", cwd: path });
    setOpeningProject(false);
    await refreshList();
    newSession(cwd);
  }

  /** Removes the project from the list (files and transcripts stay) and closes its session tabs. */
  async function removeProject(cwd: string) {
    setError(undefined);
    try {
      await client.current!.request({ type: "project.remove", cwd });
      const gone = new Set(list.filter(inProject(cwd)).map((s) => s.id));
      setTabs((t) => t.filter((id) => !gone.has(id)));
      if (activeId && gone.has(activeId)) open(undefined), history.replaceState(null, "", location.pathname + location.search);
      if (draftCwd === cwd) setDraftCwd(undefined);
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

  /** Rename, archive and delete; the daemon's `sessions.changed` then updates every tab, this one too. */
  function sessionAction(where: "list" | "tab") {
    return (sessionId: string, a: SessionAction) => {
      setError(undefined);
      if (a === "rename") return setRenaming({ id: sessionId, in: where });
      if (a === "delete") return setDeleting(sessionId);
      // Shown at once like a rename; a failed archive restores the list.
      setList((l) => patchSession(l, sessionId, { archived: a === "archive" }));
      client.current!.request({ type: "session.archive", sessionId, archived: a === "archive" }).catch((e: Error) => (setError(e.message), void refreshList()));
    };
  }

  function renamed(sessionId: string, title: string | undefined) {
    setRenaming(undefined);
    if (!title) return;
    // Shown at once; a failed rename restores the list title.
    setList((l) => patchSession(l, sessionId, { title }));
    client.current!.request({ type: "session.rename", sessionId, title }).catch((e: Error) => (setError(e.message), void refreshList()));
  }

  function deleteSession(sessionId: string) {
    setDeleting(undefined);
    client.current!.request({ type: "session.delete", sessionId }).catch((e: Error) => setError(e.message));
  }

  const sessionOf = (id: string): SessionInfo | undefined => infos[id] ?? list.find((s) => s.id === id);
  const active = activeId && activeId !== NEW_TAB ? sessionOf(activeId) : undefined;
  const view = activeId ? views[activeId] : undefined;
  const shown = active && view ? active : undefined;
  // The side panel stays mounted while the new-session tab or no tab shows, so its open files survive.
  const lastShown = useRef<SessionInfo>(undefined);
  if (shown) lastShown.current = shown;
  const panelSession = shown ?? lastShown.current;
  const panelView = panelSession && views[panelSession.id];
  const changedPaths = useMemo(() => (panelView ? sessionChanges(panelView).map((c) => c.path) : []), [panelView?.parts]);
  const colors = useMemo(() => avatarColors(projects), [projects]);
  const ThemeIcon = { system: MonitorIcon, light: SunIcon, dark: MoonIcon }[theme];
  const upload = async (file: File) => {
    const data = (await readDataUrl(file)).replace(/^data:[^,]*,/, "");
    return (await client.current!.request<UploadResult>({ type: "fs.upload", name: file.name, data })).path;
  };
  // Offline, a request would wait for the reconnect with no feedback; a reply that never comes times out.
  const search = (cwd: string) => (query: string) =>
    status === "connected"
      ? client.current!.request<FsSearchResult>({ type: "fs.search", cwd, query }, { timeoutMs: 10_000 }).then((r) => r.paths)
      : Promise.reject(new Error(`the daemon is ${status}`));
  const canQuickOpen = !!shown && status !== "unauthorized";
  const showQuickOpen = () => {
    if (!quickOpen) quickOpener.current = document.activeElement;
    setQuickOpen(true);
  };
  const hideQuickOpen = (restoreFocus: boolean) => {
    setQuickOpen(false);
    if (restoreFocus && quickOpener.current instanceof HTMLElement) quickOpener.current.focus();
  };
  const wide = (px: number) => window.matchMedia(`(min-width: ${px}px)`).matches;
  // Below lg the session and the side panel share one pane; from lg on the session always shows and "pane" picks the side panel tab.
  const showSession = () => !wide(1024) && setPane("session");
  /** Opens a file of the shown session (path relative to its cwd) in the files panel. */
  const openInPanel = (p: string) => {
    setOpenFile(`${shown!.cwd.replace(/\/$/, "")}/${p}`);
    setPane("files");
    setPanel(true);
  };
  const commands = appCommands({
    tabs,
    activeId,
    sessions: list,
    session: shown && {
      model: view?.model ?? shown.model,
      effort: view?.effort ?? shown.effort,
      mode: view?.permissionMode ?? shown.permissionMode,
      modes: shown.permissionModes,
      running: view?.state === "running" || view?.state === "needs_input",
      prompts: timeline(view!).flatMap((i) => (i.kind === "part" && i.part.type === "user_text" ? [{ id: i.part.id, text: i.part.text }] : [])),
    },
    models,
    canQuickOpen,
    newSession: () => newSession(),
    selectTab: open,
    closeTab: close,
    quickOpen: showQuickOpen,
    // md: the sidebar breakpoint; below it the sidebar is a drawer.
    toggleSidebar: () => (wide(768) ? setSidebar((v) => !v) : setDrawer((v) => !v)),
    // lg: the side panel breakpoint; below it the session and the files share one pane.
    toggleSidePanel: () => (wide(1024) ? setPanel((v) => !v) : setPane(pane === "session" ? "files" : "session")),
    focusPrompt: () => {
      showSession();
      // After the pane shows: only the visible session's prompt box has a layout box.
      requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('textarea[aria-label="Prompt"]')].find((el) => el.offsetParent)?.focus());
    },
    setModel: (model) => configure({ type: "session.setModel", sessionId: shown!.id, model }),
    setEffort: (effort) => configure({ type: "session.setEffort", sessionId: shown!.id, effort }),
    setMode: (mode) => configure({ type: "session.setPermissionMode", sessionId: shown!.id, mode }),
    rewind: (id) => (setRewindTo(id), showSession()),
    stop: () => client.current!.request({ type: "session.interrupt", sessionId: shown!.id }).catch((e) => setError((e as Error).message)),
  });
  // App shortcuts. Each has Ctrl, Cmd or Alt, so it also fires in the prompt box; an open dialog (quick open, palette) owns the keyboard.
  // A shortcut whose command does not apply now is left to the browser (e.g. Ctrl+P prints without a session).
  const latestCommands = useRef(commands);
  latestCommands.current = commands;
  useEffect(() => {
    if (status === "unauthorized") return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      const isPalette = matchesKey(KEYS.palette, e) || matchesKey(KEYS.paletteAlt, e);
      const c = isPalette ? undefined : shortcutFor(latestCommands.current, e);
      if (!isPalette && !c) return;
      e.preventDefault();
      if (c && "run" in c) return c.run();
      // Focus goes back there when the palette closes, like quick open.
      paletteOpener.current = document.activeElement;
      setPalette({ start: c?.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status]);

  return (
    <AvatarColors value={colors}>
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-9 shrink-0 items-center gap-1.5 px-2 max-md:h-11 max-md:gap-2 md:pr-3 md:pl-4" data-testid="titlebar">
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
              const item = list.find((l) => l.id === id);
              return { title: item?.title || "Untitled", cwd: s?.cwd, state: views[id]?.state ?? s?.state, unread: unread.has(id), archived: item?.archived, transcript: item?.transcript };
            }}
            renaming={renaming?.in === "tab" ? renaming.id : undefined}
            onAction={sessionAction("tab")}
            onRenamed={renamed}
            onSelect={open}
            onClose={close}
            onMove={(from, to) => setTabs((t) => moveTab(t, from, to))}
            onNew={() => newSession()}
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
      <DeleteDialog title={deleting && (list.find((s) => s.id === deleting)?.title ?? "Untitled")} onConfirm={() => deleteSession(deleting!)} onCancel={() => setDeleting(undefined)} />
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
          {error && <p className="text-destructive">{error}</p>}
          {status !== "unauthorized" && (
            <SessionList
              list={list}
              projects={projects}
              state={(s) => views[s.id]?.state ?? s.state}
              unread={unread}
              activeId={activeId}
              onOpen={open}
              onNew={newSession}
              onRemove={removeProject}
              onOpenProject={() => (setDrawer(false), setOpeningProject(true))}
              renaming={renaming?.in === "list" ? renaming.id : undefined}
              onAction={sessionAction("list")}
              onRenamed={renamed}
            />
          )}
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
                  <PaneTabs panes={["session", "changes", "files"]} value={pane} onChange={setPane} changes={changedPaths.length} />
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
                        rewindTo={id === activeId ? rewindTo : undefined}
                        onRewindShown={() => setRewindTo(undefined)}
                        session={s}
                        view={v}
                        models={models}
                        onModel={(model) => configure({ type: "session.setModel", sessionId: s.id, model })}
                        onMode={(mode) => configure({ type: "session.setPermissionMode", sessionId: s.id, mode })}
                        onEffort={(effort) => configure({ type: "session.setEffort", sessionId: s.id, effort })}
                        onUpload={upload}
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
              {shown && panel && <PanelResizer width={panelWidth} onResize={setPanelWidth} />}
              {panelSession && (
                <section
                  className={`${card} flex-1 lg:w-(--panel-w) lg:flex-none ${!shown ? "hidden" : pane === "session" ? "hidden lg:flex" : ""} ${panel ? "" : "lg:hidden"}`}
                  style={{ "--panel-w": `${panelWidth}px` } as CSSProperties}
                  data-testid="side-panel"
                >
                  <div className="hidden border-b px-2 py-1 lg:flex">
                    <PaneTabs panes={["changes", "files"]} value={pane === "changes" ? "changes" : "files"} onChange={setPane} changes={changedPaths.length} />
                  </div>
                  <div className={`min-h-0 flex-1 flex-col ${pane === "changes" ? "hidden" : "flex"}`}>
                    <FilesPanel
                      client={client.current!}
                      status={status}
                      cwd={panelSession.cwd}
                      onSend={(mention) => (setInsert(mention), setPane("session"))}
                      openPath={openFile}
                      onOpened={() => setOpenFile(undefined)}
                      watch={changedPaths}
                    />
                  </div>
                  {pane === "changes" && views[panelSession.id] && (
                    <ChangesPanel
                      key={panelSession.id}
                      client={client.current!}
                      view={views[panelSession.id]!}
                      cwd={panelSession.cwd}
                      onOpen={(path) => (setOpenFile(path), setPane("files"))}
                    />
                  )}
                </section>
              )}
              {/* Mounted while the tab is open: hidden, it keeps its draft; replaced by the created session, it starts empty next time. */}
              {tabs.includes(NEW_TAB) && (
                <NewSessionTab
                  active={activeId === NEW_TAB}
                  projects={projects}
                  cwd={draftCwd && projects.includes(draftCwd) ? draftCwd : projects[0]}
                  onCwd={setDraftCwd}
                  models={models}
                  onOpenProject={() => setOpeningProject(true)}
                  onUpload={upload}
                  onSearch={search}
                  onStart={createSession}
                  inputRef={newPrompt}
                />
              )}
              {activeId !== NEW_TAB && !shown && (
                <div className={`${card} flex-1`}>
                  <div className="m-auto text-muted-foreground">Open or create a session to start.</div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {quickOpen && shown && (
        <QuickOpen
          connected={status === "connected"}
          onSearch={search(shown.cwd)}
          onOpen={(p) => (hideQuickOpen(false), openInPanel(p))}
          onMention={(p) => {
            hideQuickOpen(false);
            setInsert(mentionPath(p));
            showSession();
          }}
          onClose={() => hideQuickOpen(true)}
        />
      )}
      {palette && (
        <CommandPalette
          items={commands}
          start={palette.start}
          files={shown && { search: search(shown.cwd), open: openInPanel }}
          onClose={() => {
            setPalette(undefined);
            // Before the chosen command runs, so a dialog it opens (quick open) returns focus here too.
            if (paletteOpener.current instanceof HTMLElement) paletteOpener.current.focus();
          }}
        />
      )}
      <OpenProjectDialog
        open={openingProject}
        onOpenChange={setOpeningProject}
        list={async (path) => (await client.current!.request<FsListResult>(path ? { type: "fs.list", path } : { type: "fs.list" })).entries}
        onPick={openProject}
        // Focus goes to the new-session prompt, not back to the button that opened the dialog.
        finalFocus={newPrompt}
      />
    </div>
    </AvatarColors>
  );
}

type Pane = "session" | "changes" | "files";

/** `changes`: the changed file count, shown on the changes tab like OpenCode's "Files Changed N". */
export function PaneTabs({ panes, value, onChange, changes = 0 }: { panes: Pane[]; value: Pane; onChange: (p: Pane) => void; changes?: number }) {
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
          {p === "changes" && changes > 0 && <span className="text-muted-foreground tabular-nums">{changes}</span>}
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

/**
 * Creates the session (or reuses `created`: one in `cwd` whose first prompt failed), applies mode and effort, sends the first prompt.
 * Rejects when the prompt was not taken; `created` then keeps the session for the retry.
 */
export async function startSession(
  request: Client["request"],
  created: { current?: SessionInfo },
  cwd: string,
  { model, mode, effort }: StartOptions,
  text: string,
  images: string[],
  onInfo: (s: SessionInfo) => void = () => {},
): Promise<SessionInfo> {
  const reused = created.current?.cwd === cwd;
  let session = reused ? created.current! : (await request<CreateResult>({ type: "session.create", cwd, model })).session;
  created.current = session;
  onInfo(session);
  // Before the first prompt, mode and effort become the query's start options; on failure the prompt is not sent.
  for (const msg of [
    reused && model !== session.model && { type: "session.setModel" as const, sessionId: session.id, model },
    mode !== session.permissionMode && { type: "session.setPermissionMode" as const, sessionId: session.id, mode },
    effort !== session.effort && { type: "session.setEffort" as const, sessionId: session.id, effort },
  ])
    if (msg) {
      session = created.current = (await request<SetModelResult>(msg)).session;
      onInfo(session);
    }
  await request({ type: "session.prompt", sessionId: session.id, text, images });
  created.current = undefined;
  return session;
}

/** The new-session tab's card. Hidden, not unmounted, while another tab is active: it keeps its draft, images, model, mode and effort. */
export function NewSessionTab({ active, ...props }: { active: boolean } & ComponentProps<typeof NewSession>) {
  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <div className={`${card} flex-1 items-center justify-center p-4`} data-testid="new-session-tab">
        <NewSession {...props} />
      </div>
    </Activity>
  );
}

/** New-session tab (OpenCode empty state): prompt box, model, and the project chip; the first prompt creates the session. */
export function NewSession({
  projects,
  cwd,
  onCwd,
  models,
  onOpenProject,
  onUpload,
  onSearch,
  onStart,
  inputRef,
}: {
  projects: string[];
  cwd?: string;
  onCwd: (cwd: string) => void;
  models: ModelInfo[];
  onOpenProject: () => void;
  onUpload: (file: File) => Promise<string>;
  onSearch: (cwd: string) => (query: string) => Promise<string[]>;
  /** Rejects when the session was not created; the prompt box keeps the draft. */
  onStart: (cwd: string, opts: StartOptions, text: string, images: string[]) => Promise<void>;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [model, setModel] = useState("default");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [effort, setEffort] = useState<Effort>("default");
  const OPEN = "\0open";

  return (
    <div className="flex w-full max-w-[720px] flex-col items-center gap-4">
      <div className="w-full">
        <PromptBox
          cwd={cwd}
          commands={[]}
          models={models}
          model={model}
          onModel={setModel}
          effort={effort}
          onEffort={setEffort}
          mode={mode}
          // ponytail: bypassPermissions is not offered before the session exists (the daemon's allowBypass is per session info).
          modes={NEW_SESSION_MODES}
          onMode={setMode}
          onUpload={onUpload}
          onSearch={cwd ? onSearch(cwd) : async () => []}
          onPrompt={(text, images) => (cwd ? onStart(cwd, { model, mode, effort }, text, images) : Promise.reject(new Error("no project")))}
          label="First prompt"
          placeholder={cwd ? `Ask Claude in ${projectName(cwd)}…` : "Open a project to start"}
          autoFocus
          disabled={!cwd}
          inputRef={inputRef}
        />
      </div>
      {cwd ? (
        // Project chip: a native select over the visual chip (like the narrow tab switcher).
        <div className="relative flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-secondary has-focus-visible:ring-2 has-focus-visible:ring-ring max-md:h-11" title={cwd}>
          <ProjectAvatar cwd={cwd} />
          <span className="font-medium" data-testid="new-project">
            {projectName(cwd)}
          </span>
          <ChevronDownIcon className="size-4 text-faint" aria-hidden />
          <select
            aria-label="Project"
            className="absolute inset-0 cursor-pointer text-base opacity-0"
            value={cwd}
            onChange={(e) => (e.target.value === OPEN ? onOpenProject() : onCwd(e.target.value))}
            data-testid="project-chip"
          >
            {projects.map((p) => (
              <option key={p} value={p} title={p}>
                {projectName(p)} — {p}
              </option>
            ))}
            <option value={OPEN}>Open project…</option>
          </select>
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={onOpenProject} data-testid="new-open-project" className="max-md:h-11">
          <FolderPlusIcon />
          Open project
        </Button>
      )}
    </div>
  );
}

export type StartOptions = { model: string; mode: PermissionMode; effort: Effort };
const NEW_SESSION_MODES = PERMISSION_MODES.filter((m) => m !== "bypassPermissions");

export function SessionPane({
  scrollKey,
  insert,
  onInserted,
  rewindTo,
  onRewindShown,
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
  /** Opens the rewind panel of this user message (palette Rewind). */
  rewindTo?: string;
  onRewindShown?: () => void;
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
  const [rewinding, setRewinding] = useState<string>();
  useEffect(() => {
    if (!rewindTo) return;
    setRewinding(rewindTo);
    onRewindShown?.();
  }, [rewindTo]);
  const [draft, setDraft] = useState<{ text: string; images: string[] }>();

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
                <MessageActions className="ml-auto opacity-0 transition-opacity motion-reduce:transition-none group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
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
                      if (mode !== "code") setDraft({ text: prompt.text, images: prompt.images });
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
      >
        {permission ? (
          <PermissionPanel key={permission.id} part={permission} onRespond={(a) => onRespond(permission.requestId, a)} />
        ) : question ? (
          <QuestionPanel key={question.id} part={question} onAnswer={(a) => onAnswer(question.requestId, a)} onDismiss={onInterrupt} />
        ) : (
          <>
            <PromptBox
              cwd={session.cwd}
              commands={view.commands}
              models={models}
              model={view.model ?? session.model}
              onModel={onModel}
              effort={view.effort ?? session.effort}
              onEffort={onEffort}
              mode={view.permissionMode ?? session.permissionMode}
              modes={session.permissionModes}
              onMode={onMode}
              onUpload={onUpload}
              onPrompt={onPrompt}
              onSearch={onSearch}
              insert={insert}
              onInserted={onInserted}
              draft={draft}
              state={connected ? (turnRunning ? (view.state as "running" | "needs_input") : "idle") : "disconnected"}
              onInterrupt={onInterrupt}
              usage={view.contextUsage}
              todos={showTodoDock(view.state, view.todos, false) ? view.todos : undefined}
              label="Prompt"
              placeholder={turnRunning ? "Claude is working… (Enter to steer, Esc to stop)" : "Ask Claude… (Enter to send, Shift+Enter for newline, paste or drop images)"}
            />
          </>
        )}
      </div>
    </CwdContext>
  );
}

/** The prompt box: text with / commands and @ mentions, images, attach and the toolbar. Session view and new-session tab. */
function PromptBox({
  cwd,
  commands,
  models,
  model,
  onModel,
  effort,
  onEffort,
  mode,
  modes,
  onMode,
  onUpload,
  onPrompt,
  onSearch,
  insert,
  onInserted,
  draft,
  state = "idle",
  onInterrupt,
  usage,
  todos,
  label,
  placeholder,
  autoFocus,
  disabled,
  inputRef,
}: {
  /** Changing it clears the send error. */
  cwd?: string;
  commands: SlashCommand[];
  models: ModelInfo[];
  model: string;
  onModel: (model: string) => void;
  effort: Effort;
  onEffort: (effort: Effort) => void;
  mode: PermissionMode;
  modes: PermissionMode[];
  onMode: (mode: PermissionMode) => void;
  /** Stores a non-image attachment in the daemon; resolves to its absolute path. */
  onUpload: (file: File) => Promise<string>;
  /** Rejects when the prompt was not taken; the prompt box then gets the text back. */
  onPrompt: (text: string, images: string[]) => Promise<unknown>;
  onSearch: (query: string) => Promise<string[]>;
  insert?: string;
  onInserted?: () => void;
  /** Replaces the text and images (rewind puts the original prompt back). */
  draft?: { text: string; images: string[] };
  /** What the send button shows; default idle. */
  state?: SendState;
  onInterrupt?: () => void;
  /** Context window meter; none = hidden. */
  usage?: ContextUsage;
  /** Todo dock above the box; none = hidden. */
  todos?: TodoItem[];
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  disabled?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [found, setFound] = useState<{ query: string; paths: string[] }>();
  const [sendError, setSendError] = useState<string>();
  // The prompt box covers the dock's bottom 36px (OpenCode prompt lift), only when it directly follows the dock.
  const lift = !!todos && !sendError && !images.length;
  const input = useRef<HTMLTextAreaElement>(null);
  const matches = dismissed ? undefined : matchCommands(commands, text);
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
    onInserted?.();
    input.current?.focus();
  }, [insert]);
  useEffect(() => {
    if (!draft) return;
    edit(draft.text);
    setImages(draft.images);
  }, [draft]);
  // Another project: an error about the last one does not apply.
  useEffect(() => setSendError(undefined), [cwd]);
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
      const next = nextMode(modes, mode);
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
    <div className="relative flex flex-col gap-2" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
    {todos && <TodoDock items={todos} className={lift ? "pb-9" : undefined} />}
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
        className="absolute inset-x-0 bottom-full max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 font-mono text-sm shadow-md"
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
        className="absolute inset-x-0 bottom-full max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 text-sm shadow-md"
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
    <div
      className={`relative flex flex-col rounded-xl border bg-card shadow-sm focus-within:ring-2 focus-within:ring-ring/50 ${lift ? "-mt-11" : ""}`}
      data-testid="prompt-box"
    >
      <textarea
        role="combobox"
        aria-expanded={pickerOpen}
        aria-controls="command-picker"
        aria-activedescendant={pickerOpen ? `command-${selected}` : undefined}
        aria-label={label}
        className="max-h-45 min-h-15 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-sm outline-none pointer-coarse:text-base"
        rows={2}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        value={text}
        ref={(el) => void ((input.current = el), inputRef && (inputRef.current = el))}
        onChange={(e) => edit(e.target.value, e.target.selectionStart)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <PromptToolbar
        models={models}
        model={model}
        onModel={onModel}
        effort={effort}
        onEffort={onEffort}
        mode={mode}
        modes={modes}
        onMode={onMode}
        onAttach={(f) => void attach(f)}
        usage={usage}
        state={state}
        hasInput={!disabled && (!!text.trim() || images.length > 0)}
        onSend={() => send()}
        onStop={() => onInterrupt?.()}
        onFocusLost={() => input.current?.focus()}
      />
    </div>
    </div>
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
  // Once, on open: opened from the palette, the message can be far up the timeline.
  // Leave stick-to-bottom first, or the timeline growing (preview loaded) scrolls back to the bottom.
  const self = useRef<HTMLDivElement>(null);
  const { stopScroll } = useStickToBottomContext();
  useEffect(() => {
    stopScroll();
    self.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
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
    <div
      className="ml-auto flex w-full max-w-md flex-col gap-2 rounded-lg border p-3 text-sm"
      data-testid="rewind-panel"
      ref={self}
    >
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
