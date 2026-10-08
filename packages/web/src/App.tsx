import { Activity, lazy, memo, Suspense, use, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ComponentProps, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { CheckIcon, CopyIcon, FolderPlusIcon, GitBranchIcon, GitBranchPlusIcon, LoaderCircleIcon, MenuIcon, MonitorIcon, MoonIcon, PanelRightIcon, RotateCcwIcon, SearchIcon, SettingsIcon, SquareIcon, SquareTerminalIcon, SunIcon, TriangleAlertIcon, UsersIcon } from "lucide-react";
import type {
  ContextUsage,
  CreateResult,
  CommandsResult,
  DefaultModeResult,
  Effort,
  Event,
  FsListResult,
  FsSearchResult,
  ListResult,
  McpListResult,
  RecentProject,
  ModelInfo,
  ModelsResult,
  Part,
  PermissionMode,
  ProjectOpenResult,
  RewindMode,
  RewindPreview,
  RespondResult,
  SessionInfo,
  PlanUsage,
  SessionListItem,
  SetModelResult,
  SlashCommand,
  SubscribeResult,
  PageResult,
  EditsResult,
  TodoItem,
  UploadResult,
  GitStatus,
  GitStatusResult,
  Worktree,
  WorktreeCreateResult,
  WorktreeStatusResult,
} from "@claude-ui/protocol";
import { isPromptImage, MAX_UPLOAD_BYTES, ORCHESTRATION_NOTICE, PERMISSION_MODES, permissionModesFor, type SearchHit, worktreeNameError } from "@claude-ui/protocol";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Skeleton } from "@/components/ui/skeleton";
import { usePhone } from "./lib/use-narrow.ts";
import { useHideOnScroll } from "./lib/hide-on-scroll.ts";
import { cancelFlight, launchFlight, useLanding } from "./flight.ts";
import { clearing, heirView } from "./clear.ts";
import { addPending, dropPending, movePending, pendingKey, promptedIds, pruneEchoed, titleLoading, unechoed, type Pending } from "./optimistic.ts";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { connect, type ConnectionStatus, type Request, type RequestError } from "./client.ts";
import { ImageStrip, readDataUrl, readImages } from "./images.tsx";
import { Toast } from "./toast.tsx";
import { GHOST, ModePicker, nextMode, PromptToolbar, ROW, type SendState } from "./toolbar.tsx";
import { activeCommand, choose, dialogArg, dialogOf, insertSlash, matchCommands, withDialogCommands, type DialogName } from "./commands.ts";
import { nextUpdate, UpdateToast, type UpdateInfo } from "./update.tsx";
import { StaleToast } from "./stale-toast.tsx";
import { McpDialog } from "./mcp-dialog.tsx";
import { SkillsDialog } from "./skills-dialog.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";
import { PluginsDialog } from "./plugins-dialog.tsx";
import { nextReloadFailed } from "./plugins.ts";
import { paletteOrder, statusIcon, statusLabel } from "./mcp.ts";
import { activeMention, insertAtCaret, insertCommand, insertMention, mentionPath, splitUploads } from "./mentions.ts";
import { SessionList } from "./sidebar.tsx";
import { resumeSearchText, byRow, inProject, patchSession, projectCwd, projectOf, removeWorktreeText, repoOf, worktreeName } from "./sessions.ts";
import { appendQuote } from "./quote.ts";
import { MarkdownToolbar, formatShortcut } from "./markdown-toolbar.tsx";
import { UserMarkdown } from "./user-markdown.tsx";
import { QuoteAction, QuoteButton, QuoteContext } from "./quote-button.tsx";
import { PlanMeter } from "./plan-meter.tsx";
import { ContinueDock } from "./continue-dock.tsx";
import { StatusBar, totals, type Totals } from "./status-bar.tsx";
import { rewindOptions } from "./rewind.ts";
import { useSmoothText } from "./smooth.ts";
import { disablePush, enablePush, pushSubscription, pushSupported, sendSubscription } from "./push.ts";
import { isUnread, loadSeen, saveSeen, seenNow, tabTitle, type Seen } from "./unread.ts";
import { PermissionPanel, type PermissionAnswer } from "./permission.tsx";
import { QuestionMarker, QuestionPanel } from "./question.tsx";
import { applyEvent, awaitingPermission, bashRunning, emptySession, pendingPermission, pendingQuestion, hitKey, partOf, shownState, timeline, turnText, withEdits, withPage, withSubscribe, type SessionView, type TimelineItem, type ToolCall } from "./store.ts";
import { ContextGroup, CwdContext, SubagentGroup, ToolBody, ToolCard, useExpanded } from "./tool-card.tsx";
import { VirtualTimeline } from "./virtual-timeline.tsx";
import { useStableProps } from "@/lib/utils";
import { showTodoDock, TodoDock } from "./todo-dock.tsx";
import { joinPath, relPath } from "./paths.ts";
import { FilesPanel } from "./files-panel.tsx";
import { ChangesPanel } from "./changes-panel.tsx";
import { sessionChanges } from "./changes.ts";
import { QuickOpen, quickOpenLabel } from "./quick-open.tsx";
import { CommandPalette } from "./palette.tsx";
import { appCommands, shortcutFor } from "./app-commands.ts";
import { shownPrompt } from "./config-dialog.tsx";
import { autoChapter, decideFirstUse, finishRun, GUIDE_KEY, isVisible, loadGuide, parseGuide, restartGuide, saveGuide, settled, skipGuide, wasFreshBrowser, withStep, type ChapterId, type GuideHost, type GuideState } from "./guide.ts";
import { chaptersOf, stepById, stepsFor } from "./guide-steps.ts";
import { GuideTour } from "./guide-tour.tsx";
import { IS_MAC, KEYS, keyLabels, matchesKey } from "./shortcuts.ts";
import { isImeKey } from "./ime.ts";
import { OpenProjectDialog } from "./open-project.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger } from "@/components/ui/select";
import { SideBadge, SideLabel, sideLookup } from "./sides.tsx";
import { NEW_TAB, avatarColors, closeTab, loadTabs, moveGroup, moveGroupTo, moveTabIn, openTab, projectName, replaceTab, runFromHash, runHash, saveTabs, staleTabs, tabFromHash, tabHash } from "./tabs.ts";
import { AgentsButton, inRun, isRunning, NotPromptable, OpenRunContext, runOf, SubagentBar } from "./agents.tsx";
import { loadTabGrouping, saveTabGrouping, tabGroup, type TabGrouping } from "./tab-grouping.ts";
import { AvatarColors, IconButton, ProjectAvatar, TabsBar, useGroupedTabs } from "./tabs-bar.tsx";
import { ConfirmDialog, DeleteDialog, type SessionAction } from "./session-actions.tsx";
import { applyTheme, loadPref, nextPref, type ThemePref } from "./theme.ts";

type Client = ReturnType<typeof connect>;

// The active tab lives in the URL hash, so a reload reopens it.
const hashTab = () => tabFromHash(location.hash);
const card = "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-raised";
// xterm (~300 KB) loads with the first opened terminal panel, not with the app.
const GraphPanel = lazy(() => import("./git-graph-panel.tsx").then((m) => ({ default: m.GraphPanel })));
const TerminalPanel = lazy(() => import("./terminal-panel.tsx").then((m) => ({ default: m.TerminalPanel })));
const TERMINAL_KEY = "claude-ui.terminalOpen";
const PANEL_HIDDEN_KEY = "claude-ui.sidePanelHidden";
const FILE_TREE_HIDDEN_KEY = "claude-ui.fileTreeHidden";
const keyText = (spec: string) => keyLabels(spec).join(IS_MAC ? "" : "+");
const loadFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};
const saveFlag = (key: string, on: boolean) => {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the state lasts until the page reloads.
  }
};
const TERMINAL_HEIGHT_KEY = "claude-ui.terminalHeight";
const SIDEBAR_WIDTH_KEY = "claude-ui.sidebarWidth";
/** Least time between two automatic retries of a failed older-page cursor (n9: a burst of scroll events sends one request). */
const PAGE_RETRY_MS = 3000;
const loadNumber = (key: string, fallback: number) => {
  try {
    return Number(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};
/** `r` without the entry of `id`. */
const without = <T,>(r: Record<string, T>, id: string) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== id));

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
  // Account-wide plan limits; null (API key, Bedrock, Vertex) or not yet known hides the meter.
  const [plan, setPlan] = useState<PlanUsage | null>(null);
  // Known project cwds from the daemon, newest first.
  const [projects, setProjects] = useState<string[]>([]);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  // Sides (WSL distros, Docker containers): every side, and the side of each listed cwd that is not local.
  const [sides, setSides] = useState<ListResult["sides"]>();
  const [cwdSides, setCwdSides] = useState<Record<string, string>>({});
  const [worktrees, setWorktrees] = useState<Record<string, Worktree[]>>({});
  const sideOf = useMemo(() => sideLookup(sides, cwdSides), [sides, cwdSides]);
  // Project the new-session tab starts in.
  const [draftCwd, setDraftCwd] = useState<string>();
  // The new-session tab's model, mode and effort: here, not in the tab, so the palette can change them too.
  // `mode` is unset until picked: the project's `permissions.defaultMode` (daemon, `defaultMode`) applies.
  const [pick, setDraft] = useState<DraftPick>(NEW_DRAFT);
  const [defaultMode, setDefaultMode] = useState<PermissionMode>("default");
  // Modes a new session may start in (session.list): bypassPermissions only when the daemon enables it.
  const [newModes, setNewModes] = useState<PermissionMode[]>(NEW_SESSION_MODES);
  const [openingProject, setOpeningProject] = useState(false);
  // MCP servers dialog, on the project (and session) shown when it opened; `server`: opened on that server's detail (palette row).
  // Kept after closing, so the dialog stays mounted for its close and focus return.
  const [mcp, setMcp] = useState<{ open: boolean; cwd: string; sessionId?: string; server?: string }>();
  // "Slash commands" dialog, same rules.
  const [skillsDialog, setSkillsDialog] = useState<{ open: boolean; cwd: string; sessionId?: string }>();
  // config.changed count per project cwd: an open dialog of that project refreshes.
  // Settings dialog; `settingsChanged`: another client changed the settings (the open dialog reloads).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsChanged, setSettingsChanged] = useState(0);
  const [configChanged, setConfigChanged] = useState<Record<string, number>>({});
  // Manage Plugins dialog, like `mcp`; `reloadFailed`: sessions whose last plugin reload failed (its restart banner).
  const [plugins, setPlugins] = useState<{ open: boolean; cwd: string; sessionId?: string }>();
  const [reloadFailed, setReloadFailed] = useState<Set<string>>(new Set());
  const newPrompt = useRef<HTMLTextAreaElement>(null);
  const [views, setViews] = useState<Record<string, SessionView>>({});
  // GH-133: prompts sent but not yet echoed by the daemon, by tab key (NEW_TAB while the first prompt creates the session).
  const [optimistic, setOptimistic] = useState<Record<string, Pending[]>>({});
  useEffect(() => setOptimistic((o) => pruneEchoed(o, views)), [views]);
  // Active tab: a session id or NEW_TAB.
  const [activeId, setActiveId] = useState(hashTab);
  // A tab switch or route change mid-flight: the ghost must not fly over another view. Not the first prompt's own hand-off (its session already holds the pending prompt).
  useEffect(() => {
    if (!optimistic[activeId ?? ""]?.length) cancelFlight();
  }, [activeId]);
  // Subagent run shown in the active session tab (its subagent view; URL `#<session>/agent/<run>`), undefined = the session view.
  const [run, setRun] = useState(() => runFromHash(location.hash));
  const [tabs, setTabs] = useState(() => {
    const h = hashTab();
    return h ? openTab(loadTabs(), h) : loadTabs();
  });
  const [grouping, setGrouping] = useState<TabGrouping>(loadTabGrouping);
  const changeGrouping = (g: TabGrouping) => {
    setGrouping(g);
    saveTabGrouping(g);
  };
  // A closed or replaced new-session tab starts with the defaults next time.
  const draftOpen = tabs.includes(NEW_TAB);
  useEffect(() => void (!draftOpen && setDraft(NEW_DRAFT)), [draftOpen]);
  // Open project lists the sides as of now: a container started since the last list joins.
  useEffect(() => void (openingProject && refreshList()), [openingProject]);
  const [theme, setTheme] = useState<ThemePref>(loadPref);
  const [error, setError] = useState<string>();
  const [toast, setToast] = useState<string>();
  const closeToast = useCallback(() => setToast(undefined), []);
  // Guided tour (docs/spec.md "First-use guide"): `guideState` is the per-browser state, decided once after the first session list.
  const guideState = useRef<GuideState>(undefined);
  const guideDecided = useRef(false);
  const [guideReady, setGuideReady] = useState(false);
  const guideStep = useRef<string>(undefined);
  const [guideRun, setGuideRun] = useState<{ n: number; ids: string[]; chapters: ChapterId[]; start?: string; from?: "settings" }>();
  const [update, setUpdate] = useState<UpdateInfo>();
  // The daemon's "runs older code" note; a dismissed note stays hidden until the page reloads.
  const [stale, setStale] = useState<string>();
  const staleDismissed = useRef<string | undefined>(undefined);
  const [status, setStatus] = useState<ConnectionStatus>("reconnecting");
  const [drawer, setDrawer] = useState(false);
  /** A `/resume` request for the sidebar search (SessionList `search`). */
  const [resumeSearch, setResumeSearch] = useState<{ text: string; seq: number }>();
  // Wide screens: the Home button shows or hides the sessions sidebar.
  const [sidebar, setSidebar] = useState(true);
  // Wide screens: the sidebar's width, dragged on its edge; kept per browser. The narrow-screen drawer is min(85vw, 360px).
  const [sidebarWidth, setSidebarWidth] = useState(() => loadNumber(SIDEBAR_WIDTH_KEY, 288));
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Storage blocked: the width lasts until the page reloads.
    }
  }, [sidebarWidth]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // Replies to subscribe / create / setModel: the freshest SessionInfo, incl. model.
  const [infos, setInfos] = useState<Record<string, SessionInfo>>({});
  /** React key of a session tab: a /clear moves it to the session the tab follows to, so its prompt box (text, images, focus) stays mounted. */
  const [tabKeys, setTabKeys] = useState<Record<string, string>>({});
  /** A session a tab followed to after /clear, until its subscribe reply: the session it replaced. */
  const [heirOf, setHeirOf] = useState<Record<string, string>>({});
  /** Titles from subscribe replies: a tab of a session not (yet) in the list, e.g. the page-load hash session. */
  const [titles, setTitles] = useState<Record<string, string>>({});
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
  const [panel, setPanel] = useState(() => !loadFlag(PANEL_HIDDEN_KEY));
  useEffect(() => saveFlag(PANEL_HIDDEN_KEY, !panel), [panel]);
  const [fileTree, setFileTree] = useState(() => !loadFlag(FILE_TREE_HIDDEN_KEY));
  useEffect(() => saveFlag(FILE_TREE_HIDDEN_KEY, !fileTree), [fileTree]);
  // Command palette, open on its first page or on a command's page (e.g. the model page).
  const [palette, setPalette] = useState<{ start?: string }>();
  // A user message whose rewind panel the palette asked for, waiting for its SessionPane.
  const [rewindTo, setRewindTo] = useState<string>();
  // A content search hit (palette Messages) the opened session scrolls to once its message is loaded.
  const [revealHit, setRevealHit] = useState<{ sessionId: string; hit: SearchHit; query: string }>();
  // Wide screens: the terminal panel below the side panel (Toggle terminal); narrow screens show it as the "terminal" pane.
  // Kept per browser across reloads; the daemon's shells outlive the page.
  const [terminalOpen, setTerminalOpen] = useState(() => loadFlag(TERMINAL_KEY));
  useEffect(() => saveFlag(TERMINAL_KEY, terminalOpen), [terminalOpen]);
  // OpenCode: 280px by default, resizable when stacked below the side panel.
  const [terminalHeight, setTerminalHeight] = useState(() => loadNumber(TERMINAL_HEIGHT_KEY, 280));
  useEffect(() => {
    try {
      localStorage.setItem(TERMINAL_HEIGHT_KEY, String(terminalHeight));
    } catch {
      // Storage blocked: the height lasts until the page reloads.
    }
  }, [terminalHeight]);
  // A mention from "Send selection to Claude", a quote (`>`) or a command, waiting for the prompt box to take it.
  const [insert, setInsert] = useState<string>();
  // Quick open, and the file it asks the files panel to open (absolute path).
  const [quickOpen, setQuickOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string>();
  const quickOpener = useRef<Element>(null);
  // Title editor: in the sidebar row or in the tab the Rename action came from.
  const [renaming, setRenaming] = useState<{ id: string; in: "list" | "tab" }>();
  // Session waiting for the delete confirmation.
  const [deleting, setDeleting] = useState<string>();
  // Project cwd whose Remove waits for the confirmation.
  const [removing, setRemoving] = useState<string>();
  // Keeps the name while the dialog fades out.
  const lastRemoving = useRef("");
  // Set on Remove confirm, read by the dialog's final focus.
  const removed = useRef<{ next?: string }>(undefined);
  // Worktree being created for the new-session tab (`project`: the repository's project cwd); `error` once it failed.
  const [worktreeJob, setWorktreeJob] = useState<{ project: string; error?: string }>();
  // Project whose "New worktree" name dialog is open, and the typed name.
  const [naming, setNaming] = useState<string>();
  const [wtName, setWtName] = useState("");
  // Worktree waiting for the Remove confirmation; kept while the dialog fades out.
  const [removingWt, setRemovingWt] = useState<{ project: string; path: string; branch: string; text: string }>();
  const lastRemovingWt = useRef(removingWt);
  if (removingWt) lastRemovingWt.current = removingWt;
  // Set on Remove worktree confirm: the project whose group toggle takes the focus.
  const removedWt = useRef<string>(undefined);
  if (removing) lastRemoving.current = removing;
  const paletteOpener = useRef<Element>(null);
  const client = useRef<Client>(undefined);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const statusRef = useRef(status);
  statusRef.current = status;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const listRef = useRef(list);
  listRef.current = list;
  /** Prompts sent while a session's /clear runs: they go to the session the tab follows to (or back to this one when the /clear ends without), keyed by the session they were typed in. */
  const clearQueue = useRef<Record<string, { key: string; text: string; images: string[] }[]>>({});
  const requested = useRef(new Set<string>());
  /** Sessions subscribed holding on this connection: a tab shows them, the daemon keeps their CLI (docs/spec.md "Idle close"). */
  const held = useRef(new Set<string>());
  const isShown = (id: string) => tabsRef.current.includes(id) || hashId() === id;
  const titleRefreshed = useRef(0);
  /** Seq of each session's last subscribe reply: events up to it are a replay of known changes, not new ones. */
  const replayedTo = useRef<Record<string, number>>({});
  /** Sessions whose older page is requested right now (a second request for the same cursor would be wasted), and the same for the indicator. */
  const loadingOlder = useRef(new Set<string>());
  const [olderLoading, setOlderLoading] = useState<Record<string, boolean>>({});
  const resnapshotting = useRef(new Set<string>());
  const editsAsked = useRef(new Set<string>());
  /** Per session, the epoch and cursor whose page request failed, and when: retried only by a scroll event, at most every PAGE_RETRY_MS. */
  const failedPage = useRef(new Map<string, { key: string; at: number }>());
  const runRequested = useRef(new Set<string>());
  /** Session whose prompt box gets the focus once shown (follow()). */
  const refocus = useRef<string>(undefined);
  // Tabs restored from storage, checked against the first session list: a stale one would show "Untitled".
  const restored = useRef<string[] | undefined>(tabs);

  async function refreshList() {
    try {
      const { sessions, projects, recentProjects = [], permissionModes, sides, cwdSides = {}, worktrees = {} } = await client.current!.request<ListResult>({ type: "session.list" });
      // A project removed here or by another client: its session tabs close (they would show a session no longer listed).
      const listed = new Set(sessions.map((s) => s.id));
      closeTabs(new Set(listRef.current.filter((s) => !listed.has(s.id) && !projects.includes(projectCwd(s.cwd))).map((s) => s.id)));
      setList(sessions);
      setProjects(projects);
      if (!guideDecided.current) {
        // The first list of this page decides: a fresh browser on a daemon with no projects gets the tour, anything else is only offered it.
        // A dialog open now (a pairing flow) postpones the decision to the next page load.
        guideDecided.current = true;
        let g = loadGuide();
        if (!g && !document.querySelector('[aria-modal="true"]')) saveGuide((g = decideFirstUse(wasFreshBrowser(), projects.length)));
        guideState.current = g;
        setGuideReady(!!g);
      }
      setRecentProjects(recentProjects);
      setSides(sides);
      setCwdSides(cwdSides);
      setWorktrees(worktrees);
      if (permissionModes) setNewModes(permissionModes);
      if (restored.current) {
        // The page-load hash session is left out: its project may be removed (not listed); its own subscribe forgets it when unknown.
        for (const id of staleTabs(restored.current.filter((id) => id !== hashId()), new Set(sessions.map((s) => s.id)))) forget(id);
        restored.current = undefined;
      }
      // Live sessions are followed so their unread markers update without opening them (background: no hold on the CLI).
      // ponytail: replays every live session's log into this tab; follow state only if that gets heavy.
      for (const s of sessions)
        if (s.state !== "closed" && (s.state !== "error" || isShown(s.id)) && !viewsRef.current[s.id] && !requested.current.has(s.id)) requested.current.add(s.id), void subscribe(s.id, false, false, !isShown(s.id));
    } catch (e) {
      if ((e as Error).message !== "disconnected") setError((e as Error).message);
    }
  }

  // Replays events after the view's last seq, or everything when the daemon restarted (new logEpoch).
  // A session that is not live in the daemon is rebuilt from its transcript and resumes with the same ID on the next prompt.
  /** `addProject`: an explicit open (link, notification, click); a reconnect resubscribe must not re-add a project the user removed. */
  /** `fresh`: a new snapshot (last page) whatever the view holds: a cursor or rewind the view cannot follow. `background`: follow only (no hold). */
  async function subscribe(sessionId: string, addProject = false, fresh = false, background = false) {
    const view = viewsRef.current[sessionId];
    // After a daemon restart the snapshot starts at the oldest turn this view holds (transcript uuids are stable), so the scroll position survives.
    const from = fresh ? undefined : view?.order.find((id) => {
      const p = view.parts.get(id);
      return p?.type === "user_text" && !p.parentId;
    });
    try {
      const r = await client.current!.request<SubscribeResult>({
        type: "session.subscribe",
        sessionId,
        sinceSeq: fresh ? 0 : view?.lastSeq ?? 0,
        logEpoch: view?.logEpoch,
        paged: true,
        ...(from && { from }),
        ...(addProject && { addProject }),
        ...(background && { background }),
      });
      if (background) held.current.delete(sessionId);
      else held.current.add(sessionId);
      // Runs before the replayed events: the reply precedes them on the socket and this continuation is a microtask.
      replayedTo.current[sessionId] = r.seq;
      // A snapshot replaces the view: its older edits and failed cursor are asked again.
      if (r.snapshot) {
        for (const k of editsAsked.current) if (k.startsWith(`${sessionId}:`)) editsAsked.current.delete(k);
        failedPage.current.delete(sessionId);
        for (const k of runRequested.current) if (k.startsWith(`${sessionId}:`)) runRequested.current.delete(k);
      }
      setViews((v) => ({ ...v, [sessionId]: withSubscribe(v[sessionId] ?? emptySession(), r) }));
      setInfos((i) => ({ ...i, [sessionId]: r.session }));
      setHeirOf((h) => (h[sessionId] ? without(h, sessionId) : h));
      if (r.title) setTitles((t) => ({ ...t, [sessionId]: r.title }));
    } catch (e) {
      // Gone from the daemon, e.g. never prompted before a daemon restart (no transcript): drop it from this tab.
      if ((e as RequestError).code === "unknown_session") return forget(sessionId);
      if ((e as Error).message !== "disconnected") setError((e as Error).message); // else resubscribed on reconnect
    }
  }

  /** Loads the page of whole turns before the view's cursor (`until`: back to the turn holding that part or message). Prepended without moving the view. */
  async function loadOlder(sessionId: string, opts?: { until?: string; user?: boolean }) {
    const view = viewsRef.current[sessionId];
    if (!view?.older || !view.logEpoch || loadingOlder.current.has(sessionId)) return;
    const { before } = view.older;
    const epoch = view.logEpoch;
    const cursorKey = `${epoch}:${before}`;
    // A scroll event retries a failed cursor, at most every PAGE_RETRY_MS (measurements and the pinned follow fire scroll events too); layout passes do not.
    const failed = failedPage.current.get(sessionId);
    if (failed?.key === cursorKey && (!opts?.user || Date.now() - failed.at < PAGE_RETRY_MS)) return;
    loadingOlder.current.add(sessionId);
    setOlderLoading((l) => ({ ...l, [sessionId]: true }));
    try {
      const r = await client.current!.request<PageResult>({ type: "session.page", sessionId, logEpoch: epoch, before, ...(opts?.until && { until: opts.until }) });
      failedPage.current.delete(sessionId);
      setViews((v) => (v[sessionId]?.logEpoch === epoch ? { ...v, [sessionId]: withPage(v[sessionId]!, before, r.page) } : v));
    } catch (e) {
      const code = (e as RequestError).code;
      // The cursor is gone (rewound away): a fresh snapshot replaces the view.
      if (code === "unknown_cursor") await subscribe(sessionId, false, true, !held.current.has(sessionId));
      // The daemon restarted: the resubscribe (with `from`, so the position stays) takes the new epoch.
      else if (code === "stale_epoch") await subscribe(sessionId, false, false, !held.current.has(sessionId));
      else if ((e as Error).message !== "disconnected") {
        // One toast per cursor: a retry that fails again stays quiet.
        const again = failedPage.current.get(sessionId)?.key === cursorKey;
        failedPage.current.set(sessionId, { key: cursorKey, at: Date.now() });
        if (!again) setError((e as Error).message);
      }
    } finally {
      loadingOlder.current.delete(sessionId);
      setOlderLoading((l) => ({ ...l, [sessionId]: false }));
    }
  }

  // A subagent view opened by URL or Back/Forward whose run is only known from aux: load back to its turn once.
  useEffect(() => {
    const v = activeId ? views[activeId] : undefined;
    if (!run || !activeId || !v || v.parts.has(run) || !partOf(v, run) || olderLoading[activeId]) return;
    const key = `${activeId}:${run}`;
    if (runRequested.current.has(key)) return;
    runRequested.current.add(key);
    void loadOlder(activeId, { until: run });
  }, [run, activeId, views, olderLoading]);

  // A view that cannot follow a rewind into its unloaded region takes a fresh snapshot.
  useEffect(() => {
    for (const [id, v] of Object.entries(views))
      if (v.stale && !resnapshotting.current.has(id)) {
        resnapshotting.current.add(id);
        void subscribe(id, false, true, !held.current.has(id)).finally(() => resnapshotting.current.delete(id));
      }
  }, [views]);

  /** The tab of session `from` shows session `to` instead, in its place; the active one opens it, its prompt box keeps the focus. */
  function follow(from: string, to: string) {
    if (tabsRef.current.includes(from)) {
      setTabKeys((k) => ({ ...k, [to]: k[from] ?? from, [from]: pendingKey() }));
      setHeirOf((h) => ({ ...h, [to]: from }));
      // The event handler is a closure of the first render: the latest infos come from the updater, the list from its ref.
      setInfos((i) => {
        const old = i[from] ?? listRef.current.find((x) => x.id === from);
        if (i[to] || !old) return i;
        const { cwd, state, model, permissionMode, effort, permissionModes } = old;
        return { ...i, [to]: { id: to, cwd, state, model, permissionMode, effort, permissionModes } };
      });
      // The daemon titles an unprompted heir "New session" (the tab shows that, not "Untitled", until the list or the reply).
      setTitles((t) => (t[to] ? t : { ...t, [to]: "New session" }));
    }
    flushClearQueue(from, to);
    setTabs((t) => (t.includes(from) ? replaceTab(t, from, to) : t));
    if (hashId() !== from) return;
    if (document.activeElement && document.activeElement === shownPrompt()) refocus.current = to;
    open(to);
  }

  // A /clear that ended without moving the tab (it failed, or was a no-op): the queued prompts go to the session they were typed in.
  useEffect(() => {
    for (const id of Object.keys(clearQueue.current)) {
      const v = views[id];
      if (v && shownState(v) === "idle" && !clearing(v, optimistic[id])) flushClearQueue(id, id);
    }
  });

  /** Sends the prompts queued during a /clear: the bubble moves from the old session to `to`. */
  function flushClearQueue(from: string, to: string) {
    const queued = clearQueue.current[from];
    if (!queued) return;
    delete clearQueue.current[from];
    for (const q of queued) {
      setOptimistic((o) => dropPending(o, from, q.key));
      sendPrompt(to, q.text, q.images).catch((e: Error) => setError(`Prompt not sent: ${e.message}`));
    }
  }

  /** A prompt of the user to session `id`: the bubble shows at once (GH-133); the daemon's user_text replaces it. */
  function sendPrompt(id: string, text: string, images: string[]): Promise<unknown> {
    // Offline, a request would wait for the reconnect with no feedback; the prompt box keeps the text instead.
    if (statusRef.current !== "connected") return Promise.reject(new Error(`the daemon is ${statusRef.current}`));
    const key = pendingKey();
    setOptimistic((o) => ({ ...o, [id]: addPending(o[id], viewsRef.current[id], { key, text, images }) }));
    return client.current!.request({ type: "session.prompt", sessionId: id, text, images }).catch((e) => {
      setOptimistic((o) => dropPending(o, id, key));
      throw e;
    });
  }

  /** Drops the view of a session this tab no longer follows; `unsubscribe`: also stops the daemon's events. */
  function drop(sessionId: string, unsubscribe = true) {
    held.current.delete(sessionId);
    requested.current.delete(sessionId);
    setViews((v) => without(v, sessionId));
    setInfos((i) => without(i, sessionId));
    if (unsubscribe) client.current?.request({ type: "session.unsubscribe", sessionId }).catch(() => {});
  }

  /** `deleted`: removed on purpose (this or another tab), so no "no longer exists" error. */
  function forget(sessionId: string, deleted = false) {
    drop(sessionId, false);
    setOptimistic((o) => without(o, sessionId));
    setList((l) => l.filter((s) => s.id !== sessionId));
    setTabs((t) => t.filter((id) => id !== sessionId));
    setHeirOf((h) => without(h, sessionId));
    delete clearQueue.current[sessionId];
    setTabKeys((k) => without(k, sessionId));
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
  function open(id: string | undefined, keepHash = false) {
    setError(undefined);
    setActiveId(id);
    setDrawer(false);
    if (!keepHash) setRun(undefined);
    if (!id) return;
    setTabs((t) => openTab(t, id));
    if (!keepHash) history.replaceState(null, "", tabHash(id));
    // A page-load link subscribed without adding its project: the first explicit open of that session adds it, view or not.
    // A session the list only follows in the background is held now (a tab shows it).
    const add = !viewsRef.current[id] || !listRef.current.some((s) => s.id === id);
    if (id !== NEW_TAB && (add || !held.current.has(id))) void subscribe(id, add);
  }

  /** Opens the subagent view of `id` in the active session tab, or its session view; a history entry each, so browser Back returns. */
  async function openRun(sessionId: string, id?: string) {
    // A run that is only known from the agent map (its turn is not loaded): load back to its turn first, so its children are there.
    const v = viewsRef.current[sessionId];
    if (id && v && !v.parts.has(id) && partOf(v, id)) await loadOlder(sessionId, { until: id });
    history.pushState(null, "", runHash(sessionId, id));
    setRun(id);
  }

  // Browser Back / Forward between session and subagent views.
  useEffect(() => {
    const onPop = () => {
      const tab = hashTab();
      if (tab) {
        open(tab, true);
        // A link to a session: it opens at the bottom, also when its tab is open and scrolled up (like a notification click).
        setScrollKeys((k) => ({ ...k, [tab]: (k[tab] ?? 0) + 1 }));
      }
      setRun(runFromHash(location.hash));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /** Closes the tab; the session stays in the sidebar. A live session is followed in the background only (its CLI closes after the idle time), any other is unsubscribed. */
  function close(id: string) {
    const r = closeTab(tabs, id, activeId);
    setTabs(r.tabs);
    const state = listRef.current.find((s) => s.id === id)?.state;
    if (id !== NEW_TAB) state && state !== "closed" && state !== "error" ? void subscribe(id, false, false, true) : drop(id);
    if (r.active === activeId) return;
    open(r.active);
    if (!r.active) history.replaceState(null, "", location.pathname + location.search);
  }

  useEffect(() => {
    const c = connect({
      onEvent: (e: Event) => {
        setViews((v) => ({ ...v, [e.sessionId]: applyEvent(v[e.sessionId] ?? emptySession(), e) }));
        // New titles and last activity come from the transcript; refresh when a session changes state. A replayed
        // change is in the list already (one session.list per subscribe would rescan every transcript, FIX-LEAK).
        const live = e.seq > (replayedTo.current[e.sessionId] ?? 0);
        // /clear: a tab of the session follows the session the CLI goes on in; a replay (reopening the old session) does not.
        if (e.part.type === "session_cleared" && live) follow(e.sessionId, e.part.sessionId);
        if (e.part.type === "session_state" && live) void refreshList();
        // The title of a session without transcript is "New session" until its transcript exists, some time into the first turn.
        else if (live && listRef.current.some((s) => s.id === e.sessionId && !s.transcript) && Date.now() - titleRefreshed.current > 2000) {
          titleRefreshed.current = Date.now();
          void refreshList();
        }
      },
      onSessionsChanged: (m) => {
        if (m.deleted) forget(m.deleted, true);
        void refreshList();
      },
      onPlanUsage: setPlan,
      onSettingsChanged: () => setSettingsChanged((n) => n + 1),
      onUpdate: (m) => setUpdate((u) => nextUpdate(u, m)),
      onStale: (note) => staleDismissed.current !== note && setStale(note),
      onConfigChanged: (m) => {
        setConfigChanged((c) => ({ ...c, [m.cwd]: (c[m.cwd] ?? 0) + 1 }));
        setReloadFailed((f) => nextReloadFailed(f, m.reloadFailed));
      },
      onOpen: () => {
        // The daemon sends its update state right after the connect; a restarted one has none.
        setUpdate(undefined);
        setStale(undefined);
        // A transient page failure (a side restarting) is retried after a reconnect.
        failedPage.current.clear();
        // Models first: the subscribe replays come before later replies, and the toolbar needs the model names and effort levels.
        c.request<ModelsResult>({ type: "models.list" }).then(
          (r) => setModels(r.models),
          (e: Error) => e.message !== "disconnected" && setError(`models: ${e.message}`),
        );
        void refreshList();
        const h = hashId();
        // The hash session of a page load is only shown, not opened by the user: a removed project stays removed.
        held.current.clear();
        if (h && !viewsRef.current[h]) void subscribe(h);
        Object.keys(viewsRef.current).forEach((id) => void subscribe(id, false, false, !isShown(id)));
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

  /**
   * Creates the session in a known project with the chosen start options and sends its first prompt or runs its first bash
   * mode command. Rejects when the session was not created.
   */
  // A session whose first prompt failed: the retry from the new-session tab sends to it instead of creating another.
  const unprompted = useRef<SessionInfo>(undefined);
  async function createSession(cwd: string, opts: StartOptions, first: FirstMessage) {
    setError(undefined);
    if (status !== "connected") throw new Error(`the daemon is ${status}`);
    const key = pendingKey();
    // GH-133: the bubble shows in this commit; the new-session card hides (Activity keeps its prompt box for a failure).
    // A command has no user bubble: its bash card shows once the session tab does.
    if (!("command" in first)) setOptimistic((o) => ({ ...o, [NEW_TAB]: addPending(undefined, undefined, { key, text: first.text, images: first.images }) }));
    let listed = false;
    try {
      // The new-session tab (and its draft) stays until the first prompt is taken.
      const session = await startSession(client.current!.request, unprompted, cwd, opts, first, (s) => {
        setInfos((i) => ({ ...i, [s.id]: s }));
        setOptimistic((o) => (o[NEW_TAB] ? { ...o, [NEW_TAB]: o[NEW_TAB].map((p) => ({ ...p, sessionId: s.id })) } : o));
        // Listed (and so subscribed) before the prompt goes out: its echo can be in the view before the tab switches.
        if (!listed) (listed = true), void refreshList();
      });
      setOptimistic((o) => movePending(o, session.id));
      setTabs((t) => replaceTab(t, NEW_TAB, session.id));
      open(session.id);
    } catch (e) {
      setOptimistic((o) => dropPending(o, NEW_TAB, key));
      // The new-session card shows again after this render; its prompt box got the text back.
      requestAnimationFrame(() => newPrompt.current?.focus());
      throw e;
    } finally {
      void refreshList();
    }
  }

  /** The new-session tab, starting in `cwd`: by default the active session's project, else the newest project. */
  function newSession(cwd?: string) {
    setDraftCwd(cwd ?? (activeId && activeId !== NEW_TAB ? sessionOf(activeId)?.cwd : undefined) ?? draftCwd);
    open(NEW_TAB);
    // autoFocus works only on the first mount; the tab may be open already, hidden. After the render shows it.
    requestAnimationFrame(() => newPrompt.current?.focus());
  }

  async function openProject(path: string, side?: string) {
    const { cwd } = await client.current!.request<ProjectOpenResult>({ type: "project.open", cwd: path, ...(side && { side }) });
    setOpeningProject(false);
    await refreshList();
    newSession(cwd);
  }

  function closeTabs(gone: Set<string>) {
    if (!gone.size) return;
    setTabs((t) => t.filter((id) => !gone.has(id)));
    if (gone.has(hashId() ?? "")) open(undefined), history.replaceState(null, "", location.pathname + location.search);
  }

  /** Removes the project from the list (files and transcripts stay) and closes its session tabs; with it the other added projects of its repository (one sidebar group). */
  async function removeProject(cwd: string) {
    setError(undefined);
    const gone = projects.filter((p) => repoOf(p, worktrees) === repoOf(cwd, worktrees));
    try {
      for (const p of gone.length ? gone : [cwd]) await client.current!.request({ type: "project.remove", cwd: p });
      // Gone at once; the list refresh below scans every transcript and can take seconds.
      setProjects((p) => p.filter((x) => !gone.includes(x) && x !== cwd));
      closeTabs(new Set(list.filter(inProject(cwd)).map((s) => s.id)));
      if (draftCwd === cwd) setDraftCwd(undefined);
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Creates a worktree of `project`'s repository and opens the new-session tab in it (prompt held until git is done). */
  async function newWorktree(project: string, name?: string) {
    if (worktreeJob && !worktreeJob.error) return;
    setError(undefined);
    setWorktreeJob({ project });
    newSession(project);
    try {
      const { path } = await client.current!.request<WorktreeCreateResult>({ type: "worktree.create", cwd: project, ...(name && { name }) });
      await refreshList();
      setDraftCwd((d) => (d === project ? path : d));
      setWorktreeJob(undefined);
    } catch (e) {
      setWorktreeJob({ project, error: (e as Error).message });
    }
  }
  async function askRemoveWorktree(project: string, path: string) {
    setError(undefined);
    try {
      const st = await client.current!.request<WorktreeStatusResult>({ type: "worktree.status", cwd: project, path });
      setRemovingWt({ project, path, branch: st.branch, text: removeWorktreeText(st) });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function removeWorktree(w: { project: string; path: string }) {
    try {
      await client.current!.request({ type: "worktree.remove", cwd: w.project, path: w.path });
      if (draftCwd === w.path) setDraftCwd(w.project);
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const nameError = wtName.trim() ? worktreeNameError(wtName.trim()) : undefined;
  const createNamed = () => {
    if (naming === undefined || nameError) return;
    const p = naming;
    setNaming(undefined);
    void newWorktree(p, wtName.trim() || undefined);
  };

  /** session.setModel, session.setPermissionMode, session.setEffort: the reply carries the new SessionInfo. */
  async function configure(msg: Extract<Request, { type: "session.setModel" | "session.setPermissionMode" | "session.setEffort" }>) {
    setError(undefined);
    try {
      const before = viewsRef.current[msg.sessionId]?.permissionMode ?? infos[msg.sessionId]?.permissionMode;
      const { session } = await client.current!.request<SetModelResult>(msg);
      setInfos((i) => ({ ...i, [session.id]: session }));
      // The daemon drops auto to ask when the new model has no auto support.
      if (msg.type === "session.setModel" && before === "auto" && session.permissionMode !== "auto") setToast(autoUnavailable(models, session.model));
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

  // A session with a worker (the list flag): its orchestration notices show as chips.
  const isCoordinator = (id: string) => !!list.find((s) => s.id === id)?.coordinator;
  const sessionOf = (id: string): SessionInfo | undefined => infos[id] ?? list.find((s) => s.id === id);
  const groupOfTab = (id: string) => (id === NEW_TAB ? "" : tabGroup(sessionOf(id)?.cwd, grouping, worktrees).key);
  // The stored list stays grouped by the Tab grouping setting (also once the session cwds arrive), so close, next/previous tab and moves all use the order the strip draws.
  useGroupedTabs(tabs, setTabs, groupOfTab);
  const active = activeId && activeId !== NEW_TAB ? sessionOf(activeId) : undefined;
  // GH-133: a just-created session shows (with its pending prompt) before its subscribe reply.
  // A tab that followed a /clear shows the new session at once too: an empty timeline carrying the old one's settings.
  const heirViews = useMemo(() => Object.fromEntries(Object.entries(heirOf).map(([to, from]) => [to, heirView(views[from])])), [heirOf, views]);
  const viewOf = (id: string) => views[id] ?? heirViews[id] ?? (optimistic[id]?.length ? EMPTY_VIEW : undefined);
  const view = activeId ? viewOf(activeId) : undefined;
  const shown = active && view ? active : undefined;
  // A tab that followed a /clear typed in the prompt box: the box gets the focus once the session shows (after its subscribe).
  useEffect(() => {
    if (!shown || refocus.current !== shown.id) return;
    refocus.current = undefined;
    requestAnimationFrame(() => shownPrompt()?.focus());
  }, [shown?.id]);
  // The side panel stays mounted while the new-session tab or no tab shows, so its open files survive.
  const lastShown = useRef<SessionInfo>(undefined);
  if (shown) lastShown.current = shown;
  const panelSession = shown ?? lastShown.current;
  const panelView = panelSession && views[panelSession.id];
  // The changes panel needs the Edit/Write calls of the unloaded region: asked once per session (the cursor moves, aux keeps them).
  useEffect(() => {
    const v = panelView;
    if (!panelSession || !v || !v.older || v.auxEdits || !v.logEpoch) return;
    const { before } = v.older;
    const epoch = v.logEpoch;
    const id = panelSession.id;
    const key = `${id}:${epoch}:${before}`;
    if (editsAsked.current.has(key)) return;
    editsAsked.current.add(key);
    client.current?.request<EditsResult>({ type: "session.edits", sessionId: id, logEpoch: epoch, before }).then(
      (r) => setViews((vs) => (vs[id]?.logEpoch === epoch ? { ...vs, [id]: withEdits(vs[id]!, before, r.parts) } : vs)),
      () => editsAsked.current.delete(key),
    );
  }, [panelSession?.id, panelView?.older?.before, panelView?.auxEdits, panelView?.logEpoch]);
  const changedPaths = useMemo(() => (panelView ? sessionChanges(panelView).map((c) => c.path) : []), [panelView?.parts, panelView?.aux]);
  // The pane tab counts the files the changes panel lists (a file created and deleted again is not listed).
  const [listedChanges, setListedChanges] = useState<{ id: string; n: number }>();
  const changeCount = listedChanges && listedChanges.id === panelSession?.id ? listedChanges.n : changedPaths.length;
  // The graph tab exists only while the side panel's cwd is a git work tree.
  const [isGit, setIsGit] = useState(false);
  // The cwd whose git status has been answered: the tour waits for it so "Git graph" is not dropped by a status still on its way.
  const [gitChecked, setGitChecked] = useState<string>();
  const panelCwd = panelSession?.cwd;
  useEffect(() => {
    if (!panelCwd || status !== "connected") return;
    let live = true;
    client.current!.request<GitStatusResult>({ type: "git.status", cwd: panelCwd }).then(
      (r) => live && (setIsGit(!!r.status), setGitChecked(panelCwd)),
      () => live && (setIsGit(false), setGitChecked(panelCwd)),
    );
    return () => void (live = false);
  }, [panelCwd, status]);
  const sidePane = pane === "graph" && !isGit ? "files" : pane;
  const colors = useMemo(() => avatarColors(projects), [projects]);
  const ThemeIcon = { system: MonitorIcon, light: SunIcon, dark: MoonIcon }[theme];
  const upload = (uploadCwd?: string) => async (file: File) => {
    const data = (await readDataUrl(file)).replace(/^data:[^,]*,/, "");
    // The session's side keeps the file: its Claude reads it there.
    return (await client.current!.request<UploadResult>({ type: "fs.upload", name: file.name, data, ...(uploadCwd && { cwd: uploadCwd }) })).path;
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
    setOpenFile(joinPath(shown!.cwd, p));
    setPane("files");
    setPanel(true);
  };
  /** Toggle file tree: hides the tree when it shows; otherwise shows it with the Files tab (and the side panel on wide screens), like openInPanel. */
  const toggleFileTree = () => {
    const seen = fileTree && (wide(1024) ? panel && sidePane !== "changes" && sidePane !== "graph" : sidePane === "files");
    if (seen) return setFileTree(false);
    setFileTree(true);
    setPane("files");
    setPanel(true);
  };
  const draftShown = activeId === NEW_TAB && tabs.includes(NEW_TAB);
  const draftModes = permissionModesFor({ allowBypass: newModes.includes("bypassPermissions"), supportsAuto: models.some((m) => m.value === pick.model && m.supportsAutoMode) });
  // The settings default applies only where the draft's model offers it (auto needs support); else Ask.
  const draft: StartOptions = { ...pick, mode: pick.mode ?? (draftModes.includes(defaultMode) ? defaultMode : "default") };
  // A model without auto support takes the draft out of auto mode, like the daemon does for a session.
  const changeDraft = (d: StartOptions) => {
    const lost = d.mode === "auto" && !models.some((m) => m.value === d.model && m.supportsAutoMode);
    if (lost) setToast(autoUnavailable(models, d.model));
    setDraft(lost ? { ...d, mode: "default" } : { ...d, mode: d.mode === draft.mode ? pick.mode : d.mode });
  };
  // The project the config dialogs act on: the shown session's cwd, or the new-session tab's project chip.
  // A worktree row's New session starts in that worktree (inside the roots), not only in an added project.
  const startable = [...projects, ...Object.values(worktrees).flatMap((l) => l.filter((w) => !w.outsideRoots).map((w) => w.path))];
  const draftProject = draftCwd && startable.includes(draftCwd) ? draftCwd : projects[0];
  // The new-session tab's mode comes from the Claude settings of its project, read again each time the tab is shown.
  useEffect(() => {
    if (!draftShown || !draftProject || status !== "connected") return;
    let stale = false;
    client.current!.request<DefaultModeResult>({ type: "session.defaultMode", cwd: draftProject }).then(
      (r) => !stale && setDefaultMode(r.mode ?? "default"),
      () => {},
    );
    return () => void (stale = true);
  }, [draftShown, draftProject, status]);
  const project = draftShown ? draftProject : shown?.cwd;
  const projectSession = draftShown ? undefined : shown?.id;
  const openMcp = (server?: string) => project && setMcp({ open: true, cwd: project, sessionId: projectSession, server });
  const openPlugins = () => project && setPlugins({ open: true, cwd: project, sessionId: projectSession });
  const openSkills = () => project && setSkillsDialog({ open: true, cwd: project, sessionId: projectSession });
  /** `/resume` (GH-100): shows the sidebar (the drawer below md) with the session search on this project's repository, then the typed text. */
  const openResume = (arg?: string) => {
    if (!project) return;
    if (wide(768)) setSidebar(true);
    else setDrawer(true);
    const name = projectName(projectOf(project, worktrees));
    setResumeSearch((s) => ({ text: resumeSearchText(name, arg), seq: (s?.seq ?? 0) + 1 }));
  };
  const openDialog = (d: DialogName, arg?: string) => (d === "mcp" ? openMcp() : d === "plugins" ? openPlugins() : d === "resume" ? openResume(arg) : openSkills());
  // The dialog lists the commands of its session (none on the new-session tab), plus the ones the web app handles itself.
  const dialogSession = skillsDialog?.sessionId ? views[skillsDialog.sessionId] : undefined;
  const skillsCommands = dialogSession?.commands.length ? withDialogCommands(dialogSession.commands) : [];
  /** A command row was clicked: `/name ` goes into the prompt box, a command without arguments is sent (a dialog command opens its dialog). */
  const runCommand = (r: ReturnType<typeof choose>) => {
    if ("text" in r) return setInsert(r.text.trimEnd());
    const dialog = dialogOf(r.send, dialogSession?.commands);
    if (dialog) return openDialog(dialog, dialogArg(r.send));
    if (!skillsDialog?.sessionId) return;
    client.current!.request({ type: "session.prompt", sessionId: skillsDialog.sessionId, text: r.send, images: [] }).catch((e) => setError((e as Error).message));
  };
  const mcpRows = async () =>
    project
      ? paletteOrder((await client.current!.request<McpListResult>({ type: "mcp.list", cwd: project, ...(projectSession && { sessionId: projectSession }) })).servers).map((x) => ({
          id: `mcp:${x.name}`,
          group: "MCP servers",
          title: x.name,
          description: "Open MCP server details",
          meta: `${statusIcon(x.status)} ${statusLabel(x.status)}`,
          searchOnly: true,
          run: () => openMcp(x.name),
        }))
      : [];
  // Palette "New worktree…": the shown project's repository, when its main checkout is inside the roots.
  const gitProject = project ? projectOf(project, worktrees) : undefined;
  const canWorktree = !!gitProject && !!worktrees[gitProject]?.some((w) => w.main && !w.outsideRoots);
  const commands = appCommands({
    newWorktree: canWorktree ? () => (setWtName(""), setNaming(gitProject)) : undefined,
    tabs,
    activeId,
    sessions: list,
    session: draftShown
      ? { model: draft.model, effort: draft.effort, mode: draft.mode, modes: draftModes, running: false, prompts: [], draft: true }
      : shown && {
      model: view?.model ?? shown.model,
      effort: view?.effort ?? shown.effort,
      mode: view?.permissionMode ?? shown.permissionMode,
      modes: modesOf(shown.permissionModes, view?.model ?? shown.model, models),
      running: view?.state === "running" || view?.state === "needs_input",
      prompts: timeline(view!).flatMap((i) => (i.kind === "part" && i.part.type === "user_text" && !(isCoordinator(shown.id) && i.part.text.startsWith(ORCHESTRATION_NOTICE)) ? [{ id: i.part.id, text: i.part.text }] : [])),
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
    toggleFileTree,
    toggleSidePanel: () => (wide(1024) ? setPanel((v) => !v) : setPane(pane === "session" ? "files" : "session")),
    toggleTerminal: () => (wide(1024) ? setTerminalOpen((v) => !v) : setPane(pane === "terminal" ? "session" : "terminal")),
    // `id`: the tab just selected, which this render does not show yet.
    focusPrompt: (id = activeId) => {
      if (id !== NEW_TAB) showSession();
      // After the render: only the shown tab's prompt box has a layout box.
      const prompts = () => [...document.querySelectorAll<HTMLElement>('textarea[aria-label="Prompt"], textarea[aria-label="First prompt"]')];
      requestAnimationFrame(() => (id === NEW_TAB ? newPrompt.current : prompts().find((el) => el.offsetParent))?.focus());
    },
    setModel: (model) => (draftShown ? changeDraft({ ...draft, model }) : configure({ type: "session.setModel", sessionId: shown!.id, model })),
    setEffort: (effort) => (draftShown ? setDraft((d) => ({ ...d, effort })) : configure({ type: "session.setEffort", sessionId: shown!.id, effort })),
    setMode: (mode) => (draftShown ? setDraft((d) => ({ ...d, mode })) : configure({ type: "session.setPermissionMode", sessionId: shown!.id, mode })),
    rewind: (id) => (setRewindTo(id), showSession()),
    stop: () => client.current!.request({ type: "session.interrupt", sessionId: shown!.id }).catch((e) => setError((e as Error).message)),
    openSettings: () => setSettingsOpen(true),
    startGuide: () => startGuide(),
    openMcp: project ? () => openMcp() : undefined,
    openSkills: project ? openSkills : undefined,
    openPlugins: project ? openPlugins : undefined,
  });
  // Guided tour. The tour gets its key text only from here; the palette rows carry the keys.
  const sessionIdle = !!shown && shownState(view) === "idle";
  const guideHost: GuideHost = {
    // The tab rows exist only with several tabs; the tour names their keys anyway.
    keyOf: (id) => ({ "palette.open": KEYS.palette, "tab.next": KEYS.nextTab, "tab.close": KEYS.closeTab })[id] ?? commands.find((c) => c.id === id)?.keys,
    openProject: () => (setDrawer(false), setOpeningProject(true)),
    openSettings: () => setSettingsOpen(true),
    closeDrawer: () => setDrawer(false),
  };
  const startRun = (chapter: ChapterId, from?: "settings") => {
    const ids = stepsFor(chapter, { session: !!shown, git: isGit, narrow: !wide(768) }).map((s) => s.id);
    const step = guideState.current?.step;
    setGuideRun((r) => ({ n: (r?.n ?? 0) + 1, ids, chapters: chaptersOf(ids), start: step && ids.includes(step) ? step : undefined, from }));
  };
  // Settings > Guide > Restart guide and the palette's "Show guide": both chapters pending again, from the first step.
  const startGuide = (from?: "settings") => {
    guideState.current = restartGuide(guideState.current ?? decideFirstUse(false, 0));
    saveGuide(guideState.current);
    setGuideReady(true);
    if (from) setSettingsOpen(false);
    setDrawer(false);
    startRun("basics", from);
  };
  // An automatic start waits for the shown session (a reload restores its tab a moment after the list) and its git status, so the run's step count is final (a restored tab that never shows: 3 s at most).
  const [guideWaited, setGuideWaited] = useState(false);
  useEffect(() => {
    if (!guideReady) return;
    const t = setTimeout(() => setGuideWaited(true), 3000);
    return () => clearTimeout(t);
  }, [guideReady]);
  const guideSettled = shown ? gitChecked === shown.cwd : !activeId || activeId === NEW_TAB || guideWaited;
  useEffect(() => {
    if (!guideReady || guideRun || !guideState.current || !guideSettled) return;
    const chapter = autoChapter(guideState.current, { session: sessionIdle });
    if (chapter) startRun(chapter);
  }, [guideReady, guideRun, sessionIdle, guideSettled]);
  // The shown session's tab closed (another client) while "Your session" showed: the tour is over.
  useEffect(() => {
    if (guideRun && !shown && guideStep.current && stepById(guideStep.current)?.chapter === "session") endGuide("done");
  }, [!!shown]);
  const endGuide = (outcome: "done" | "skipped") => {
    const s = guideState.current;
    if (s && guideRun) {
      guideState.current = outcome === "done" ? finishRun(s, guideRun.chapters) : skipGuide(s);
      saveGuide(guideState.current);
    }
    setGuideRun(undefined);
    guideStep.current = undefined;
    if (outcome === "skipped") setToast("Tour closed. Restart it from Settings › Guide.");
  };
  // Another tab of this profile finished or skipped the tour: this one ends it too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== GUIDE_KEY) return;
      const s = parseGuide(e.newValue, false);
      if (!settled(s)) return;
      guideState.current = s;
      setGuideRun(undefined);
    };
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  }, []);
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

  const prompted = useMemo(() => promptedIds(optimistic, views), [optimistic, views]);

  return (
    <AvatarColors value={colors}>
    <SideLabel value={sideOf.badge}>
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
              if (id === NEW_TAB) return { title: "New session", unread: false, titleLoading: !!optimistic[NEW_TAB]?.length };
              const item = list.find((l) => l.id === id);
              const g = tabGroup(s?.cwd, grouping, worktrees);
              const title = item?.title || titles[id] || "Untitled";
              return { title, titleLoading: titleLoading(title, prompted.has(id)), cwd: s?.cwd, group: g.key, groupLabel: g.label || undefined, groupSub: g.sub, groupColor: g.color || undefined, worktree: s?.cwd ? worktreeName(s.cwd, worktrees) : undefined, state: shownState(views[id]) ?? s?.state, unread: unread.has(id), archived: item?.archived, transcript: item?.transcript };
            }}
            renaming={renaming?.in === "tab" ? renaming.id : undefined}
            onAction={sessionAction("tab")}
            onRenamed={renamed}
            onSelect={open}
            onClose={close}
            grouping={grouping}
            onMove={(from, to) => setTabs((t) => moveTabIn(t, groupOfTab, from, to))}
            onMoveGroup={(cwd, by) => setTabs((t) => moveGroup(t, groupOfTab, cwd, by))}
            onMoveGroupTo={(from, to) => setTabs((t) => moveGroupTo(t, groupOfTab, from, to))}
            onNew={() => newSession()}
            home={sidebar}
            onHome={() => setSidebar((v) => !v)}
          />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 max-md:gap-2">
          {plan && status !== "unauthorized" && <PlanMeter usage={plan} />}
          {/* Below sm the tab switcher needs the width for the session name: search and theme live in the drawer. */}
          {canQuickOpen && (
            <IconButton className="max-sm:hidden" label={quickOpenLabel} onClick={showQuickOpen} testId="quick-open-button" command="file.open">
              <SearchIcon />
            </IconButton>
          )}
          <IconButton className="max-sm:hidden" label={`Theme: ${theme} (click to change)`} onClick={() => setTheme(nextPref)} testId="theme-toggle">
            <ThemeIcon />
          </IconButton>
          {shown && (
            <IconButton className="max-lg:hidden aria-expanded:bg-transparent aria-expanded:text-faint aria-expanded:shadow-none aria-expanded:hover:bg-accent aria-expanded:hover:text-foreground" label={`Toggle side panel (${keyText(KEYS.sidePanel)})`} expanded={panel} controls="side-panel" onClick={() => setPanel((v) => !v)} testId="panel-toggle" command="panel.toggle">
              <PanelRightIcon />
            </IconButton>
          )}
        </div>
      </header>
      <DeleteDialog title={deleting && (list.find((s) => s.id === deleting)?.title ?? "Untitled")} onConfirm={() => deleteSession(deleting!)} onCancel={() => setDeleting(undefined)} />
      <ConfirmDialog
        open={removing !== undefined}
        title="Remove project?"
        description={`“${projectName(lastRemoving.current)}” leaves the list. Its files and sessions stay on disk; open the folder again to bring it back.`}
        confirm="Remove"
        onConfirm={() => {
          // The row below (else above) is taken now: once project.remove answers, the removed row may be gone.
          const cwds = [...document.querySelectorAll<HTMLElement>('[data-testid="session-group"]')].map((r) => r.dataset.cwd);
          const at = cwds.indexOf(removing);
          removed.current = { next: cwds[at + 1] ?? cwds[at - 1] };
          setRemoving(undefined);
          void removeProject(removing!);
        }}
        onCancel={() => setRemoving(undefined)}
        // The removed row's button is gone: the next project row, else the previous one, else the prompt box or Open project.
        finalFocus={() => {
          const target = removed.current;
          removed.current = undefined;
          if (target === undefined) return true;
          const row = [...document.querySelectorAll<HTMLElement>('[data-testid="session-group"]')].find((r) => target.next !== undefined && r.dataset.cwd === target.next);
          const prompt = [...document.querySelectorAll<HTMLElement>("textarea")].find((t) => t.offsetParent && !t.closest(`[data-cwd]`));
          return row?.querySelector<HTMLElement>('[data-testid="group-toggle"]') ?? prompt ?? document.querySelector<HTMLElement>('[data-testid="open-project"]');
        }}
        testId="remove-project"
      />
      <ConfirmDialog
        open={naming !== undefined}
        title="New worktree"
        description={`A new branch in ${projectName(naming ?? "")}/.claude/worktrees. Leave the name empty for a generated one.`}
        confirm="Create"
        confirmDisabled={!!nameError}
        onConfirm={createNamed}
        onCancel={() => setNaming(undefined)}
        testId="new-worktree"
      >
        <label className="flex flex-col gap-1 text-sm">
          New worktree name
          <input
            value={wtName}
            onChange={(e) => setWtName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && (e.preventDefault(), createNamed())}
            placeholder="e.g. my-feature"
            maxLength={64}
            autoFocus
            aria-invalid={!!nameError}
            aria-describedby="new-worktree-hint"
            className="h-9 rounded-md bg-secondary/60 px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
            data-testid="new-worktree-name"
          />
          <span id="new-worktree-hint" className={nameError ? "text-destructive text-xs" : "text-muted-foreground text-xs"} data-testid="new-worktree-hint">
            {nameError || "Only letters, numbers, dots, hyphens, and underscores"}
          </span>
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={removingWt !== undefined}
        title={`Remove worktree ${lastRemovingWt.current?.branch ?? ""}?`}
        description={lastRemovingWt.current?.text ?? ""}
        confirm="Remove worktree"
        destructive
        onConfirm={() => {
          const w = removingWt!;
          removedWt.current = w.project;
          setRemovingWt(undefined);
          void removeWorktree(w);
        }}
        onCancel={() => setRemovingWt(undefined)}
        // Cancel / Esc: back to the trash button (default). Confirmed: its row is gone; the project's group toggle.
        finalFocus={() => {
          const p = removedWt.current;
          removedWt.current = undefined;
          if (p === undefined) return true;
          return [...document.querySelectorAll<HTMLElement>('[data-testid="session-group"]')].find((g) => g.dataset.cwd === p)?.querySelector<HTMLElement>('[data-testid="group-toggle"]') ?? true;
        }}
        testId="remove-worktree"
      />
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        {drawer && <div className="fixed inset-0 z-30 bg-overlay md:hidden" onClick={() => setDrawer(false)} aria-hidden />}
        <aside
          data-testid="sidebar"
          style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}
          className={`fixed inset-y-0 left-0 z-40 flex w-[min(85vw,360px)] shrink-0 md:w-(--sidebar-w) flex-col gap-3 bg-card p-3 shadow-floating transition-transform md:static md:translate-x-0 md:bg-transparent md:p-1 md:shadow-none ${sidebar ? "" : "md:hidden"} ${drawer ? "translate-x-0" : "-translate-x-full"}`}
        >
          <ConnectionBadge status={status} />
          <div className="flex items-center gap-2 sm:hidden" data-testid="drawer-tools">
            {canQuickOpen && (
              <IconButton label={quickOpenLabel} onClick={() => (setDrawer(false), showQuickOpen())} testId="drawer-quick-open">
                <SearchIcon />
              </IconButton>
            )}
            <IconButton label={`Theme: ${theme} (click to change)`} onClick={() => setTheme(nextPref)} testId="drawer-theme">
              <ThemeIcon />
            </IconButton>
          </div>
          <label
            className="flex items-center gap-2 pointer-coarse:min-h-11"
            title={pushSupported() ? "Push notification when a session needs input or finishes" : "Web Push needs HTTPS or localhost and a browser with Web Push. Without it, the daemon shows desktop notifications on its own machine."}
          >
            <input type="checkbox" checked={pushOn} disabled={!pushSupported()} onChange={togglePush} data-testid="push-toggle" />
            Notifications
          </label>
          {error && <p className="text-destructive">{error}</p>}
          {status !== "unauthorized" && (
            <SessionList
              list={list}
              projects={projects}
              worktrees={worktrees}
              state={(s) => shownState(views[s.id]) ?? s.state}
              titleLoading={(s) => titleLoading(s.title, prompted.has(s.id))}
              unread={unread}
              activeId={activeId}
              onOpen={open}
              onNew={newSession}
              onRemove={setRemoving}
              onNewWorktree={(cwd, named) => (setDrawer(false), named ? (setWtName(""), setNaming(cwd)) : void newWorktree(cwd))}
              onRemoveWorktree={askRemoveWorktree}
              onOpenProject={() => (setDrawer(false), setOpeningProject(true))}
              renaming={renaming?.in === "list" ? renaming.id : undefined}
              onAction={sessionAction("list")}
              onRenamed={renamed}
              search={resumeSearch}
            />
          )}
          <button
            type="button"
            onClick={() => (setDrawer(false), setSettingsOpen(true))}
            className="mt-auto flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
            data-testid="open-settings"
            data-command="settings.open"
          >
            <SettingsIcon className="size-4" />
            Settings
          </button>
        </aside>
        {sidebar && <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />}
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
                  <PaneTabs panes={["session", "changes", "files", ...(isGit ? (["graph"] as const) : []), "terminal"]} value={sidePane} onChange={setPane} changes={changeCount} />
                </div>
              )}
              {/* Every visited session tab stays mounted (hidden), so it keeps its scroll position and draft prompt. */}
              <div className={`${card} flex-1 ${shown && pane === "session" ? "" : shown ? "hidden lg:flex" : "hidden"}`}>
                <QuoteContext value={setInsert}>
                {tabs.map((id) => {
                  const s = id === NEW_TAB ? undefined : sessionOf(id);
                  const pend = optimistic[id];
                  // Just created: shown before its subscribe reply, so the card is never blank.
                  const v = viewOf(id);
                  if (!s || !v) return null;
                  return (
                    <Activity key={tabKeys[id] ?? id} mode={id === activeId ? "visible" : "hidden"}>
                      <SessionTab
                        scrollKey={scrollKeys[id] ?? 0}
                        insert={id === activeId ? insert : undefined}
                        onInserted={() => setInsert(undefined)}
                        rewindTo={id === activeId ? rewindTo : undefined}
                        revealHit={id === revealHit?.sessionId ? revealHit : undefined}
                        onRevealShown={() => setRevealHit(undefined)}
                        run={id === activeId ? run : undefined}
                        onOpenRun={(r) => openRun(s.id, r)}
                        onLoadOlder={(opts) => loadOlder(s.id, opts)}
                        loadingOlder={!!olderLoading[s.id]}
                        onStopRun={(subagentId) => client.current!.request({ type: "session.stopSubagent", sessionId: s.id, subagentId })}
                        onRewindShown={() => setRewindTo(undefined)}
                        session={s}
                        coordinator={isCoordinator(id)}
                        place={worktreeName(s.cwd, worktrees)}
                        view={v}
                        pending={pend}
                        models={models}
                        onModel={(model) => configure({ type: "session.setModel", sessionId: s.id, model })}
                        onMode={(mode) => configure({ type: "session.setPermissionMode", sessionId: s.id, mode })}
                        onEffort={(effort) => configure({ type: "session.setEffort", sessionId: s.id, effort })}
                        onUpload={upload(s.cwd)}
                        onPrompt={(text, images) => {
                          // While the /clear runs the message waits: its bubble shows now, it is sent once the tab follows (or the /clear ends without).
                          if (!v.externalTurn && clearing(v, pend)) {
                            if (status !== "connected") return Promise.reject(new Error(`the daemon is ${status}`));
                            const key = pendingKey();
                            setOptimistic((o) => ({ ...o, [s.id]: addPending(o[s.id], viewsRef.current[s.id], { key, text, images }) }));
                            (clearQueue.current[s.id] ??= []).push({ key, text, images });
                            return Promise.resolve();
                          }
                          return sendPrompt(s.id, text, images);
                        }}
                        onBash={(command) =>
                          status === "connected"
                            ? client.current!.request({ type: "session.bash", sessionId: s.id, command })
                            : Promise.reject(new Error(`the daemon is ${status}`))
                        }
                        onCancelContinue={() => client.current!.request({ type: "session.cancelContinue", sessionId: s.id }).catch((e) => setError((e as Error).message))}
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
                        onDialog={openDialog}
                        onAnswer={answer}
                        connected={status === "connected"}
                        onGitStatus={() =>
                          status === "connected"
                            ? client.current!.request<GitStatusResult>({ type: "git.status", cwd: s.cwd }).then((r) => r.status)
                            : Promise.reject(new Error(`the daemon is ${status}`))
                        }
                      />
                    </Activity>
                  );
                })}
                </QuoteContext>
              </div>
              {shown && (panel || terminalOpen) && <PanelResizer width={panelWidth} onResize={setPanelWidth} />}
              {panelSession && (
                <div
                  className={`flex min-h-0 min-w-0 flex-1 flex-col lg:w-(--panel-w) lg:flex-none ${!shown ? "hidden" : pane === "session" ? "hidden lg:flex" : ""} ${panel || terminalOpen ? "" : "lg:hidden"}`}
                  style={{ "--panel-w": `${panelWidth}px`, "--terminal-h": `${terminalHeight}px` } as CSSProperties}
                >
                <section className={`${card} flex-1 ${pane === "terminal" ? "hidden lg:flex" : ""} ${panel ? "" : "lg:hidden"}`} id="side-panel" data-testid="side-panel">
                  <div className="hidden items-center border-b px-2 py-1 lg:flex">
                    <PaneTabs panes={["changes", "files", ...(isGit ? (["graph"] as const) : [])]} value={sidePane === "changes" || sidePane === "graph" ? sidePane : "files"} onChange={setPane} changes={changeCount} />
                    <IconButton className="ml-auto" label="Toggle terminal (Ctrl+`)" pressed={terminalOpen} onClick={() => setTerminalOpen((o) => !o)} testId="terminal-toggle" command="terminal.toggle">
                      <SquareTerminalIcon />
                    </IconButton>
                  </div>
                  <div className={`min-h-0 flex-1 flex-col ${sidePane === "changes" || sidePane === "graph" ? "hidden" : "flex"}`}>
                    <FilesPanel
                      client={client.current!}
                      status={status}
                      cwd={panelSession.cwd}
                      onSend={(mention) => (setInsert(mention), setPane("session"))}
                      openPath={openFile}
                      onOpened={() => setOpenFile(undefined)}
                      watch={changedPaths}
                      showTree={fileTree}
                      onToggleTree={() => setFileTree((v) => !v)}
                    />
                  </div>
                  {views[panelSession.id] && (
                    <ChangesPanel
                      key={panelSession.id}
                      hidden={pane !== "changes"}
                      onCount={(n) => setListedChanges({ id: panelSession.id, n })}
                      client={client.current!}
                      view={views[panelSession.id]!}
                      cwd={panelSession.cwd}
                      onOpen={(path) => (setOpenFile(path), setPane("files"))}
                      sessionId={panelSession.id}
                    />
                  )}
                  {sidePane === "graph" && (
                    <Suspense fallback={<p className="m-auto text-muted-foreground text-sm">Loading graph…</p>}>
                      <GraphPanel key={panelSession.cwd} client={client.current!} cwd={panelSession.cwd} />
                    </Suspense>
                  )}
                </section>
                {panel && terminalOpen && <TerminalResizer height={terminalHeight} onResize={setTerminalHeight} />}
                {(terminalOpen || pane === "terminal") && (
                  // OpenCode: below the side panel, 100px to 60% of the window high (CSS keeps it there when the window shrinks).
                  <section
                    className={`${card} ${pane === "terminal" ? "flex-1" : "max-lg:hidden"} ${!terminalOpen ? "lg:hidden" : panel ? "lg:h-(--terminal-h) lg:max-h-[60vh] lg:min-h-25 lg:flex-none" : "lg:flex-1"}`}
                    data-testid="terminal-panel"
                  >
                    <Suspense fallback={<p className="m-auto text-muted-foreground text-sm">Loading terminal…</p>}>
                      <TerminalPanel
                        client={client.current!}
                        status={status}
                        cwd={panelSession.cwd}
                        onEmpty={() => (setTerminalOpen(false), pane === "terminal" && setPane("session"))}
                      />
                    </Suspense>
                  </section>
                )}
                </div>
              )}
              {/* Mounted while the tab is open: hidden, it keeps its draft; replaced by the created session, it starts empty next time. */}
              {tabs.includes(NEW_TAB) && (
                <NewSessionTab
                  active={activeId === NEW_TAB && !optimistic[NEW_TAB]?.length}
                  projects={projects}
                  worktrees={worktrees}
                  cwd={draftProject}
                  onCwd={(c) => (setDraftCwd(c), setWorktreeJob((j) => (j?.error ? undefined : j)))}
                  onNewWorktree={(p) => void newWorktree(p)}
                  worktreeJob={worktreeJob?.project === projectOf(draftProject ?? "", worktrees) ? worktreeJob : undefined}
                  models={models}
                  draft={draft}
                  onDraft={changeDraft}
                  modes={draftModes}
                  onOpenProject={() => setOpeningProject(true)}
                  onUpload={upload(draftProject)}
                  onSearch={search}
                  commandsRev={Object.values(configChanged).reduce((a, b) => a + b, 0)}
                  onCommands={(cwd) => client.current!.request<CommandsResult>({ type: "session.commands", cwd }).then((r) => r.commands)}
                  onStart={createSession}
                  onDialog={openDialog}
                  inputRef={newPrompt}
                  connected={status === "connected"}
                />
              )}
              {activeId === NEW_TAB && !!optimistic[NEW_TAB]?.length && draftProject && (
                <>
                  {/* The height of the pane tabs row the session card has below lg (28px + the main gap): the prompt does not move when the session shows. */}
                  <div className="h-7 shrink-0 lg:hidden" aria-hidden />
                  <StartingSession cwd={draftProject} place={worktreeName(draftProject, worktrees)} pending={optimistic[NEW_TAB]} />
                  {/* The side panel's footprint (resizer 6px + panel) on wide screens, empty: the prompt does not shift when the session shows it. */}
                  {(panel || terminalOpen) && <div className={`${card} ml-1.5 hidden shrink-0 lg:flex`} style={{ width: panelWidth }} aria-hidden />}
                </>
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
      <QuoteButton onQuote={(q) => (setInsert(q), setPane("session"))} />
      {guideRun && (
        <GuideTour
          key={guideRun.n}
          ids={guideRun.ids}
          start={guideRun.start}
          host={guideHost}
          onStep={(id) => ((guideStep.current = id), guideState.current && saveGuide((guideState.current = withStep(guideState.current, id))))}
          onEnd={endGuide}
          // Started from Settings: the focus goes back to its button (a closed drawer has none on a phone: the prompt box).
          returnFocus={guideRun.from === "settings" ? () => [...document.querySelectorAll<HTMLElement>('[data-testid="open-settings"]')].find((b) => isVisible(b)) ?? shownPrompt() : undefined}
        />
      )}
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
          messages={{
            cwd: project,
            search: (query, cwd, onResult) =>
              status === "connected" ? client.current!.search({ type: "sessions.search", query, ...(cwd && { cwd }) }, onResult) : Promise.reject(new Error(`the daemon is ${status}`)),
            open: (sessionId, hit, query) => (open(sessionId), setRevealHit({ sessionId, hit, query }), showSession()),
          }}
          more={project ? mcpRows : undefined}
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
        list={async (path, side) => (await client.current!.request<FsListResult>({ type: "fs.list", ...(path && { path }), ...(side && { side }) })).entries}
        onPick={openProject}
        recent={recentProjects}
        sides={sides}
        onStartSide={(side) => client.current!.request({ type: "side.start", side })}
        sideOf={sideOf.sideOf}
        // Focus goes to the new-session prompt, not back to the button that opened the dialog.
        finalFocus={newPrompt}
      />
      {mcp && (
        <McpDialog
          open={mcp.open}
          cwd={mcp.cwd}
          sessionId={mcp.sessionId}
          server={mcp.server}
          changed={configChanged[mcp.cwd]}
          request={(m) => client.current!.request(m)}
          onClose={() => setMcp({ ...mcp, open: false })}
        />
      )}
      {skillsDialog && (
        <SkillsDialog
          open={skillsDialog.open}
          cwd={skillsDialog.cwd}
          sessionId={skillsDialog.sessionId}
          commands={skillsCommands}
          changed={configChanged[skillsDialog.cwd]}
          request={(m) => client.current!.request(m)}
          onRun={runCommand}
          onClose={() => setSkillsDialog({ ...skillsDialog, open: false })}
        />
      )}
      {plugins && (
        <PluginsDialog
          open={plugins.open}
          cwd={plugins.cwd}
          sessionId={plugins.sessionId}
          changed={configChanged[plugins.cwd]}
          reloadFailed={!!plugins.sessionId && reloadFailed.has(plugins.sessionId)}
          request={(m) => client.current!.request(m)}
          onRestarted={(ids) => setReloadFailed((f) => new Set([...f].filter((x) => !ids.includes(x))))}
          onClose={() => setPlugins({ ...plugins, open: false })}
        />
      )}
      <SettingsDialog open={settingsOpen} changed={settingsChanged} request={(m) => client.current!.request(m)} onClose={() => setSettingsOpen(false)} tabGrouping={grouping} onTabGrouping={changeGrouping} onRestartGuide={() => startGuide("settings")} />
      {update && <UpdateToast update={update} request={(m) => client.current!.request(m)} />}
      {stale && !update && (
        <StaleToast
          note={stale}
          onDismiss={() => {
            staleDismissed.current = stale;
            setStale(undefined);
          }}
        />
      )}
      {toast && <Toast message={toast} onClose={closeToast} />}
    </div>
    </SideLabel>
    </AvatarColors>
  );
}

type Pane = "session" | "changes" | "files" | "terminal" | "graph";

/** `changes`: the changed file count, shown on the changes tab like OpenCode's "Files Changed N". */
export function PaneTabs({ panes, value, onChange, changes = 0 }: { panes: Pane[]; value: Pane; onChange: (p: Pane) => void; changes?: number }) {
  return (
    <div className="flex gap-1 pointer-coarse:gap-2" role="tablist" aria-label="Panes">
      {panes.map((p) => (
        <Button
          key={p}
          size="sm"
          variant={p === value ? "secondary" : "ghost"}
          className="pointer-coarse:h-11"
          role="tab"
          aria-selected={p === value}
          onClick={() => onChange(p)}
          data-testid={`pane-${p}`}
          data-command={p === "files" || p === "changes" || p === "graph" ? `pane.${p}` : undefined}
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

/** Drag handle (or arrow keys) on the sessions sidebar's right edge on md and up; it sits in the gap beside the sidebar. */
function SidebarResizer({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const clamp = (w: number) => Math.round(Math.max(200, Math.min(w, 560, window.innerWidth / 2)));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      tabIndex={0}
      className="-mx-2 hidden w-2 shrink-0 cursor-col-resize touch-none rounded-full hover:bg-primary/30 focus-visible:bg-primary/30 md:block"
      data-testid="sidebar-resizer"
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={(e) =>
        e.currentTarget.hasPointerCapture(e.pointerId) && onResize(clamp(e.clientX - e.currentTarget.previousElementSibling!.getBoundingClientRect().left))
      }
      onDoubleClick={() => onResize(288)}
      onKeyDown={(e) => {
        const d = { ArrowLeft: -32, ArrowRight: 32 }[e.key];
        if (d) (e.preventDefault(), onResize(clamp(width + d)));
      }}
    />
  );
}

/** Drag handle (or arrow keys) between the side panel and the terminal panel below it on wide screens (OpenCode: 100px to 60% of the window). */
function TerminalResizer({ height, onResize }: { height: number; onResize: (h: number) => void }) {
  const clamp = (h: number) => Math.round(Math.max(100, Math.min(h, window.innerHeight * 0.6)));
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
      aria-valuenow={height}
      tabIndex={0}
      className="hidden h-2 shrink-0 cursor-row-resize touch-none rounded-full hover:bg-primary/30 focus-visible:bg-primary/30 lg:block"
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={(e) =>
        e.currentTarget.hasPointerCapture(e.pointerId) && onResize(clamp(e.currentTarget.parentElement!.getBoundingClientRect().bottom - e.clientY - 4))
      }
      onKeyDown={(e) => {
        const d = { ArrowUp: 32, ArrowDown: -32 }[e.key];
        if (d) (e.preventDefault(), onResize(clamp(height + d)));
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
 * Creates the session (or reuses `created`: one in `cwd` whose first prompt failed), applies mode and effort, sends the first prompt
 * or runs the first bash mode command. Rejects when it was not taken; `created` then keeps the session for the retry.
 */
export async function startSession(
  request: Client["request"],
  created: { current?: SessionInfo },
  cwd: string,
  { model, mode, effort }: StartOptions,
  first: FirstMessage,
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
  // A command starts the query too (Session.bash), so mode and effort are set before it as well.
  await request(
    "command" in first
      ? { type: "session.bash", sessionId: session.id, command: first.command }
      : { type: "session.prompt", sessionId: session.id, text: first.text, images: first.images },
  );
  created.current = undefined;
  return session;
}

/** Stable empty view for a session tab shown before its subscribe reply (the memoized pane must not re-render for a fresh object). */
const EMPTY_VIEW = emptySession();

/** The new-session tab while its first prompt creates the session (GH-133): SessionPane's layout with the prompt, Thinking and skeletons. */
function StartingSession({ cwd, place, pending }: { cwd: string; place?: string; pending: Pending[] }) {
  const phone = usePhone();
  return (
    <div className={`${card} flex-1`} data-testid="starting-session" aria-busy="true">
      {!phone && (
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4" data-testid="session-header">
          <ProjectAvatar cwd={cwd} />
          <span className="min-w-0 truncate font-medium" title={cwd}>
            {place ?? projectName(cwd)}
          </span>
          <SideBadge cwd={cwd} />
          <span className="min-w-0 truncate text-muted-foreground" title={cwd}>
            {cwd}
          </span>
        </header>
      )}
      <VirtualTimeline
        items={[] as TimelineItem[]}
        itemKey={timelineKey}
        renderItem={() => null}
        footer={
          <>
            {pending.map((p, i) => (
              <PendingMessage key={p.key} p={p} view={EMPTY_VIEW} index={i} />
            ))}
            <ThinkingRow className="mt-3" />
          </>
        }
      />
      <div className="relative mx-auto flex w-full max-w-3xl flex-col gap-2 p-4 max-sm:px-2 max-sm:py-2">
        <Skeleton className="h-[104px] w-full rounded-lg" data-testid="prompt-skeleton" />
      </div>
    </div>
  );
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
  worktrees = {},
  cwd,
  onCwd,
  onNewWorktree,
  worktreeJob,
  models,
  draft,
  onDraft,
  modes,
  onOpenProject,
  onUpload,
  onSearch,
  onCommands,
  commandsRev,
  onStart,
  onDialog,
  inputRef,
  connected = true,
}: {
  projects: string[];
  /** session.list worktrees: the chosen project's ones fill the Run session in chip. */
  worktrees?: Record<string, Worktree[]>;
  cwd?: string;
  onCwd: (cwd: string) => void;
  /** Run session in → New worktree: creates one in this project's repository. */
  onNewWorktree?: (project: string) => void;
  /** Worktree being created for this project: the prompt is held; `error`: shown under the chips. */
  worktreeJob?: { error?: string };
  models: ModelInfo[];
  draft: StartOptions;
  onDraft: (d: StartOptions) => void;
  modes: PermissionMode[];
  onOpenProject: () => void;
  onUpload: (file: File) => Promise<string>;
  onSearch: (cwd: string) => (query: string) => Promise<string[]>;
  /** Commands and skills of a project for the `/` menu (no session exists yet). */
  onCommands: (cwd: string) => Promise<SlashCommand[]>;
  /** Changes on any config.changed (a user-wide change shows in every project): the commands are asked again. */
  commandsRev?: number;
  /** Rejects when the session was not created; the prompt box keeps the draft. */
  onStart: (cwd: string, opts: StartOptions, first: FirstMessage) => Promise<void>;
  /** `/mcp`, `/skills`, `/plugins` typed alone, `/resume` with or without text: opens that dialog of `cwd` instead of creating a session. */
  onDialog?: (dialog: DialogName, arg?: string) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  connected?: boolean;
}) {
  const { model, mode, effort } = draft;
  const project = cwd ? projectOf(cwd, worktrees) : "";
  const runIn = ((project && worktrees[project]) || []).filter((w) => !w.outsideRoots).sort(byRow);
  const here = runIn.find((w) => w.path === cwd);
  const OPEN = "\0open";
  const NEW_WT = "\0worktree";
  const creating = worktreeJob && !worktreeJob.error;
  // The project's commands, asked when the tab shows or the project changes; until they arrive only the dialog commands are listed.
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    if (!cwd || !connected) return setCommands([]);
    let stale = false;
    onCommands(cwd).then((c) => !stale && setCommands(c), () => {});
    return () => void (stale = true);
  }, [cwd, connected, commandsRev]);
  useEffect(() => setCommands([]), [cwd]);

  return (
    <div className="flex w-full max-w-[720px] flex-col items-center gap-4">
      <div className="w-full">
        <PromptBox
          cwd={cwd}
          commands={commands}
          onDialog={cwd ? onDialog : undefined}
          models={models}
          model={model}
          onModel={(m) => onDraft({ ...draft, model: m })}
          effort={effort}
          onEffort={(e) => onDraft({ ...draft, effort: e })}
          mode={mode}
          modes={modes}
          onMode={(m) => onDraft({ ...draft, mode: m })}
          onUpload={onUpload}
          onSearch={cwd ? onSearch(cwd) : async () => []}
          onPrompt={(text, images) => (cwd ? onStart(cwd, { model, mode, effort }, { text, images }) : Promise.reject(new Error("no project")))}
          onBash={cwd ? (command) => onStart(cwd, { model, mode, effort }, { command }) : undefined}
          state={connected ? "idle" : "disconnected"}
          blocked={creating ? "Creating worktree…" : undefined}
          blockedIcon={creating ? <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : undefined}
          label="First prompt"
          placeholder={cwd ? `Ask Claude in ${worktreeName(cwd, worktrees) ?? projectName(cwd)}…` : "Open a project to start"}
          autoFocus
          disabled={!cwd}
          inputRef={inputRef}
        />
      </div>
      {cwd ? (
        // Project chip: Base UI Select like the prompt toolbar pickers; "Open project…" is its last item.
        <div className="flex flex-wrap items-center justify-center gap-1">
        <Select value={project} onValueChange={(v) => (v === OPEN ? onOpenProject() : v && onCwd(v))}>
          <SelectTrigger aria-label="Project" title={project} data-testid="project-chip" className={`${GHOST} max-md:h-11! text-foreground hover:bg-secondary`}>
            <ProjectAvatar cwd={project} />
            <span className="font-medium" data-testid="new-project">
              {projectName(project)}
            </span>
            <SideBadge cwd={project} />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} side="bottom" align="start" className="w-auto min-w-64 max-w-[calc(100vw-2rem)] rounded-md p-0.5 shadow-floating! ring-0">
            {projects.map((p) => (
              <SelectItem key={p} value={p} className={ROW}>
                <ProjectAvatar cwd={p} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{projectName(p)}</span>
                  <span className="truncate text-muted-foreground text-xs" title={p}>{p}</span>
                </span>
                <SideBadge cwd={p} />
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={OPEN} className={ROW}>
              <FolderPlusIcon />
              Open project…
            </SelectItem>
          </SelectContent>
        </Select>
        {(runIn.length > 1 || (onNewWorktree && runIn.length > 0)) && (
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="select-none text-faint">
              /
            </span>
            {/* OpenCode PromptWorkspaceSelector: "Run session in", Run session in, Local repository, the worktrees, New worktree. */}
            <Select value={cwd} onValueChange={(v) => (v === NEW_WT ? onNewWorktree?.(project) : v && onCwd(v))}>
              <SelectTrigger aria-label={`${here?.main ? "Local" : (here?.branch ?? projectName(cwd))}, Run session in`} title={cwd} data-testid="worktree-chip" className={`${GHOST} max-md:h-11! text-foreground hover:bg-secondary`}>
                {here?.main ? <MonitorIcon /> : <GitBranchIcon />}
                <span className="max-w-50 truncate">{here?.main ? "Local" : (here?.branch ?? projectName(cwd))}</span>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom" align="start" className="w-auto min-w-48 max-w-[calc(100vw-2rem)] rounded-md p-0.5 shadow-floating! ring-0">
                <SelectGroup>
                  <SelectLabel>Run session in</SelectLabel>
                  {runIn.map((w) => (
                    <SelectItem key={w.path} value={w.path} title={w.path} className={ROW}>
                      {w.main ? <MonitorIcon /> : <GitBranchIcon />}
                      <span className="truncate">{w.main ? "Local repository" : (w.branch ?? projectName(w.path))}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
                {onNewWorktree && (
                  <>
                    <SelectSeparator />
                    <SelectItem value={NEW_WT} className={ROW} data-testid="new-worktree-item">
                      <GitBranchPlusIcon />
                      <span className="truncate">New worktree</span>
                    </SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          </span>
        )}
        {worktreeJob?.error && (
          <p role="alert" className="w-full text-center text-destructive text-sm" data-testid="worktree-error">
            Worktree not created: {worktreeJob.error}
          </p>
        )}
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

/** The modes a session offers now: SessionInfo.permissionModes is from the last reply; auto follows the current model, which another client can change. */
const modesOf = (offered: PermissionMode[], model: string, models: ModelInfo[]) =>
  offered.length && models.length ? permissionModesFor({ allowBypass: offered.includes("bypassPermissions"), supportsAuto: models.some((m) => m.value === model && m.supportsAutoMode) }) : offered;

const autoUnavailable = (models: ModelInfo[], model: string) => `Auto mode not available for ${models.find((m) => m.value === model)?.displayName ?? model}; switched to Ask`;

export type StartOptions = { model: string; mode: PermissionMode; effort: Effort };
/** What starts a session: a first prompt, or a bash mode command (`!` in the first prompt box). */
export type FirstMessage = { text: string; images: string[] } | { command: string };
const NEW_SESSION_MODES = PERMISSION_MODES.filter((m) => m !== "bypassPermissions");
type DraftPick = Omit<StartOptions, "mode"> & { mode?: PermissionMode };
const NEW_DRAFT: DraftPick = { model: "default", effort: "default" };

const timelineKey = (item: TimelineItem) => (item.kind === "context" ? item.id : item.part.id);

const MemoSessionPane = memo(SessionPane);

/**
 * A mounted session tab: its pane re-renders only when a value prop changes (its view, session, connection), not for the new callbacks of
 * every App render (a tab switch, another session's event). The callbacks it gets are stable and call the latest App closure.
 */
function SessionTab(props: ComponentProps<typeof SessionPane>) {
  return <MemoSessionPane {...useStableProps(props)} />;
}

export function SessionPane({
  place,
  coordinator,
  scrollKey,
  run,
  onOpenRun = () => {},
  onStopRun = async () => {},
  insert,
  onInserted,
  rewindTo,
  onRewindShown,
  revealHit,
  onRevealShown,
  onLoadOlder,
  loadingOlder,
  session,
  view,
  pending,
  models,
  onModel,
  onMode,
  onEffort,
  onUpload,
  onPrompt,
  onBash,
  onSearch,
  onInterrupt,
  onCancelContinue,
  onRewindPreview,
  onRewind,
  onRespond,
  onAnswer,
  connected,
  onGitStatus,
  onDialog,
}: {
  scrollKey: number;
  /** Subagent run whose subagent view shows; an unknown one shows the session view. */
  run?: string;
  /** Opens a run's subagent view; undefined: the session view. */
  onOpenRun?: (id?: string) => void;
  /** Stop agent: stops that subagent run only; rejects with the daemon's error. */
  onStopRun?: (id: string) => Promise<unknown>;
  insert?: string;
  onInserted: () => void;
  /** Opens the rewind panel of this user message (palette Rewind). */
  rewindTo?: string;
  onRewindShown?: () => void;
  /** A content search hit to scroll to once its message is loaded (palette Messages). */
  revealHit?: { hit: SearchHit; query: string };
  onRevealShown?: () => void;
  /** Loads the page before the view's cursor; `until`: back to the turn holding that part or message id. */
  onLoadOlder?: (opts?: { until?: string; user?: boolean }) => void;
  loadingOlder?: boolean;
  session: SessionInfo;
  /** "<project> · <branch>" of a linked worktree session. */
  place?: string;
  coordinator?: boolean;
  view: SessionView;
  /** Optimistic prompts not yet echoed (GH-133). */
  pending?: Pending[];
  models: ModelInfo[];
  onModel: (model: string) => void;
  onMode: (mode: PermissionMode) => void;
  onEffort: (effort: Effort) => void;
  /** Stores a non-image attachment in the daemon; resolves to its absolute path. */
  onUpload: (file: File) => Promise<string>;
  /** Rejects when the prompt was not taken; the prompt box then gets the text back. */
  onPrompt: (text: string, images: string[]) => Promise<unknown>;
  /** Bash mode (`!`): runs a shell command in the session cwd; rejects when it was not run. */
  onBash?: (command: string) => Promise<unknown>;
  onSearch: (query: string) => Promise<string[]>;
  onInterrupt: () => void;
  /** Drops the scheduled continue after a usage limit. */
  onCancelContinue?: () => void;
  onRewindPreview: (userMessageId: string) => Promise<RewindPreview>;
  onRewind: (userMessageId: string, mode: RewindMode) => Promise<unknown>;
  onRespond: (requestId: string, answer: PermissionAnswer) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  /** The daemon is reachable; otherwise the send button is disabled. */
  connected: boolean;
  onGitStatus?: () => Promise<GitStatus | null>;
  /** `/mcp`, `/skills`, `/plugins` typed alone, `/resume` with or without text: opens that dialog instead of sending. */
  onDialog?: (dialog: DialogName, arg?: string) => void;
}) {
  const phone = usePhone();
  const current = runOf(view, run);
  const pendingPart = pendingPermission(view);
  const pendingAsk = pendingQuestion(view);
  // In a subagent view only a request from inside that run replaces the notice; the session view shows every one.
  const permission = pendingPart && (!current || inRun(view, pendingPart.toolUseId, current.id)) ? pendingPart : undefined;
  const question = pendingAsk && (!current || inRun(view, pendingAsk.toolUseId, current.id)) ? pendingAsk : undefined;
  const modePicker = <ModePicker mode={view.permissionMode ?? session.permissionMode} modes={modesOf(session.permissionModes, view.model ?? session.model, models)} onMode={onMode} shortcut={false} />;
  // Waiting for a permission answer is part of the running turn.
  const turnRunning = view.state === "running" || view.state === "needs_input";
  const isClearing = clearing(view, pending);
  // A bash mode command runs: Stop and Esc kill it.
  const shellRunning = bashRunning(view);
  // Stop agent of the shown run: pending until the run ends, or the request's error next to the button.
  const [stop, setStop] = useState<{ run: string; error?: string }>();
  const stopRun = (id: string) => {
    setStop({ run: id });
    onStopRun(id).catch((e: Error) => setStop({ run: id, error: e.message }));
  };
  const stopOf = current && stop?.run === current.id ? stop : undefined;
  // Esc stops the turn, like Claude Code; in a subagent view it stops only that run, like Stop agent. The command picker handles
  // its own Esc first (preventDefault), and an open modal dialog owns Esc.
  const escStops = current ? isRunning(current) && !(stopOf && !stopOf.error) : turnRunning || shellRunning;
  const onEscape = useEffectEvent(() => (current ? stopRun(current.id) : onInterrupt()));
  useEffect(() => {
    if (!escStops) return;
    const onEsc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && !isImeKey(e) && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]') && onEscape();
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [escStops]);
  const [rewinding, setRewinding] = useState<string>();
  // Palette Rewind: the timeline scrolls to the message first (it can be outside the rendered window), then its panel opens.
  const [reveal, setReveal] = useState<{ key: string }>();
  useEffect(() => {
    if (!rewindTo) return;
    setReveal({ key: rewindTo });
    setRewinding(rewindTo);
    onRewindShown?.();
  }, [rewindTo]);
  const items = useMemo(() => timeline(view), [view]);
  // Palette Messages: the session may still be loading; the hit is revealed once its message is in the timeline.
  const triedUntil = useRef<unknown>(undefined);
  useEffect(() => {
    if (!revealHit) return;
    const key = hitKey(items, revealHit.hit, revealHit.query);
    if (!key) {
      // Not loaded: it may be in an older page. Load back to it once; if it is still not there afterwards, give up.
      if (loadingOlder || !view.older) return;
      if (triedUntil.current === revealHit) return onRevealShown?.();
      triedUntil.current = revealHit;
      return onLoadOlder?.({ until: revealHit.hit.messageId });
    }
    setReveal({ key });
    onRevealShown?.();
  }, [revealHit, items, loadingOlder]);
  // Reasoning text stays hidden (OpenCode default); this row shows the turn (or the shown run) is working.
  // GH-133: a sent prompt shows its bubble and the Thinking row before the daemon's own state arrives.
  const shownPending = current ? [] : unechoed(pending, view);
  const thinking = ((view.state === "running" && (!current || current.status === "running")) || shownPending.length > 0) && (
    <ThinkingRow className={shownPending.length ? "mt-3" : ""} />
  );
  const [draft, setDraft] = useState<{ text: string; images: string[] }>();
  const prompt = useRef<HTMLTextAreaElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  // Phone: scrolling up through an idle transcript hides the prompt dock for reading space; scrolling down or the end brings it back (GH-166).
  // Never while a turn or shell runs (Stop), a panel waits for an answer, or the dock has focus (typing).
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => void (card.current = dock.current?.parentElement ?? null), []);
  const [dockFocused, setDockFocused] = useState(false);
  const dockHidden = useHideOnScroll(card, phone, turnRunning || shellRunning || !!permission || !!question || !!current || dockFocused);

  return (
    <CwdContext value={session.cwd}>
    <OpenRunContext value={onOpenRun}>
      {current ? (
        <SubagentBar view={view} run={current} onOpen={onOpenRun} />
      ) : (
      phone ? null : (
      // From sm up: where the session is (project, side, cwd). Below sm the tab switcher says it, so the reading space starts at the top (GH-165).
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4" data-testid="session-header">
        <ProjectAvatar cwd={session.cwd} />
        <span className="min-w-0 truncate font-medium" title={session.cwd} data-testid="session-project">
          {place ?? projectName(session.cwd)}
        </span>
        <SideBadge cwd={session.cwd} />
        <span className="min-w-0 truncate text-muted-foreground" title={session.cwd}>
          {session.cwd}
        </span>
        {/* Idle, running and needs input show in the tab and the send button. Only error and closed have no other place. */}
        {(shownState(view) === "error" || shownState(view) === "closed") && (
          <span className="ml-auto rounded bg-muted px-2 py-0.5 text-xs" data-testid="session-state">
            {shownState(view)}
          </span>
        )}
      </header>
      )
      )}
      {current ? (
        <Conversation key={`${scrollKey}:${current.id}`} className="flex-1">
          <ConversationContent className="timeline mx-auto w-full max-w-[800px] 2xl:max-w-[1000px]">
            <Timeline view={view} parentId={current.id} />
            {thinking}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      ) : (
        <VirtualTimeline
          key={scrollKey}
          items={items}
          itemKey={timelineKey}
          reveal={reveal}
          sticky={(item) => {
            if (item.kind !== "part" || item.part.type !== "user_text" || (coordinator && item.part.text.startsWith(ORCHESTRATION_NOTICE))) return;
            const { text } = splitUploads(item.part.text);
            const n = item.part.images.length;
            const label = text || `${n} image${n === 1 ? "" : "s"}`;
            return { label, content: n && text ? `${text} (${n} image${n === 1 ? "" : "s"})` : label };
          }}
          onJump={() => {
            if (window.matchMedia?.("(pointer: coarse)").matches) return;
            // A permission or question panel replaces the prompt box: its first option or action is the target (a question's Dismiss stops the turn, so it is never first).
            (prompt.current ?? dock.current?.querySelector<HTMLElement>("form input[type=radio], form input[type=checkbox], form button"))?.focus();
          }}
          footer={
            (shownPending.length > 0 || thinking) && (
              <>
                {shownPending.map((p, i) => (
                  <PendingMessage key={p.key} p={p} view={view} index={items.length + i} />
                ))}
                {thinking}
              </>
            )
          }
          onReachTop={view.older && onLoadOlder ? (user) => onLoadOlder({ user }) : undefined}
          loadingOlder={loadingOlder}
          renderItem={(item, index) => {
            // A finished turn (not running; the next top-level item is a prompt, or it is the last) ends with Copy response, with or without a usage footer: a restored transcript has none.
            const next = items[index + 1];
            const copyText = (next ? next.kind === "part" && (next.part.type === "user_text" || next.part.type === "bash") : !turnRunning && !view.externalTurn) ? turnText(items, index) : "";
            const row = (
            item.kind === "context" ? (
              <ContextGroup calls={item.calls} result={(c) => resultOf(view, c)} awaiting={(c) => awaitingPermission(view).has(c.toolUseId)} />
            ) : item.part.type === "user_text" && coordinator && item.part.text.startsWith(ORCHESTRATION_NOTICE) ? (
              <div className={`flex ${index ? "mt-3" : ""}`} data-testid="orchestration-notice">
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-muted-foreground text-xs">
                  <UsersIcon className="size-3.5 shrink-0" aria-hidden />
                  <span className="sr-only">Orchestration notice: </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{item.part.text.slice(ORCHESTRATION_NOTICE.length).trim()}</span>
                </span>
              </div>
            ) : item.part.type === "user_text" ? (
              <UserMessage
                part={item.part}
                view={view}
                index={index}
                actions={
                  <>
                    <CopyAction text={item.part.text} />
                    <QuoteAction text={splitUploads(item.part.text).text} />
                    {/* No tooltip prop: its trigger renders a button around this button. */}
                    <MessageAction
                      className="pointer-coarse:size-11"
                      title="Rewind"
                      label="Rewind to before this message"
                      disabled={turnRunning}
                      onClick={() => setRewinding(rewinding === item.part.id ? undefined : item.part.id)}
                    >
                      <RotateCcwIcon />
                    </MessageAction>
                  </>
                }
              >
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
              </UserMessage>
            ) : (
              <PartView part={item.part} view={view} />
            )
            );
            return copyText ? (
              <>
                {row}
                <MessageActions className="mt-1">
                  <CopyAction text={copyText} label="Copy response" className="max-md:size-11" />
                </MessageActions>
              </>
            ) : (
              row
            );
          }}
        />
      )}
      <div
        ref={dock}
        className={`relative mx-auto flex w-full max-w-3xl flex-col gap-2 p-4 max-sm:px-2 max-sm:py-2 ${dockHidden ? "hidden" : ""}`}
        data-hidden={dockHidden || undefined}
        onFocus={() => setDockFocused(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setDockFocused(false)}
      >
        {permission ? (
          <PermissionPanel key={permission.id} part={permission} onRespond={(a) => onRespond(permission.requestId, a)} mode={modePicker} onStop={onInterrupt} />
        ) : question ? (
          <QuestionPanel key={question.id} part={question} onAnswer={(a) => onAnswer(question.requestId, a)} onDismiss={onInterrupt} mode={modePicker} />
        ) : current ? (
          <NotPromptable view={view} run={current} onOpen={onOpenRun} onStop={stopRun} stopping={!!stopOf && !stopOf.error} error={stopOf?.error} />
        ) : (
          <>
            {view.continueAt !== undefined && <ContinueDock at={view.continueAt} onCancel={() => onCancelContinue?.()} />}
            <PromptBox
              cwd={session.cwd}
              commands={view.commands}
              onDialog={onDialog}
              models={models}
              model={view.model ?? session.model}
              onModel={onModel}
              effort={view.effort ?? session.effort}
              onEffort={onEffort}
              mode={view.permissionMode ?? session.permissionMode}
              modes={modesOf(session.permissionModes, view.model ?? session.model, models)}
              onMode={onMode}
              onUpload={onUpload}
              onPrompt={onPrompt}
              onBash={onBash}
              onSearch={onSearch}
              insert={insert}
              onInserted={onInserted}
              draft={draft}
              state={connected ? (turnRunning ? (view.state as "running" | "needs_input") : shellRunning ? "running" : "idle") : "disconnected"}
              onInterrupt={onInterrupt}
              usage={view.contextUsage}
              stats={totals(view)}
              todos={showTodoDock(view.state, view.todos, false) ? view.todos : undefined}
              blocked={view.externalTurn ? "A terminal CLI turn is running in this session" : isClearing ? "Clearing the conversation… your message sends when it is done" : undefined}
              queueing={!view.externalTurn && isClearing}
              blockedIcon={!view.externalTurn && isClearing ? <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : undefined}
              agents={<AgentsButton view={view} onOpen={onOpenRun} />}
              label="Prompt"
              inputRef={prompt}
              placeholder={phone ? (turnRunning ? "Claude is working…" : "Ask Claude…") : turnRunning ? "Claude is working… (Enter to steer, Esc to stop)" : "Ask Claude… (Enter to send, Shift+Enter for newline, paste or drop images)"}
            />
          </>
        )}
        <StatusBar view={view} git={onGitStatus} />
      </div>
    </OpenRunContext>
    </CwdContext>
  );
}

function fitHeight(el: HTMLTextAreaElement) {
  const parent = el.parentElement!;
  parent.style.minHeight = `${parent.offsetHeight}px`;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
  parent.style.minHeight = "";
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
  onBash,
  onSearch,
  insert,
  onInserted,
  draft,
  state = "idle",
  onInterrupt,
  usage,
  stats,
  todos,
  agents,
  label,
  placeholder,
  autoFocus,
  disabled,
  blocked,
  blockedIcon,
  queueing,
  inputRef,
  onDialog,
}: {
  /** Changing it clears the send error. */
  cwd?: string;
  commands: SlashCommand[];
  /** Given: the dialog commands (`/mcp`, `/skills`, `/plugins`, `/resume`) are in the picker and open their dialog instead of being sent. */
  onDialog?: (dialog: DialogName, arg?: string) => void;
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
  /** Given: `!` at the start of the box enters bash mode, Enter runs the command; rejects when it was not run. Not on the new-session tab. */
  onBash?: (command: string) => Promise<unknown>;
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
  stats?: Totals;
  /** Todo dock above the box; none = hidden. */
  todos?: TodoItem[];
  /** Agents button in the toolbar (session view). */
  agents?: ReactNode;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Why nothing is sent now (a terminal CLI turn runs): shown above the box; the text stays and Send is off. */
  blocked?: string;
  /** Icon of the blocked dock; default the terminal icon. */
  blockedIcon?: React.ReactNode;
  /** The block is a wait the app queues sends through (a /clear running): Enter sends the prompt, the app holds it. */
  queueing?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const phone = usePhone();
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [found, setFound] = useState<{ query: string; paths: string[] }>();
  const [sendError, setSendError] = useState<string>();
  // Bash mode: the text is a shell command, the box looks like OpenCode's shell mode.
  const [bash, setBash] = useState(false);
  // The prompt box covers the dock's bottom 36px (OpenCode prompt lift), only when it directly follows the dock.
  const lift = !!todos && !blocked && !sendError && !images.length;
  const input = useRef<HTMLTextAreaElement>(null);
  // An input method is composing (Telex, Gboard...): its keys and its text are not ours to act on until compositionend.
  const composing = useRef(false);
  const token = dismissed || bash ? undefined : activeCommand(text, caret);
  // Dialog commands are actions, not text: only when the slash is the whole prompt.
  const matches = token && matchCommands(onDialog && token.lead ? withDialogCommands(commands) : commands, text, caret);
  const mention = dismissed || bash || matches ? undefined : activeMention(text, caret);
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
    // Again on reconnect: a search while offline rejects at once.
  }, [mention?.query, state === "disconnected"]);
  // Where the caret goes after the app itself replaced the text (an inserted mention, a restored prompt): a controlled textarea
  // moves it to the end. Only then: after the user's own typing or selecting the browser's selection is right, and collapsing
  // it breaks Ctrl+A and input methods that select a letter to replace it (EVKey, Unikey).
  const placeCaret = useRef<number>(undefined);
  // Never while an IME composes: moving the selection then makes it commit or restart (Gboard); it is placed after compositionend.
  useLayoutEffect(() => {
    const el = input.current;
    const c = placeCaret.current;
    if (!el || c === undefined || composing.current) return;
    placeCaret.current = undefined;
    if (el.selectionStart !== c || el.selectionEnd !== c) el.setSelectionRange(c, c);
  }, [text, caret]);
  // Fallback where CSS field-sizing is missing: measure with the parent's height held, so the timeline above is not
  // resized (and its scroll position clamped) by the temporary collapse; again when the width changes (re-wrap).
  const native = globalThis.CSS?.supports?.("field-sizing", "content");
  useLayoutEffect(() => void (!native && input.current && fitHeight(input.current)), [text, bash]);
  useEffect(() => {
    const el = input.current;
    if (!el || native) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => el.clientWidth !== width && ((width = el.clientWidth), fitHeight(el)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** The user's own edit: the browser already put the caret where it belongs. */
  const typed = (t: string, c: number) => {
    setText(t);
    setCaret(c);
    setSelected(0);
    setDismissed(false);
  };
  /** The app's edit: the caret is moved to `c` once the text renders. */
  const edit = (t: string, c = t.length) => {
    placeCaret.current = c;
    typed(t, c);
  };
  /** A prompt that was not sent goes back in front of anything typed since, the caret after it. */
  const restore = (t: string) => {
    setText((cur) => (cur ? `${t}\n${cur}` : t));
    placeCaret.current = t.length;
    setCaret(t.length);
  };
  useEffect(() => {
    if (!insert) return;
    // A quote (GH-56) is prompt text, never part of a shell command.
    if (insert.startsWith(">")) setBash(false);
    const r = insert.startsWith(">") ? appendQuote(text, insert) : insert.startsWith("/") ? insertCommand(text, insert) : insertAtCaret(text, caret, insert);
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
  // Only on a change: a hidden Activity (the new-session card during its first send, GH-133) re-runs its effects when it shows again, and that would clear the error of the failed send.
  const errorCwd = useRef(cwd);
  useEffect(() => {
    if (errorCwd.current === cwd) return;
    errorCwd.current = cwd;
    setSendError(undefined);
  }, [cwd]);
  const send = (t = text) => {
    if (bash) {
      const command = t.trim();
      if (!command || blocked) return;
      setSendError(undefined);
      onBash!(command).catch((e: Error) => {
        restore(t);
        setBash(true);
        setSendError(`Command not run: ${e.message}`);
      });
      edit("");
      setBash(false);
      return;
    }
    if (!t.trim() && !images.length) return;
    const dialog = onDialog && dialogOf(t, commands);
    if (dialog && (!images.length || dialog === "resume")) {
      const arg = dialogArg(t);
      return arg ? onDialog(dialog, arg) : onDialog(dialog), edit("");
    }
    if (blocked && !queueing) return;
    const sent = images;
    setSendError(undefined);
    launchFlight(t, input.current?.getBoundingClientRect());
    onPrompt(t, sent).catch((e: Error) => {
      cancelFlight(t);
      // Back into the prompt box, before anything typed since.
      restore(t);
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
    if (!token!.lead) {
      const r = insertSlash(text, token!, matches[i]!.name);
      return edit(r.text, r.caret);
    }
    const r = choose(matches[i]!, text);
    "send" in r ? send(r.send) : edit(r.text);
  };
  /** Images go with the prompt; other files are uploaded and become `@path` mentions. */
  const attach = async (files: Iterable<File>) => {
    const all = [...files];
    // Checked before reading: a big file would be held in memory as base64 and could exceed the daemon's frame limit.
    const big = all.find((f) => f.size > MAX_UPLOAD_BYTES);
    if (big) return setSendError(`Attach failed: ${big.name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    // Only an earlier attach error is stale now; a send error stays until the next send.
    setSendError((e) => (e?.startsWith("Attach failed") ? undefined : e));
    const others = all.filter((f) => !isPromptImage(f.type));
    const added = await readImages(all);
    setImages((i) => [...i, ...added]);
    try {
      const paths = await Promise.all(others.map(onUpload));
      if (!paths.length) return;
      setText((t) => {
        const r = insertAtCaret(t, Math.min(caret, t.length), paths.map(mentionPath).join(" "));
        placeCaret.current = r.caret;
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
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter commits the composition, Esc cancels it, arrows pick IME candidates: never send, pick, dismiss or switch modes then.
    if (composing.current || isImeKey(e.nativeEvent)) return;
    // Ctrl/Cmd+B, I, E format the selection; defaultPrevented keeps Ctrl+B from toggling the sidebar here. Not in bash mode.
    if (!bash && formatShortcut(e)) return;
    // OpenCode shell mode: `!` typed at the start of an empty caret switches modes and is not inserted.
    if (onBash && !bash && e.key === "!" && !e.ctrlKey && !e.metaKey && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault();
      return setBash(true);
    }
    if (bash && ((e.key === "Escape" && state === "idle") || (e.key === "Backspace" && !text && caret === 0))) {
      e.preventDefault();
      return setBash(false);
    }
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
        Tab: () => {
          if (!matches?.length) return pick(selected);
          const r = insertSlash(text, token!, matches[selected]!.name);
          edit(r.text, r.caret);
        },
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
    {blocked && (
      // OpenCode composer dock anatomy (followup dock): rounded-xl, hairline border, layer-01 background.
      <p role="status" data-testid="external-turn" className="flex min-h-[42px] w-full items-center gap-2 rounded-xl border-[0.5px] bg-muted py-2 pr-3 pl-4 text-sm">
        {blockedIcon ?? <SquareTerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        {blocked}
      </p>
    )}
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
      {!bash && <MarkdownToolbar input={input} disabled={disabled} />}
      {bash && (
        <span data-testid="bash-mode" aria-hidden className="pointer-events-none absolute top-4 left-4 font-mono text-sm text-muted-foreground pointer-coarse:text-base">
          !
        </span>
      )}
      <textarea
        role="combobox"
        aria-expanded={pickerOpen}
        aria-controls="command-picker"
        aria-activedescendant={pickerOpen ? `command-${selected}` : undefined}
        aria-label={bash ? "Shell command" : label}
        className={`field-sizing-content max-h-[min(240px,40dvh)] min-h-[calc(2lh+1.5rem)] max-sm:min-h-[calc(1lh+1.5rem)] w-full resize-none bg-transparent pt-4 pb-2 text-sm outline-none pointer-coarse:text-base ${bash ? "pr-4 pl-8 font-mono" : "px-4"}`}
        rows={phone ? 1 : 2}
        placeholder={bash ? "Run a shell command (Esc to exit)" : placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        value={text}
        ref={(el) => void ((input.current = el), inputRef && (inputRef.current = el))}
        onChange={(e) => {
          const v = e.target.value;
          // Soft keyboards send no key for "!": the box was empty-caret-at-0 before, and now starts with it.
          if (!composing.current && onBash && !bash && v.startsWith("!") && v.length === text.length + 1 && e.target.selectionStart === 1 && !text.startsWith("!")) {
            setBash(true);
            return edit(v.slice(1), 0);
          }
          typed(v, e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onCompositionStart={() => void (composing.current = true)}
        onCompositionEnd={() => void (composing.current = false)}
        onBlur={() => void (composing.current = false)}
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
        agents={agents}
        usage={usage}
        stats={stats}
        state={state}
        hasInput={!disabled && !blocked && (!!text.trim() || images.length > 0)}
        onSend={() => send()}
        onStop={() => onInterrupt?.()}
        // Not on touch screens: focusing the prompt box there opens the soft keyboard (OpenCode leaves focus on the page).
        onFocusLost={() => !window.matchMedia?.("(pointer: coarse)").matches && input.current?.focus()}
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

function CopyAction({ text, label = "Copy message", className = "" }: { text: string; label?: string; className?: string }) {
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
    <MessageAction title="Copy" label={label} className={`pointer-coarse:size-11 ${className}`} onClick={copy}>
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
    <div
      className="ml-auto flex w-full max-w-md flex-col gap-2 rounded-lg border p-3 text-sm"
      data-testid="rewind-panel"
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

type UserTextPart = Extract<Part, { type: "user_text" }>;

/** A user prompt row: bubble, hover actions, extras (rewind panel). A pending one keeps the actions' space, invisible and inert. */
function UserMessage({ part, view, index, pending, actions, children }: { part: UserTextPart; view: SessionView; index: number; pending?: boolean; actions: ReactNode; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLanding(ref, part.text);
  return (
    // 12px item gap + 12px = OpenCode 24px turn gap.
    <div ref={ref} className={`group flex flex-col gap-1 ${index ? "mt-3" : ""}`} data-testid="user-message" data-pending={pending ? "" : undefined}>
      <PartView part={part} view={view} />
      {/* Shown on hover or keyboard focus (OpenCode user bubble). */}
      <MessageActions
        className={pending ? "invisible ml-auto" : "ml-auto opacity-0 transition-opacity motion-reduce:transition-none group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"}
        inert={pending || undefined}
        aria-hidden={pending || undefined}
      >
        {actions}
      </MessageActions>
      {children}
    </div>
  );
}

/** Optimistic prompt (GH-133): the bubble of a sent prompt until its user_text arrives; same box as the real one. */
function PendingMessage({ p, view, index }: { p: Pending; view: SessionView; index: number }) {
  const part: UserTextPart = { type: "user_text", id: p.key, text: p.text, images: p.images };
  return (
    <UserMessage
      part={part}
      view={view}
      index={index}
      pending
      actions={
        <>
          <CopyAction text={p.text} />
          <QuoteAction text={splitUploads(p.text).text} />
          <MessageAction className="pointer-coarse:size-11" title="Rewind" label="Rewind to before this message" disabled>
            <RotateCcwIcon />
          </MessageAction>
        </>
      }
    />
  );
}

/** The working row: shown while a turn runs, and at once for a just-sent prompt. */
function ThinkingRow({ className }: { className?: string }) {
  return (
    <div data-testid="thinking" className={className}>
      <Shimmer as="span" className="font-medium text-sm">
        Thinking
      </Shimmer>
    </div>
  );
}

function PartView({ part, view }: { part: Part; view: SessionView }) {
  const openRun = use(OpenRunContext);
  switch (part.type) {
    case "user_text": {
      const { text, files } = splitUploads(part.text);
      return (
        <>
          {(text || part.images.length > 0) && (
            <Message from="user">
              <MessageContent className="[overflow-wrap:anywhere]">
                <ImageStrip images={part.images} />
                <UserMarkdown text={text} />
              </MessageContent>
            </Message>
          )}
          {/* OpenCode AttachmentCardV2: 160px two-line card (name, type) below the bubble, right-aligned. */}
          {files.length > 0 && (
            <div className="ml-auto flex max-w-[min(82%,64ch)] flex-wrap justify-end gap-2">
              {files.map((f) => (
                <div key={f.path} title={f.name} data-testid="attachment" className="flex w-40 flex-col gap-1.5 rounded-md bg-accent p-2 text-[11px] leading-3 tracking-[0.05px] shadow-[inset_0_0_0_0.5px_var(--border)]">
                  <span className="truncate font-medium">{f.name}</span>
                  <span className="text-muted-foreground">{/\.([^.]+)$/.exec(f.name)?.[1]!.toUpperCase() ?? "File"}</span>
                </div>
              ))}
            </div>
          )}
        </>
      );
    }
    case "assistant_text":
      return <AssistantText text={part.text} streaming={part.streaming} />;
    case "tool_call":
      return <ToolCard call={part} result={resultOf(view, part)} awaiting={awaitingPermission(view).has(part.toolUseId)} />;
    case "subagent":
      return (
        <SubagentGroup part={part} result={resultOf(view, part)} awaiting={awaitingPermission(view).has(part.id)} onOpen={openRun && (() => openRun(part.id))}>
          <Timeline view={view} parentId={part.id} />
        </SubagentGroup>
      );
    case "question":
      return <QuestionMarker part={part} />;
    case "turn_result":
      return <TurnFooter part={part} />;
    case "compaction":
      return <CompactionDivider id={part.id} summary={part.summary} />;
    case "turn_interrupted":
      return (
        <div className="text-muted-foreground text-xs" data-testid="turn-interrupted">
          Interrupted by user
        </div>
      );
    case "notice":
      // Claude Code's banner levels: notice in inactive gray, warning prominent. A run of blank lines shows as one.
      return (
        <div data-testid="notice" className={`flex items-start gap-1.5 text-xs ${part.level === "warning" ? "text-warning" : "text-muted-foreground"}`}>
          {part.level === "warning" && <TriangleAlertIcon role="img" aria-label="Warning" className="mt-px size-3.5 shrink-0" />}
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{part.text.replace(/\n{3,}/g, "\n\n")}</span>
        </div>
      );
    case "raw":
      return <RawPart message={part.message} />;
    case "bash":
      return <BashCard part={part} />;
    default:
      return null;
  }
}

/** Bash mode: what the user ran (`!command`) and its output, always open; a status line while running, stopped or failed. */
function BashCard({ part }: { part: Extract<Part, { type: "bash" }> }) {
  const output = [part.stdout, part.stderr].filter(Boolean).join("\n");
  const call: ToolCall = { type: "tool_call", id: part.id, toolUseId: part.id, tool: "Bash", input: { command: part.command }, status: part.status === "running" ? "running" : "done" };
  const result = output ? { type: "tool_result" as const, id: `${part.id}:result`, toolUseId: part.id, output, isError: part.status === "error" } : undefined;
  const status = part.status === "running" ? "Running…" : part.status === "stopped" ? "Stopped" : part.exitCode ? `Exit code ${part.exitCode}` : undefined;
  return (
    <div data-testid="bash-card" data-status={part.status} className="space-y-1">
      <ToolBody call={call} result={result} />
      {status && <p className="text-muted-foreground text-xs">{status}</p>}
    </div>
  );
}

/** An SDK message the adapter does not know yet, or the error of a failed query: one muted line, never its JSON. */
/** "type/subtype" of an SDK message, e.g. "system/task_updated", muted; the error text of a failed query as a warning notice. */
function RawPart({ message }: { message: unknown }) {
  const { type, subtype, error } = (message ?? {}) as { type?: unknown; subtype?: unknown; error?: unknown };
  if (typeof error === "string")
    return (
      <div className="flex items-start gap-1.5 text-warning text-xs" data-testid="raw-part">
        <TriangleAlertIcon role="img" aria-label="Warning" className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{error}</span>
      </div>
    );
  return (
    <div className="text-muted-foreground text-xs [overflow-wrap:anywhere]" data-testid="raw-part">
      {[type, subtype].filter((v) => typeof v === "string").join("/") || "SDK message"}
    </div>
  );
}

/** OpenCode compaction divider (line, label, line, 10px block padding); the summary Claude continues from, collapsed below it. */
function CompactionDivider({ id, summary }: { id: string; summary?: string }) {
  // Outside the item: an item leaving the rendered window keeps its open summary.
  const { open, onOpenChange } = useExpanded(`compaction:${id}`);
  return (
    <div data-testid="compaction" className="flex flex-col">
      <div className="flex items-center gap-3 py-2.5 text-muted-foreground text-xs">
        <span className="h-px flex-1 bg-border" aria-hidden />
        <span className="whitespace-nowrap">Conversation compacted</span>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
      {summary && (
        <details className="group text-sm" data-testid="compaction-summary" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)}>
          <summary className="mx-auto flex min-h-6 w-fit cursor-pointer items-center rounded px-2 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Summary
          </summary>
          <div className="mt-2 rounded-lg bg-muted p-3">
            <MessageResponse mode="static">{summary}</MessageResponse>
          </div>
        </details>
      )}
    </div>
  );
}

function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useSmoothText(text, streaming);
  const revealing = streaming || shown.length < text.length;
  return (
    // OpenCode text part margin-top 24px, on top of the 12px timeline gap.
    <Message from="assistant" className="relative mt-6" data-testid="assistant-text">
      <MessageContent>
        <MessageResponse mode={revealing ? "streaming" : "static"} isAnimating={revealing}>
          {shown}
        </MessageResponse>
      </MessageContent>
      {/* Overlay in the 24px gap above the text: no height added; touch uses the floating Quote button. */}
      {!revealing && (
        <MessageActions className="absolute -top-7 right-0 opacity-0 transition-opacity motion-reduce:transition-none group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:hidden">
          <QuoteAction text={text} />
        </MessageActions>
      )}
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
