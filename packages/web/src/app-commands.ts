// The app's commands: palette rows and the shortcuts that run them. Only commands that apply right now are listed.
import type { Effort, ModelInfo, PermissionMode, SessionListItem } from "@claude-ui/protocol";
import type { PaletteItem } from "./palette.tsx";
import { type Area, type DockArea } from "./layout.ts";
import { matchesKey, shortcutById } from "./shortcuts.ts";
import { specOf } from "./keymap.ts";
import type { CleanupMenu, CleanupRule } from "./tab-cleanup.ts";
import { timeAgo } from "./sessions.ts";
import { t } from "./i18n.ts";
import { projectName } from "./tabs.ts";
import { EFFORT_LABEL, MODE_LABEL, effortOptions } from "./toolbar.tsx";

export type CommandContext = {
  tabs: string[];
  /** Every open session tab, docked ones included (`tabs` is the strip: next/previous/goto). */
  openIds: string[];
  activeId?: string;
  sessions: SessionListItem[];
  /** The shown session's settings; undefined on the new-session tab or with no tab. */
  session?: {
    model: string;
    effort: Effort;
    mode: PermissionMode;
    modes: PermissionMode[];
    running: boolean;
    /** User prompts, oldest first: the rewind targets. */
    prompts: { id: string; text: string }[];
    /** The new-session tab's draft: no session to view changes or a plan of yet. */
    draft?: boolean;
  };
  /** The side and bottom panel show for the current tab: a session, or the new-session tab on wide screens (GH-430). */
  panels: boolean;
  models: ModelInfo[];
  canQuickOpen: boolean;
  newSession: () => void;
  /** Opens the New worktree name dialog for the shown project's repository; none outside git. */
  newWorktree?: () => void;
  /** Opens the Clean up dialog for all projects; none while there is no linked worktree or worker. */
  cleanUp?: () => void;
  /** Moves the shown session's running foreground Bash calls to the background (GH-440); none while there is none. */
  runInBackground?: () => void;
  /** Opens the shells list of the shown session (GH-442). */
  openShells?: () => void;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  /** Closes the active tab's group (asks first for 2 or more tabs); none while the active tab is in no named group. */
  closeGroup?: () => void;
  /** Close other tabs / tabs to the right / all tabs (GH-359) relative to the active tab; none while nothing would close. */
  closeOthers?: () => void;
  closeRight?: () => void;
  closeAll?: () => void;
  /** Shows the current session in the side or bottom panel (GH-401); absent on narrow screens and without a session. */
  dockSession?: (area: DockArea) => void;
  /** Pins or unpins the active session tab (GH-359); none on the New session tab. */
  togglePin?: () => void;
  /** Clean up tabs (GH-378): counts per rule for the whole strip; absent: no cleanup commands. */
  tabCleanup?: CleanupMenu;
  cleanUpTabs?: (rule: CleanupRule) => void;
  /** The active tab is pinned: the command reads "Unpin tab". */
  pinned?: boolean;
  /** Split view (GH-356): each is absent while it does not apply (narrow screen, fewer than two sessions, no split). */
  /** A session split is on screen while a pane split is active: Focus prompt is offered (GH-398). */
  splitPrompt?: boolean;
  splitRight?: () => void;
  splitDown?: () => void;
  splitNext?: () => void;
  splitPrev?: () => void;
  joinSplits?: () => void;
  quickOpen: () => void;
  toggleSidebar: () => void;
  toggleSidePanel: () => void;
  toggleFileTree: () => void;
  toggleTerminal: () => void;
  /** Shows the side panel pane (files, changes, git graph); where it already shows, focus goes back to the prompt. */
  showPane: (pane: "files" | "changes" | "graph") => void;
  /** Adds a terminal to the terminal panel (opens the panel or the terminal tab first). */
  newTerminal: () => void;
  resetLayout: () => void;
  /** Moves the side panel to the other side of the session view. */
  flipSide: () => void;
  side: "left" | "right";
  /** Reopens the tab closed last that still exists; false when there is none. */
  reopenTab: () => void;
  canReopen: boolean;
  /** Opens the Keyboard shortcuts dialog. */
  openShortcuts: () => void;
  /** Opens the shown session's changes in the popup viewer; none without a session. */
  viewChanges?: () => void;
  /** Opens the newest plan of the shown session in the popup viewer; none while it has no plan. */
  viewPlan?: () => void;
  /** GH-395: reveals the current session's plan (its tab in the main area, or the dock Plan pane). Absent without a plan. */
  showPlan?: () => void;
  /** GH-176: reveals the current session's Artifacts pane. Absent while it has no artifacts. */
  showArtifacts?: () => void;
  /** GH-399: the file the Files editor shows becomes a main-area tab. Absent unless a Files editor shows a file inside the owner's folder. */
  openFileTab?: () => void;
  /** Where the Plan, Files and Git graph panes live, and the move to another home; absent: no move rows. Changes never moves. */
  homes?: Partial<Record<"plan" | "files" | "graph" | "terminal" | "artifacts", Area>>;
  moveKind?: (p: "plan" | "files" | "graph" | "terminal" | "artifacts", to: Area) => void;
  /** Git graph needs a repository. */
  isGit?: boolean;
  /** `id`: the tab just selected; default the shown one. */
  focusPrompt: (id?: string) => void;
  setModel: (model: string) => void;
  setEffort: (effort: Effort) => void;
  setMode: (mode: PermissionMode) => void;
  rewind: (userMessageId: string) => void;
  stop: () => void;
  /** Opens the Focus page (GH-159). */
  openFocus?: () => void;
  /** Opens Focus on the next waiting request; none while nothing waits. */
  nextWaiting?: () => void;
  /** Moves focus to the newest in-app notification card; none while no card shows (GH-158). */
  focusNotifications?: () => void;
  /** Toggles Signal only, the browser-wide setting (GH-205). */
  toggleSignalOnly: () => void;
  /** Set only where the Screen Wake Lock API works (HTTPS or localhost). */
  toggleKeepAwake?: () => void;
  /** Opens the Settings dialog. */
  openSettings: () => void;
  /** Restarts the guided tour from its first step. */
  startGuide: () => void;
  /** Clears the key promoter's counters and turns tips on (GH-234). */
  resetKeyTips: () => void;
  /** Ask aside (docs/spec.md "Aside"): puts `/btw ` in the shown session's prompt box; none without a session tab. */
  askAside?: () => void;
  /** Opens the MCP servers dialog of the shown project; none without a project. */
  openMcp?: () => void;
  /** Opens the "Slash commands" dialog of the shown project; none without a project. */
  openSkills?: () => void;
  /** Opens the Manage Plugins dialog of the shown project; none without a project. */
  openPlugins?: () => void;
};

const RECENT_SESSIONS = 5;

const firstLine = (text: string) => text.trim().split("\n")[0]!.slice(0, 80) || t("app.cmd.image");

export function appCommands(c: CommandContext): PaletteItem[] {
  const s = c.session;
  const at = c.activeId ? c.tabs.indexOf(c.activeId) : -1;
  const step = (d: number) => c.tabs[(at + d + c.tabs.length) % c.tabs.length]!;
  // The prompt box that had focus is hidden with its tab; focus goes to the shown tab's prompt.
  const go = (id: string) => (c.selectTab(id), c.focusPrompt(id));
  const efforts = s ? effortOptions(c.models, s.model) : [];
  // The shortcut's title and its current binding come from the registry (shortcuts.ts, keymap.ts).
  const cmd = (id: string, title: string, run: () => void, searchOnly?: boolean): PaletteItem => ({ id, group: t("app.palette.groupCommands"), title, keys: specOf(id), run, searchOnly });
  const page = (id: string, title: string, placeholder: string, items: PaletteItem[], keys = specOf(id)): PaletteItem => ({ id, group: t("app.palette.groupCommands"), title, keys, page: { placeholder, items } });
  const items: (PaletteItem | false | undefined)[] = [
    cmd("session.new", t("app.cmd.sessionNew"), c.newSession),
    c.newWorktree && cmd("worktree.new", t("app.cmd.worktreeNew"), c.newWorktree),
    c.cleanUp && cmd("cleanup.open", t("app.cmd.cleanupOpen"), c.cleanUp),
    c.canQuickOpen && cmd("file.open", t("app.cmd.fileOpen"), c.quickOpen),
    c.tabs.length > 1 && cmd("tab.next", t("app.cmd.tabNext"), () => go(step(1))),
    c.tabs.length > 1 && cmd("tab.prev", t("app.cmd.tabPrev"), () => go(step(-1))),
    at >= 0 && cmd("tab.close", t("app.cmd.tabClose"), () => c.closeTab(c.activeId!)),
    c.closeGroup && cmd("tab.closeGroup", t("app.cmd.tabCloseGroup"), c.closeGroup),
    c.closeOthers && cmd("tab.closeOthers", t("app.cmd.tabCloseOthers"), c.closeOthers),
    c.closeRight && cmd("tab.closeRight", t("app.cmd.tabCloseRight"), c.closeRight),
    c.closeAll && cmd("tab.closeAll", t("app.cmd.tabCloseAll"), c.closeAll),
    c.tabCleanup &&
      c.cleanUpTabs &&
      page(
        "tab.cleanup",
        t("app.cmd.tabCleanup"),
        t("app.cmd.closeWhich"),
        c.tabCleanup.items.map((i) => ({ id: `cleanup:${i.rule}`, group: c.tabCleanup!.kept.text || t("app.cmd.rules"), title: i.label, meta: t("app.cmd.tabCount", { count: i.count }), disabled: i.count === 0, run: () => c.cleanUpTabs!(i.rule) })),
      ),
    ...(c.tabCleanup && c.cleanUpTabs ? c.tabCleanup.items.map((i) => cmd(`tab.cleanup.${i.rule}`, i.label, () => c.cleanUpTabs!(i.rule), true)) : []),
    c.togglePin && cmd("tab.pin", t(c.pinned ? "app.cmd.unpin" : "app.cmd.pin"), c.togglePin),
    c.dockSession && cmd("session.dock.side", t("app.cmd.sessionDockSide"), () => c.dockSession!("side")),
    c.dockSession && cmd("session.dock.bottom", t("app.cmd.sessionDockBottom"), () => c.dockSession!("bottom")),
    c.splitRight && cmd("split.right", t("app.cmd.splitRight"), c.splitRight),
    c.splitDown && cmd("split.down", t("app.cmd.splitDown"), c.splitDown),
    c.splitNext && cmd("split.next", t("app.cmd.splitNext"), c.splitNext),
    c.splitPrev && cmd("split.prev", t("app.cmd.splitPrev"), c.splitPrev),
    c.joinSplits && cmd("split.join", t("app.cmd.splitJoin"), c.joinSplits),
    c.canReopen && cmd("tab.reopen", t("app.cmd.tabReopen"), c.reopenTab),
    // Tab N: only for tabs that exist; found by typing "go to tab".
    ...Array.from({ length: Math.min(8, c.tabs.length) }, (_, i) => cmd(`tab.goto${i + 1}`, t("app.cmd.gotoTab", { n: i + 1 }), () => go(c.tabs[i]!), true)),
    c.tabs.length > 0 && cmd("tab.gotoLast", t("app.cmd.tabGotoLast"), () => go(c.tabs.at(-1)!), true),
    cmd("shortcuts.open", t("app.cmd.shortcutsOpen"), c.openShortcuts),
    c.openFocus && cmd("focus.open", t("app.cmd.focusOpen"), c.openFocus),
    c.nextWaiting && cmd("focus.next", t("app.cmd.focusNext"), c.nextWaiting),
    c.focusNotifications && cmd("notifications.focus", t("app.cmd.notificationsFocus"), c.focusNotifications),
    cmd("settings.open", t("app.cmd.settingsOpen"), c.openSettings),
    cmd("guide.start", t("app.cmd.guideStart"), c.startGuide),
    cmd("tips.reset", t("app.cmd.tipsReset"), c.resetKeyTips),
    cmd("sidebar.toggle", t("app.cmd.sidebarToggle"), c.toggleSidebar),
    c.panels && cmd("panel.toggle", t("app.cmd.panelToggle"), c.toggleSidePanel),
    c.panels && cmd("filetree.toggle", t("app.cmd.filetreeToggle"), c.toggleFileTree),
    c.panels && cmd("pane.files", t("app.cmd.paneFiles"), () => c.showPane("files")),
    c.panels && cmd("pane.changes", t("app.cmd.paneChanges"), () => c.showPane("changes")),
    c.panels && c.isGit && cmd("pane.graph", t("app.cmd.paneGraph"), () => c.showPane("graph")),
    s && !s.draft && c.viewChanges && cmd("viewer.changes", t("app.cmd.viewerChanges"), c.viewChanges),
    s && !s.draft && c.viewPlan && cmd("viewer.plan", t("app.cmd.viewerPlan"), c.viewPlan),
    c.showPlan && cmd("plan.show", t("app.cmd.planShow"), c.showPlan),
    c.showArtifacts && cmd("artifacts.show", t("app.cmd.artifactsShow"), c.showArtifacts),
    c.openFileTab && cmd("file.openInTab", t("app.cmd.fileOpenInTab"), c.openFileTab),
    ...(c.moveKind && c.homes ? (["plan", "files", "graph", "terminal", "artifacts"] as const).flatMap((k) => (c.homes![k] && (k !== "graph" || c.isGit) ? (["main", "side", "bottom"] as const).filter((to) => to !== c.homes![k]).map((to) => cmd(`${k}.move.${to}`, t("app.cmd.move", { pane: t(`app.cmd.pane.${k}`), home: t(`app.cmd.home.${to}`) }), () => c.moveKind!(k, to))) : [])) : []),
    c.panels && cmd("terminal.toggle", t("app.cmd.terminalToggle"), c.toggleTerminal),
    cmd("signal.toggle", t("app.cmd.signalToggle"), c.toggleSignalOnly),
    c.toggleKeepAwake && cmd("awake.toggle", t("app.cmd.awakeToggle"), c.toggleKeepAwake),
    c.panels && cmd("terminal.new", t("app.cmd.terminalNew"), c.newTerminal),
    cmd("layout.reset", t("app.cmd.layoutReset"), c.resetLayout),
    c.panels && cmd("panel.flip", t(c.side === "left" ? "app.cmd.flipRight" : "app.cmd.flipLeft"), c.flipSide),
    (s || c.splitPrompt) && cmd("prompt.focus", t("app.cmd.promptFocus"), () => c.focusPrompt()),
    c.askAside && cmd("aside.ask", t("app.cmd.asideAsk"), c.askAside),
    s &&
      c.models.length > 0 &&
      page(
        "model.choose",
        t("app.cmd.changeModel"),
        t("app.cmd.chooseModel"),
        c.models.map((m) => ({ id: `model:${m.value}`, group: t("app.cmd.groupModels"), title: m.displayName, description: m.description, checked: m.value === s.model, run: () => c.setModel(m.value) })),
      ),
    s &&
      efforts.length > 0 &&
      page(
        "effort.choose",
        t("app.cmd.changeEffort"),
        t("app.cmd.chooseEffort"),
        efforts.map((e) => ({ id: `effort:${e}`, group: t("app.cmd.groupEffort"), title: t(EFFORT_LABEL[e]), checked: e === s.effort, run: () => c.setEffort(e) })),
      ),
    s &&
      s.modes.length > 0 &&
      page(
        "mode.choose",
        t("app.cmd.changeMode"),
        t("app.cmd.chooseMode"),
        s.modes.map((m) => ({ id: `mode:${m}`, group: t("app.cmd.groupMode"), title: t(MODE_LABEL[m].label), checked: m === s.mode, run: () => c.setMode(m) })),
        // Shown only: Shift+Tab in the prompt box cycles the mode (SessionPane).
        "shift+tab",
      ),
    // The daemon rejects a rewind while a turn runs.
    s &&
      !s.running &&
      s.prompts.length > 0 &&
      page(
        "rewind",
        t("app.cmd.rewind"),
        t("app.cmd.rewindWhich"),
        [...s.prompts].reverse().map((p) => ({ id: `rewind:${p.id}`, group: t("app.cmd.groupNewest"), title: firstLine(p.text), run: () => c.rewind(p.id) })),
      ),
    s?.running && { ...cmd("session.stop", t("app.cmd.sessionStop"), c.stop), keys: "escape" },
    c.runInBackground && cmd("shell.background", t("app.cmd.shellBackground"), c.runInBackground),
    c.openShells && { id: "shells.open", group: t("app.cmd.groupSession"), keys: specOf("shells.open"), title: t("app.cmd.shells"), description: t("app.cmd.shellsDesc"), run: c.openShells },
    // The extension's command menu section "Customize".
    c.openMcp && { id: "mcp.open", group: t("app.cmd.groupCustomize"), keys: specOf("mcp.open"), title: t("app.cmd.mcp"), description: t("app.cmd.mcpDesc"), run: c.openMcp },
    c.openSkills && { id: "skills.open", group: t("app.cmd.groupCustomize"), keys: specOf("skills.open"), title: t("app.cmd.skills"), description: t("app.cmd.skillsDesc"), run: c.openSkills },
    c.openPlugins && { id: "plugins.open", group: t("app.cmd.groupCustomize"), keys: specOf("plugins.open"), title: t("app.cmd.plugins"), description: t("app.cmd.pluginsDesc"), run: c.openPlugins },
    // Newest first; the recent ones also show before anything is typed (OpenCode lists recent items there, not all).
    ...[...c.sessions]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((x, i) => ({
        id: `session:${x.id}`,
        group: t("app.palette.groupSessions"),
        title: x.title || t("app.palette.untitled"),
        description: projectName(x.cwd),
        cwd: x.cwd,
        open: c.openIds.includes(x.id),
        // OpenCode's palette: "Just now", "2m ago".
        meta: ((ago) => (ago === "now" ? t("app.cmd.justNow") : t("app.cmd.ago", { time: ago })))(timeAgo(x.lastActivity)),
        searchOnly: i >= RECENT_SESSIONS,
        run: () => go(x.id),
      })),
  ];
  return items.filter((i): i is PaletteItem => !!i);
}

/** The command a key press runs: a page command opens the palette on its page. Esc and Shift+Tab stay with their own handlers. */
export const shortcutFor = (items: PaletteItem[], e: KeyboardEvent) =>
  items.find((i) => i.keys && shortcutById(i.id) && matchesKey(i.keys, e));

