import { createPortal } from "react-dom";
import { Activity, lazy, memo, Suspense, use, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ComponentProps, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, FolderPlusIcon, GitBranchIcon, GitBranchPlusIcon, LoaderCircleIcon, MenuIcon, MonitorIcon, MoonIcon, PanelLeftIcon, PanelRightIcon, RotateCcwIcon, SearchIcon, SettingsIcon, SquareIcon, SquareTerminalIcon, SunIcon, TriangleAlertIcon, UsersIcon, XIcon } from "lucide-react";
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
  ArtifactPreviewResult,
  MediaResult,
  ModelInfo,
  ModelsResult,
  Part,
  PermissionMode,
  ProjectOpenResult,
  RewindMode,
  RewindPreview,
  RespondResult,
  SessionInfo,
  SideCheck,
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
  TerminalListResult,
  Worktree,
  WorktreeCreateResult,
  WorktreeRemoveResult,
  WorktreeStatusResult,
} from "@claude-ui/protocol";
import { isPromptImage, MAX_UPLOAD_BYTES, ORCHESTRATION_NOTICE, PERMISSION_MODES, permissionModesFor, type AsideOpenResult, type SearchHit, type SettingsResult, type ShellOutputResult } from "@claude-ui/protocol";
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
import { QueueChips } from "./queue-chips.tsx";
import { connect, type ConnectionStatus, type Request, type RequestError } from "./client.ts";
import { ImageStrip, readDataUrl, readImages } from "./images.tsx";
import { PastedBlock, pastedBlockId, PasteChips } from "./pasted-text.tsx";
import { backspaceToken, cleanTitle, collapsePasted, deleteToken, expandPastes, healDeletion, isLargePaste, nextPasteId, normalizePaste, type Pastes, pasteRefs, pasteTagId, pasteToken, prunePastes, splitPasted, stripPasted, summarizePasted } from "./pasted-text.ts";
import { ArtifactConnectedContext, ArtifactPreviewContext, type ArtifactPreviewLoader } from "./artifact-preview.tsx";
import { MediaContext, restoreImages, type MediaLoader } from "./media.ts";
import { Toast, ToastRegion } from "./toast.tsx";
import { GHOST, ModePicker, nextMode, PromptToolbar, ROW, type SendState } from "./toolbar.tsx";
import { activeCommand, asideOf, choose, dialogArg, dialogOf, insertSlash, matchCommands, withDialogCommands, type DialogName } from "./commands.ts";
import { nextUpdate, UpdateToast, type UpdateInfo } from "./update.tsx";
import { StaleToast } from "./stale-toast.tsx";
import { NotificationStack, useNotifications, type CardItem } from "./notifications.tsx";
import { cardText, describeCard, IN_APP_EVENT, loadInApp, type Card } from "./notify.ts";
import { McpDialog } from "./mcp-dialog.tsx";
import { SkillsDialog } from "./skills-dialog.tsx";
import { ShellsDialog } from "./shells-dialog.tsx";
import { saveGroup as saveSettingsGroup, SettingsDialog } from "./settings-dialog.tsx";
import { PluginsDialog } from "./plugins-dialog.tsx";
import { nextReloadFailed } from "./plugins.ts";
import { paletteOrder, statusIcon, statusLabel } from "./mcp.ts";
import { activeMention, insertAtCaret, insertCommand, insertMention, mentionPath, splitUploads } from "./mentions.ts";
import { SessionList } from "./sidebar.tsx";
import { copyFailText } from "./copy-text.ts";
import { noteRefs } from "./git-refs.ts";
import { agentLinks, NO_LINKS, sameLinks, workerState, type AgentLinks } from "./workers.ts";
import { confirmNames, daysLabel } from "./sidebar-menus.ts";
import { resumeSearchText, byRow, inProject, keepsBranch, patchSession, projectCwd, projectOf, removableWorktree, removeWorktreeText, repoOf, timeAgo, worktreeName } from "./sessions.ts";
import { BLOCK_TEXT, ignoredText, summaryText, type CleanupScope } from "./cleanup.ts";
import { CleanupDialog } from "./cleanup-dialog.tsx";
import { CreateWorktreeDialog } from "./create-worktree-dialog.tsx";
import { appendQuote } from "./quote.ts";
import { MarkdownToolbar, formatShortcut } from "./markdown-toolbar.tsx";
import { UserMarkdown } from "./user-markdown.tsx";
import { clearDrafts, draftKeys, loadDraft, NEW_TAB_DRAFT } from "./drafts.ts";
import { autoCloseDue, autoCloseTargets, cleanupMenu as buildCleanupMenu, cleanupTargets, loadAutoClose, saveAutoClose, type AutoClose, type CleanupContext, type CleanupRule, type TabFacts } from "./tab-cleanup.ts";
import { loadUsed, pruneUsed, saveUsed, seedUsed, stampUsed } from "./tab-used.ts";
import { PairingForm } from "./pairing-form.tsx";
import { useDraft } from "./use-draft.ts";
import { QuoteAction, QuoteButton, QuoteContext } from "./quote-button.tsx";
import { PlanMeter } from "./plan-meter.tsx";
import { ContinueDock } from "./continue-dock.tsx";
import { foregroundShells, StatusBar, totals, type Totals } from "./status-bar.tsx";
import { rewindOptions } from "./rewind.ts";
import { useSmoothText } from "./smooth.ts";
import { disablePush, enablePush, pushSubscription, pushSupported, sendSubscription } from "./push.ts";
import { isUnread, loadSeen, loadShownActivity, pruneShownActivity, saveSeen, saveShownActivity, seenNow, tabTitle, tabUnread, type Seen } from "./unread.ts";
import { PermissionPanel, type PermissionAnswer } from "./permission.tsx";
import { QuestionMarker, QuestionPanel } from "./question.tsx";
import { applyEvent, awaitingPermission, bashRunning, emptySession, pendingPermission, pendingQuestion, hitKey, partOf, shownState, timeline, turnText, withEdits, withPage, withSubscribe, type SessionView, type TimelineItem, type ToolCall } from "./store.ts";
import { FILE_LINK_PROPS, FileLinkContext } from "./file-links.tsx";
import { BackgroundShellContext, PlanTabContext, ViewerContext, isFileTarget, latestPlan, planOfPart, useOpenViewer, type ViewerState } from "./viewer.ts";
import { ViewerDialog } from "./viewer-dialog.tsx";
import { ContextGroup, CwdContext, SubagentGroup, ToolBody, ToolCard, useExpanded } from "./tool-card.tsx";
import { VirtualTimeline } from "./virtual-timeline.tsx";
import { useSendMode } from "./send-mode.ts";
import { loadSignalOnly, saveSignalOnly, signalItems, useSignalOnly, type SignalItem } from "./signal.ts";
import { FoldRow } from "./signal-fold.tsx";
import { FocusPage, FocusRow, useNow } from "./focus-page.tsx";
import { AsideAsk } from "./aside-ask.tsx";
import { AsidePopup } from "./aside-popup.tsx";
import { isClearCommand } from "./clear.ts";
import { asideItem, cascade, clampRect, DEFAULT_SIZE, raise, setMinimized, type AsideState } from "./aside.ts";
import { nextWaiting, waitingCount, waitingRequests, waitingStatus } from "./focus.ts";
import { announcement, faviconHref, setFavicon } from "./attention.ts";
import { useStableProps } from "@/lib/utils";
import { showTodoDock, TodoDock } from "./todo-dock.tsx";
import { inDir, joinPath, relPath } from "./paths.ts";
import { EditorSync, FilesPanel } from "./files-panel.tsx";
import { FileDialog } from "./file-dialog.tsx";
import { createEditorStore, useEditorStore } from "./editor-store.ts";
import { defaultRepo, useRepos } from "./repos.ts";
import { repoProjectKey, type RepoList } from "./repo-choice.ts";
import { ChangesPanel } from "./changes-panel.tsx";
import { sessionDiffChoice } from "./diff-mode.ts";
import { sessionChanges } from "./changes.ts";
import { QuickOpen, quickOpenLabel } from "./quick-open.tsx";
import { CommandPalette } from "./palette.tsx";
import { appCommands, shortcutFor } from "./app-commands.ts";
import { shownPrompt } from "./config-dialog.tsx";
import { autoChapter, decideFirstUse, finishRun, GUIDE_KEY, isVisible, loadGuide, parseGuide, restartGuide, saveGuide, settled, skipGuide, wasFreshBrowser, withStep, type ChapterId, type GuideHost, type GuideState } from "./guide.ts";
import { chaptersOf, stepById, stepsFor } from "./guide-steps.ts";
import { GuideTour } from "./guide-tour.tsx";
import { keyText, matchesKey, withKey } from "./shortcuts.ts";
import { specOf, useKeymap } from "./keymap.ts";
import { LEADER_MS, PREFIX_KEYS, leaderStep } from "./leader.ts";
import { KeyTips } from "./key-tip.tsx";
import { markKeyUsed, resetAllKeyTips } from "./key-tips.ts";
import { loadClosed, popClosed, pushClosed, restoreClosed, restoreMany, saveClosed } from "./closed-tabs.ts";
import { ShortcutsDialog } from "./shortcuts-dialog.tsx";
import { isImeKey } from "./ime.ts";
import { OpenProjectDialog } from "./open-project.tsx";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger } from "@/components/ui/select";
import { SideBadge, SideLabel, sideLookup } from "./sides.tsx";
import { FOCUS_TAB, NEW_TAB, avatarColors, insertPaneTab, keysFinal as tabKeysFinal, closeMany, closeTab, closeTargets, otherGroupTargets, loadPinned, loadTabs, moveGroup, moveGroupTo, moveTabIn, openTab, projectName, replaceTab, runFromHash, runHash, savePinned, saveTabs, setPinned, staleTabs, tabFromHash, tabHash } from "./tabs.ts";
import { AgentLinksContext, AgentsButton, inRun, isRunning, NotPromptable, OpenRunContext, runOf, SubagentBar } from "./agents.tsx";
import { loadTabCompact, loadTabGrouping, saveTabCompact, saveTabGrouping, tabGroup, type TabGrouping } from "./tab-grouping.ts";
import { type Area, type DockArea, type DockSide, PANE_IDS, PANE_LABEL, canMain, type PaneId, activePane, areaOf, flipSide, loadLayout, loadPaneTabs, movePane, rememberPane, resetLayout, saveLayout, saveTerminalDock, useLayout, useMinWidth, withPane } from "./layout.ts";
import { PlanPane } from "./plan-pane.tsx";
import { PER_CWD, identityOf, isPaneRef, kindOf, ownerOf, paneTabFor, paneTabTitle, parseRef, refOf } from "./pane-ref.ts";
import { DockHeader, DropStrip, useAreaDrop, type DropAt, droppedPane, isPaneDrag, PaneSlot, usePaneHosts } from "./dock-area.tsx";
import type { TabCommand } from "./tab-menu.ts";
import { useSplitDrop } from "./split-drop.ts";
import { SPLIT_MIN_H, SPLIT_MIN_W, switchRuns, type Split, type SplitDir, canSplit as canSplitTabs, followSplit, isSession, loadSplit, nextAfterClose, nextSplit, placeIn, ratioFor, saveSplit, splitTo } from "./split.ts";
import { AvatarColors, IconButton, ProjectAvatar, QUIET_PRESSED, TabsBar, useGroupedTabs } from "./tabs-bar.tsx";
import { ConfirmDialog, DeleteDialog, type SessionAction } from "./session-actions.tsx";
import { anySessionRunning, useKeepAwake } from "./keep-awake.ts";
import { KeepAwakeButton } from "./keep-awake-button.tsx";
import { applyTheme, loadPref, nextPref, type ThemePref } from "./theme.ts";
import { draftToken, rotateDraftToken, uploadOwnerFor, uploadWithRetry, type UploadOwner } from "./upload-owner.ts";

type Client = ReturnType<typeof connect>;
/** What the side and bottom panel show: the shown session, or the new-session tab's project (`key` NEW_TAB, no session). */
type PanelTarget = { key: string; cwd: string; sessionId?: string };

// The active tab lives in the URL hash, so a reload reopens it.
const hashTab = () => tabFromHash(location.hash);
const card = "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-raised";
// xterm (~300 KB) loads with the first opened terminal panel, not with the app.
const GraphTab = lazy(() => import("./graph-tab.tsx").then((m) => ({ default: m.GraphTab })));
const GraphPane = lazy(() => import("./git-graph-panel.tsx").then((m) => ({ default: m.GraphPane })));
const TerminalPanel = lazy(() => import("./terminal-panel.tsx").then((m) => ({ default: m.TerminalPanel })));
const TERMINAL_KEY = "claude-ui.terminalOpen";
const PANEL_HIDDEN_KEY = "claude-ui.sidePanelHidden";
const FILE_TREE_HIDDEN_KEY = "claude-ui.fileTreeHidden";
const lastSegment = (p: string) => p.split(/[\\/]/).pop()!;
type RemovingWt = { project: string; path: string; branch: string; status?: WorktreeStatusResult; cached?: WorktreeStatusResult; checking: boolean; error?: string };
/** The remove dialog's text: Checking… (with the cached status and its age when there is one), the reason when blocked, the error, or the counts. */
function removeDialogText(w: RemovingWt | undefined, worktrees: Record<string, Worktree[]>) {
  if (!w) return "";
  const text = (st: WorktreeStatusResult) => removeWorktreeText(st, { keepsBranch: keepsBranch(worktrees[w.project], w.path, st) });
  if (w.error !== undefined) return w.error;
  if (w.checking) return w.cached ? `${text(w.cached)}${w.cached.checkedAt ? ` · checked ${timeAgo(w.cached.checkedAt)}` : ""} · Checking…` : "Checking…"; // an older daemon sends no checkedAt
  if (w.status?.safety === "blocked") return `Worktree ${w.status.branch} cannot be removed: ${BLOCK_TEXT[w.status.blocked!]}`;
  return w.status ? text(w.status) : "";
}
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

/** The session in the URL hash; none for the new-session tab, the Focus page and a pane tab (`plan:<session>`). */
const hashId = () => {
  const t = hashTab();
  return t && t !== NEW_TAB && t !== FOCUS_TAB && !isPaneRef(t) ? t : undefined;
};

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
  const [docker, setDocker] = useState<ListResult["docker"]>();
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
  const [shellsDialog, setShellsDialog] = useState<{ open: boolean; sessionId?: string }>();
  // config.changed count per project cwd: an open dialog of that project refreshes.
  // Settings dialog; `settingsChanged`: another client changed the settings (the open dialog reloads).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutsEdit, setShortcutsEdit] = useState<string>();
  // Shortcut labels and the shortcuts themselves follow the user's bindings.
  useKeymap();
  // Closed session tabs (Reopen closed tab), per browser.
  const [closedTabs, setClosedTabs] = useState(loadClosed);
  useEffect(() => saveClosed(closedTabs), [closedTabs]);
  const closedRef = useRef(closedTabs);
  closedRef.current = closedTabs;
  // Prefix key: shows the second keys until one is pressed or the time is up.
  const [prefixOn, setPrefixOn] = useState(false);
  // New terminal shortcut: each bump adds a terminal to the shown terminal panel.
  const [terminalTick, setTerminalTick] = useState(0);
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
  // GH-395 R8: a pane tab (`plan:<session>`) makes its owner the current session: docks, per-session pane history and the sidebar follow it.
  const paneRef = parseRef(activeId);
  const currentId = paneRef ? paneRef.owner : activeId;
  // A tab switch or route change mid-flight: the ghost must not fly over another view. Not the first prompt's own hand-off (its session already holds the pending prompt).
  useEffect(() => {
    if (!optimistic[activeId ?? ""]?.length) cancelFlight();
  }, [activeId]);
  // Subagent run shown in the active session tab (its subagent view; URL `#<session>/agent/<run>`), undefined = the session view.
  const [run, setRun] = useState(() => runFromHash(location.hash));
  const [tabs, setTabs] = useState(() => {
    const h = hashTab();
    return h && h !== FOCUS_TAB ? openTab(loadTabs(), h) : loadTabs();
  });
  // The request the Focus page has selected (GH-159); the oldest waiting one while unset.
  const [focusSel, setFocusSel] = useState<string>();
  // When this browser first saw a request that came without the daemon's `at`.
  const firstSeen = useRef(new Map<string, number>());
  /** Last live event per session (ms): the Focus page's quiet time. */
  const liveAt = useRef(new Map<string, number>());
  // Signal only (GH-159, one setting for the browser since GH-205), set in Settings.
  const signalOnly = useSignalOnly();
  // Keep screen awake (GH-361): "running" = a listed, unarchived session that works or waits for the user.
  const anyRunning = useMemo(() => anySessionRunning(list, views), [list, views]);
  const awake = useKeepAwake(anyRunning);
  const [grouping, setGrouping] = useState<TabGrouping>(loadTabGrouping);
  const changeGrouping = (g: TabGrouping) => {
    setGrouping(g);
    saveTabGrouping(g);
  };
  const [compact, setCompact] = useState(loadTabCompact);
  const changeCompact = (on: boolean) => {
    setCompact(on);
    saveTabCompact(on);
  };
  // Clean up tabs (GH-378): when each tab was last shown (per browser) and the auto-close setting.
  const [used, setUsed] = useState(loadUsed);
  const usedRef = useRef(used);
  usedRef.current = used;
  const [autoClose, setAutoClose] = useState(loadAutoClose);
  const changeAutoClose = (v: AutoClose) => {
    setAutoClose(v);
    saveAutoClose(v);
  };
  // A closed or replaced new-session tab starts with the defaults next time.
  const draftOpen = tabs.includes(NEW_TAB);
  useEffect(() => void (!draftOpen && setDraft(NEW_DRAFT)), [draftOpen]);
  // Open project lists the sides as of now: a container started since the last list joins.
  useEffect(() => void (openingProject && refreshList()), [openingProject]);
  const [theme, setTheme] = useState<ThemePref>(loadPref);
  const [error, setError] = useState<string>();
  const [toast, setToastState] = useState<{ key: number; message: string; action?: { label: string; onClick: () => void } }>();
  const toastKey = useRef(0);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /** The Undo toast of the last cleanup close: a following close while it shows joins it (one toast, Undo restores every set). */
  const undoToast = useRef<{ key: number; parts: { entries: { id: string; at: number }[]; wasActive?: string; onUndo?: () => void }[] }>(undefined);
  // Every toast is its own element (a key): a closing one cannot clear the next, and the same text restarts the timer.
  const setToast = useCallback((t: string | { message: string; action: { label: string; onClick: () => void } } | undefined) => setToastState(t === undefined ? undefined : { key: ++toastKey.current, ...(typeof t === "string" ? { message: t } : t) }), []);
  const closeToast = useCallback(() => setToast(undefined), [setToast]);
  // Guided tour (docs/spec.md "First-use guide"): `guideState` is the per-browser state, decided once after the first session list.
  const guideState = useRef<GuideState>(undefined);
  const guideDecided = useRef(false);
  const [guideReady, setGuideReady] = useState(false);
  const guideStep = useRef<string>(undefined);
  const [guideRun, setGuideRun] = useState<{ n: number; ids: string[]; chapters: ChapterId[]; start?: string; from?: "settings" | "palette" }>();
  const [update, setUpdate] = useState<UpdateInfo>();
  // The daemon's "runs older code" note; a dismissed note stays hidden until the page reloads.
  const [stale, setStale] = useState<string>();
  const staleDismissed = useRef<string | undefined>(undefined);
  const [status, setStatus] = useState<ConnectionStatus>("reconnecting");
  // Unpaired: the drafts of this browser go with its token (drafts.ts).
  useEffect(() => void (status === "unauthorized" && clearDrafts()), [status]);
  const [drawer, setDrawer] = useState(false);
  /** A `/resume` request for the sidebar search (SessionList `search`). */
  const [revealSeq, setRevealSeq] = useState(0);
  // Pinned session tabs (GH-359), per browser; a pin ends with its tab.
  const [pinned, setPinnedState] = useState(loadPinned);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const pinnedRef = useRef(pinnedSet);
  pinnedRef.current = pinnedSet;
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
  /** Open Aside popups (docs/spec.md "Aside"), the top one last; `asideFocused`: the one Esc applies to. */
  const [asides, setAsides] = useState<AsideState[]>([]);
  const [asideFocused, setAsideFocused] = useState<string>();
  /** React key of a session tab: a /clear moves it to the session the tab follows to, so its prompt box (text, images, focus) stays mounted. */
  const [tabKeys, setTabKeys] = useState<Record<string, string>>({});
  /** A session a tab followed to after /clear, until its subscribe reply: the session it replaced. */
  const [heirOf, setHeirOf] = useState<Record<string, string>>({});
  /** Titles from subscribe replies: a tab of a session not (yet) in the list, e.g. the page-load hash session. */
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [seen, setSeen] = useState<Record<string, Seen>>(loadSeen);
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const [shownActivity, setShownActivity] = useState(loadShownActivity);
  const shownActivityRef = useRef(shownActivity);
  shownActivityRef.current = shownActivity;
  // In-app notifications (GH-158): `notifyRef` takes every event; the choice is per browser and Settings tells this page by event.
  const notifyRef = useRef<(e: Event, live: boolean) => void>(undefined);
  const [inApp, setInApp] = useState(loadInApp);
  // Settings › Orchestration › Notifications from workers (GH-387): read on connect and from settings_changed.
  const [workerNotices, setWorkerNotices] = useState(true);
  // Settings › Git: no "modified content" probes of submodules in Changes.
  const [ignoreSubmodules, setIgnoreSubmodules] = useState(false);
  useEffect(() => {
    const sync = (e: globalThis.Event) => setInApp((e as CustomEvent<boolean>).detail ?? loadInApp());
    window.addEventListener(IN_APP_EVENT, sync);
    return () => window.removeEventListener(IN_APP_EVENT, sync);
  }, []);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string>();
  // Per session, bumped by a notification click: remounts its conversation, which starts scrolled to the bottom.
  const [scrollKeys, setScrollKeys] = useState<Record<string, number>>({});
  const focused = usePageFocused();
  // Narrow screens show one pane; wide screens show the session plus a side panel with changes or files.
  // Per session tab, so switching tabs keeps each one's pane.
  // GH-355: newest first per session tab. The narrow pane is the first entry; each dock area shows its newest pane.
  // GH-381: every selection is also remembered per browser (layout.ts PaneTabs), so a reload reopens on it.
  const [paneHist, setPaneHist] = useState<Record<string, Pane[]>>({});
  const hist = (currentId && paneHist[currentId]) || [];
  const histPane: Pane = hist[0] ?? "session";
  // The remembered tabs: read once at load, then updated by this page's own picks only (another browser tab's picks are not followed).
  const [paneTabs, setPaneTabs] = useState(loadPaneTabs);
  const setPane = (p: Pane) => {
    if (!currentId) return;
    rememberPane(p);
    setPaneTabs((t) => withPane(t, p, loadLayout()));
    setPaneHist((x) => ({ ...x, [currentId]: [p, ...(x[currentId] ?? []).filter((q) => q !== p)] }));
  };
  // GH-381: after a reload the first shown session tab reopens on the last selected pane (narrow: the pane switcher).
  const [restoreTo] = useState(() => loadPaneTabs().narrow);
  const paneRestored = useRef(false);
  useLayoutEffect(() => {
    if (paneRestored.current || !isSession(currentId)) return;
    paneRestored.current = true;
    if (restoreTo && restoreTo !== "session") setPaneHist((x) => (x[currentId] ? x : { ...x, [currentId]: [restoreTo] }));
  }, [currentId]);
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
  // Wide screens: the bottom panel shown (GH-354 terminal, GH-355 any pane; the key keeps its name so saved state carries over).
  // Kept per browser across reloads; the daemon's shells outlive the page.
  const [bottomOpen, setBottomOpen] = useState(() => loadFlag(TERMINAL_KEY));
  useEffect(() => saveFlag(TERMINAL_KEY, bottomOpen), [bottomOpen]);
  // OpenCode: 280px by default, resizable when stacked below the side panel.
  const [terminalHeight, setTerminalHeight] = useState(() => loadNumber(TERMINAL_HEIGHT_KEY, 280));
  useEffect(() => {
    try {
      localStorage.setItem(TERMINAL_HEIGHT_KEY, String(terminalHeight));
    } catch {
      // Storage blocked: the height lasts until the page reloads.
    }
  }, [terminalHeight]);
  // GH-355: wide screens place each pane in the side or the bottom panel; narrow screens keep the pane switcher.
  const layout = useLayout();
  const lg = useMinWidth(1024);
  // Split view (GH-356): two session tabs side by side or stacked; `activeId` stays the current session and the active split shows it.
  const [splitRaw, setSplitRaw] = useState(loadSplit);
  const split = followSplit(splitRaw, activeId, tabs);
  useEffect(() => {
    if (split !== splitRaw) setSplitRaw(split);
    saveSplit(split);
  }, [split]);
  // The session area's size: two splits need room for both minimum sizes, else the active one shows alone (the split returns with the space).
  const [area, setArea] = useState<{ w: number; h: number }>();
  const splitFits = !split || !area || !area.w || (split.dir === "row" ? area.w >= 2 * SPLIT_MIN_W + 8 : area.h >= 2 * SPLIT_MIN_H + 8);
  /** Wide with a split, but no room for both: the active split shows alone, with a hint. */
  const splitCramped = lg && !!split && isSession(activeId) && !splitFits;
  const splitRef = useRef(split);
  splitRef.current = split;
  /** Wide, roomy enough, a split exists and a session shows (the New session tab and Focus page suspend it). Both splits are on screen: they count as shown. */
  const splitOn = lg && !!split && isSession(activeId) && splitFits;
  const visibleIds = splitOn ? split.ids : [activeId];
  // A mention from "Send selection to Claude", a quote (`>`) or a command, waiting for the prompt box to take it.
  const [insert, setInsert] = useState<string>();
  // Quick open, and the file it asks the files panel to open (absolute path).
  const [quickOpen, setQuickOpen] = useState(false);
  const [openFile, setOpenFile] = useState<{ path: string; line?: number }>();
  /** File tree "Show changes": the Changes tab selects this path (`seq` tells a repeat apart). */
  const [changesReveal, setChangesReveal] = useState<{ path: string; seq: number }>();
  // Popup viewer (GH-238): what shows, for which session; `opener` takes the focus back on close.
  const [viewer, setViewer] = useState<ViewerState>();
  // File dialog: the Files tab's editor state in a modal (Pop out, Read cards, file references); it closes when another tab shows, like the viewer.
  const [editors] = useState(() => createEditorStore(() => client.current));
  // `git.repos` (GH-389): asked again after a session list or settings change (seq), and fresh after Reload from disk / Refresh.
  const [reposSeq, setReposSeq] = useState(0);
  const [reposFresh, setReposFresh] = useState(0);
  const editorTabs = useEditorStore(editors).tabs;
  const openFiles = useMemo(() => Object.keys(editorTabs), [editorTabs]);
  const [fileDialog, setFileDialog] = useState<{ opener: HTMLElement | null }>();
  useEffect(() => (setViewer(undefined), setFileDialog(undefined)), [activeId]);
  const quickOpener = useRef<Element>(null);
  // Title editor: in the sidebar row or in the tab the Rename action came from.
  const [renaming, setRenaming] = useState<{ id: string; in: "list" | "tab"; menu: boolean }>();
  // Session waiting for the delete confirmation.
  const [deleting, setDeleting] = useState<string>();
  // Project cwd whose Remove waits for the confirmation.
  const [removing, setRemoving] = useState<string>();
  const [closingGroup, setClosingGroup] = useState<{ ids: string[]; name: string }>();
  const lastClosingGroup = useRef({ ids: [] as string[], name: "" });
  if (closingGroup) lastClosingGroup.current = closingGroup;
  // Keeps the name while the dialog fades out.
  const lastRemoving = useRef("");
  // Set on Remove confirm, read by the dialog's final focus.
  const removed = useRef<{ next?: string }>(undefined);
  // Worktree being created for the new-session tab (`project`: the repository's project cwd); `error` once it failed.
  const [worktreeJob, setWorktreeJob] = useState<{ project: string; error?: string }>();
  // Project whose Create worktree modal is open (GH-447).
  const [creatingWt, setCreatingWt] = useState<string>();
  // Worktree waiting for the Remove confirmation; kept while the dialog fades out.
  const [removingWt, setRemovingWt] = useState<RemovingWt>();
  /** Identifies the open remove dialog's status request: a reply of a closed or replaced dialog does nothing. */
  const askToken = useRef<object>(undefined);
  /** Worktrees this page removes now (the dialog's Remove and a running Clean up): their rows show Removing…. */
  const [removingPaths, setRemovingPaths] = useState<Set<string>>(new Set());
  const markRemoving = (path: string, on: boolean) =>
    setRemovingPaths((s) => {
      const n = new Set(s);
      if (on) n.add(path);
      else n.delete(path);
      return n;
    });
  const lastRemovingWt = useRef(removingWt);
  if (removingWt) lastRemovingWt.current = removingWt;
  // Remove worker dialog (GH-358): `project`/`path`: the worker's own worktree when the app may remove it; `text`: its status; `others`: other listed sessions in it.
  const [removingWorker, setRemovingWorker] = useState<{ id: string; name: string; project?: string; path?: string; branch?: string; text?: string; others: number; loading: boolean; error?: string }>();
  const lastRemovingWorker = useRef(removingWorker);
  if (removingWorker) lastRemovingWorker.current = removingWorker;
  const [alsoWorktree, setAlsoWorktree] = useState(false);
  // Remove closed workers and Archive idle sessions confirmations; kept while the dialogs fade out.
  const [removingWorkers, setRemovingWorkers] = useState<{ ids: string[]; names: string; title: string }>();
  const lastRemovingWorkers = useRef(removingWorkers);
  if (removingWorkers) lastRemovingWorkers.current = removingWorkers;
  const [archiving, setArchiving] = useState<{ ids: string[]; where: string; days: number }>();
  const lastArchiving = useRef(archiving);
  if (archiving) lastArchiving.current = archiving;
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
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const runRef = useRef(run);
  runRef.current = run;
  const splitOnRef = useRef(false);
  splitOnRef.current = splitOn;
  const listRef = useRef(list);
  listRef.current = list;
  /** Prompts sent while a session's /clear runs: they go to the session the tab follows to (or back to this one when the /clear ends without), keyed by the session they were typed in. */
  const clearQueue = useRef<Record<string, { key: string; text: string; images: string[] }[]>>({});
  const requested = useRef(new Set<string>());
  /** Sessions subscribed holding on this connection: a tab shows them, the daemon keeps their CLI (docs/spec.md "Idle close"). */
  const held = useRef(new Set<string>());
  /** Open Aside popups, for the closure-held reconnect resubscribe (an Aside nobody holds is deleted by the daemon's idle cleanup). */
  const asidesRef = useRef(asides);
  asidesRef.current = asides;
  const isShown = (id: string) => tabsRef.current.includes(id) || hashId() === id || asidesRef.current.some((a) => a.id === id);
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
  /** True once a session list reply is in (never reset): the tab group keys are final only after it (GH-196). */
  const [listLoaded, setListLoaded] = useState(false);
  const listLoadedRef = useRef(listLoaded);
  listLoadedRef.current = listLoaded;
  /** Tabs whose subscribe failed for a reason other than unknown_session: their session never arrives, so they must not keep the group keys from becoming final (GH-201). */
  const [failedTabs, setFailedTabs] = useState<ReadonlySet<string>>(new Set());
  const failedTabsRef = useRef(failedTabs);
  failedTabsRef.current = failedTabs;
  /** Sessions whose subscribe is in flight while they have a view (a reconnect resubscribe): the view may be of an earlier daemon run (GH-378). */
  const resubscribing = useRef(new Set<string>());
  /** Connections opened so far, and whether a session.list reply requested on the current one arrived (GH-378): before it the list (state, lastActivity) may be of before a daemon restart. */
  const connGen = useRef(0);
  const listFresh = useRef(false);

  async function refreshList() {
    const gen = connGen.current;
    try {
      const { sessions, projects, recentProjects = [], permissionModes, sides, docker, cwdSides = {}, worktrees = {} } = await client.current!.request<ListResult>({ type: "session.list" });
      // A project removed here or by another client: its session tabs close (they would show a session no longer listed).
      const listed = new Set(sessions.map((s) => s.id));
      closeTabs(new Set(listRef.current.filter((s) => !listed.has(s.id) && !projects.includes(projectCwd(s.cwd))).map((s) => s.id)));
      setList(sessions.map((s) => ({ ...s, title: cleanTitle(s.title) })));
      if (gen === connGen.current) listFresh.current = true;
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
      setDocker(docker);
      setCwdSides(cwdSides);
      setWorktrees(worktrees);
      setListLoaded(true);
      if (permissionModes) setNewModes(permissionModes);
      if (restored.current) {
        // The page-load hash session is left out: its project may be removed (not listed); its own subscribe forgets it when unknown.
        for (const id of new Set(staleTabs(restored.current.filter((id) => id !== hashId()), new Set(sessions.map((s) => s.id))).map(ownerOf))) forget(id);
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
  /** `startAt`: the part to start the snapshot at when the view has none (an Aside: its own question). */
  async function subscribe(sessionId: string, addProject = false, fresh = false, background = false, startAt?: string) {
    const view = viewsRef.current[sessionId];
    if (view) resubscribing.current.add(sessionId);
    // After a daemon restart the snapshot starts at the oldest turn this view holds (transcript uuids are stable), so the scroll position survives.
    const from = fresh ? undefined : view?.order.find((id) => {
      const p = view.parts.get(id);
      return p?.type === "user_text" && !p.parentId;
    }) ?? startAt;
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
      setFailedTabs((f) => (f.has(sessionId) ? new Set([...f].filter((x) => x !== sessionId)) : f));
      setHeirOf((h) => (h[sessionId] ? without(h, sessionId) : h));
      if (r.title) setTitles((t) => ({ ...t, [sessionId]: cleanTitle(r.title) }));
    } catch (e) {
      // Gone from the daemon, e.g. never prompted before a daemon restart (no transcript): drop it from this tab.
      if ((e as RequestError).code === "unknown_session") return forget(sessionId);
      if ((e as Error).message !== "disconnected") {
        setError((e as Error).message);
        setFailedTabs((f) => (f.has(sessionId) ? f : new Set(f).add(sessionId)));
        // Asked again by the next follow (a reconnect, another pane tab) instead of waiting on "Loading plan…" for good.
        if (!viewsRef.current[sessionId]) requested.current.delete(sessionId);
      } else if (!viewsRef.current[sessionId]) requested.current.delete(sessionId); // a dropped request: the next follow asks again; a view is resubscribed on reconnect
    } finally {
      resubscribing.current.delete(sessionId);
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
    // A pinned tab stays pinned on the session it goes on in.
    setPinnedState((p) => (p.includes(from) && !p.includes(to) ? p.map((x) => (x === from ? to : x)) : p));
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

  /** Queued messages (GH-77): the daemon holds them; like sendPrompt, nothing waits for a reconnect. */
  function queueRequest<T = unknown>(msg: Request): Promise<T> {
    if (statusRef.current !== "connected") return Promise.reject(new Error(`the daemon is ${statusRef.current}`));
    return client.current!.request<T>(msg);
  }

  /** Drops the view of a session this tab no longer follows; `unsubscribe`: also stops the daemon's events. */
  function drop(sessionId: string, unsubscribe = true) {
    held.current.delete(sessionId);
    requested.current.delete(sessionId);
    setViews((v) => without(v, sessionId));
    setInfos((i) => without(i, sessionId));
    setFailedTabs((f) => (f.has(sessionId) ? new Set([...f].filter((x) => x !== sessionId)) : f));
    if (unsubscribe) client.current?.request({ type: "session.unsubscribe", sessionId }).catch(() => {});
  }

  /** `deleted`: removed on purpose (this or another tab), so no "no longer exists" error. */
  function forget(sessionId: string, deleted = false) {
    // An Aside deleted elsewhere (another tab closed it): its popup goes.
    setAsides((a) => (a.some((x) => x.id === sessionId) ? a.filter((x) => x.id !== sessionId) : a));
    drop(sessionId, false);
    setOptimistic((o) => without(o, sessionId));
    setList((l) => l.filter((s) => s.id !== sessionId));
    // Its pane tabs go with it.
    setTabs((t) => t.filter((id) => ownerOf(id) !== sessionId));
    setHeirOf((h) => without(h, sessionId));
    delete clearQueue.current[sessionId];
    setTabKeys((k) => without(k, sessionId));
    const h = hashTab();
    if (h && ownerOf(h) === sessionId) {
      // Deleted like a closed tab: its neighbour becomes active.
      const next = deleted ? closeMany(tabsRef.current, tabsRef.current.filter((t) => ownerOf(t) === sessionId), h).active : undefined;
      if (next) return open(next);
      setActiveId(undefined);
      history.replaceState(null, "", location.pathname + location.search);
      if (!deleted) setError("That session no longer exists in the daemon.");
    }
  }

  /** /btw: the daemon forks `ownerId` into an Aside and sends the question there; the popup shows its timeline from that question. */
  async function openAside(ownerId: string, question: string) {
    if (statusRef.current !== "connected") throw new Error(`the daemon is ${statusRef.current}`);
    const r = await client.current!.request<AsideOpenResult>({ type: "aside.open", sessionId: ownerId, text: question });
    const id = r.session.id;
    setInfos((i) => ({ ...i, [id]: r.session }));
    setTitles((t) => ({ ...t, [id]: cleanTitle(r.title) }));
    setAsides((a) => [...a, { id, ownerId, title: r.title, from: r.from, minimized: false, readOnly: true }]);
    setAsideFocused(id);
    void subscribe(id, false, false, false, r.from);
  }
  function closeAside(id: string) {
    setAsides((a) => a.filter((x) => x.id !== id));
    setAsideFocused((f) => (f === id ? undefined : f));
    drop(id, true);
    client.current?.request({ type: "aside.close", sessionId: id }).catch((e) => setError((e as Error).message));
  }
  /** Keep as session: the popup becomes a tab; the view and subscription stay, `loadOlder` brings the copied history on scroll up. */
  async function keepAside(id: string) {
    try {
      await client.current!.request({ type: "aside.keep", sessionId: id });
    } catch (e) {
      return setError((e as Error).message);
    }
    setAsides((a) => a.filter((x) => x.id !== id));
    setAsideFocused((f) => (f === id ? undefined : f));
    open(id);
    void refreshList();
  }
  /** Brings an Aside popup forward (Focus "open"): its owner tab shows, the popup is restored and on top. */
  function showAside(id: string) {
    const a = asides.find((x) => x.id === id);
    if (!a) return;
    setAsides((l) => raise(setMinimized(l, id, false), id));
    setAsideFocused(id);
    open(a.ownerId);
  }

  /** Subscribes the owner of a pane tab when no view exists: in the background (no CLI hold) unless a session tab of it is open. Once per owner while requested. */
  function followOwner(o: string) {
    if (viewsRef.current[o] || requested.current.has(o)) return;
    requested.current.add(o);
    void subscribe(o, false, false, !isShown(o));
  }

  /** Opens or focuses a tab; `undefined` shows no tab. Only a session tab goes into the URL hash. */
  function open(id: string | undefined, keepHash = false) {
    setError(undefined);
    // A tab shown in the other split is revealed there (VS Code), with its subagent view.
    const sp = splitRef.current;
    if (id && sp && splitOnRef.current && id !== activeRef.current && sp.ids.includes(id)) {
      setDrawer(false);
      return focusSplit(id, keepHash);
    }
    setActiveId(id);
    setDrawer(false);
    if (!keepHash) setRun(undefined);
    if (!id) return;
    // The Focus page is no session: it has no tab in the list and nothing to subscribe to.
    if (id === FOCUS_TAB) {
      if (!keepHash) history.replaceState(null, "", tabHash(id));
      if (activeId !== FOCUS_TAB) setFocusSel(undefined);
      return;
    }
    setTabs((t) => openTab(t, id));
    if (!keepHash) history.replaceState(null, "", tabHash(id));
    // A pane tab shows from its owner's view: follow the owner (no hold unless a session tab holds it).
    if (isPaneRef(id)) return followOwner(ownerOf(id));
    // A page-load link subscribed without adding its project: the first explicit open of that session adds it, view or not.
    // A session the list only follows in the background is held now (a tab shows it).
    const add = !viewsRef.current[id] || !listRef.current.some((s) => s.id === id);
    if (id !== NEW_TAB && (add || !held.current.has(id))) void subscribe(id, add);
  }

  /** Makes `t` the active tab of split `s` (already updated for it): the subagent view of each tab goes with it, the hash follows. Not `open()`: the tab is open already. */
  function enter(s: Split, t: string, keepHash = false) {
    const cur = activeRef.current;
    const sw = cur === t ? { runs: s.runs, run: runRef.current } : switchRuns(s.runs, cur, runRef.current, t);
    setSplitRaw({ ...s, runs: sw.runs });
    setError(undefined);
    setActiveId(t);
    setRun(sw.run);
    if (!keepHash) history.replaceState(null, "", sw.run ? runHash(t, sw.run) : tabHash(t));
  }

  /** Makes the split showing `id` the active one. */
  function focusSplit(id: string, keepHash = false) {
    const s = splitRef.current;
    if (!s || !s.ids.includes(id) || id === activeRef.current) return;
    enter({ ...s, at: s.ids.indexOf(id) }, id, keepHash);
  }

  /** Split right / Split down: `t` goes to a new split in the direction, focus moves there. */
  function splitTab(t: string, dir: SplitDir, before = false) {
    const r = splitTo(splitRef.current, tabsRef.current, activeRef.current, t, dir, before);
    if (!r) return;
    setDrawer(false);
    enter(r.split, t);
    focusShownPrompt(t);
  }

  /** A tab dropped on the middle of a split: it shows there (a tab shown in the other split swaps with it). */
  function showInSplit(t: string, i: number) {
    const s = splitRef.current;
    if (!s) return open(t);
    enter(placeIn(s, t, i), t);
    focusShownPrompt(t);
  }

  /** Join splits: one session shows again, the active one. */
  function joinSplits() {
    saveSplit(undefined);
    setSplitRaw(undefined);
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
  // These read the latest tabs and active tab (refs): a close can run from a timer of an earlier render (a swipe's slide-out), after another close.
  function close(id: string) {
    const r = closeTab(tabsRef.current, id, activeRef.current);
    // Closing the active split's tab: the next tab is one outside the splits, else the other split's tab (the split ends).
    const sp = splitRef.current;
    const next = sp && splitOnRef.current && id === activeRef.current ? nextAfterClose(tabsRef.current, id, sp) : r.active;
    setTabs(r.tabs);
    release(id, r.tabs);
    activate(next);
  }

  /** A close from the phone switcher (swipe or Delete on a row): the toast offers Undo for that exact tab; the New session tab has nothing to reopen. */
  function closeFromList(id: string) {
    const title = tabLabel(id);
    const wasActive = activeRef.current === id;
    close(id);
    if (id === NEW_TAB) return;
    setToast({
      message: `Closed ${title}`,
      action: {
        label: "Undo",
        onClick: () => {
          if (!existsTab(id)) return;
          const r = restoreClosed(closedRef.current, tabsRef.current, id);
          setClosedTabs(r.stack);
          setTabs(r.tabs);
          // Back in place; it becomes the shown tab only if it was the one shown when swiped away.
          if (wasActive) open(id);
          // A tab that was not shown is held again like any open tab (the close left it followed in the background, or dropped).
          else if (!isPaneRef(id)) void subscribe(id); // no `held` check: the close's background subscribe may still be in flight and would win
        },
      },
    });
  }

  /** What closing a session tab leaves behind: its place on the closed stack, and its subscription (live: followed in the background; else dropped). */
  // `left`: the tabs that stay open after this close (the ref is not updated before the commit).
  function release(id: string, left: string[] = tabsRef.current.filter((t) => t !== id)) {
    if (id === NEW_TAB) return;
    setClosedTabs((c) => pushClosed(c, id, tabsRef.current.indexOf(id)));
    const o = ownerOf(id);
    const state = listRef.current.find((s) => s.id === o)?.state;
    const live = !!state && state !== "closed" && state !== "error";
    if (isPaneRef(id)) {
      // A live owner stays followed by the list; a tab of the owner (or another pane tab) keeps its view.
      if (!live && !left.some((t) => ownerOf(t) === o)) drop(o);
      return;
    }
    // A pane tab of this session stays: its view keeps following in the background.
    live || left.some((t) => isPaneRef(t) && ownerOf(t) === id) ? void subscribe(id, false, false, true) : drop(id);
  }

  /** The tab that took over after a close; none: the hash goes. */
  function activate(next: string | undefined) {
    if (next === activeRef.current) return;
    open(next);
    if (!next) history.replaceState(null, "", location.pathname + location.search);
  }

  /** Closes the tabs of a group in one step; each lands on the closed stack in strip order, so Reopen closed tab brings the last one back first. */
  function closeGroup(ids: string[]) {
    const r = closeMany(tabsRef.current, ids, activeRef.current);
    setTabs(r.tabs);
    const left = tabsRef.current.filter((t) => !ids.includes(t));
    for (const id of tabsRef.current.filter((t) => ids.includes(t))) release(id, left);
    activate(r.active);
  }

  /** Close group (chip menu, middle click, Delete on the chip, the command): a group of 2 or more tabs asks first, a single tab closes at once. */
  function requestCloseGroup(key: string, ids: string[]) {
    const own = ids.filter((id) => id !== NEW_TAB && tabs.includes(id) && !pinnedSet.has(id));
    if (own.length < 2) return closeGroup(own);
    const g = tabGroup(sessionOf(own[0]!)?.cwd, grouping, worktrees);
    setClosingGroup({ ids: own, name: `${g.label || projectName(key)}${g.sub ? ` (${g.sub})` : ""}` });
  }

  /** Close others / to the right / all / other groups (GH-359): no question (the sessions keep running), one toast with Undo for all of them. */
  function closeSeveral(ids: string[], message?: (n: number, title: string | undefined) => string, onUndo?: () => void) {
    // Before closeGroup: release() reads the old tab list for each index.
    const now = tabsRef.current;
    const entries = ids.filter((id) => now.includes(id)).map((id) => ({ id, at: now.indexOf(id) }));
    if (!entries.length) return;
    const wasActive = activeRef.current;
    const one = entries.length === 1 ? entries[0]!.id : undefined;
    const title = one && (one === NEW_TAB ? "New session" : tabLabel(one));
    closeGroup(entries.map((e) => e.id));
    // A toast still showing with its Undo (an earlier cleanup close) is not replaced: one toast, Undo restores both sets.
    const prev = undoToast.current;
    const joined = prev && toastRef.current?.key === prev.key && toastRef.current.action ? prev.parts : [];
    const parts = [...joined, { entries, wasActive, onUndo }];
    const total = parts.reduce((n, p) => n + p.entries.length, 0);
    setToast({
      message: joined.length ? `Closed ${total} tabs` : message ? message(entries.length, title) : one ? `Closed ${title}` : `Closed ${entries.length} tabs`,
      action: {
        label: "Undo",
        onClick: () => {
          // A cleanup during the toast's exit must not join a set that is back already.
          if (undoToast.current?.parts === parts) undoToast.current = undefined;
          // Latest set first, each on the list the previous step produced.
          // A layout change (Plan back in the main area) first, so the restored pane tabs find their home.
          for (const p of parts) p.onUndo?.();
          let stack = closedRef.current;
          let tabs = tabsRef.current;
          const restored: string[] = [];
          let shown: string | undefined;
          for (const p of [...parts].reverse()) {
            const r = restoreMany(stack, tabs, p.entries, existsTab);
            stack = r.stack;
            tabs = r.tabs;
            restored.push(...r.restored);
            if (p.wasActive && r.restored.includes(p.wasActive)) shown = p.wasActive;
          }
          setClosedTabs(stack);
          setTabs(tabs);
          for (const id of restored) if (id !== NEW_TAB && !isPaneRef(id) && id !== shown) void subscribe(id);
          // Undo counts as use: the restored tabs must not be auto-closed again at once.
          setUsed((u) => stampUsed(u, restored, Date.now()));
          // The tab that was shown comes back shown; the others are held again like any open tab.
          if (shown) open(shown);
        },
      },
    });
    undoToast.current = { key: toastKey.current, parts };
  }

  /** Clean up tabs (GH-378): what the rules know about each open tab, read at call time (refs), so a click acts on the current state. */
  function tabFacts(): TabFacts[] {
    const drafts = draftKeys();
    // Another window of this browser may have shown a tab since: the newer stamp counts.
    const stored = loadUsed();
    const usedAt = (id: string) => Math.max(usedRef.current[id] ?? 0, stored[id] ?? 0) || undefined;
    const shown = loadShownActivity();
    const shownAt = (id: string) => (shownActivityRef.current[id] ?? shown[id]) === undefined ? undefined : Math.max(shownActivityRef.current[id] ?? 0, shown[id] ?? 0);
    return tabsRef.current.map((id) => {
      if (id === NEW_TAB) return { id, unread: false, draft: drafts.has(NEW_TAB_DRAFT), listed: true, archived: false, worker: false, transcript: false, busy: false, lastUsed: usedAt(id) };
      // A pane tab: no state of its own, so "idle" and "finished" never close it; an archived or deleted owner and the unused rules do.
      if (isPaneRef(id)) {
        const owner = listRef.current.find((s) => s.id === ownerOf(id));
        return { id, unread: false, draft: false, listed: !!owner, archived: !!owner?.archived, worker: false, transcript: false, busy: false, loading: !listFresh.current, lastUsed: usedAt(id) };
      }
      const item = listRef.current.find((s) => s.id === id);
      const v = viewsRef.current[id];
      // A view not replayed yet reads idle: the list state (running, needs input) still protects the tab.
      const busyList = item?.state === "running" || item?.state === "needs_input";
      // Not loaded in this daemon run: no queue, continue, request or attention seq exists; unread comes from the list's lastActivity.
      const closed = !v && item?.state === "closed";
      // A failed subscribe: no view, or one that may be of an earlier daemon run.
      const failed = failedTabsRef.current.has(id);
      // Disconnected or resubscribing: the view may be of an earlier daemon run, the new one is on its way.
      const stale = !!v && (statusRef.current !== "connected" || resubscribing.current.has(id));
      const read = item && (v || closed) ? tabUnread(v, seenRef.current[id], item.lastActivity, shownAt(id)) : undefined;
      return { id, state: busyList ? item.state : (shownState(v) ?? item?.state), loading: !listFresh.current || (!!item && !failed && (stale || (!v && !closed))), unknown: failed || (!!item && (!!v || closed) && read === undefined), unread: unreadRef.current.has(id) || read === true, draft: drafts.has(id), listed: !!item, archived: !!item?.archived, worker: !!item?.coordinatorId, transcript: !!item?.transcript, busy: !!v?.queue?.items.length || v?.continueAt !== undefined, lastUsed: usedAt(id) };
    });
  }
  const cleanupCtx = (): CleanupContext => ({ activeId: activeRef.current, shown: splitOnRef.current && splitRef.current ? new Set(splitRef.current.ids) : undefined, pinned: pinnedRef.current, listLoaded: listLoadedRef.current, now: Date.now() });
  /** Runs one cleanup rule over the strip, or over `scope` (Clean up group); safety is re-checked now, not taken from the menu's counts. */
  function cleanUp(rule: CleanupRule, scope?: string[]) {
    const ids = cleanupTargets(rule, tabFacts(), cleanupCtx(), scope && new Set(scope));
    if (!ids.length) return setToast("No tabs to close");
    closeSeveral(ids);
  }
  const cleanupInfo = (scope?: string[]) => buildCleanupMenu(tabFacts(), cleanupCtx(), scope && new Set(scope));

  /** Tab menu commands (GH-359) of tab `id`. */
  function tabCommand(id: string, c: TabCommand) {
    const kind = c === "closeOthers" ? "others" : c === "closeRight" ? "right" : c === "closeAll" ? "all" : undefined;
    if (kind) {
      const targets = closeTargets(tabsRef.current, pinnedSet, id, kind);
      const activeGone = !!activeRef.current && targets.includes(activeRef.current);
      closeSeveral(targets);
      // Close others keeps the clicked tab: it takes over (VS Code), not a pinned neighbour.
      if (kind === "others" && activeGone) open(id);
    } else if (c === "pin" || c === "unpin") togglePin(id);
    else if (c === "reopen") reopenClosed();
    else if (c === "copyId") copyText(id, "session ID");
    else if (c === "copyCwd") copyText(sessionOf(id)?.cwd, "cwd path");
    else if (c === "reveal") revealTab(id);
    else if (c === "splitRight" || c === "splitDown") splitTab(id, c === "splitRight" ? "row" : "col");
    else if (c === "moveSide" || c === "moveBottom") move(kindOf(id)!, c === "moveSide" ? "side" : "bottom");
    else if (c === "goToSession") (open(ownerOf(id)), focusShownPrompt(ownerOf(id)));
  }

  /** Pin or unpin a session tab: it moves to the end of its group's pinned block, or right after the block. */
  function togglePin(id: string) {
    if (id === NEW_TAB || id === FOCUS_TAB || !tabsRef.current.includes(id)) return;
    const r = setPinned(tabsRef.current, pinned, id, !pinned.includes(id), groupOfTab);
    setTabs(r.tabs);
    setPinnedState(r.pinned);
  }

  /** Copies to the clipboard, which the browser offers on HTTPS and localhost only. */
  function copyText(text: string | undefined, what: string) {
    const fail = () => setToast(copyFailText(text));
    if (!text || !navigator.clipboard) return fail();
    navigator.clipboard.writeText(text).then(() => setToast(`Copied ${what}`), fail);
  }

  /** Reveal in sidebar: shows the tab's session, shows the sidebar (the drawer below md), then the sidebar runs Select active session with focus. */
  function revealTab(id: string) {
    if (id !== activeRef.current) open(id);
    if (wide(768)) setSidebar(true);
    else setDrawer(true);
    setRevealSeq((n) => n + 1);
  }

  useEffect(() => {
    const c = connect({
      onEvent: (e: Event) => {
        setViews((v) => ({ ...v, [e.sessionId]: applyEvent(v[e.sessionId] ?? emptySession(), e) }));
        // New titles and last activity come from the transcript; refresh when a session changes state. A replayed
        // change is in the list already (one session.list per subscribe would rescan every transcript, FIX-LEAK).
        const live = e.seq > (replayedTo.current[e.sessionId] ?? 0);
        if (live) liveAt.current.set(e.sessionId, Date.now());
        notifyRef.current?.(e, live);
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
        setReposSeq((n) => n + 1);
        if (m.deleted) forget(m.deleted, true);
        void refreshList();
      },
      onPlanUsage: setPlan,
      onSettingsChanged: (m) => (setSettingsChanged((n) => n + 1), setReposSeq((n) => n + 1), setWorkerNotices(m.settings.orchestration.workerNotifications !== false), setIgnoreSubmodules(m.settings.git?.ignoreSubmodules === true)),
      onUpdate: (m) => setUpdate((u) => nextUpdate(u, m)),
      onStale: (note) => staleDismissed.current !== note && setStale(note),
      onConfigChanged: (m) => {
        setConfigChanged((c) => ({ ...c, [m.cwd]: (c[m.cwd] ?? 0) + 1 }));
        setReloadFailed((f) => nextReloadFailed(f, m.reloadFailed));
      },
      onOpen: () => {
        // Clean up tabs (GH-378): every session tab is "loading" until this connection's first list reply.
        connGen.current++;
        listFresh.current = false;
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
        c.request<SettingsResult>({ type: "settings.get" }).then((r) => (setWorkerNotices(r.settings.orchestration.workerNotifications !== false), setIgnoreSubmodules(r.settings.git?.ignoreSubmodules === true))).catch(() => {});
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

  // Listed sessions this page covers with in-app cards: only while in-app notifications are on and the page is focused and visible.
  const coveredKey = inApp && focused ? list.filter((s) => !s.archived).map((s) => s.id).sort().slice(0, 2000).join(",") : undefined;
  // The daemon suppresses pushes for the session a focused, visible tab shows; resent after every reconnect.
  useEffect(() => {
    if (status !== "connected") return;
    const sessionId = focused && isSession(activeId) ? activeId : undefined;
    // One event, one channel: what this page shows as in-app cards needs no push (the Focus page covers every session too).
    const covered = coveredKey === undefined ? undefined : coveredKey.split(",").filter(Boolean);
    client.current!.request({ type: "push.focus", ...(sessionId && { sessionId }), ...(covered && { covered }) }).catch(() => {});
  }, [status, focused, activeId, coveredKey]);

  const activeView = activeId ? views[activeId] : undefined;
  // Every session on screen (both splits) counts as seen.
  const seenKey = visibleIds.map((id) => `${id}:${id ? views[id]?.lastSeq : ""}`).join();
  useEffect(() => {
    if (!focused) return;
    let next = seen;
    for (const id of visibleIds) {
      const v = id ? views[id] : undefined;
      if (id && v && isUnread(v, next[id])) next = { ...next, [id]: seenNow(v) };
    }
    if (next === seen) return;
    setSeen(next);
    saveSeen(next);
  }, [focused, seenKey]);
  // Clean up tabs (GH-378): the list's lastActivity each session on screen had, for its unread state once the daemon no longer holds it.
  const lastActivityOf = (id: string | undefined) => (id && views[id] ? list.find((s) => s.id === id)?.lastActivity : undefined);
  const shownKey = visibleIds.map((id) => `${id}:${lastActivityOf(id)}`).join();
  useEffect(() => {
    if (!focused) return;
    let next = shownActivity;
    for (const id of visibleIds) {
      const at = lastActivityOf(id);
      if (id && at !== undefined && (next[id] ?? -Infinity) < at) next = { ...next, [id]: at };
    }
    if (next === shownActivity) return;
    setShownActivity(next);
    saveShownActivity(next);
  }, [focused, shownKey]);

  useEffect(() => saveTabs(tabs), [tabs]);
  // Clean up tabs (GH-378): stamp the tab that was shown and the one that is shown now; a tab without a stamp starts now; closed tabs keep theirs for Undo and Reopen.
  const prevActive = useRef(activeId);
  useEffect(() => {
    setUsed((u) => stampUsed(u, [prevActive.current, activeId], Date.now()));
    prevActive.current = activeId;
  }, [activeId]);
  useEffect(() => {
    const keep = new Set([...tabs, ...closedTabs.map((c) => c.id)]);
    setUsed((u) => pruneUsed(seedUsed(u, tabs, Date.now()), keep));
    setShownActivity((a) => pruneShownActivity(a, keep));
  }, [tabs, closedTabs]);
  useEffect(() => saveUsed(used), [used]);
  useEffect(() => {
    const onVis = () => document.visibilityState === "visible" && setUsed((u) => stampUsed(u, [activeRef.current], Date.now()));
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => savePinned(pinned), [pinned]);
  // A pin ends with its tab (Close tab, Delete, reopen and Undo bring a tab back unpinned).
  useEffect(() => {
    const kept = pinned.filter((id) => tabs.includes(id));
    if (kept.length !== pinned.length) setPinnedState(kept);
  }, [tabs, pinned]);
  useEffect(() => applyTheme(theme), [theme]);

  // GH-378: a view of another daemon run than the seen mark, and a tab of a session not loaded in this run (no view), also count output after the lastActivity this browser last showed.
  const unread = new Set(list.filter((s) => (views[s.id] || (s.state === "closed" && tabs.includes(s.id))) && tabUnread(views[s.id], seen[s.id], s.lastActivity, shownActivity[s.id]) === true).map((s) => s.id));
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  // Focus (GH-159): every unanswered request; the sidebar row, the Focus tab, the browser tab and the status text all show the same number of sessions.
  const focusList = useMemo(() => (asides.length ? [...list, ...asides.flatMap((a) => (infos[a.id] ? [asideItem(a, infos[a.id]!)] : []))] : list), [list, asides, infos]);
  const waiting = useMemo(() => {
    const w = waitingRequests(focusList, views, firstSeen.current, Date.now());
    for (const x of w) if (!firstSeen.current.has(x.part.id)) firstSeen.current.set(x.part.id, x.since);
    const ids = new Set(w.map((x) => x.part.id));
    for (const id of firstSeen.current.keys()) if (!ids.has(id)) firstSeen.current.delete(id);
    return w;
  }, [focusList, views]);
  const waitingN = waitingCount(waiting);
  /** A permission request or question of the shown session, or a file opened from search, needs the session view or side panel: restore. */
  const needKey = waiting.filter((x) => visibleIds.includes(x.sessionId)).map((x) => x.part.id).join();
  useEffect(() => void (needKey && setBottomMax(false)), [needKey]);
  useEffect(() => void (openFile && setBottomMax(false)), [openFile]);
  const everWaiting = useRef(false);
  if (waitingN > 0) everWaiting.current = true;
  useEffect(() => {
    document.title = tabTitle(waitingN);
    setFavicon(faviconHref(waitingN));
  }, [waitingN]);

  // Settings › Notifications owns the switch; its error shows under the row (not in the sidebar).
  // In-app notification cards: live events of sessions this page does not show (docs/spec.md "In-app notifications").
  const [cardNote, setCardNote] = useState<{ card: Card; hint: boolean; at?: number }>();
  const hinted = useRef(false);
  const notify = useNotifications(
    { enabled: inApp, focused, focusPage: activeId === FOCUS_TAB, shown: (id) => visibleIds.includes(id), list, views, workers: workerNotices },
    (card: Card) => {
      // Said once per page load: how to reach the cards without the mouse. The text itself is made at render, with the session's title as the card shows it.
      const hint = !hinted.current && !!specOf("notifications.focus");
      hinted.current = true;
      setCardNote({ card, hint });
    },
  );
  notifyRef.current = notify.observe;
  const noteText = (() => {
    if (!cardNote) return undefined;
    // The card as it is now: one that moved on to its session's next request says that request, not the settled one.
    const card = notify.cards.find((c) => c.sessionId === cardNote.card.sessionId && (c.kind === cardNote.card.kind || (!!c.requestId && !!cardNote.card.requestId))) ?? cardNote.card;
    const s = list.find((x) => x.id === card.sessionId);
    const d = describeCard(card, views[card.sessionId], s?.cwd ?? "");
    const keys = specOf("notifications.focus");
    return cardText({ kind: d.kind, title: s?.title || "Untitled", body: d.summary }) + (cardNote.hint && keys ? ` ${keyText(keys)} goes to notifications.` : "");
  })();
  // The note holds for the count it was said with; another count takes over with the plain count text.
  useEffect(() => setCardNote((n) => (n && n.at === undefined ? { ...n, at: waitingN } : n && n.at !== waitingN ? undefined : n)), [waitingN, cardNote]);
  const [cardFocus, setCardFocus] = useState(0);
  const cardItems: CardItem[] = notify.cards.map((card) => {
    const s = list.find((x) => x.id === card.sessionId);
    const cwd = s?.cwd ?? "";
    return { card, d: describeCard(card, views[card.sessionId], cwd), title: s?.title || "Untitled", place: cwd ? (worktreeName(cwd, worktrees) ?? projectName(cwd)) : "", cwd: cwd || undefined };
  });
  const cardsNow = useNow(60_000);

  async function togglePush() {
    setPushError(undefined);
    setPushBusy(true);
    try {
      if (pushOn) await disablePush();
      else await enablePush(client.current!);
      setPushOn(!pushOn);
    } catch (e) {
      const m = (e as Error).message;
      setPushError(/blocked/.test(m) ? "Notifications are blocked for this site in the browser. Allow them in the site settings, then turn this on again." : m);
    } finally {
      setPushBusy(false);
    }
  }

  /**
   * Creates the session in a known project with the chosen start options and sends its first prompt or runs its first bash
   * mode command. Rejects when the session was not created.
   */
  // A session whose first prompt failed: the retry from the new-session tab sends to it instead of creating another.
  const unprompted = useRef<SessionInfo>(undefined);
  // GH-281: the new-session tab's uploads belong to this token until session.create claims them; the next draft gets a new one.
  const draftUpload = useRef(draftToken());
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
      const session = await startSession(client.current!.request, unprompted, cwd, { ...opts, draft: draftUpload.current }, first, (s) => {
        setInfos((i) => ({ ...i, [s.id]: s }));
        setOptimistic((o) => (o[NEW_TAB] ? { ...o, [NEW_TAB]: o[NEW_TAB].map((p) => ({ ...p, sessionId: s.id })) } : o));
        // Listed (and so subscribed) before the prompt goes out: its echo can be in the view before the tab switches.
        if (!listed) (listed = true), void refreshList();
      }, () => void (draftUpload.current = rotateDraftToken()));
      setOptimistic((o) => movePending(o, session.id));
      // GH-430: the panels keep their state across the first prompt: the Changes diff mode and each area's selected pane carry over to the session.
      const choice = sessionDiffChoice.get(NEW_TAB);
      if (choice) (sessionDiffChoice.set(session.id, choice), sessionDiffChoice.delete(NEW_TAB));
      setPaneHist((x) => {
        if (!x[NEW_TAB]) return x;
        const { [NEW_TAB]: h, ...rest } = x;
        return { ...rest, [session.id]: h };
      });
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
    setDraftCwd(cwd ?? (activeId && activeId !== NEW_TAB ? sessionOf(ownerOf(activeId))?.cwd : undefined) ?? draftCwd);
    // A maximized bottom panel would hide the draft.
    setBottomMax(false);
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
    setTabs((t) => t.filter((id) => !gone.has(ownerOf(id))));
    if (gone.has(ownerOf(hashTab() ?? ""))) open(undefined), history.replaceState(null, "", location.pathname + location.search);
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
  async function newWorktree(project: string) {
    if (worktreeJob && !worktreeJob.error) return;
    setError(undefined);
    setWorktreeJob({ project });
    newSession(project);
    try {
      const { path } = await client.current!.request<WorktreeCreateResult>({ type: "worktree.create", cwd: project });
      await refreshList();
      setDraftCwd((d) => (d === project ? path : d));
      setWorktreeJob(undefined);
    } catch (e) {
      setWorktreeJob({ project, error: (e as Error).message });
    }
  }
  const [cleanup, setCleanup] = useState<CleanupScope>();
  /** A run that outlives its closed dialog reports by toast. */
  const cleanupOpen = useRef(false);
  cleanupOpen.current = cleanup !== undefined;
  const listState = (s: SessionListItem) => (s.coordinatorId ? workerState(s, views[s.id]) : (shownState(views[s.id]) ?? s.state));
  /** The last status of each worktree (warming, remove dialog), and the warm in flight: one at a time, once per 10 s per path. */
  const wtStatus = useRef(new Map<string, WorktreeStatusResult>());
  const warmed = useRef({ path: "", at: 0, scan: "" });
  function warmWorktree(project: string, path: string) {
    const w = warmed.current;
    if (w.path === path && Date.now() - w.at < 10_000) return;
    if (w.scan) void client.current?.request({ type: "worktree.cancel", scan: w.scan }).catch(() => {});
    const scan = crypto.randomUUID();
    warmed.current = { path, at: Date.now(), scan };
    client.current?.request<WorktreeStatusResult>({ type: "worktree.status", cwd: project, path, scan }).then((st) => wtStatus.current.set(path, st), () => {});
  }
  async function askRemoveWorktree(project: string, path: string) {
    setError(undefined);
    // The dialog opens at once; the status (the cached one meanwhile) fills it in.
    const branch = worktrees[project]?.find((w) => w.path === path)?.branch ?? lastSegment(path);
    const tok = {};
    askToken.current = tok;
    setRemovingWt({ project, path, branch, cached: wtStatus.current.get(path), checking: true });
    try {
      const st = await client.current!.request<WorktreeStatusResult>({ type: "worktree.status", cwd: project, path });
      if (askToken.current !== tok) return;
      wtStatus.current.set(path, st);
      setRemovingWt((c) => (c?.path === path ? { ...c, branch: st.branch, status: st, checking: false } : c));
    } catch (e) {
      if (askToken.current !== tok) return;
      setRemovingWt((c) => (c?.path === path ? { ...c, checking: false, error: (e as Error).message } : c));
    }
  }
  /** Removes in the background: the row shows Removing… until the list refresh drops it; a failure restores it and says why. */
  async function removeWorktree(w: { project: string; path: string; branch?: string; status?: WorktreeStatusResult }) {
    markRemoving(w.path, true);
    try {
      // The counts the user saw: the daemon checks again and refuses (`stale`) when there is more work now.
      const st = w.status;
      const r = await client.current!.request<WorktreeRemoveResult>({ type: "worktree.remove", cwd: w.project, path: w.path, ...(st && { expectSafe: st.safety === "safe", expect: { uncommitted: st.uncommitted, ahead: st.ahead } }) });
      if (r?.ignoredDeleted) setToast(`Removed ${w.branch ?? lastSegment(w.path)}: ${ignoredText(r.ignoredDeleted)} deleted`);
      if (draftCwd === w.path) setDraftCwd(w.project);
      await refreshList();
    } catch (e) {
      setError(`Worktree ${w.branch ?? lastSegment(w.path)} not removed: ${(e as Error).message}`);
    } finally {
      markRemoving(w.path, false);
    }
  }
  /** Settings opened at one group (the Create worktree modal's "Open Settings › Jira"). */
  const openSettingsGroup = (id: string) => (saveSettingsGroup(id), setSettingsOpen(true));
  /** Create worktree modal done: a new-session tab in the new worktree. */
  async function openInWorktree(project: string, path: string) {
    setCreatingWt(undefined);
    setError(undefined);
    newSession(project);
    await refreshList();
    setDraftCwd((d) => (d === project ? path : d));
  }

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
      if (a === "rename" || a === "rename-inline") return setRenaming({ id: sessionId, in: where, menu: a === "rename" });
      if (a === "delete") return setDeleting(sessionId);
      if (a === "copy-id") return copyText(sessionId, "session ID");
      if (a === "close-tab") return close(sessionId);
      if (a === "close-worker") return void runWorkers([sessionId], "close");
      if (a === "remove-worker") return void askRemoveWorker(sessionId);
      // The sidebar resolves the bulk actions to worker ids (onWorkers).
      if (a === "close-finished" || a === "remove-closed" || a === "cleanup-workers") return;
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

  /** worker.close / worker.remove per worker (GH-358): a toast when all went through, else the first error and a list refresh. */
  async function runWorkers(ids: string[], a: "close" | "remove") {
    if (!ids.length) return;
    setError(undefined);
    const results = await Promise.allSettled(ids.map((sessionId) => client.current!.request({ type: a === "close" ? "worker.close" : "worker.remove", sessionId })));
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const verb = a === "close" ? "closed" : "removed";
    if (bad.length) {
      setError(`${ids.length - bad.length} of ${ids.length} ${ids.length === 1 ? "worker" : "workers"} ${verb}: ${(bad[0]!.reason as Error).message}`);
      void refreshList();
    } else setToast(`${verb[0]!.toUpperCase()}${verb.slice(1)} ${ids.length === 1 ? "1 worker" : `${ids.length} workers`}`);
  }

  /** Remove worker: asks first; offers the worker's own worktree too when the app may remove it. */
  async function askRemoveWorker(id: string) {
    const w = list.find((s) => s.id === id);
    if (!w) return;
    setError(undefined);
    setAlsoWorktree(false);
    const hit = Object.entries(worktrees).flatMap(([project, rows]) => rows.filter((r) => r.path === w.cwd && rows.find((x) => x.main)?.path === project && removableWorktree(rows, r)).map((r) => ({ project, path: r.path })))[0];
    const others = hit ? list.filter((s) => s.id !== id && s.cwd === hit.path).length : 0;
    setRemovingWorker({ id, name: w.workerName ?? w.title, ...hit, others, loading: !!hit });
    if (!hit) return;
    try {
      const st = await client.current!.request<WorktreeStatusResult>({ type: "worktree.status", cwd: hit.project, path: hit.path });
      if (st.safety === "blocked") setRemovingWorker((c) => (c?.id === id ? { ...c, loading: false, error: `Worktree ${st.branch} cannot be removed: ${BLOCK_TEXT[st.blocked!]}` } : c));
      else setRemovingWorker((c) => (c?.id === id ? { ...c, loading: false, branch: st.branch, text: removeWorktreeText(st, { keepsBranch: keepsBranch(worktrees[hit.project], hit.path) }) } : c));
    } catch (e) {
      setRemovingWorker((c) => (c?.id === id ? { ...c, loading: false, error: (e as Error).message } : c));
    }
  }
  async function removeWorker(w: NonNullable<typeof removingWorker>, withWorktree: boolean) {
    setError(undefined);
    try {
      await client.current!.request({ type: "worker.remove", sessionId: w.id });
    } catch (e) {
      return setError((e as Error).message);
    }
    setToast(`Removed worker ${w.name}`);
    if (withWorktree && w.project && w.path) await removeWorktree({ project: w.project, path: w.path });
  }

  /** Archive idle sessions older than N days: shown at once; a failed request restores the list. At most 8 requests at a time. */
  async function archiveIdle(ids: string[]) {
    setError(undefined);
    setList((l) => ids.reduce((x, id) => patchSession(x, id, { archived: true }), l));
    const failed: Error[] = [];
    for (let i = 0; i < ids.length; i += 8) {
      const rs = await Promise.allSettled(ids.slice(i, i + 8).map((sessionId) => client.current!.request({ type: "session.archive", sessionId, archived: true })));
      for (const r of rs) if (r.status === "rejected") failed.push(r.reason as Error);
    }
    if (failed.length) {
      setError(`${ids.length - failed.length} of ${ids.length} sessions archived: ${failed[0]!.message}`);
      void refreshList();
    } else setToast(`Archived ${ids.length} ${ids.length === 1 ? "session" : "sessions"}`);
  }

  function deleteSession(sessionId: string) {
    setDeleting(undefined);
    client.current!.request({ type: "session.delete", sessionId }).catch((e: Error) => setError(e.message));
  }

  // A session with a worker (the list flag): its orchestration notices show as chips.
  /** Orchestration links per session, the previous object while equal: memo panes do not re-render on every event. */
  const linksCache = useRef(new Map<string, AgentLinks>());
  const linksOf = (id: string) => {
    const l = sameLinks(linksCache.current.get(id), agentLinks(list, views, id));
    linksCache.current.set(id, l);
    return l;
  };
  const openTabIds = useMemo(() => new Set(tabs), [tabs]);
  const isCoordinator = (id: string) => !!list.find((s) => s.id === id)?.coordinator;
  const sessionOf = (id: string): SessionInfo | undefined => infos[id] ?? list.find((s) => s.id === id);
  const groupOfTab = (id: string) => (id === NEW_TAB ? "" : tabGroup(sessionOf(ownerOf(id))?.cwd, grouping, worktrees).key);
  // The stored list stays grouped by the Tab grouping setting (also once the session cwds arrive), so close, next/previous tab and moves all use the order the strip draws.
  // Regrouped only once every tab's key is final: on partial keys the unknown tabs gather in one group and the damaged order is stored (GH-196).
  const keysFinal = tabKeysFinal(tabs, listLoaded, (id) => !!sessionOf(id), failedTabs);
  useGroupedTabs(tabs, setTabs, groupOfTab, keysFinal, pinnedSet);
  // Every owner of an open pane tab is followed (reload, a closed owner, Undo, Reopen); `requested` keeps it to one subscribe.
  const ownersKey = [...new Set(tabs.filter(isPaneRef).map(ownerOf))].sort().join();
  useEffect(() => {
    if (status !== "connected" || !ownersKey) return;
    for (const o of ownersKey.split(",")) followOwner(o);
  }, [ownersKey, status === "connected"]);
  const cwdOfOwner = (o: string) => sessionOf(o)?.cwd;
  // A pane tab whose kind has no main-area home (another browser tab moved it, or an older stored value) closes silently,
  // and so does a later tab of an identity that is open already (two stored Files tabs of one folder: another browser tab, an Undo race).
  useEffect(() => {
    const seen = new Set<string>();
    const stray = tabs.filter((t) => {
      const k = kindOf(t);
      if (!k) return false;
      if (areaOf(loadLayout(), k) !== "main") return true;
      const id = identityOf(t, cwdOfOwner);
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    if (stray.length) closeGroup(stray);
  }, [layout, tabs, list]);
  const ownerTitle = (o: string) => list.find((s) => s.id === o)?.title || titles[o] || "Untitled";
  /** A pane tab's title: Files and Git graph name the owner's folder ("demo", "demo · feature"), Plan the owner's title. */
  const paneTitle = (ref: string) => {
    const k = kindOf(ref)!;
    const c = PER_CWD.includes(k) ? cwdOfOwner(ownerOf(ref)) : undefined;
    return paneTabTitle(k, c ? (worktreeName(c, worktrees) ?? projectName(c)) : ownerTitle(ownerOf(ref)));
  };
  /** What a tab is called in toasts. */
  const tabLabel = (id: string) => (isPaneRef(id) ? paneTitle(id) : ownerTitle(id));
  /** A closed or Undo-restored tab can come back: its session is listed, and a pane tab's kind still has the main area as its home. */
  const existsTab = (id: string) => id === NEW_TAB || (listRef.current.some((s) => s.id === ownerOf(id)) && (!kindOf(id) || areaOf(loadLayout(), kindOf(id) as PaneId) === "main"));
  // Auto-close idle tabs (GH-378): only while the page shows, connected, with the list and group keys final; the 60 s tick is cheap, autoCloseDue lets one run through per 15 minutes.
  const autoRan = useRef<number>(undefined);
  // Reassigned each render: the check reads the current tabs, titles and list, the effect below only sets the timer.
  const autoRun = useRef(() => {});
  autoRun.current = () => {
    if (autoClose === "off" || document.visibilityState !== "visible" || !autoCloseDue(Date.now(), autoRan.current)) return;
    autoRan.current = Date.now();
    const ids = autoCloseTargets(tabFacts(), cleanupCtx(), autoClose);
    if (ids.length) closeSeveral(ids, (n, t) => (n === 1 ? `Auto-closed ${t}` : `Auto-closed ${n} idle tabs`));
  };
  useEffect(() => {
    if (autoClose === "off" || status !== "connected" || !listLoaded || !keysFinal) return;
    const run = () => autoRun.current();
    run();
    const t = setInterval(run, 60_000);
    document.addEventListener("visibilitychange", run);
    return () => (clearInterval(t), document.removeEventListener("visibilitychange", run));
  }, [autoClose, status, listLoaded, keysFinal]);
  const active = currentId && currentId !== NEW_TAB ? sessionOf(currentId) : undefined;
  // GH-133: a just-created session shows (with its pending prompt) before its subscribe reply.
  // A tab that followed a /clear shows the new session at once too: an empty timeline carrying the old one's settings.
  const heirViews = useMemo(() => Object.fromEntries(Object.entries(heirOf).map(([to, from]) => [to, heirView(views[from])])), [heirOf, views]);
  const viewOf = (id: string) => views[id] ?? heirViews[id] ?? (optimistic[id]?.length ? EMPTY_VIEW : undefined);
  const view = currentId ? viewOf(currentId) : undefined;
  const shown = active && view ? active : undefined;
  /** Something fills the main area: a session, or a pane tab (even while its owner loads). */
  const mainShown = !!shown || !!paneRef;
  /** Both splits render (a loading session shows alone until its view is there). */
  // Drag a tab onto the session area (GH-356): an edge splits there, the middle of a split shows the tab in it.
  const splitDrop = useSplitDrop({
    enabled: () => lg && isSession(activeRef.current),
    onDrop: (id, t) => {
      if (!isSession(id) || !tabsRef.current.includes(id)) return;
      if (t.zone !== "center") return splitTab(id, t.zone === "left" || t.zone === "right" ? "row" : "col", t.zone === "left" || t.zone === "top");
      if (splitRef.current && splitOnRef.current && t.over >= 0) return showInSplit(id, t.over);
      open(id);
      focusShownPrompt(id);
    },
  });
  const areaRef = useCallback((n: HTMLElement | null) => {
    const off = splitDrop.ref(n);
    if (!n || typeof ResizeObserver === "undefined") return off;
    const ro = new ResizeObserver((es) => {
      const r = es[0]?.contentRect;
      if (r) setArea((a) => (a && a.w === Math.round(r.width) && a.h === Math.round(r.height) ? a : { w: Math.round(r.width), h: Math.round(r.height) }));
    });
    ro.observe(n);
    return () => (off?.(), ro.disconnect());
  }, []);
  // The saved ratio can leave a split under its minimum when the area is small: only the drawn ratio is clamped, the user's ratio returns with the space.
  const drawnRatio = (() => {
    if (!split || !area || !area.w || !splitFits) return split?.ratio ?? 0.5;
    const row = split.dir === "row";
    const total = (row ? area.w : area.h) - 8;
    return ratioFor(split.ratio * total, total, row ? SPLIT_MIN_W : SPLIT_MIN_H);
  })();
  const splitShown = splitOn && split.ids.every((id) => !!viewOf(id) && !!sessionOf(id));
  // A tab that followed a /clear typed in the prompt box: the box gets the focus once the session shows (after its subscribe).
  useEffect(() => {
    if (!shown || refocus.current !== shown.id) return;
    refocus.current = undefined;
    requestAnimationFrame(() => shownPrompt()?.focus());
  }, [shown?.id]);
  /** A session tab's pane: the main area's tabs and the Aside popups render it the same way; `o` overrides props (an Aside's). */
  const renderTab = (id: string, s: SessionInfo, v: SessionView, pend: Pending[] | undefined, o: Partial<ComponentProps<typeof SessionPane>> = {}) => (
                      <SessionTab
                        // Outside a split every pane is "active": a tab switch re-renders no pane (GH-51).
                        scrollKey={scrollKeys[id] ?? 0}
                        insert={id === activeId ? insert : undefined}
                        onInserted={() => setInsert(undefined)}
                        rewindTo={id === activeId ? rewindTo : undefined}
                        revealHit={id === revealHit?.sessionId ? revealHit : undefined}
                        onRevealShown={() => setRevealHit(undefined)}
                        run={id === activeId ? run : splitShown ? split!.runs?.[id] : undefined}
                        onOpenRun={(r) => openRun(s.id, r)}
                        links={linksOf(id)}
                        onOpenSession={(sid) => open(sid)}
                        onLoadOlder={(opts) => loadOlder(s.id, opts)}
                        loadingOlder={!!olderLoading[s.id]}
                        onStopRun={(subagentId) => client.current!.request({ type: "session.stopSubagent", sessionId: s.id, subagentId })}
                        onBackgroundShell={(toolUseId) => client.current!.request({ type: "session.backgroundShell", sessionId: s.id, toolUseId })}
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
                        onUpload={upload(() => ({ sessionId: s.id }), s.cwd)}
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
                        onQueue={(text, images) => queueRequest({ type: "session.enqueue", sessionId: s.id, text, images })}
                        onDequeue={(itemId) => queueRequest<{ text: string; images: string[]; bash?: boolean }>({ type: "session.dequeue", sessionId: s.id, itemId })}
                        onSendQueued={(itemId) => queueRequest({ type: "session.sendQueued", sessionId: s.id, itemId })}
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
                        onMedia={(partId, index) => client.current!.request<MediaResult>({ type: "session.media", sessionId: s.id, partId, index }).then((r) => r.dataUrl)}
                        onArtifactPreview={(partId) => client.current!.request<ArtifactPreviewResult>({ type: "artifact.preview", sessionId: s.id, partId })}
                        onRespond={respond}
                        onSearch={search(s.cwd)}
                        onDialog={openDialog}
                        onShells={() => openShells(s.id)}
                        onAside={(q) => openAside(s.id, q)}
                        signalOnly={signalOnly}
                        onAnswer={answer}
                        connected={status === "connected"}
                        onGitStatus={() =>
                          status === "connected"
                            ? client.current!.request<GitStatusResult>({ type: "git.status", cwd: s.cwd }).then((r) => (noteRefs(s.cwd, r.status?.refs), r.status))
                            : Promise.reject(new Error(`the daemon is ${status}`))
                        }
                      {...o}
                      />
  );

  const draftShown = activeId === NEW_TAB && tabs.includes(NEW_TAB);
  // The project the config dialogs act on: the shown session's cwd, or the new-session tab's project chip.
  // A worktree row's New session starts in that worktree (inside the roots), not only in an added project.
  const startable = [...projects, ...Object.values(worktrees).flatMap((l) => l.filter((w) => !w.outsideRoots).map((w) => w.path))];
  const draftProject = draftCwd && startable.includes(draftCwd) ? draftCwd : projects[0];
  // GH-430: the side and bottom panel hang off a panel target: the shown session, or on wide screens the new-session tab's project
  // (cwd, DOM position and keys stay the same when its first prompt creates the session, so nothing remounts).
  const draftHost = lg && draftShown && !!draftProject;
  const target: PanelTarget | undefined = shown ? { key: shown.id, cwd: shown.cwd, sessionId: shown.id } : draftHost ? { key: NEW_TAB, cwd: draftProject! } : undefined;
  // The panels stay mounted while no tab shows (Focus), so their open files survive.
  const lastTarget = useRef<PanelTarget>(undefined);
  if (target) lastTarget.current = target;
  // GH-367: on wide screens Focus keeps the panels of the tab shown last, so the work area does not move on the switch.
  const panelHost = !!target || (lg && activeId === FOCUS_TAB && !!lastTarget.current);
  /** Who Files and Git graph tabs open for: the shown session, else (New session, Focus) the session shown last. */
  const lastSession = useRef<string>(undefined);
  if (target?.sessionId) lastSession.current = target.sessionId;
  const paneOwner = isSession(currentId) ? currentId : lastSession.current && sessionOf(lastSession.current) ? lastSession.current : undefined;
  const panelTarget = target ?? lastTarget.current;
  const panelTargetRef = useRef(panelTarget);
  panelTargetRef.current = panelTarget;
  const panelView = panelTarget?.sessionId ? views[panelTarget.sessionId] : undefined;
  // The changes panel needs the Edit/Write calls of the unloaded region: asked once per session (the cursor moves, aux keeps them).
  useEffect(() => {
    const v = panelView;
    if (!panelTarget?.sessionId || !v || !v.older || v.auxEdits || !v.logEpoch) return;
    const { before } = v.older;
    const epoch = v.logEpoch;
    const id = panelTarget.sessionId;
    const key = `${id}:${epoch}:${before}`;
    if (editsAsked.current.has(key)) return;
    editsAsked.current.add(key);
    client.current?.request<EditsResult>({ type: "session.edits", sessionId: id, logEpoch: epoch, before }).then(
      (r) => setViews((vs) => (vs[id]?.logEpoch === epoch ? { ...vs, [id]: withEdits(vs[id]!, before, r.parts) } : vs)),
      () => editsAsked.current.delete(key),
    );
  }, [panelTarget?.sessionId, panelView?.older?.before, panelView?.auxEdits, panelView?.logEpoch]);
  const panelPlan = useMemo(() => (panelView ? latestPlan(panelView) : undefined), [panelView?.parts, panelView?.aux]);
  const changedPaths = useMemo(() => (panelView ? sessionChanges(panelView).map((c) => c.path) : []), [panelView?.parts, panelView?.aux]);
  // The pane tab counts the files the changes panel lists (a file created and deleted again is not listed).
  const [listedChanges, setListedChanges] = useState<{ id: string; n: number }>();
  const changeCount = listedChanges && listedChanges.id === panelTarget?.key ? listedChanges.n : changedPaths.length;
  // The graph tab exists only while the side panel's cwd is a git work tree.
  const [gitProbe, setIsGit] = useState(false);
  // The cwd whose git status has been answered: the tour waits for it so "Git graph" is not dropped by a status still on its way.
  const [gitChecked, setGitChecked] = useState<string>();
  const panelCwd = panelTarget?.cwd;
  // GH-430: the terminal shows only where its folder has running shells (`hasShells`, per cwd, from terminal.list) or after an active
  // open / a deliberate move on this page (`termWanted`); it starts a shell only after an active open (`spawnFor`: the cwd to ensure one for).
  const [hasShells, setHasShells] = useState<Record<string, boolean>>({});
  const [termWanted, setTermWanted] = useState<ReadonlySet<string>>(new Set());
  const [spawnFor, setSpawnFor] = useState<string>();
  // While a folder's shells are unknown the last known answer stays (no collapse and remount for one terminal.list round trip).
  const lastAvail = useRef(false);
  const availKnown = !!panelCwd && (hasShells[panelCwd] !== undefined || termWanted.has(panelCwd));
  if (availKnown) lastAvail.current = hasShells[panelCwd!] === true || termWanted.has(panelCwd!);
  const termAvail = availKnown ? lastAvail.current : lastAvail.current && !!panelCwd;
  const spawnRef = useRef(spawnFor);
  spawnRef.current = spawnFor;
  // An active open (the user asked for the terminal) shows it loud (focus on the shell); any other show starts quiet.
  const activeOpen = useRef(false);
  useEffect(() => {
    if (!panelCwd || status !== "connected") return;
    let live = true;
    client.current!.request<TerminalListResult>({ type: "terminal.list", cwd: panelCwd }).then(
      (r) => {
        if (!live) return;
        const any = !!r.terminals?.length;
        setHasShells((h) => (h[panelCwd] === any ? h : { ...h, [panelCwd]: any }));
        // Its shells ended elsewhere (another browser, a daemon restart): no empty terminal for this folder unless an open is pending.
        if (!any && spawnRef.current !== panelCwd) setTermWanted((w) => (w.has(panelCwd) ? new Set([...w].filter((c) => c !== panelCwd)) : w));
      },
      () => {},
    );
    return () => void (live = false);
  }, [panelCwd, status]);
  useEffect(() => (setSpawnFor(undefined), void (activeOpen.current = false)), [panelCwd]);
  const wantTerminal = (cwd: string) => setTermWanted((w) => (w.has(cwd) ? w : new Set(w).add(cwd)));
  /** An active open (Toggle terminal, New terminal, a click on the Terminal pane tab): the terminal shows and starts a shell if the folder has none. */
  const askTerminal = () => {
    if (!panelCwd) return;
    wantTerminal(panelCwd);
    setSpawnFor(panelCwd);
    activeOpen.current = true;
  };
  // A restored narrow Terminal pane without shells shows the session.
  const planListed = !!panelPlan && areaOf(layout, "plan") !== "main";
  const pane: Pane = (!lg && histPane === "terminal" && !termAvail) || (histPane === "plan" && !planListed) || (histPane !== "session" && canMain(histPane) && areaOf(layout, histPane) === "main") ? "session" : histPane;
  // A project or worktree listed by session.list is a git work tree: the tab shows at once, without a git.status (a working-tree diff).
  const knownGit = !!panelCwd && !!worktrees[projectOf(panelCwd, worktrees)];
  const { repos, truncated: reposTruncated } = useRepos(client.current, panelCwd, { connected: status === "connected", openFiles, seq: reposSeq, fresh: reposFresh });
  const repo = repos ? defaultRepo(repos) : undefined;
  // Changes and the Graph resolve the remembered choice themselves.
  // Panes: the pane owner session's cwd replaces panelCwd here (the choice is kept per owner project).
  const repoKey = repoProjectKey(panelCwd, worktrees, listLoaded);
  const repoList: RepoList | undefined = panelCwd && repos && repoKey ? { list: repos, truncated: reposTruncated, projectKey: repoKey } : undefined;
  const isGit = repos ? !!repo : gitProbe;
  // The Files tab marks files of every listed repository, also when the folder itself is none; the setting changes the moved-submodule marks.
  const treeStamp = isGit ? `${panelView?.state}|${changedPaths.length}|${ignoreSubmodules}` : undefined;
  const reposAnswered = repos !== undefined;
  useEffect(() => void (panelCwd && reposAnswered && repos !== null && setGitChecked(panelCwd)), [panelCwd, repos]);
  const reloadRepos = () => setReposFresh((n) => n + 1);
  const fallback = repos === null;
  useEffect(() => {
    if (!panelCwd) return;
    if (knownGit) return void (setIsGit(true), setGitChecked(panelCwd));
    if (status !== "connected" || !fallback) return;
    let live = true;
    client.current!.request<GitStatusResult>({ type: "git.status", cwd: panelCwd }).then(
      (r) => live && (noteRefs(panelCwd, r.status?.refs), setIsGit(!!r.status), setGitChecked(panelCwd)),
      () => live && (setIsGit(false), setGitChecked(panelCwd)),
    );
    return () => void (live = false);
  }, [panelCwd, status, knownGit, fallback]);
  // The Graph panel stays mounted (hidden) after its first visit, so coming back shows the loaded list at once.
  const [graphCwd, setGraphCwd] = useState<string>();
  // The Plan pane lists only while the current session has a plan and its home is a dock.
  const available = (p: PaneId) => (p === "plan" ? planListed : p !== "graph" || isGit);
  /** Narrow: the side column holds every pane. */
  const areaPanes = (a: DockArea): PaneId[] => (lg ? layout.areas[a] : a === "side" ? PANE_IDS.filter((p) => areaOf(layout, p) !== "main") : []).filter(available);
  /** The panes of the area that can be selected: the Terminal tab stays listed, but selects only once the terminal is available. */
  const selectable = (a: DockArea) => areaPanes(a).filter((p) => p !== "terminal" || termAvail);
  const activeOf = (a: DockArea) => activePane(selectable(a), hist, paneTabs[a]);
  const sideShown = lg && panel && selectable("side").length > 0;
  const bottomShown = lg && bottomOpen && selectable("bottom").length > 0;
  /** The pane shows: wide = its area shows it; narrow = it is the pane. */
  const shows = (p: PaneId) => (lg ? areaOf(layout, p) !== "main" && (areaOf(layout, p) === "side" ? sideShown : bottomShown) && activeOf(areaOf(layout, p) as DockArea) === p : p === "files" ? pane === "files" || (pane === "graph" && !isGit) : pane === p && available(p));
  // Bottom panel only, this page only: it takes the whole work area.
  const [bottomMax, setBottomMax] = useState(false);
  /** Shown and in sight: a maximized bottom panel hides the side panel, so its panes are not seen. */
  const inSight = (p: PaneId) => (areaOf(layout, p) === "main" ? kindOf(activeId ?? "") === p && (lg || pane === "session") : shows(p) && !(bottomMax && lg && areaOf(layout, p) === "side"));
  const sideEmpty = lg && areaPanes("side").length === 0;
  // The terminal stays mounted (hidden) while another pane of its open area is selected, so switching tabs keeps it as it was.
  const termHome = areaOf(layout, "terminal");
  const termDock = termHome as DockArea; // only read where termHome is not "main"
  const termAreaOpen = lg && termHome !== "main" && (termDock === "side" ? sideShown : bottomShown);
  // `termKeep`: it has shown and its area has stayed open since; it resets when the area hides, so hiding unmounts it.
  const termShows = shows("terminal");
  const [termKeep, setTermKeep] = useState(false);
  const [termFocusReq, setTermFocusReq] = useState(0);
  useEffect(() => setTermKeep((k) => termShows || (k && termAreaOpen)), [termShows, termAreaOpen]);
  const termMounted = termShows || (termKeep && termAreaOpen);
  // Hidden again: a pending open request (spawn, loud show) is void, so a later passive show spawns and focuses nothing.
  useEffect(() => {
    if (termMounted) return;
    setSpawnFor(undefined);
    activeOpen.current = false;
  }, [termMounted]);
  // GH-397: terminal tabs (home = main). One TerminalPanel per open tab, mounted once shown. `termCarry`: the folder whose dock terminal
  // moved into a tab; that tab shows `hosts.terminal`, so the move never remounts its xterm. `termLoud`: the tab an explicit request
  // (Ctrl+`, New terminal, a click on its strip tab) is for; any other show is quiet (GH-382). `termReq`: per-tab New terminal / focus counters.
  const [termCarry, setTermCarry] = useState<string>();
  const [termSeen, setTermSeen] = useState<ReadonlySet<string>>(new Set());
  if (kindOf(activeId ?? "") === "terminal" && !termSeen.has(activeId!)) setTermSeen(new Set(termSeen).add(activeId!));
  const [termLoud, setTermLoud] = useState<string>();
  if (termLoud && termLoud !== activeId) setTermLoud(undefined);
  // A pending explicit request (its panel may mount late, GH-382) ends at the user's next key or pointer press: later navigation must not focus the shell.
  useEffect(() => {
    if (!termLoud) return;
    const done = () => setTermLoud(undefined);
    const kinds = ["keydown", "pointerdown"] as const;
    for (const k of kinds) window.addEventListener(k, done, true);
    return () => kinds.forEach((k) => window.removeEventListener(k, done, true));
  }, [termLoud]);
  const [termReq, setTermReq] = useState<Record<string, { add: number; focus: number }>>({});
  const [termSpawn, setTermSpawn] = useState<string>();
  const termTabs = termHome === "main" ? tabs.filter((t) => kindOf(t) === "terminal" && termSeen.has(t)) : [];
  const carryRef = termTabs.find((t) => termCarry !== undefined && cwdOfOwner(ownerOf(t)) === termCarry);
  const termHosts = useRef(new Map<string, HTMLDivElement>());
  const hostOf = (ref: string) => {
    let el = termHosts.current.get(ref);
    if (!el) (el = document.createElement("div"), (el.style.display = "contents"), (el.dataset.paneHost = ref), termHosts.current.set(ref, el));
    return el;
  };
  useEffect(() => void [...termHosts.current.keys()].forEach((k) => tabs.includes(k) || termHosts.current.delete(k)), [tabs]);
  const termBump = (ref: string, k: "add" | "focus") =>
    ref === carryRef ? (k === "add" ? setTerminalTick : setTermFocusReq)((n) => n + 1) : setTermReq((m) => ({ ...m, [ref]: { add: m[ref]?.add ?? 0, focus: m[ref]?.focus ?? 0, [k]: (m[ref]?.[k] ?? 0) + 1 } }));
  useEffect(() => void (!bottomShown && setBottomMax(false)), [bottomShown]);
  const openArea = (a: DockArea, v = true) => (a === "side" ? setPanel(v) : setBottomOpen(v));
  /** Selects the pane and, on wide screens, opens its area. */
  const reveal = (p: Pane) => {
    setPane(p);
    if (p === "session") return;
    const a = areaOf(layout, p);
    // Main home: the tab of the current session. Plan opens on wide screens only (narrow: the switcher), Files and Git graph everywhere.
    if (a === "main") return void (p === "plan" ? lg && currentId && isSession(currentId) && openPaneTab(refOf({ kind: "plan", owner: currentId })) : (p === "files" || p === "graph") && showKind(p));
    if (!lg) return;
    // A maximized bottom panel hides everything else: a pane outside it needs the restore.
    if (a === "side") setBottomMax(false);
    openArea(a);
  };
  // GH-355 drag and drop: the pane being dragged and the target it is over (Esc cancels a native drag: dragend without drop).
  const [drag, setDrag] = useState<PaneId>();
  const [dropAt, setDropAt] = useState<DropAt>();
  const kindToast = (p: PaneId) => (n: number) => `Closed ${n} ${PANE_LABEL[p]} ${n === 1 ? "tab" : "tabs"}`;
  /** Back to a dock: the pane's main tabs close, one toast with Undo (the layout comes back first). */
  const leaveMain = (p: PaneId) => {
    if (areaOf(loadLayout(), p) !== "main") return;
    const prev = loadLayout();
    closeSeveral(tabsRef.current.filter((t) => kindOf(t) === p), kindToast(p), () => saveLayout(prev));
  };
  const move = (p: PaneId, to: Area, before?: PaneId) => {
    if (to === "main") {
      // The main area: a tab of the current session (Changes never lives there).
      if (!canMain(p)) return;
      saveLayout(movePane(layout, p, "main"));
      if (p === "files") return paneOwner ? showKind("files") : (focusShownPrompt(), setToast("Files moved to the main area. Its tab opens when a session shows."));
      if (p === "graph") return paneOwner && isGit ? showKind("graph") : (focusShownPrompt(), setToast("Git graph moved to the main area. Its tab opens for a git project."));
      if (p === "terminal") {
        if (!paneOwner) return (focusShownPrompt(), setToast("Terminal moved to the main area. Its tab opens when a session shows."));
        // Carry: the dock terminal's xterm moves into the tab (no remount) when it is mounted for the tab's own folder.
        setTermCarry(termMounted && panelCwd === cwdOfOwner(paneOwner) ? panelCwd : undefined);
        return openPaneTab(paneTabFor(tabsRef.current, "terminal", paneOwner, cwdOfOwner)); // the instance is quiet: no termLoud
      }
      const owner = currentId && isSession(currentId) ? currentId : undefined;
      if (owner && views[owner] && latestPlan(views[owner]!)) openPaneTab(refOf({ kind: "plan", owner }));
      else (focusShownPrompt(), setToast("Plan moved to the main area. Its tab opens when the session has a plan."));
      return;
    }
    leaveMain(p);
    const n = movePane(layout, p, to, before);
    if (n !== layout) saveLayout(n);
    // A Terminal pane moved on purpose shows (its empty tab bar with +) even where the folder has no shells.
    if (p === "terminal" && panelCwd) wantTerminal(panelCwd);
    // Only a move out of the bottom panel needs the session view and side panel back; a reorder inside it keeps the maximize.
    if (to !== "bottom") setBottomMax(false);
    openArea(to);
    setPane(p);
    focusTab.current = p;
    setMoving(true);
  };
  /** Reset layout: Plan, Files and Git graph return to their docks, their tabs close (Undo brings the layout and the tabs back). */
  const resetPanes = () => {
    const prev = loadLayout();
    const refs = tabsRef.current.filter(isPaneRef);
    resetLayout();
    setPaneTabs({});
    const kinds = new Set(refs.map((r) => kindOf(r)!));
    if (refs.length) closeSeveral(refs, kinds.size === 1 ? kindToast([...kinds][0]!) : (n) => `Closed ${n} pane tabs`, () => saveLayout(prev));
  };
  // A moved pane's DOM moves with it: focus its tab in the new area once rendered, once (the menu that moved it returns no focus).
  const focusTab = useRef<PaneId>(undefined);
  useEffect(() => {
    const p = focusTab.current;
    if (!p) return;
    focusTab.current = undefined;
    document.querySelector<HTMLElement>(`[data-pane-tab="${p}"]`)?.focus();
  });
  // From a move to the user's next key or pointer press: a terminal that shows because of the move (moved, or next in the area the
  // moved pane left) keeps off the focus. A late (Suspense) mount of a terminal shown by the move is covered by `termMoveShow`.
  // GH-381: a terminal the reload restores as the narrow pane (shown one effect after the first render) keeps off the focus until the first key or pointer press.
  // GH-430: a terminal that shows without an active open (a remembered one once terminal.list answers, a session switch) starts quiet too.
  const [moving, setMoving] = useState(() => loadPaneTabs().narrow === "terminal");
  useEffect(() => {
    if (!moving) return;
    const done = () => setMoving(false);
    const kinds = ["keydown", "pointerdown"] as const;
    for (const k of kinds) window.addEventListener(k, done, true);
    return () => kinds.forEach((k) => window.removeEventListener(k, done, true));
  }, [moving]);
  // GH-382: a terminal that shows because of a move stays quiet for that whole show, not only until the next key: its code-split
  // panel can mount (and want the shell focus) long after the user pressed Tab. An explicit request (a click on the Terminal pane
  // tab, New terminal, Ctrl+` behind a maximized panel) ends the latch, also before the panel has mounted, so it focuses the shell
  // then. A click on one of the terminal's own tabs does not need it: the panel focuses itself.
  // GH-381: a terminal that shows at page load (the default bottom terminal, a remembered tab) starts latched the same way.
  const [termMoveShow, setTermMoveShow] = useState(termShows);
  const [termShowsBefore, setTermShowsBefore] = useState(termShows);
  if (termShows !== termShowsBefore) {
    setTermShowsBefore(termShows);
    setTermMoveShow(termShows && (moving || !activeOpen.current));
  }
  const [termAsk, setTermAsk] = useState(termFocusReq + terminalTick);
  if (termFocusReq + terminalTick !== termAsk) {
    setTermAsk(termFocusReq + terminalTick);
    setTermMoveShow(false);
  }
  /** A pane tab click; on the terminal's tab, the selected one too, the shell takes the focus (docs/spec.md Terminal panel). */
  const selectPane = (p: Pane) => {
    if (p === "terminal") (askTerminal(), setTermFocusReq((n) => n + 1));
    setPane(p);
  };
  /** The narrow pane switcher: Plan with its home in the main area shows the plan tab; a plan tab is left by picking another pane. */
  const switchPane = (p: Pane) => {
    if (p !== "session" && areaOf(layout, p) === "main") return paneRef?.kind === p ? setPane("session") : p === "plan" ? showPlan() : p === "terminal" ? showTerminal() : showKind(p as "files" | "graph");
    if (p === "session" && paneRef) return open(paneRef.owner);
    selectPane(p);
  };
  const hosts = usePaneHosts();
  useEffect(() => {
    if (shows("graph") && panelCwd) setGraphCwd(panelCwd);
  }, [shows("graph"), panelCwd]);
  const colors = useMemo(() => avatarColors(projects), [projects]);
  const ThemeIcon = { system: MonitorIcon, light: SunIcon, dark: MoonIcon }[theme];
  const upload = (owner: () => UploadOwner, uploadCwd?: string, rotate: () => void = () => {}) => async (file: File) => {
    const data = (await readDataUrl(file)).replace(/^data:[^,]*,/, "");
    // The session's side keeps the file: its Claude reads it there.
    return uploadWithRetry(async (o) => (await client.current!.request<UploadResult>({ type: "fs.upload", name: file.name, data, ...o, ...(uploadCwd && { cwd: uploadCwd }) })).path, owner, rotate);
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
  // A maximized terminal hides the session view: whatever brings the session or the side panel forward restores it.
  const showSession = () => (setBottomMax(false), !wide(1024) && setPane("session"));
  /** Opens a file of the shown session (path relative to its cwd) in the files panel. */
  const openInPanel = (p: string, line?: number) => {
    setOpenFile({ path: joinPath(shown!.cwd, p), line });
    reveal("files");
  };
  const popFile = useCallback((path?: string, line?: number, opener?: HTMLElement | null) => {
    const cwd = panelTargetRef.current?.cwd;
    if (path && cwd) void editors.open(path, { cwd, line, outside: !inDir(path, cwd) });
    setFileDialog({ opener: opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null) });
  }, []);
  const openViewer = useOpenViewer(shown, (v) => (isFileTarget(v.target) ? popFile(v.target.path, v.target.line, v.opener) : setViewer(v)));
  /** A path in assistant text (absolute, inside the session cwd): the Files tab opens it at the line. */
  const openFileLink = useCallback((path: string, line?: number) => popFile(path, line), []);
  /** Plan pane / "Open in tab": reveals the Plan pane of the current session. */
  const showPlan = (sid = currentId) => {
    if (!sid || !isSession(sid)) return;
    if (areaOf(loadLayout(), "plan") === "main") return openPaneTab(refOf({ kind: "plan", owner: sid }));
    reveal("plan");
  };
  /** Opens or focuses the Files / Git graph tab of the folder of `sid` (default: the shown session, else the one shown last). */
  const showKind = (p: "files" | "graph", sid = paneOwner) => {
    if (!sid) return setToast(`Open a session to show ${PANE_LABEL[p]}.`);
    openPaneTab(paneTabFor(tabsRef.current, p, sid, cwdOfOwner));
  };
  /** The tab of a pane ref takes the focus (its strip button; on a phone its body). */
  const focusTabOf = (ref: string) => {
    const focus = (frames: number) => {
      const strip = document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(ref)}"] [role="tab"]`);
      const el = strip && strip.getClientRects().length > 0 ? strip : document.querySelector<HTMLElement>(`[data-pane-tab-body="${CSS.escape(ref)}"]`);
      if (el && el.getClientRects().length > 0) el.focus();
      else if (frames > 0) requestAnimationFrame(() => focus(frames - 1));
    };
    requestAnimationFrame(() => focus(60));
  };
  /** Opens (or focuses) a pane tab right of its owner's tab. */
  const openPaneTab = (ref: string) => {
    setTabs((t) => insertPaneTab(t, ref, groupOfTab));
    open(ref);
    focusTabOf(ref);
  };
  /** Explicit open of a terminal tab: the shell takes the focus; `spawn`: a shell starts if the folder has none; `add`: New terminal on the shown tab. */
  const loudTerminal = (ref: string, { spawn = true, add = false } = {}) => {
    if (add && ref === activeId && termSeen.has(ref)) termBump(ref, "add");
    else if (spawn) setTermSpawn(ref);
    setTermLoud(ref);
    termBump(ref, "focus");
    if (!lg) setPane("session");
    setTabs((t) => insertPaneTab(t, ref, groupOfTab));
    open(ref);
  };
  /** Ctrl+`, the terminal buttons, New terminal, the narrow switcher with home = main: the current session's project terminal tab. */
  const showTerminal = (add = false) => (paneOwner ? loudTerminal(paneTabFor(tabsRef.current, "terminal", paneOwner, cwdOfOwner), { add }) : setToast("Open a session to show Terminal."));
  const showPlanRef = useRef(showPlan);
  showPlanRef.current = showPlan;
  const showPlanStable = useCallback(() => showPlanRef.current(), []);
  /** The body of a pane tab by kind. Terminal: its instance portals into its own host (or the dock host when carried). Plan: Activity; Files and Git graph: CSS hidden, so a hidden tab keeps its tree, editor tabs and loaded graph without effects re-running. */
  const paneTabBody = (ref: string) => {
    const kind = kindOf(ref);
    if (kind === "plan")
      return (
        <Activity key={ref} mode={ref === activeId ? "visible" : "hidden"}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-pane-tab-body={ref} tabIndex={-1}>
            <PlanPane view={views[ownerOf(ref)]} failed={failedTabs.has(ownerOf(ref))} label={tabLabel(ref)} onGoToRequest={() => goToRequest(ownerOf(ref))} />
          </div>
        </Activity>
      );
    const on = ref === activeId;
    if (kind === "terminal")
      return (
        <div key={ref} className={on ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"} data-pane-tab-body={ref} tabIndex={-1}>
          {termSeen.has(ref) && <PaneSlot host={ref === carryRef ? hosts.terminal : hostOf(ref)} />}
        </div>
      );
    const cwd = cwdOfOwner(ownerOf(ref));
    const loading = <p className="m-auto text-muted-foreground text-sm">Loading {kind === "files" ? "files" : "graph"}…</p>;
    return (
      <div key={ref} className={on ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"} data-pane-tab-body={ref} tabIndex={-1}>
        {!cwd ? (
          loading
        ) : kind === "files" ? (
          <FilesPanel
            client={client.current!}
            status={status}
            cwd={cwd}
            onSend={(mention) => (open(ownerOf(ref)), setInsert(mention))}
            onCopy={copyText}
            onViewer={(path) => popFile(path)}
            editors={editors}
            sync={false}
            suspended={!!fileDialog || !on}
            onPopOut={() => popFile()}
            onShowChanges={(path) => (setChangesReveal((r) => ({ path, seq: (r?.seq ?? 0) + 1 })), reveal("changes"))}
            openPath={on ? openFile?.path : undefined}
            openLine={on ? openFile?.line : undefined}
            onOpened={() => setOpenFile(undefined)}
            watch={[]}
            showTree={fileTree}
            onToggleTree={() => setFileTree((v) => !v)}
            gitStamp={treeStamp}
            repos={cwd === panelCwd ? repoList : undefined}
            onShowGraph={() => reveal("graph")}
            visible={on && (lg || pane === "session")}
          />
        ) : (
          <Suspense fallback={loading}>
            <GraphTab client={client.current!} cwd={cwd} hidden={!on || (!lg && pane !== "session")} connected={status === "connected"} openFiles={openFiles} seq={reposSeq} repoKey={repoProjectKey(cwd, worktrees, listLoaded)} />
          </Suspense>
        )}
      </div>
    );
  };
  /** "Go to request": the session of the plan, then the plan approval's popup button, else its first control (no answer by accident). */
  const goToRequest = (sid: string) => {
    open(sid);
    showSession();
    const focus = (frames: number) => {
      const root = document.getElementById(`split-${sid}`) ?? document;
      const panel = [...root.querySelectorAll<HTMLElement>('[data-testid="permission-panel"]')].find((e) => e.getClientRects().length > 0);
      const target = panel?.querySelector<HTMLElement>('[data-testid="plan-open"]') ?? panel?.querySelector<HTMLElement>("button, input");
      if (target) target.focus();
      else if (frames > 0) requestAnimationFrame(() => focus(frames - 1));
    };
    requestAnimationFrame(() => focus(60));
  };
  const latest = useMemo(() => (view ? latestPlan(view) : undefined), [view?.parts, view?.aux]);
  /** Toggle file tree: hides the tree when it shows; otherwise shows it with the Files tab (and the side panel on wide screens), like openInPanel. */
  const toggleFileTree = () => {
    setBottomMax(false);
    if (fileTree && inSight("files")) return setFileTree(false);
    setFileTree(true);
    reveal("files");
  };
  const draftModes = permissionModesFor({ allowBypass: newModes.includes("bypassPermissions"), supportsAuto: models.some((m) => m.value === pick.model && m.supportsAutoMode) });
  // The settings default applies only where the draft's model offers it (auto needs support); else Ask.
  const draft: StartOptions = { ...pick, mode: pick.mode ?? (draftModes.includes(defaultMode) ? defaultMode : "default") };
  // A model without auto support takes the draft out of auto mode, like the daemon does for a session.
  const changeDraft = (d: StartOptions) => {
    const lost = d.mode === "auto" && !models.some((m) => m.value === d.model && m.supportsAutoMode);
    if (lost) setToast(autoUnavailable(models, d.model));
    setDraft(lost ? { ...d, mode: "default" } : { ...d, mode: d.mode === draft.mode ? pick.mode : d.mode });
  };
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
  /** Shells list (GH-442) of session `sessionId`. */
  const openShells = (sessionId = projectSession) => sessionId && setShellsDialog({ open: true, sessionId });
  /** `/resume` (GH-100): shows the sidebar (the drawer below md) with the session search on this project's repository, then the typed text. */
  const openResume = (arg?: string) => {
    if (!project) return;
    if (wide(768)) setSidebar(true);
    else setDrawer(true);
    const name = projectName(projectOf(project, worktrees));
    setResumeSearch((s) => ({ text: resumeSearchText(name, arg), seq: (s?.seq ?? 0) + 1 }));
  };
  const openDialog = (d: DialogName, arg?: string) => (d === "mcp" ? openMcp() : d === "plugins" ? openPlugins() : d === "resume" ? openResume(arg) : d === "shells" ? openShells() : openSkills());
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
  // `id`: the tab just selected, which this render does not show yet.
  const focusShownPrompt = (id = activeId) => {
    if (id !== NEW_TAB) showSession();
    else setBottomMax(false);
    // After the render: only the shown tab's prompt box has a layout box; in a split only the active split's (never the other one's).
    // A session that just opened (Reopen closed tab, Go to tab N after a reload) has its prompt box once its view loaded: wait for it, up to 1 s.
    const focus = (frames: number) => {
      const el = id === NEW_TAB ? newPrompt.current : shownPrompt();
      if (el) el.focus();
      else if (frames > 0) requestAnimationFrame(() => focus(frames - 1));
    };
    requestAnimationFrame(() => focus(60));
  };
  // Wide: the terminal pane wherever it lives (VS Code: Ctrl+` reveals the view); it shows -> its area hides. Narrow: the terminal pane.
  const toggleTerminal = () => {
    if (termHome === "main") return showTerminal();
    if (!wide(1024)) return pane === "terminal" ? setPane("session") : (askTerminal(), setPane("terminal"));
    if (!inSight("terminal")) return (askTerminal(), shows("terminal") && setTermFocusReq((n) => n + 1), reveal("terminal"));
    openArea(termDock, false);
    focusShownPrompt();
  };
  /** Reopen closed tab (palette, tab menu): the newest closed session that still exists, back in its place. */
  const reopenClosed = () => {
    const r = popClosed(closedTabs, existsTab, tabs);
    setClosedTabs(r.rest);
    if (!r.tab) return;
    const { id, at } = r.tab;
    setTabs((t) => (t.includes(id) ? t : [...t.slice(0, at), id, ...t.slice(at)]));
    open(id);
    if (isPaneRef(id)) focusTabOf(id);
    else focusShownPrompt(id);
  };
  const reopen = popClosed(closedTabs, existsTab, tabs).tab;
  const movingShells = useRef(new Set<string>());
  const commands = appCommands({
    newWorktree: canWorktree ? () => setCreatingWt(gitProject) : undefined,
    askAside: shown && !paneRef && !draftShown ? () => setInsert("/btw ") : undefined,
    cleanUp: Object.values(worktrees).some((l) => l.some((w) => !w.main)) || list.some((x) => x.coordinatorId) ? () => setCleanup({ kind: "all" }) : undefined,
    tabs,
    activeId,
    panels: panelHost,
    splitRight: lg && isSession(activeId) && canSplitTabs(tabs) ? () => splitTab(activeId!, "row") : undefined,
    splitDown: lg && isSession(activeId) && canSplitTabs(tabs) ? () => splitTab(activeId!, "col") : undefined,
    splitNext: splitShown ? () => (focusSplit(nextSplit(split!, 1)), focusShownPrompt()) : undefined,
    splitPrev: splitShown ? () => (focusSplit(nextSplit(split!, -1)), focusShownPrompt()) : undefined,
    joinSplits: split ? joinSplits : undefined,
    sessions: list,
    session: draftShown
      ? { model: draft.model, effort: draft.effort, mode: draft.mode, modes: draftModes, running: false, prompts: [], draft: true }
      : shown && !paneRef ? {
      model: view?.model ?? shown.model,
      effort: view?.effort ?? shown.effort,
      mode: view?.permissionMode ?? shown.permissionMode,
      modes: modesOf(shown.permissionModes, view?.model ?? shown.model, models),
      running: view?.state === "running" || view?.state === "needs_input",
      prompts: timeline(view!).flatMap((i) => (i.kind === "part" && i.part.type === "user_text" && !(isCoordinator(shown.id) && i.part.text.startsWith(ORCHESTRATION_NOTICE)) ? [{ id: i.part.id, text: summarizePasted(i.part.text) }] : [])),
    } : undefined,
    runInBackground: shown && !paneRef && !draftShown && view && foregroundShells(view).length
      ? () => {
          // A second press while a move is pending would only get unknown_shell.
          for (const c of foregroundShells(view)) {
            if (movingShells.current.has(c.toolUseId)) continue;
            movingShells.current.add(c.toolUseId);
            client.current!.request({ type: "session.backgroundShell", sessionId: shown.id, toolUseId: c.toolUseId })
              .catch((e) => setError((e as Error).message))
              .finally(() => movingShells.current.delete(c.toolUseId));
          }
        }
      : undefined,
    models,
    canQuickOpen,
    newSession: () => newSession(),
    selectTab: open,
    closeTab: close,
    // Only while a chip shows for the group (2 or more groups, or compact tabs), like the chip menu.
    closeGroup: grouping !== "none" && activeId && groupOfTab(activeId) && (compact || new Set(tabs.map(groupOfTab).filter(Boolean)).size > 1) ? () => requestCloseGroup(groupOfTab(activeId), tabs.filter((id) => groupOfTab(id) === groupOfTab(activeId))) : undefined,
    // Like the tab menu's items: only while something would close (not pinned ones).
    closeOthers: activeId && closeTargets(tabs, pinnedSet, activeId, "others").length && tabs.includes(activeId) ? () => tabCommand(activeId, "closeOthers") : undefined,
    closeRight: activeId && closeTargets(tabs, pinnedSet, activeId, "right").length && tabs.includes(activeId) ? () => tabCommand(activeId, "closeRight") : undefined,
    closeAll: closeTargets(tabs, pinnedSet, activeId ?? "", "all").length ? () => tabCommand(activeId ?? tabs[0]!, "closeAll") : undefined,
    tabCleanup: cleanupInfo(),
    cleanUpTabs: (rule) => cleanUp(rule),
    togglePin: activeId && activeId !== NEW_TAB && activeId !== FOCUS_TAB && tabs.includes(activeId) ? () => togglePin(activeId) : undefined,
    pinned: !!activeId && pinnedSet.has(activeId),
    quickOpen: showQuickOpen,
    // md: the sidebar breakpoint; below it the sidebar is a drawer.
    toggleSidebar: () => (wide(768) ? setSidebar((v) => !v) : setDrawer((v) => !v)),
    // lg: the side panel breakpoint; below it the session and the files share one pane.
    toggleFileTree,
    toggleSidePanel: () => (sideEmpty ? undefined : (setBottomMax(false), wide(1024) ? setPanel((v) => !v) : setPane(pane === "session" ? "files" : "session"))),
    toggleTerminal,
    // The pane that shows already: focus goes back to the prompt (VS Code's Explorer key does the same).
    showPane: (p) => {
      if (areaOf(layout, p) === "main") return reveal(p);
      if (inSight(p)) return focusShownPrompt();
      reveal(p);
    },
    newTerminal: () => {
      if (termHome === "main") return showTerminal(true);
      if (inSight("terminal")) return setTerminalTick((n) => n + 1);
      askTerminal();
      // It may be the shown pane already, behind a maximized bottom panel: the shell takes the focus once it is in sight.
      if (shows("terminal")) setTermFocusReq((n) => n + 1);
      reveal("terminal");
    },
    resetLayout: resetPanes,
    flipSide: () => saveLayout(flipSide(layout)),
    side: layout.side,
    canReopen: !!reopen,
    reopenTab: reopenClosed,
    openShortcuts: () => setShortcutsOpen(true),
    isGit,
    viewChanges: shown && !draftShown ? () => openViewer({ kind: "changes" }) : undefined,
    viewPlan: shown && !draftShown && latest ? () => openViewer({ kind: "plan", plan: latest }) : undefined,
    showPlan: shown && !draftShown && latest ? () => showPlan() : undefined,
    homes: { plan: areaOf(layout, "plan"), files: areaOf(layout, "files"), graph: areaOf(layout, "graph"), terminal: termHome },
    moveKind: (p, to) => move(p, to),
    focusPrompt: focusShownPrompt,
    setModel: (model) => (draftShown ? changeDraft({ ...draft, model }) : configure({ type: "session.setModel", sessionId: shown!.id, model })),
    setEffort: (effort) => (draftShown ? setDraft((d) => ({ ...d, effort })) : configure({ type: "session.setEffort", sessionId: shown!.id, effort })),
    setMode: (mode) => (draftShown ? setDraft((d) => ({ ...d, mode })) : configure({ type: "session.setPermissionMode", sessionId: shown!.id, mode })),
    rewind: (id) => (setRewindTo(id), showSession()),
    stop: () => client.current!.request({ type: "session.interrupt", sessionId: shown!.id }).catch((e) => setError((e as Error).message)),
    openFocus: () => open(FOCUS_TAB),
    focusNotifications: notify.cards.length ? () => setCardFocus((n) => n + 1) : undefined,
    nextWaiting: waiting.length ? () => (open(FOCUS_TAB), setFocusSel(nextWaiting(waiting, activeId === FOCUS_TAB ? focusSel ?? waiting[0]?.part.id : undefined)?.part.id)) : undefined,
    toggleSignalOnly: () => saveSignalOnly(!loadSignalOnly()),
    toggleKeepAwake: awake.supported ? awake.toggle : undefined,
    openSettings: () => setSettingsOpen(true),
    startGuide: () => startGuide("palette"),
    resetKeyTips: () => (resetAllKeyTips(), setToast("Shortcut tips reset.")),
    openMcp: project ? () => openMcp() : undefined,
    openSkills: project ? openSkills : undefined,
    openShells: shown && !draftShown ? () => openShells(shown.id) : undefined,
    openPlugins: project ? openPlugins : undefined,
  });
  // Guided tour. The tour gets its key text only from here (the user's keymap, not the palette rows).
  const sessionIdle = !!shown && shownState(view) === "idle";
  const guideHost: GuideHost = {
    // The user's own bindings (a rebound or removed key shows as such); App re-renders on a keymap change.
    keyOf: (id) => specOf(id),
    openProject: () => (setDrawer(false), setOpeningProject(true)),
    openSettings: () => setSettingsOpen(true),
    openShortcuts: () => setShortcutsOpen(true),
    closeDrawer: () => setDrawer(false),
  };
  const startRun = (chapter: ChapterId, from?: "settings" | "palette") => {
    const ids = stepsFor(chapter, { session: !!shown, git: isGit, narrow: !wide(768) }).map((s) => s.id);
    const step = guideState.current?.step;
    setGuideRun((r) => ({ n: (r?.n ?? 0) + 1, ids, chapters: chaptersOf(ids), start: step && ids.includes(step) ? step : undefined, from }));
  };
  // Settings > Guide > Restart guide and the palette's "Show guide": both chapters pending again, from the first step.
  const startGuide = (from?: "settings" | "palette") => {
    guideState.current = restartGuide(guideState.current ?? decideFirstUse(false, 0));
    saveGuide(guideState.current);
    setGuideReady(true);
    if (from === "settings") setSettingsOpen(false);
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
      if (e.defaultPrevented || isImeKey(e) || document.querySelector('[aria-modal="true"]')) return;
      const isPalette = [specOf("palette.open"), specOf("palette.alt")].some((k) => k && matchesKey(k, e));
      const c = isPalette ? undefined : shortcutFor(latestCommands.current, e);
      if (!isPalette && !c) return;
      e.preventDefault();
      if (c) markKeyUsed(c.id);
      if (c && "run" in c) return c.run();
      // Focus goes back there when the palette closes, like quick open.
      paletteOpener.current = document.activeElement;
      setPalette({ start: c?.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status]);

  // Prefix key (tmux): runs in the capture phase, so the key after the prefix reaches no prompt box, terminal or other handler.
  useEffect(() => {
    if (status === "unauthorized") return;
    let armed: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => ((armed = undefined), setPrefixOn(false));
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]') || isImeKey(e)) return armed !== undefined ? disarm() : undefined;
      const spec = specOf("leader");
      const r = leaderStep(armed, e, Date.now(), !!spec && matchesKey(spec, e));
      if (r.armedAt !== armed) {
        clearTimeout(timer);
        if (r.armedAt !== undefined) timer = setTimeout(disarm, LEADER_MS);
      }
      armed = r.armedAt;
      setPrefixOn(armed !== undefined);
      if (r.swallow) (e.preventDefault(), e.stopPropagation());
      if (!r.run) return;
      if (r.run === "palette.open") {
        paletteOpener.current = document.activeElement;
        return setPalette({});
      }
      markKeyUsed(r.run);
      const c = latestCommands.current.find((i) => i.id === r.run);
      if (c && "run" in c) c.run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(timer);
    };
  }, [status]);

  const prompted = useMemo(() => promptedIds(optimistic, views), [optimistic, views]);


  // The terminal panel: the dock's (one) and each terminal tab's, built the same way.
  type TermProps = { shown: boolean; quiet: boolean; ensure: boolean; onEnsured: () => void; newTick: number; focusReq: number; onEmpty: () => void; onTerminals?: (n: number) => void };
  const terminalSection = (cwd: string, p: TermProps, dock: string) => (
    <section className={p.shown || dock === "main" ? "flex min-h-0 flex-1 flex-col" : "hidden"} data-testid="terminal-panel" data-dock={dock}>
      <Suspense fallback={<p className="m-auto text-muted-foreground text-sm">Loading terminal…</p>}>
        <TerminalPanel client={client.current!} status={status} cwd={cwd} {...p} />
      </Suspense>
    </section>
  );
  const dockTerminal = () =>
    panelTarget &&
    terminalSection(
      panelTarget.cwd,
      {
        ensure: spawnFor === panelTarget.cwd,
        onEnsured: () => setSpawnFor(undefined),
        onTerminals: (n) => setHasShells((h) => (h[panelTarget.cwd] === n > 0 ? h : { ...h, [panelTarget.cwd]: n > 0 })),
        onEmpty: () => {
          // Not wanted any more: its folder shows no terminal until the next active open.
          setTermWanted((w) => (w.has(panelTarget.cwd) ? new Set([...w].filter((c) => c !== panelTarget.cwd)) : w));
          setHasShells((h) => ({ ...h, [panelTarget.cwd]: false }));
          if (!lg) return setPane("session");
          // The last terminal closed: the area hides, or shows its other pane.
          const a = termDock;
          const rest = areaPanes(a).filter((p) => p !== "terminal");
          if (rest.length) setPane(rest[0]!);
          else openArea(a, false);
        },
        newTick: terminalTick,
        shown: shows("terminal"),
        focusReq: termFocusReq,
        quiet: moving || termMoveShow,
      },
      lg ? areaOf(layout, "terminal") : "side",
    );
  const tabTerminal = (ref: string) => {
    const cwd = cwdOfOwner(ownerOf(ref));
    const carry = ref === carryRef;
    return (
      cwd &&
      terminalSection(
        cwd,
        {
          shown: ref === activeId && (lg || pane === "session"),
          quiet: termLoud !== ref,
          ensure: termSpawn === ref,
          onEnsured: () => setTermSpawn(undefined),
          newTick: carry ? terminalTick : termReq[ref]?.add ?? 0,
          focusReq: carry ? termFocusReq : termReq[ref]?.focus ?? 0,
          onEmpty: () => close(ref),
        },
        "main",
      )
    );
  };
  const dragProps = { drag, dropAt, onDrag: setDrag, onDropAt: setDropAt };
  /** Drop on an area (header or body): append at its end. */
  const dropHandlers = (a: DockArea) => ({
    over: (e: globalThis.DragEvent) => {
      if (!isPaneDrag(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      if (dropAt?.area !== a || dropAt.before) setDropAt({ area: a });
    },
    leave: (e: globalThis.DragEvent) => !(e.currentTarget as Node).contains(e.relatedTarget as Node | null) && setDropAt(undefined),
    drop: (e: globalThis.DragEvent) => {
      const p = droppedPane(e);
      if (!p) return;
      e.preventDefault();
      setDrag(undefined);
      setDropAt(undefined);
      move(p, a);
    },
  });
  /** While dragging every area is outlined; the one under the pointer is filled. */
  const dropCls = (a: DockArea) => (drag ? (dropAt?.area === a && !dropAt.before ? "outline-2 outline-primary -outline-offset-2 bg-primary/5" : "outline-1 outline-dashed outline-primary/40 -outline-offset-2") : "");
  const sideDropRef = useAreaDrop(dropHandlers("side"));
  const bottomDropRef = useAreaDrop(dropHandlers("bottom"));
  const dropPane = (a: DockArea) => (p: PaneId) => (setDrag(undefined), setDropAt(undefined), move(p, a));
  const terminalToggle = areaOf(layout, "terminal") !== "side" && (
    <IconButton className={QUIET_PRESSED} label={withKey("Toggle terminal", specOf("terminal.toggle"))} pressed={inSight("terminal")} onClick={toggleTerminal} testId="terminal-toggle" command="terminal.toggle">
      <SquareTerminalIcon />
    </IconButton>
  );
  const resizer = panelHost && sideShown && <PanelResizer width={panelWidth} onResize={setPanelWidth} side={layout.side} />;
  const sideStrip = panelTarget && lg && drag && panelHost && !sideShown && (
    <DropStrip area="side" over={dropAt?.area === "side"} onOver={() => setDropAt({ area: "side" })} onLeave={() => setDropAt(undefined)} onDrop={dropPane("side")} />
  );
  // The side panel (GH-355): its tabs, then the pane hosts it holds; the hosts move between areas without remounting.
  const sideCol = panelTarget && (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col lg:w-(--panel-w) lg:flex-none ${!panelHost ? "hidden" : pane === "session" ? "hidden lg:flex" : ""} ${sideShown ? "" : "lg:hidden"}`}
      style={{ "--panel-w": `${panelWidth}px` } as CSSProperties}
    >
      <section className={`${card} flex-1 ${dropCls("side")}`} id="side-panel" data-testid="side-panel" aria-label="Side panel" data-drop-target={drag && dropAt?.area === "side" ? "" : undefined} ref={sideDropRef}>
        <DockHeader
          area="side"
          panes={areaPanes("side")}
          active={activeOf("side")}
          changes={changeCount}
          side={layout.side}
          onSelect={selectPane}
          onMove={move}
          onFlipSide={() => saveLayout(flipSide(layout))}
          onReset={resetPanes}
          extra={terminalToggle}
          {...dragProps}
        />
        {areaPanes("side").map((p) => (
          <PaneSlot key={p} host={hosts[p]} />
        ))}
      </section>
    </div>
  );
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
              const s = sessionOf(ownerOf(id));
              if (id === NEW_TAB) return { title: "New session", unread: false, titleLoading: !!optimistic[NEW_TAB]?.length };
              const g = tabGroup(s?.cwd, grouping, worktrees);
              const groupInfo = keysFinal ? { group: g.key, groupLabel: g.label || undefined, groupSub: g.sub, groupColor: g.color || undefined } : { group: "" };
              const pk = kindOf(id);
              // A pane tab: the owner's project and group, no session state of its own.
              if (pk) return { title: paneTitle(id), kind: pk, cwd: s?.cwd, ...groupInfo, worktree: s?.cwd ? worktreeName(s.cwd, worktrees) : undefined, unread: false, transcript: false };
              const item = list.find((l) => l.id === id);
              const title = item?.title || titles[id] || "Untitled";
              return { title, titleLoading: titleLoading(title, prompted.has(id)), cwd: s?.cwd, ...(keysFinal ? { group: g.key, groupLabel: g.label || undefined, groupSub: g.sub, groupColor: g.color || undefined } : { group: "" }), worktree: s?.cwd ? worktreeName(s.cwd, worktrees) : undefined, state: shownState(views[id]) ?? s?.state, unread: unread.has(id), archived: item?.archived, transcript: item?.transcript };
            }}
            renaming={renaming?.in === "tab" ? renaming.id : undefined}
            renamingFromMenu={renaming?.menu}
            onAction={sessionAction("tab")}
            onRenamed={renamed}
            onSelect={(id, click) => (click && kindOf(id) === "terminal" ? loudTerminal(id, { spawn: false }) : open(id))}
            onClose={close}
            onSwipeClose={closeFromList}
            grouping={grouping}
            compact={compact && grouping !== "none"}
            onMove={(from, to) => setTabs((t) => moveTabIn(t, keysFinal ? groupOfTab : () => "", from, to, pinnedSet))}
            onMoveGroup={(cwd, by) => setTabs((t) => moveGroup(t, groupOfTab, cwd, by))}
            onMoveGroupTo={(from, to) => setTabs((t) => moveGroupTo(t, groupOfTab, from, to))}
            onCloseGroup={requestCloseGroup}
            onCloseOtherGroups={(key) => closeSeveral(otherGroupTargets(tabs, pinnedSet, groupOfTab, key))}
            onTabCommand={tabCommand}
            cleanupMenu={cleanupInfo}
            onCleanup={cleanUp}
            canReopen={!!reopen}
            pinned={pinnedSet}
            canSplit={lg ? canSplitTabs(tabs) : undefined}
            splitShown={splitShown ? { id: split!.ids[1 - split!.at]!, dir: split!.dir, n: 2 - split!.at } : splitCramped ? { id: split!.ids[1 - split!.at]!, dir: split!.dir, n: 2 - split!.at, hidden: true } : undefined}
            onNew={() => newSession()}
            home={sidebar}
            onHome={() => setSidebar((v) => !v)}
            focus={{ count: waitingN }}
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
          <KeepAwakeButton className="max-sm:hidden" status={awake.status} error={awake.error} onToggle={awake.toggle} testId="keep-awake" />
          <IconButton className="max-sm:hidden" label={`Theme: ${theme} (click to change)`} onClick={() => setTheme(nextPref)} testId="theme-toggle">
            <ThemeIcon />
          </IconButton>
          {panelHost && (
            <IconButton className="max-lg:hidden aria-expanded:bg-transparent aria-expanded:text-faint aria-expanded:shadow-none aria-expanded:hover:bg-accent aria-expanded:hover:text-foreground" label={sideEmpty ? "No panes in the side panel" : withKey("Toggle side panel", specOf("panel.toggle"))} disabled={sideEmpty} expanded={panel && !sideEmpty} controls="side-panel" onClick={() => (setBottomMax(false), setPanel((v) => !v))} testId="panel-toggle" command="panel.toggle">
              {layout.side === "left" ? <PanelLeftIcon /> : <PanelRightIcon />}
            </IconButton>
          )}
          {panelHost && (
            <IconButton className={`max-lg:hidden ${QUIET_PRESSED}`} label={withKey("Toggle terminal", specOf("terminal.toggle"))} pressed={inSight("terminal")} onClick={toggleTerminal} testId="terminal-toggle-titlebar" command="terminal.toggle">
              <SquareTerminalIcon />
            </IconButton>
          )}
        </div>
      </header>
      <DeleteDialog title={deleting && (list.find((s) => s.id === deleting)?.title ?? "Untitled")} onConfirm={() => deleteSession(deleting!)} onCancel={() => setDeleting(undefined)} />
      <CleanupDialog
        scope={cleanup}
        list={list}
        worktrees={worktrees}
        state={listState}
        request={(m) => client.current!.request(m)}
        onClose={() => setCleanup(undefined)}
        onRemoving={markRemoving}
        onDone={(r) => {
          void refreshList();
          if (!cleanupOpen.current) setToast(summaryText(r) + (r.skipped[0] ? `: ${r.skipped[0].label}: ${r.skipped[0].reason}` : ""));
        }}
      />
      <ConfirmDialog
        open={closingGroup !== undefined}
        title={`Close ${lastClosingGroup.current.ids.length} tabs of ${lastClosingGroup.current.name}?`}
        description="Sessions keep running. Reopen them from the sidebar or with Reopen closed tab."
        confirm="Close group"
        onConfirm={() => {
          const g = closingGroup!;
          setClosingGroup(undefined);
          closeGroup(g.ids);
        }}
        onCancel={() => setClosingGroup(undefined)}
        // Cancel: back to the chip; closed: the tab that took over (it is in the Tab order), else New session.
        finalFocus={() =>
          document.querySelector<HTMLElement>(`[data-group-chip="${CSS.escape(lastClosingGroup.current.ids[0] ? groupOfTab(lastClosingGroup.current.ids[0]) : "")}"]`) ??
          document.querySelector<HTMLElement>('[data-testid="tab-strip"] [role="tab"][tabindex="0"]') ??
          document.querySelector<HTMLElement>('[data-testid="tab-new"]')
        }
        testId="close-group"
      />
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
          const prompt = shownPrompt();
          return row?.querySelector<HTMLElement>('[data-testid="group-toggle"]') ?? prompt ?? document.querySelector<HTMLElement>('[data-testid="open-project"]');
        }}
        testId="remove-project"
      />
      <CreateWorktreeDialog
        project={creatingWt}
        request={(m) => client.current!.request(m)}
        onClose={() => setCreatingWt(undefined)}
        onCreated={(project, r) => void openInWorktree(project, r.path)}
        onJiraSettings={() => (setCreatingWt(undefined), openSettingsGroup("jira"))}
      />
      <ConfirmDialog
        open={removingWorker !== undefined}
        title={`Remove worker ${lastRemovingWorker.current?.name ?? ""}?`}
        description="Its session and transcript are removed for good; the name is free again. The terminal CLI loses it too."
        confirm="Remove"
        destructive
        confirmDisabled={!!removingWorker?.loading && alsoWorktree}
        onConfirm={() => {
          const w = removingWorker!;
          setRemovingWorker(undefined);
          void removeWorker(w, alsoWorktree && !w.loading && !w.error);
        }}
        onCancel={() => setRemovingWorker(undefined)}
        testId="remove-worker"
      >
        {lastRemovingWorker.current?.path && (
          <div className="flex flex-col gap-1 text-sm">
            {!lastRemovingWorker.current.error && (
              <label className="flex min-h-8 cursor-pointer items-center gap-2 max-md:min-h-11">
                <input type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={alsoWorktree} disabled={lastRemovingWorker.current.loading} onChange={(e) => setAlsoWorktree(e.target.checked)} data-testid="remove-worker-worktree" />
                <span>Also remove worktree {lastRemovingWorker.current.branch ?? ""}</span>
              </label>
            )}
            <p className="text-muted-foreground" data-testid="remove-worker-worktree-text">
              {lastRemovingWorker.current.error ?? (lastRemovingWorker.current.loading ? "Checking the worktree…" : lastRemovingWorker.current.text)}
              {!lastRemovingWorker.current.error && lastRemovingWorker.current.others > 0 && ` ${lastRemovingWorker.current.others} other ${lastRemovingWorker.current.others === 1 ? "session" : "sessions"} there; their transcripts stay.`}
            </p>
          </div>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={removingWorkers !== undefined}
        title={`Remove ${lastRemovingWorkers.current?.ids.length === 1 ? "1 closed worker" : `${lastRemovingWorkers.current?.ids.length ?? 0} closed workers`}?`}
        description={`Workers of “${lastRemovingWorkers.current?.title ?? ""}”: ${lastRemovingWorkers.current?.names ?? ""}. Their sessions and transcripts are removed for good. Worktrees stay.`}
        confirm="Remove"
        destructive
        onConfirm={() => {
          const ids = removingWorkers!.ids;
          setRemovingWorkers(undefined);
          void runWorkers(ids, "remove");
        }}
        onCancel={() => setRemovingWorkers(undefined)}
        testId="remove-workers"
      />
      <ConfirmDialog
        open={archiving !== undefined}
        title={`Archive ${lastArchiving.current?.ids.length === 1 ? "1 session" : `${lastArchiving.current?.ids.length ?? 0} sessions`}?`}
        description={`Sessions in ${lastArchiving.current?.where ?? ""} idle for more than ${daysLabel(lastArchiving.current?.days ?? 1)}. They move to Archived sessions; Unarchive brings one back.`}
        confirm="Archive"
        onConfirm={() => {
          const ids = archiving!.ids;
          setArchiving(undefined);
          void archiveIdle(ids);
        }}
        onCancel={() => setArchiving(undefined)}
        testId="archive-idle"
      />
      <ConfirmDialog
        open={removingWt !== undefined}
        title={`Remove worktree ${lastRemovingWt.current?.branch ?? ""}?`}
        description={removeDialogText(lastRemovingWt.current, worktrees)}
        confirm="Remove worktree"
        destructive
        confirmDisabled={lastRemovingWt.current?.checking}
        hideConfirm={!!lastRemovingWt.current && (lastRemovingWt.current.error !== undefined || lastRemovingWt.current.status?.safety === "blocked")}
        onConfirm={() => {
          const w = removingWt!;
          removedWt.current = w.project;
          askToken.current = undefined;
          setRemovingWt(undefined);
          void removeWorktree(w);
        }}
        onCancel={() => {
          askToken.current = undefined;
          setRemovingWt(undefined);
        }}
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
            <KeepAwakeButton status={awake.status} error={awake.error} onToggle={awake.toggle} testId="drawer-keep-awake" />
            <IconButton label={`Theme: ${theme} (click to change)`} onClick={() => setTheme(nextPref)} testId="drawer-theme">
              <ThemeIcon />
            </IconButton>
          </div>
          {error && <p className="text-destructive">{error}</p>}
          {status !== "unauthorized" && <FocusRow count={waitingN} active={activeId === FOCUS_TAB} onOpen={() => open(FOCUS_TAB)} />}
          {status !== "unauthorized" && (
            <SessionList
              onCopy={copyText}
              list={list}
              projects={projects}
              worktrees={worktrees}
              state={listState}
              titleLoading={(s) => titleLoading(s.title, prompted.has(s.id))}
              unread={unread}
              activeId={currentId}
              onOpen={open}
              onNew={newSession}
              onRemove={setRemoving}
              onNewWorktree={(cwd, quick) => (setDrawer(false), quick ? void newWorktree(cwd) : setCreatingWt(cwd))}
              onRemoveWorktree={askRemoveWorktree}
              onWarmWorktree={warmWorktree}
              removing={(path) => removingPaths.has(path)}
              onCleanUp={(scope) => (setDrawer(false), setCleanup(scope))}
              onOpenProject={() => (setDrawer(false), setOpeningProject(true))}
              renaming={renaming?.in === "list" ? renaming.id : undefined}
              renamingFromMenu={renaming?.menu}
              onAction={sessionAction("list")}
              onRenamed={renamed}
              search={resumeSearch}
              reveal={revealSeq}
              openTabs={openTabIds}
              onWorkers={(ids, a, c) => {
                if (!ids.length) return;
                if (a === "close") return void runWorkers(ids, "close");
                setRemovingWorkers({ ids, title: c.title, names: confirmNames(ids.map((id) => list.find((s) => s.id === id)?.workerName ?? id)) });
              }}
              onArchiveIdle={(ids, where, days) => ids.length && setArchiving({ ids, where, days })}
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ "--terminal-h": `${terminalHeight}px` } as CSSProperties} data-testid="work-area">
        <main className={`flex min-h-0 min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:gap-0 ${bottomMax && panelHost ? "hidden" : ""}`}>
          {status === "unauthorized" ? (
            // Also over an open session: nothing works until the browser is paired again (e.g. the token was rotated).
            <div className={`${card} flex-1`}>
              <PairingForm />
            </div>
          ) : (
            <>
              {shown && (
                <div className="flex items-center gap-1 lg:hidden">
                  <PaneTabs panes={["session", "changes", "files", ...(isGit ? (["graph"] as const) : []), "terminal", ...(panelPlan ? (["plan"] as const) : [])]} value={paneRef && pane === "session" ? paneRef.kind : pane === "graph" && !isGit ? "files" : pane} onChange={switchPane} changes={changeCount} />
                </div>
              )}
              {layout.side === "left" && lg && (
                <>
                  {sideStrip}
                  {sideCol}
                  {resizer}
                </>
              )}
              {/* Every visited session tab stays mounted (hidden), so it keeps its scroll position and draft prompt. */}
              <div
                ref={areaRef}
                className={`relative ${splitShown ? `flex min-h-0 min-w-0 flex-1 ${split!.dir === "row" ? "flex-row" : "flex-col"}` : `${card} flex-1`} ${mainShown && pane === "session" ? "" : mainShown ? "hidden lg:flex" : "hidden"}`}
                data-testid="session-area"
                data-split={splitShown ? split!.dir : undefined}
              >
                <ViewerContext value={openViewer}>
                <PlanTabContext value={showPlanStable}>
                <FileLinkContext value={openFileLink}>
                <QuoteContext value={setInsert}>
                {tabs.map((id) => {
                  const s = id === NEW_TAB ? undefined : sessionOf(id);
                  const pend = optimistic[id];
                  // Just created: shown before its subscribe reply, so the card is never blank.
                  const v = viewOf(id);
                  if (!s || !v) return null;
                  return (
                    <Activity key={tabKeys[id] ?? id} mode={(splitShown ? split!.ids.includes(id) : id === activeId) ? "visible" : "hidden"}>
                      <div
                        className={splitShown && split!.ids.includes(id) ? `${card} ${id === activeId ? "outline outline-1 -outline-offset-1 outline-ring" : ""}` : "flex min-h-0 min-w-0 flex-1 flex-col"}
                        style={splitShown && split!.ids.includes(id) ? { order: split!.ids[0] === id ? 0 : 2, flex: `${split!.ids[0] === id ? drawnRatio : 1 - drawnRatio} 1 0%` } : undefined}
                        {...(splitShown && split!.ids.includes(id) && {
                          id: `split-${id}`,
                          role: "group",
                          "aria-label": `${list.find((l) => l.id === id)?.title || titles[id] || "Untitled"}, split ${split!.ids.indexOf(id) + 1} of 2${id === activeId ? ", active" : ""}`,
                          "data-testid": "split",
                          "data-active": id === activeId ? "" : undefined,
                          onPointerDownCapture: () => focusSplit(id),
                          onFocusCapture: () => focusSplit(id),
                        })}
                      >
                      {renderTab(id, s, v, pend, { active: splitShown ? id === activeId : true })}
                      </div>
                    </Activity>
                  );
                })}
                </QuoteContext>
                </FileLinkContext>
                </PlanTabContext>
                </ViewerContext>
                {tabs.filter(isPaneRef).map(paneTabBody)}
                {splitCramped && (
                  <div className="order-first flex shrink-0 items-center gap-2 border-b px-3 py-1 text-muted-foreground text-xs" data-testid="split-hint" role="status">
                    <span className="min-w-0 truncate">Split hidden — widen the window or hide a panel</span>
                    <button type="button" className="shrink-0 cursor-pointer rounded-sm px-1.5 py-0.5 text-foreground underline underline-offset-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" onClick={joinSplits}>
                      Close split
                    </button>
                  </div>
                )}
                {splitDrop.state && (
                  <div
                    aria-hidden
                    data-testid="split-drop"
                    data-zone={splitDrop.state.zone}
                    className="pointer-events-none absolute z-10 rounded-xl bg-ring/15 outline-2 -outline-offset-2 outline-ring"
                    style={splitDrop.state.box}
                  />
                )}
                {splitShown && <SplitResizer split={{ ...split!, ratio: drawnRatio }} onResize={(ratio) => setSplitRaw({ ...split!, ratio })} />}
              </div>
              {/* Aside popups (docs/spec.md "Aside"): hidden with their owner's tab, still running and subscribed. */}
              {asides.map((a, i) => {
                if (!visibleIds.includes(a.ownerId)) return null;
                const s = sessionOf(a.id);
                const v = views[a.id];
                const rect = a.rect ?? { ...cascade(i, { w: window.innerWidth }), ...DEFAULT_SIZE };
                const notHere = () => Promise.reject(new Error("Not available inside an aside"));
                return (
                  <AsidePopup
                    key={a.id}
                    id={a.id}
                    index={asides.filter((x, j) => j < i && x.minimized).length}
                    title={a.title}
                    readOnly={a.readOnly}
                    minimized={a.minimized}
                    rect={rect}
                    onRect={(r) => setAsides((l) => l.map((x) => (x.id === a.id ? { ...x, rect: clampRect(r, { w: window.innerWidth, h: window.innerHeight }) } : x)))}
                    onMinimize={() => (setAsides((l) => setMinimized(l, a.id, true)), setAsideFocused((f) => (f === a.id ? undefined : f)))}
                    onRestore={() => (setAsides((l) => raise(setMinimized(l, a.id, false), a.id)), setAsideFocused(a.id))}
                    onClose={() => closeAside(a.id)}
                    onKeep={() => void keepAside(a.id)}
                    onFocus={() => (setAsideFocused(a.id), setAsides((l) => raise(l, a.id)))}
                  >
                    {s && v ? (
                      renderTab(a.id, s, v, optimistic[a.id], {
                        active: asideFocused === a.id,
                        aside: true,
                        scrollKey: 0,
                        insert: undefined,
                        rewindTo: undefined,
                        revealHit: undefined,
                        run: undefined,
                        place: undefined,
                        links: NO_LINKS,
                        onLoadOlder: () => Promise.resolve(),
                        onAside: notHere,
                        onMode: (mode) => (setAsides((l) => l.map((x) => (x.id === a.id ? { ...x, readOnly: false } : x))), configure({ type: "session.setPermissionMode", sessionId: a.id, mode })),
                        onPrompt: (text, images) => (isClearCommand(text) ? notHere() : sendPrompt(a.id, text, images)),
                      })
                    ) : (
                      <p className="m-auto text-muted-foreground text-sm">Loading…</p>
                    )}
                  </AsidePopup>
                );
              })}
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
                  onUpload={upload(() => uploadOwnerFor(unprompted.current, draftProject, draftUpload.current), draftProject, () => void (draftUpload.current = rotateDraftToken()))}
                  onSearch={search}
                  commandsRev={Object.values(configChanged).reduce((a, b) => a + b, 0)}
                  onCommands={(cwd) => client.current!.request<CommandsResult>({ type: "session.commands", cwd }).then((r) => r.commands)}
                  onStart={createSession}
                  onDialog={openDialog}
                  inputRef={newPrompt}
                  connected={status === "connected"}
                  insert={activeId === NEW_TAB ? insert : undefined}
                  onInserted={() => setInsert(undefined)}
                />
              )}
              {activeId === NEW_TAB && !!optimistic[NEW_TAB]?.length && draftProject && (
                <>
                  {/* The height of the pane tabs row the session card has below lg (28px + the main gap): the prompt does not move when the session shows. */}
                  <div className="h-7 shrink-0 lg:hidden" aria-hidden />
                  <StartingSession cwd={draftProject} place={worktreeName(draftProject, worktrees)} pending={optimistic[NEW_TAB]} />
                </>
              )}
              {/* GH-367: before the side panel, so it keeps its place right of the work area on Focus. */}
              {activeId === FOCUS_TAB && (
                <FocusPage
                  list={focusList}
                  views={views}
                  worktrees={worktrees}
                  waiting={waiting}
                  selected={focusSel}
                  onSelect={setFocusSel}
                  onRespond={respond}
                  onAnswer={answer}
                  onOpenSession={(id) => (asides.some((a) => a.id === id) ? showAside(id) : open(id))}
                  unread={unread}
                  activity={(id) => Math.max(liveAt.current.get(id) ?? 0, list.find((s) => s.id === id)?.lastActivity ?? 0)}
                  onCancelContinue={(id) => client.current!.request({ type: "session.cancelContinue", sessionId: id }).catch((e) => setError((e as Error).message))}
                />
              )}
              {!(layout.side === "left" && lg) && (
                <>
                  {resizer}
                  {sideCol}
                  {sideStrip}
                </>
              )}
              {activeId !== NEW_TAB && activeId !== FOCUS_TAB && !mainShown && (
                <div className={`${card} flex-1`}>
                  <div className="m-auto text-muted-foreground">Open or create a session to start.</div>
                </div>
              )}
              {panelTarget && (
                <>
                  <EditorSync store={editors} client={client.current!} status={status} watch={changedPaths} />
                  {/* The pane contents render here once; each host sits in the slot of the area that holds the pane. */}
                  {createPortal(
                    areaOf(layout, "files") !== "main" && (
                    <div className={shows("files") ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                      <FilesPanel
                        client={client.current!}
                        status={status}
                        cwd={panelTarget.cwd}
                        onSend={(mention) => (setInsert(mention), setPane("session"))}
                        onCopy={copyText}
                        onViewer={(path) => popFile(path)}
                        editors={editors}
                        suspended={!!fileDialog}
                        onPopOut={() => popFile()}
                        onShowChanges={(path) => (setChangesReveal((r) => ({ path, seq: (r?.seq ?? 0) + 1 })), reveal("changes"))}
                        openPath={openFile?.path}
                        openLine={openFile?.line}
                        onOpened={() => setOpenFile(undefined)}
                        watch={changedPaths}
                        showTree={fileTree}
                        onToggleTree={() => setFileTree((v) => !v)}
                        gitStamp={treeStamp}
                        repos={repoList}
                        onShowGraph={() => reveal("graph")}
                        visible={inSight("files")}
                        sync={false}
                      />
                    </div>
                    ),
                    hosts.files,
                  )}
                  {createPortal(
                    panelTarget.sessionId ? (
                      views[panelTarget.sessionId] && (
                        <ChangesPanel
                          key={panelTarget.sessionId}
                          hidden={!shows("changes")}
                          onCount={(n) => setListedChanges({ id: panelTarget.key, n })}
                          client={client.current!}
                          view={views[panelTarget.sessionId]!}
                          cwd={panelTarget.cwd}
                          onOpen={(path) => (setOpenFile({ path }), reveal("files"))}
                          sessionId={panelTarget.sessionId}
                          onPopOut={() => openViewer({ kind: "changes" })}
                          reveal={changesReveal}
                          repos={repoList}
                          ignoreSubmodules={ignoreSubmodules}
                          onReload={reloadRepos}
                        />
                      )
                    ) : (
                      // The new-session tab: no session yet, so nothing was edited; git modes work for the draft's project.
                      <ChangesPanel
                        key={NEW_TAB}
                        hidden={!shows("changes")}
                        onCount={(n) => setListedChanges({ id: NEW_TAB, n })}
                        client={client.current!}
                        view={EMPTY_VIEW}
                        cwd={panelTarget.cwd}
                        onOpen={(path) => (setOpenFile({ path }), reveal("files"))}
                        sessionId={NEW_TAB}
                        reveal={changesReveal}
                        repos={repoList}
                        ignoreSubmodules={ignoreSubmodules}
                        onReload={reloadRepos}
                        emptyText="No changes yet. Claude's edits appear here."
                      />
                    ),
                    hosts.changes,
                  )}
                  {createPortal(
                    isGit && areaOf(layout, "graph") !== "main" && (shows("graph") || graphCwd === panelTarget.cwd) && (
                      <Suspense fallback={<p className="m-auto text-muted-foreground text-sm">Loading graph…</p>}>
                        <GraphPane hidden={!shows("graph")} client={client.current!} cwd={panelTarget.cwd} repos={repos === null ? null : repoList} onRefresh={reloadRepos} />
                      </Suspense>
                    ),
                    hosts.graph,
                  )}
                  {createPortal(
                    areaOf(layout, "plan") !== "main" && panelTarget.sessionId && (
                      <div className={shows("plan") ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                        <PlanPane view={panelView} label="Plan" onGoToRequest={() => goToRequest(panelTarget.sessionId!)} />
                      </div>
                    ),
                    hosts.plan,
                  )}
                </>
              )}
              {/* GH-397: one position for the dock terminal and the tab it moved into, so a move never remounts it. */}
              {createPortal(termHome === "main" ? carryRef && tabTerminal(carryRef) : termMounted && dockTerminal(), hosts.terminal)}
              {termTabs.filter((r) => r !== carryRef).map((r) => createPortal(tabTerminal(r), hostOf(r), r))}
            </>
          )}
        </main>
        {status !== "unauthorized" && panelTarget && bottomShown && (
          <>
            {panelHost && !bottomMax && <TerminalResizer height={terminalHeight} onResize={setTerminalHeight} />}
            <section
              id="bottom-panel"
              aria-label="Bottom panel"
              className={`${card} ${!panelHost ? "hidden" : bottomMax ? "flex-1" : "h-(--terminal-h) max-h-[60vh] min-h-25 flex-none"} ${dropCls("bottom")}`}
              data-testid="bottom-panel"
              data-dock="bottom"
              data-drop-target={drag && dropAt?.area === "bottom" ? "" : undefined}
              ref={bottomDropRef}
            >
              <DockHeader
                area="bottom"
                panes={areaPanes("bottom")}
                active={activeOf("bottom")}
                changes={changeCount}
                onSelect={selectPane}
                onMove={move}
                onReset={resetPanes}
                {...dragProps}
                extra={
                  <>
                    <IconButton label={bottomMax ? "Restore panel" : "Maximize panel"} pressed={bottomMax} onClick={() => setBottomMax((m) => !m)} testId="dock-maximize">
                      {bottomMax ? <ChevronDownIcon /> : <ChevronUpIcon />}
                    </IconButton>
                    <IconButton label="Hide bottom panel" onClick={() => (setBottomOpen(false), focusShownPrompt())} testId="dock-hide">
                      <XIcon />
                    </IconButton>
                  </>
                }
              />
              {areaPanes("bottom").map((p) => (
                <PaneSlot key={p} host={hosts[p]} />
              ))}
            </section>
          </>
        )}
        {status !== "unauthorized" && panelTarget && lg && drag && panelHost && !bottomShown && (
          <DropStrip area="bottom" over={dropAt?.area === "bottom"} onOver={() => setDropAt({ area: "bottom" })} onLeave={() => setDropAt(undefined)} onDrop={dropPane("bottom")} />
        )}
        </div>
      </div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="attention-status">
        {noteText !== undefined ? noteText + (waitingN ? ` ${waitingStatus(waitingN)}.` : "") : announcement(waitingN, everWaiting.current)}
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
          // Started from the palette: back to where it was opened from, else the prompt box, else the New session button.
          returnFocus={
            guideRun.from === "settings"
              ? () => [...document.querySelectorAll<HTMLElement>('[data-testid="open-settings"]')].find((b) => isVisible(b)) ?? shownPrompt()
              : guideRun.from === "palette"
                ? () => {
                    const o = paletteOpener.current;
                    // Opened with nothing focused and no session shown: the New session button, so the focus is never lost to the page.
                    return o instanceof HTMLElement && o !== document.body && o.isConnected && isVisible(o) ? o : shownPrompt() ?? [...document.querySelectorAll<HTMLElement>('[data-testid="tab-new"]')].find((b) => isVisible(b));
                  }
                : undefined
          }
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
        docker={docker}
        onStartSide={(side, setup) => client.current!.request({ type: "side.start", side, ...(setup && { setup }) })}
        onCheckSide={(side) => client.current!.request<SideCheck>({ type: "side.check", side })}
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
      {shellsDialog && (
        <ShellsDialog
          open={shellsDialog.open}
          view={shellsDialog.sessionId ? views[shellsDialog.sessionId] : undefined}
          output={(toolUseId) => client.current!.request<ShellOutputResult>({ type: "session.shellOutput", sessionId: shellsDialog.sessionId!, toolUseId })}
          kill={(toolUseId) => client.current!.request({ type: "session.stopShell", sessionId: shellsDialog.sessionId!, toolUseId })}
          onClose={() => setShellsDialog({ ...shellsDialog, open: false })}
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
      <SettingsDialog push={{ on: pushOn, supported: pushSupported(), busy: pushBusy, error: pushError, toggle: () => void togglePush() }} open={settingsOpen} changed={settingsChanged} request={(m) => client.current!.request(m)} onClose={() => setSettingsOpen(false)} tabGrouping={grouping} onTabGrouping={changeGrouping} onRestartGuide={() => startGuide("settings")} onTerminalPosition={(a) => (a !== "main" && leaveMain("terminal"), saveTerminalDock(a))} tabCompact={compact} onTabCompact={changeCompact} tabAutoClose={autoClose} onTabAutoClose={changeAutoClose} onShortcuts={() => (setSettingsOpen(false), setShortcutsOpen(true))} />
      {shown && client.current && (
        <ViewerDialog
          target={viewer && !isFileTarget(viewer.target) ? viewer.target : undefined}
          opener={viewer?.opener}
          client={client.current}
          cwd={viewer?.cwd ?? shown.cwd}
          view={viewer ? views[viewer.sessionId] : undefined}
          sessionId={viewer?.sessionId}
          repos={(viewer?.cwd ?? shown.cwd) === panelCwd ? repoList : undefined}
          ignoreSubmodules={ignoreSubmodules}
          onClose={() => setViewer(undefined)}
          onOpenInEditor={(p, line) => (setViewer(undefined), setOpenFile({ path: p, line }), reveal("files"))}
        />
      )}
      {panelTarget && client.current && (
        <FileDialog
          open={!!fileDialog}
          opener={fileDialog?.opener}
          client={client.current}
          status={status}
          cwd={panelTarget.cwd}
          store={editors}
          gitStamp={treeStamp}
          repos={repoList}
          onShowGraph={() => (setFileDialog(undefined), reveal("graph"))}
          onClose={() => setFileDialog(undefined)}
          onSend={(m) => (setFileDialog(undefined), setInsert(m), setPane("session"))}
          onCopy={copyText}
          onShowChanges={(path) => (setFileDialog(undefined), setChangesReveal((r) => ({ path, seq: (r?.seq ?? 0) + 1 })), reveal("changes"))}
          onOpenInFiles={() => (setFileDialog(undefined), reveal("files"))}
        />
      )}
      <ShortcutsDialog open={shortcutsOpen} edit={shortcutsEdit} onClose={() => (setShortcutsOpen(false), setShortcutsEdit(undefined))} />
      {/* Always mounted so a screen reader announces the hint when it fills in. */}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-3 left-1/2 z-50 w-max max-w-[calc(100vw-24px)] -translate-x-1/2" data-testid="prefix-hint">
        {prefixOn && (
          <p className="flex flex-wrap justify-center gap-x-3 gap-y-1 rounded-lg bg-card px-3 py-2 text-xs shadow-floating">
            <span className="font-medium">{keyText(specOf("leader"))} then</span>
            {PREFIX_KEYS.map((p) => (
              <span key={p.key} className="text-muted-foreground">
                <kbd className="font-sans font-medium text-foreground">{p.key}</kbd> {p.title}
              </span>
            ))}
            <span className="text-muted-foreground">
              <kbd className="font-sans font-medium text-foreground">Esc</kbd> cancel
            </span>
          </p>
        )}
      </div>
      <ToastRegion>
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
        {toast && <Toast key={toast.key} message={toast.message} action={toast.action} onClose={closeToast} />}
        <KeyTips
          hidden={drawer || settingsOpen || shortcutsOpen || !!palette || quickOpen || openingProject || !!guideRun}
          onAssign={(id) => (setShortcutsEdit(id), setShortcutsOpen(true))}
          onTurnedOff={() => setToast("Shortcut tips off. Turn them on in Settings › Keyboard.")}
        />
        <NotificationStack
          items={cardItems}
          now={cardsNow}
          focusTick={cardFocus}
          hidden={drawer || settingsOpen || shortcutsOpen || !!palette || quickOpen || openingProject}
          onRespond={(card, decision) => client.current!.request({ type: "permission.respond", requestId: card.requestId!, decision })}
          onOpenFocus={(card) => (open(FOCUS_TAB), setFocusSel(card.requestId))}
          onOpenSession={(card) => (open(card.sessionId), setScrollKeys((k) => ({ ...k, [card.sessionId]: (k[card.sessionId] ?? 0) + 1 })))}
          onDismiss={notify.dismiss}
          onOpenAll={() => open(FOCUS_TAB)}
          restoreFocus={() => (activeId === FOCUS_TAB ? document.querySelector<HTMLElement>("main")?.focus() : focusShownPrompt())}
        />
      </ToastRegion>
    </div>
    </SideLabel>
    </AvatarColors>
  );
}

type Pane = "session" | PaneId;

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
function PanelResizer({ width, onResize, side }: { width: number; onResize: (w: number) => void; side: DockSide }) {
  const clamp = (w: number) => Math.round(Math.max(280, Math.min(w, window.innerWidth - 480)));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuenow={width}
      tabIndex={0}
      className={`hidden w-1.5 shrink-0 cursor-col-resize touch-none ${side === "left" ? "border-r" : "border-l"} bg-border/40 hover:bg-primary/30 focus-visible:bg-primary/30 lg:block`}
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      // Right: the panel ends at the window edge; left: it starts at its own left edge (the element before the resizer).
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && onResize(clamp(side === "left" ? e.clientX - e.currentTarget.previousElementSibling!.getBoundingClientRect().left : window.innerWidth - e.clientX))}
      onKeyDown={(e) => {
        const d = (side === "left" ? { ArrowLeft: -32, ArrowRight: 32 } : { ArrowLeft: 32, ArrowRight: -32 })[e.key];
        if (d) onResize(clamp(width + d));
      }}
    />
  );
}

/** Drag handle (or arrow keys) between the two splits; it takes the gap between them. */
function SplitResizer({ split, onResize }: { split: Split; onResize: (ratio: number) => void }) {
  const row = split.dir === "row";
  const min = row ? SPLIT_MIN_W : SPLIT_MIN_H;
  const GAP = 8;
  const at = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.parentElement!.getBoundingClientRect();
    return row ? ratioFor(e.clientX - r.left - GAP / 2, r.width - GAP, min) : ratioFor(e.clientY - r.top - GAP / 2, r.height - GAP, min);
  };
  const total = (el: HTMLElement) => {
    const r = el.parentElement!.getBoundingClientRect();
    return (row ? r.width : r.height) - GAP;
  };
  const step = (el: HTMLElement, px: number) => onResize(ratioFor(split.ratio * total(el) + px, total(el), min));
  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label="Resize split"
      aria-valuenow={Math.round(split.ratio * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-controls={`split-${split.ids[0]}`}
      tabIndex={0}
      className={`shrink-0 touch-none rounded-full hover:bg-primary/30 focus-visible:bg-primary/30 focus-visible:outline-2 focus-visible:outline-ring ${row ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"}`}
      style={{ order: 1 }}
      data-testid="split-resizer"
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && onResize(at(e, e.currentTarget))}
      onDoubleClick={() => onResize(0.5)}
      onKeyDown={(e) => {
        const d = (row ? { ArrowLeft: -32, ArrowRight: 32 } : { ArrowUp: -32, ArrowDown: 32 })[e.key as "ArrowLeft"];
        if (d) return (e.preventDefault(), step(e.currentTarget, d));
        if (e.key === "Home") (e.preventDefault(), onResize(ratioFor(0, total(e.currentTarget), min)));
        else if (e.key === "End") (e.preventDefault(), onResize(ratioFor(total(e.currentTarget), total(e.currentTarget), min)));
        else if (e.key === "Enter") (e.preventDefault(), onResize(0.5));
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

/** Drag handle (or arrow keys) between the work area and the bottom panel on wide screens (OpenCode: 100px to 60% of the window). */
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
  { model, mode, effort, draft }: StartOptions,
  first: FirstMessage,
  onInfo: (s: SessionInfo) => void = () => {},
  /** The draft token is spent by session.create: the caller makes a new one at once (later attachments go by session id). */
  onDraftClaimed: () => void = () => {},
): Promise<SessionInfo> {
  const reused = created.current?.cwd === cwd;
  let session = reused ? created.current! : (await request<CreateResult>({ type: "session.create", cwd, model, ...(draft && { draft }) })).session;
  if (!reused && draft) onDraftClaimed();
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
  insert,
  onInserted,
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
  /** Text the panels send to the prompt (a file mention, a quote): GH-430, the panels show on this tab too. */
  insert?: string;
  onInserted?: () => void;
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
          draftKey={NEW_TAB_DRAFT}
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
          insert={insert}
          onInserted={onInserted}
        />
      </div>
      {cwd ? (
        // Project chip: Base UI Select like the prompt toolbar pickers; "Open project…" is its last item.
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1">
        <Select value={project} onValueChange={(v) => (v === OPEN ? onOpenProject() : v && onCwd(v))}>
          <SelectTrigger aria-label="Project" title={project} data-testid="project-chip" className={`${GHOST} min-w-0 max-w-full max-md:h-11! text-foreground hover:bg-secondary`}>
            <ProjectAvatar cwd={project} />
            <span className="min-w-0 truncate font-medium" data-testid="new-project">
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
          <span className="inline-flex min-w-0 max-w-full items-center gap-1">
            <span aria-hidden className="select-none text-faint">
              /
            </span>
            {/* OpenCode PromptWorkspaceSelector: "Run session in", Run session in, Primary worktree (OpenCode: Local repository), the worktrees, New worktree. */}
            <Select value={cwd} onValueChange={(v) => (v === NEW_WT ? onNewWorktree?.(project) : v && onCwd(v))}>
              <SelectTrigger aria-label={`${here?.main ? "Primary worktree" : (here?.branch ?? projectName(cwd))}, Run session in`} title={cwd} data-testid="worktree-chip" className={`${GHOST} min-w-0 max-w-full max-md:h-11! text-foreground hover:bg-secondary`}>
                {here?.main ? <MonitorIcon /> : <GitBranchIcon />}
                <span className="min-w-0 max-w-50 truncate">{here?.main ? "Primary worktree" : (here?.branch ?? projectName(cwd))}</span>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} side="bottom" align="start" className="w-auto min-w-48 max-w-[calc(100vw-2rem)] rounded-md p-0.5 shadow-floating! ring-0">
                <SelectGroup>
                  <SelectLabel>Run session in</SelectLabel>
                  {runIn.map((w) => (
                    <SelectItem key={w.path} value={w.path} title={w.path} className={ROW}>
                      {w.main ? <MonitorIcon /> : <GitBranchIcon />}
                      <span className="truncate">{w.main ? "Primary worktree" : (w.branch ?? projectName(w.path))}</span>
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

/** `draft`: the new-session tab's upload token (upload-owner.ts), claimed by session.create. */
export type StartOptions = { model: string; mode: PermissionMode; effort: Effort; draft?: string };
/** What starts a session: a first prompt, or a bash mode command (`!` in the first prompt box). */
export type FirstMessage = { text: string; images: string[] } | { command: string };
const NEW_SESSION_MODES = PERMISSION_MODES.filter((m) => m !== "bypassPermissions");
type DraftPick = Omit<StartOptions, "mode"> & { mode?: PermissionMode };
const NEW_DRAFT: DraftPick = { model: "default", effort: "default" };

const timelineKey = (item: SignalItem) => (item.kind === "part" ? item.part.id : item.id);

const MemoSessionPane = memo(SessionPane);

/**
 * A mounted session tab: its pane re-renders only when a value prop changes (its view, session, connection), not for the new callbacks of
 * every App render (a tab switch, another session's event). The callbacks it gets are stable and call the latest App closure.
 */
function SessionTab(props: ComponentProps<typeof SessionPane>) {
  return <MemoSessionPane {...useStableProps(props)} />;
}

export function SessionPane({
  active = true,
  place,
  coordinator,
  scrollKey,
  run,
  onOpenRun = () => {},
  links = NO_LINKS,
  onOpenSession = () => {},
  onStopRun = async () => {},
  onBackgroundShell,
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
  onQueue,
  onDequeue,
  onSendQueued,
  onBash,
  onSearch,
  onInterrupt,
  onCancelContinue,
  onRewindPreview,
  onRewind,
  onMedia,
  onArtifactPreview,
  onRespond,
  onAnswer,
  connected,
  onGitStatus,
  onDialog,
  onShells,
  onAside,
  aside = false,
  signalOnly = false,
}: {
  /** Split view: only the active split stops its turn on Esc. */
  active?: boolean;
  scrollKey: number;
  /** Signal only: runs of tool cards fold into one line (GH-159). The browser-wide setting. */
  signalOnly?: boolean;
  /** Subagent run whose subagent view shows; an unknown one shows the session view. */
  run?: string;
  /** Opens a run's subagent view; undefined: the session view. */
  onOpenRun?: (id?: string) => void;
  /** Orchestration links for the agent map: the coordinator and the workers (workers.ts); `onOpenSession` opens or focuses a session's tab. */
  links?: AgentLinks;
  onOpenSession?: (id: string) => void;
  /** Stop agent: stops that subagent run only; rejects with the daemon's error. */
  onStopRun?: (id: string) => Promise<unknown>;
  /** Run in background of a Bash card (GH-440); rejects with the daemon's error. Undefined: no button. */
  onBackgroundShell?: (toolUseId: string) => Promise<unknown>;
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
  /** Queues a message for when the session is idle (Alt+Enter, send menu); rejects when it was not queued. */
  onQueue?: (text: string, images: string[]) => Promise<unknown>;
  /** Removes a queued message and resolves to its text and images (Edit, Delete); rejects with code unknown_item when it was already sent. */
  onDequeue?: (itemId: string) => Promise<{ text: string; images: string[]; bash?: boolean }>;
  /** Send now: steers the queued message into the running turn, or starts a turn when idle. */
  onSendQueued?: (itemId: string) => Promise<unknown>;
  /** Bash mode (`!`): runs a shell command in the session cwd; rejects when it was not run. */
  onBash?: (command: string) => Promise<unknown>;
  onSearch: (query: string) => Promise<string[]>;
  onInterrupt: () => void;
  /** Drops the scheduled continue after a usage limit. */
  onCancelContinue?: () => void;
  onRewindPreview: (userMessageId: string) => Promise<RewindPreview>;
  /** Loads a payload a snapshot or page left out (session.media). */
  onMedia?: MediaLoader;
  /** Asks for the preview URL of an Artifact publish part (artifact.preview). */
  onArtifactPreview?: ArtifactPreviewLoader;
  onRewind: (userMessageId: string, mode: RewindMode) => Promise<unknown>;
  onRespond: (requestId: string, answer: PermissionAnswer) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  /** The daemon is reachable; otherwise the send button is disabled. */
  connected: boolean;
  onGitStatus?: () => Promise<GitStatus | null>;
  /** `/mcp`, `/skills`, `/plugins` typed alone, `/resume` with or without text: opens that dialog instead of sending. */
  onDialog?: (dialog: DialogName, arg?: string) => void;
  /** The status bar's shells field: opens the list of this pane's own session (split view: not the active one's). */
  onShells?: () => void;
  /** /btw typed in the prompt box (docs/spec.md "Aside"): opens the Aside; rejects with the reason it did not. */
  onAside?: (question: string) => Promise<unknown>;
  /** This pane is an Aside popup's: Esc stops its turn only from inside the popup; an owner pane's only from outside. */
  aside?: boolean;
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
  const sendModeSetting = useSendMode();
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
  // Stable for the cards: they do not re-render on every App render.
  const backgroundShellRef = useRef(onBackgroundShell);
  backgroundShellRef.current = onBackgroundShell;
  const backgroundShellStable = useCallback((id: string) => backgroundShellRef.current!(id), []);
  // Esc stops the turn, like Claude Code; in a subagent view it stops only that run, like Stop agent. The command picker handles
  // its own Esc first (preventDefault), and an open modal dialog owns Esc.
  const escStops = current ? isRunning(current) && !(stopOf && !stopOf.error) : turnRunning || shellRunning;
  const onEscape = useEffectEvent(() => (current ? stopRun(current.id) : onInterrupt()));
  useEffect(() => {
    if (!escStops || !active) return;
    // An Aside popup's pane answers Esc from inside the popup, an owner pane from outside it: one Esc stops one turn.
    const onEsc = (e: globalThis.KeyboardEvent) =>
      e.key === "Escape" && !isImeKey(e) && !e.defaultPrevented && !document.querySelector('[aria-modal="true"]') && !!(e.target as Element | null)?.closest?.("[data-aside-popup]") === aside && onEscape();
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [escStops, active]);
  const [rewinding, setRewinding] = useState<string>();
  /** A rewind request is in flight (the daemon takes no shell command meanwhile). */
  const [rewindRunning, setRewindRunning] = useState(false);
  // Palette Rewind: the timeline scrolls to the message first (it can be outside the rendered window), then its panel opens.
  const [reveal, setReveal] = useState<{ key: string }>();
  useEffect(() => {
    if (!rewindTo) return;
    setReveal({ key: rewindTo });
    setRewinding(rewindTo);
    onRewindShown?.();
  }, [rewindTo]);
  const items = useMemo(() => timeline(view), [view]);
  const shownItems = useMemo<SignalItem[]>(() => (signalOnly ? signalItems(items, (c) => awaitingPermission(view).has(c.toolUseId)) : items), [items, signalOnly, view]);
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
  // A queued message taken back (Edit) or an error of a chip action: the prompt box shows it once per key.
  const [takeBack, setTakeBack] = useState<{ key: string; text: string; images: string[]; bash?: boolean; error?: string }>();
  const chipAction = (id: string, how: "edit" | "delete" | "send") => {
    const fail = (e: Error) => {
      // Delete and Send now of an item that is gone: nothing to report, nothing to change in the box.
      const gone = (e as RequestError).code === "unknown_item";
      if (gone && how !== "edit") return;
      setTakeBack({ key: pendingKey(), text: "", images: [], error: gone ? "Already sent" : `${how === "send" ? "Send now" : how === "edit" ? "Edit" : "Delete"} failed: ${e.message}` });
    };
    if (how === "send") return void onSendQueued?.(id).catch(fail);
    void onDequeue?.(id).then((r) => how === "edit" && setTakeBack({ key: pendingKey(), text: r.text, images: r.images, bash: r.bash }), fail);
  };
  const prompt = useRef<HTMLTextAreaElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  // Phone: scrolling up through an idle transcript hides the prompt dock for reading space; scrolling down or the end brings it back (GH-166).
  // Never while a turn or shell runs (Stop), a panel waits for an answer, or the dock has focus (typing).
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => void (card.current = dock.current?.parentElement ?? null), []);
  const [dockFocused, setDockFocused] = useState(false);
  const agentCtx = useMemo(() => ({ links, onOpenSession }), [links, onOpenSession]);
  const dockHidden = useHideOnScroll(card, phone, turnRunning || shellRunning || !!permission || !!question || !!current || dockFocused);

  return (
    <MediaContext value={onMedia}>
    <ArtifactPreviewContext value={onArtifactPreview}>
    <ArtifactConnectedContext value={connected}>
    <CwdContext value={session.cwd}>
    <OpenRunContext value={onOpenRun}>
    <BackgroundShellContext value={onBackgroundShell && backgroundShellStable}>
    <AgentLinksContext value={agentCtx}>
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
          <span className="rounded bg-muted px-2 py-0.5 text-xs" data-testid="session-state">
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
          items={shownItems}
          itemKey={timelineKey}
          reveal={reveal}
          sticky={(item) => {
            if (item.kind !== "part" || item.part.type !== "user_text" || (coordinator && item.part.text.startsWith(ORCHESTRATION_NOTICE))) return;
            const { text } = splitUploads(summarizePasted(item.part.text));
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
                  <PendingMessage key={p.key} p={p} view={view} index={shownItems.length + i} />
                ))}
                {thinking}
              </>
            )
          }
          onReachTop={view.older && onLoadOlder ? (user) => onLoadOlder({ user }) : undefined}
          loadingOlder={loadingOlder}
          renderItem={(item, index) => {
            // A finished turn (not running; the next top-level item is a prompt, or it is the last) ends with Copy response, with or without a usage footer: a restored transcript has none.
            const next = shownItems[index + 1];
            const copyText = (next ? next.kind === "part" && (next.part.type === "user_text" || next.part.type === "bash") : !turnRunning && !view.externalTurn) ? turnText(shownItems, index) : "";
            const row = (
            item.kind === "fold" ? (
              <FoldRow id={item.id} calls={item.calls}>
                <Timeline view={view} items={item.items} />
              </FoldRow>
            ) : item.kind === "context" ? (
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
                    <CopyAction text={stripPasted(item.part.text)} />
                    <QuoteAction text={splitUploads(stripPasted(item.part.text)).text} />
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
                      // Images a snapshot or page left out load before the rewind (it drops the prompt from the daemon). One that fails to load
                      // stops the rewind with a notice in the panel: the image would be lost for good.
                      const images = mode === "code" ? [] : await restoreImages(prompt.images, prompt.id, onMedia);
                      setRewindRunning(true);
                      try {
                        await onRewind(prompt.id, mode);
                      } finally {
                        setRewindRunning(false);
                      }
                      setRewinding(undefined);
                      // Conversation modes: the original prompt goes back into the prompt box.
                      if (mode !== "code") setDraft({ text: prompt.text, images });
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
        {!current && (
          <QueueChips
            items={view.queue?.items ?? []}
            held={view.queue?.held}
            bashWait={
              view.externalTurn || view.working
                ? "Runs when the terminal CLI turn ends"
                : rewindRunning
                  ? "Runs when the rewind ends"
                  : shellRunning
                    ? "Runs when the running shell command ends"
                  : turnRunning || isClearing
                    ? "A shell command cannot steer a turn: it runs when the turn ends"
                    : undefined
            }
            onSendNow={(id) => chipAction(id, "send")}
            onEdit={(id) => chipAction(id, "edit")}
            onDelete={(id) => chipAction(id, "delete")}
            onEmpty={() => prompt.current?.focus()}
          />
        )}
        {(permission || question) && onAside && !aside && <AsideAsk onAside={onAside} insert={insert} onInserted={onInserted} />}
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
              draftKey={session.id}
              pasteTag={pasteTagId(session.id)}
              cwd={session.cwd}
              commands={view.commands}
              onDialog={onDialog}
              onAside={onAside}
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
              onQueue={onQueue}
              takeBack={takeBack}
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
              placeholder={phone ? (turnRunning ? "Claude is working…" : "Ask Claude…") : turnRunning ? (onQueue ? (sendModeSetting === "queue" ? "Claude is working… (Enter to queue, Alt+Enter to steer, Esc to stop)" : "Claude is working… (Enter to steer, Alt+Enter to queue, Esc to stop)") : "Claude is working… (Enter to steer, Esc to stop)") : "Ask Claude… (Enter to send, Shift+Enter for newline, paste or drop images)"}
            />
          </>
        )}
        <StatusBar view={view} git={onGitStatus} onShells={onShells} />
      </div>
    </AgentLinksContext>
    </BackgroundShellContext>
    </OpenRunContext>
    </CwdContext>
    </ArtifactConnectedContext>
    </ArtifactPreviewContext>
    </MediaContext>
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
  onQueue,
  takeBack,
  onBash,
  onSearch,
  insert,
  onInserted,
  draft,
  draftKey,
  pasteTag,
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
  onAside,
}: {
  /** Changing it clears the send error. */
  cwd?: string;
  commands: SlashCommand[];
  /** Given: the dialog commands (`/mcp`, `/skills`, `/plugins`, `/resume`) are in the picker and open their dialog instead of being sent. */
  onDialog?: (dialog: DialogName, arg?: string) => void;
  /** /btw typed in the prompt box (docs/spec.md "Aside"): opens the Aside; rejects with the reason it did not. */
  onAside?: (question: string) => Promise<unknown>;
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
  /** Given (session view): Alt+Enter and the send menu queue the message instead of steering; rejects when it was not queued. */
  onQueue?: (text: string, images: string[]) => Promise<unknown>;
  /** A queued message taken back: its text goes before the typed text, its images in front; `error` only shows. Handled once per `key`. */
  takeBack?: { key: string; text: string; images: string[]; bash?: boolean; error?: string };
  /** Given: `!` at the start of the box enters bash mode, Enter runs the command; rejects when it was not run. Not on the new-session tab. */
  onBash?: (command: string) => Promise<unknown>;
  onSearch: (query: string) => Promise<string[]>;
  insert?: string;
  onInserted?: () => void;
  /** Replaces the text and images (rewind puts the original prompt back). */
  draft?: { text: string; images: string[] };
  /** Keeps the unsent text across a reload (drafts.ts); a `draft` above wins. */
  draftKey?: string;
  /** Id of the pasted_content blocks sent from this box (4 hex of sha256(session id), like the CLI); none = random per send. */
  pasteTag?: string;
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
  // The stored draft holds each pasted text as a pasted_content block (GH-441); the box shows it as a token with a chip.
  const [initialText] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
  const [initialPaste] = useState(() => collapsePasted(initialText));
  const [text, setText] = useState(initialPaste.text);
  const [pastes, setPastes] = useState<Pastes>(initialPaste.pastes);
  const latest = useRef({ text, pastes });
  latest.current = { text, pastes };
  const [images, setImages] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [caret, setCaret] = useState(0);
  const [found, setFound] = useState<{ query: string; paths: string[] }>();
  const [sendError, setSendError] = useState<string>();
  // Bash mode: the text is a shell command, the box looks like OpenCode's shell mode.
  const [bash, setBash] = useState(false);
  const stored = useMemo(() => expandPastes(text, prunePastes(text, pastes), "0000"), [text, pastes]);
  const dropDraft = useDraft(draftKey, stored, bash, initialText);
  // Pastes stay while the box lives: a token that is cut, pasted back or undone must still find its text. Only a draft save and a send leave out the ones without a token; a send clears all.
  // The prompt box covers the dock's bottom 36px (OpenCode prompt lift), only when it directly follows the dock.
  const lift = !!todos && !blocked && !sendError && !images.length;
  const input = useRef<HTMLTextAreaElement>(null);
  // An input method is composing (Telex, Gboard...): its keys and its text are not ours to act on until compositionend.
  const composing = useRef(false);
  const token = dismissed || bash ? undefined : activeCommand(text, caret);
  // Dialog commands are actions, not text: only when the slash is the whole prompt.
  const matches = token && matchCommands((onDialog || onAside) && token.lead ? withDialogCommands(commands) : commands, text, caret);
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
  const restore = (given: string) => {
    // A prompt with pasted_content blocks comes back as tokens and chips, numbered after those already in the box.
    const back = collapsePasted(given, nextPasteId(latest.current.text, latest.current.pastes));
    const t = back.text;
    if (Object.keys(back.pastes).length) setPastes((p) => ({ ...p, ...back.pastes }));
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
    if (!takeBack) return;
    if (takeBack.error) return setSendError(takeBack.error);
    // Only an item that was really returned (text or images) goes back into the box.
    if (!takeBack.text && !takeBack.images.length) return;
    if (takeBack.bash) {
      // A bash item: an empty box becomes bash mode; typed prose never runs as a shell command.
      if (!text && !images.length) {
        setBash(true);
        restore(takeBack.text);
      } else restore(bash ? takeBack.text : `!${takeBack.text}`);
      input.current?.focus();
      return;
    }
    restore(takeBack.text);
    setImages((cur) => [...takeBack.images, ...cur]);
    input.current?.focus();
  }, [takeBack?.key]);
  useEffect(() => {
    if (!draft) return;
    const back = collapsePasted(draft.text);
    setPastes(back.pastes);
    edit(back.text);
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
  // While a turn runs and queueing is available, Enter and the send button follow the Sending setting and Alt+Enter does the other one.
  const sendMode = useSendMode();
  const running = state === "running" || state === "needs_input";
  const enterHow: "send" | "queue" = running && onQueue && sendMode === "queue" ? "queue" : "send";
  const altHow: "send" | "queue" = running && onQueue && sendMode === "queue" ? "send" : "queue";
  const send = (given = text, how: "send" | "queue" = enterHow) => {
    // Each pasted text goes as the CLI's pasted_content block at its token (GH-441); the bash and dialog paths never hold one.
    const t = bash ? given : expandPastes(given, pastes, pasteTag ?? pasteTagId());
    if (bash) {
      const command = t.trim();
      if (!command || (blocked && !onQueue)) return;
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
    // /btw works while the turn runs: before `blocked` and the queue. Images stay in the box (the Aside takes text only).
    // shortcut: /btw sends text only; pass images if asked.
    const aside = onAside && asideOf(t);
    if (aside !== undefined && onAside) {
      if (!aside) return setSendError("Type a question after /btw");
      setSendError(undefined);
      onAside(aside).catch((e: Error) => (restore(t), setSendError(`Aside not opened: ${e.message}`)));
      return setPastes({}), edit("");
    }
    const dialog = onDialog && dialogOf(t, commands);
    if (dialog && (!images.length || dialog === "resume")) {
      const arg = dialogArg(t);
      return arg ? onDialog(dialog, arg) : onDialog(dialog), setPastes({}), edit("");
    }
    if (how === "queue" && onQueue) {
      // The queue waits for the idle session, also behind a terminal CLI turn or a running /clear.
      const sent = images;
      setSendError(undefined);
      onQueue(t, sent).catch((e: Error) => {
        restore(t);
        setImages((cur) => [...sent, ...cur]);
        setSendError(`Not queued: ${e.message}`);
      });
      dropDraft();
      edit("");
      setPastes({});
      setImages([]);
      return;
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
    dropDraft();
    edit("");
    setPastes({});
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
    if (![...e.clipboardData.files].some((f) => f.type.startsWith("image/"))) {
      // Claude Code: a large text paste is one numbered chip, not text in the box. A shell command stays literal.
      const content = bash ? "" : normalizePaste(e.clipboardData.getData("text/plain") ?? "");
      if (!isLargePaste(content)) return;
      e.preventDefault();
      const id = nextPasteId(text, pastes);
      setPastes((p) => ({ ...p, [id]: content }));
      const el = e.currentTarget as HTMLTextAreaElement;
      const token = pasteToken(id, content);
      // One native edit keeps the textarea's undo stack; setRangeText is the fallback (jsdom, a browser that refuses).
      if (!(typeof document.execCommand === "function" && document.execCommand("insertText", false, token))) {
        el.setRangeText(token, el.selectionStart, el.selectionEnd, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
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
    if (onBash && !bash && !pasteRefs(text).length && e.key === "!" && !e.ctrlKey && !e.metaKey && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
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
    // Alt+Enter queues the message (while a turn runs: the mode Enter does not do), also with the picker open (the picker keeps plain Enter). Without a queue (new-session tab) it is Enter.
    if (e.key === "Enter" && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      return send(text, altHow);
    }
    // Backspace right after a pasted-text token, Delete right before it: the whole token goes.
    if (!bash && (e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const { selectionStart: a, selectionEnd: b } = e.currentTarget;
      const gone = (e.key === "Backspace" ? backspaceToken : deleteToken)(text, a, b);
      if (gone) {
        e.preventDefault();
        return edit(gone.text, gone.caret);
      }
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
    <PasteChips
      text={text}
      pastes={pastes}
      onRemove={(id) => {
        const r = pasteRefs(text).find((x) => x.id === id);
        if (r) edit(text.slice(0, r.index) + text.slice(r.index + r.match.length), r.index);
        input.current?.focus();
      }}
    />
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
        placeholder={bash ? (running || blocked ? "Queue a shell command: it runs when the current work ends" : "Run a shell command (Esc to exit)") : placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        value={text}
        ref={(el) => void ((input.current = el), inputRef && (inputRef.current = el))}
        onChange={(e) => {
          const v = e.target.value;
          // Soft keyboards send no key for "!": the box was empty-caret-at-0 before, and now starts with it.
          if (!composing.current && onBash && !bash && !pasteRefs(text).length && v.startsWith("!") && v.length === text.length + 1 && e.target.selectionStart === 1 && !text.startsWith("!")) {
            setBash(true);
            return edit(v.slice(1), 0);
          }
          // A soft keyboard deletes one character (no usable Backspace key): a token it cut into goes whole.
          const healed = bash || composing.current ? undefined : healDeletion(text, v, e.target.selectionStart);
          if (healed) return edit(healed.text, healed.caret);
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
        onQueue={onQueue && (() => send(text, "queue"))}
        sendMode={bash && running ? "queue" : sendMode}
        shell={bash}
        onStop={() => onInterrupt?.()}
        // Not on touch screens: focusing the prompt box there opens the soft keyboard (OpenCode leaves focus on the page).
        onFocusLost={() => !window.matchMedia?.("(pointer: coarse)").matches && input.current?.focus()}
      />
    </div>
    </div>
  );
}

/** Top-level parts, or with `parentId` the child parts of that subagent. */
function Timeline({ view, parentId, items = timeline(view, parentId) }: { view: SessionView; parentId?: string; items?: TimelineItem[] }) {
  return items.map((item) =>
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
          <CopyAction text={stripPasted(p.text)} />
          <QuoteAction text={splitUploads(stripPasted(p.text)).text} />
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
      // A pasted_content block (GH-441) is a collapsed block in place; attached files come from the typed text around it.
      const segments = splitPasted(part.text).map((seg) => (seg.kind === "text" ? { ...seg, ...splitUploads(seg.text) } : seg));
      const files = segments.flatMap((seg) => (seg.kind === "text" ? seg.files : []));
      const shown = segments.filter((seg) => seg.kind === "paste" || seg.text);
      return (
        <>
          {(shown.length > 0 || part.images.length > 0) && (
            <Message from="user">
              <MessageContent className="[overflow-wrap:anywhere]">
                <ImageStrip images={part.images} partId={part.id} />
                {shown.map((seg, i) => (seg.kind === "paste" ? <PastedBlock key={i} body={seg.body} id={pastedBlockId(part.text, i)} /> : <UserMarkdown key={i} text={seg.text} />))}
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
      return <ToolCard call={part} result={resultOf(view, part)} awaiting={awaitingPermission(view).has(part.toolUseId)} plan={planOfPart(view, part)} />;
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
        <MessageResponse mode={revealing ? "streaming" : "static"} isAnimating={revealing} {...FILE_LINK_PROPS}>
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
