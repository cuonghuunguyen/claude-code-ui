// The app's commands: palette rows and the shortcuts that run them. Only commands that apply right now are listed.
import type { Effort, ModelInfo, PermissionMode, SessionListItem } from "@claude-ui/protocol";
import type { PaletteItem } from "./palette.tsx";
import { HOME_LABEL, PANE_LABEL, type Area } from "./layout.ts";
import { matchesKey, shortcutById } from "./shortcuts.ts";
import { specOf } from "./keymap.ts";
import type { CleanupMenu, CleanupRule } from "./tab-cleanup.ts";
import { timeAgo } from "./sessions.ts";
import { projectName } from "./tabs.ts";
import { EFFORT_LABEL, MODE_LABEL, effortOptions } from "./toolbar.tsx";

export type CommandContext = {
  tabs: string[];
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
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  /** Closes the active tab's group (asks first for 2 or more tabs); none while the active tab is in no named group. */
  closeGroup?: () => void;
  /** Close other tabs / tabs to the right / all tabs (GH-359) relative to the active tab; none while nothing would close. */
  closeOthers?: () => void;
  closeRight?: () => void;
  closeAll?: () => void;
  /** Pins or unpins the active session tab (GH-359); none on the New session tab. */
  togglePin?: () => void;
  /** Clean up tabs (GH-378): counts per rule for the whole strip; absent: no cleanup commands. */
  tabCleanup?: CleanupMenu;
  cleanUpTabs?: (rule: CleanupRule) => void;
  /** The active tab is pinned: the command reads "Unpin tab". */
  pinned?: boolean;
  /** Split view (GH-356): each is absent while it does not apply (narrow screen, fewer than two sessions, no split). */
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
  /** Adds a terminal to the terminal panel (opens the panel first). */
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
  /** Where the Plan, Files and Git graph panes live, and the move to another home; absent: no move rows. Changes never moves. */
  homes?: Partial<Record<"plan" | "files" | "graph", Area>>;
  moveKind?: (p: "plan" | "files" | "graph", to: Area) => void;
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
  /** Opens the MCP servers dialog of the shown project; none without a project. */
  openMcp?: () => void;
  /** Opens the "Slash commands" dialog of the shown project; none without a project. */
  openSkills?: () => void;
  /** Opens the Manage Plugins dialog of the shown project; none without a project. */
  openPlugins?: () => void;
};

const RECENT_SESSIONS = 5;

const firstLine = (t: string) => t.trim().split("\n")[0]!.slice(0, 80) || "(image)";

export function appCommands(c: CommandContext): PaletteItem[] {
  const s = c.session;
  const at = c.activeId ? c.tabs.indexOf(c.activeId) : -1;
  const step = (d: number) => c.tabs[(at + d + c.tabs.length) % c.tabs.length]!;
  // The prompt box that had focus is hidden with its tab; focus goes to the shown tab's prompt.
  const go = (id: string) => (c.selectTab(id), c.focusPrompt(id));
  const efforts = s ? effortOptions(c.models, s.model) : [];
  // The shortcut's title and its current binding come from the registry (shortcuts.ts, keymap.ts).
  const cmd = (id: string, title: string, run: () => void, searchOnly?: boolean): PaletteItem => ({ id, group: "Commands", title, keys: specOf(id), run, searchOnly });
  const page = (id: string, title: string, placeholder: string, items: PaletteItem[], keys = specOf(id)): PaletteItem => ({ id, group: "Commands", title, keys, page: { placeholder, items } });
  const items: (PaletteItem | false | undefined)[] = [
    cmd("session.new", "New session", c.newSession),
    c.newWorktree && cmd("worktree.new", "New worktree…", c.newWorktree),
    c.cleanUp && cmd("cleanup.open", "Clean up worktrees and workers…", c.cleanUp),
    c.canQuickOpen && cmd("file.open", "Open file", c.quickOpen),
    c.tabs.length > 1 && cmd("tab.next", "Next tab", () => go(step(1))),
    c.tabs.length > 1 && cmd("tab.prev", "Previous tab", () => go(step(-1))),
    at >= 0 && cmd("tab.close", "Close tab", () => c.closeTab(c.activeId!)),
    c.closeGroup && cmd("tab.closeGroup", "Close tab group", c.closeGroup),
    c.closeOthers && cmd("tab.closeOthers", "Close other tabs", c.closeOthers),
    c.closeRight && cmd("tab.closeRight", "Close tabs to the right", c.closeRight),
    c.closeAll && cmd("tab.closeAll", "Close all tabs", c.closeAll),
    c.tabCleanup &&
      c.cleanUpTabs &&
      page(
        "tab.cleanup",
        "Clean up tabs…",
        "Close which tabs?",
        c.tabCleanup.items.map((i) => ({ id: `cleanup:${i.rule}`, group: c.tabCleanup!.kept.text || "Rules", title: i.label, meta: `${i.count} ${i.count === 1 ? "tab" : "tabs"}`, disabled: i.count === 0, run: () => c.cleanUpTabs!(i.rule) })),
      ),
    ...(c.tabCleanup && c.cleanUpTabs ? c.tabCleanup.items.map((i) => cmd(`tab.cleanup.${i.rule}`, i.label, () => c.cleanUpTabs!(i.rule), true)) : []),
    c.togglePin && cmd("tab.pin", c.pinned ? "Unpin tab" : "Pin tab", c.togglePin),
    c.splitRight && cmd("split.right", "Split right", c.splitRight),
    c.splitDown && cmd("split.down", "Split down", c.splitDown),
    c.splitNext && cmd("split.next", "Focus next split", c.splitNext),
    c.splitPrev && cmd("split.prev", "Focus previous split", c.splitPrev),
    c.joinSplits && cmd("split.join", "Join splits", c.joinSplits),
    c.canReopen && cmd("tab.reopen", "Reopen closed tab", c.reopenTab),
    // Tab N: only for tabs that exist; found by typing "go to tab".
    ...Array.from({ length: Math.min(8, c.tabs.length) }, (_, i) => cmd(`tab.goto${i + 1}`, `Go to tab ${i + 1}`, () => go(c.tabs[i]!), true)),
    c.tabs.length > 0 && cmd("tab.gotoLast", "Go to last tab", () => go(c.tabs.at(-1)!), true),
    cmd("shortcuts.open", "Keyboard shortcuts", c.openShortcuts),
    c.openFocus && cmd("focus.open", "Open Focus", c.openFocus),
    c.nextWaiting && cmd("focus.next", "Next waiting request", c.nextWaiting),
    c.focusNotifications && cmd("notifications.focus", "Go to notifications", c.focusNotifications),
    cmd("settings.open", "Open settings", c.openSettings),
    cmd("guide.start", "Show guide", c.startGuide),
    cmd("tips.reset", "Reset shortcut tips", c.resetKeyTips),
    cmd("sidebar.toggle", "Toggle sidebar", c.toggleSidebar),
    c.panels && cmd("panel.toggle", "Toggle side panel", c.toggleSidePanel),
    c.panels && cmd("filetree.toggle", "Toggle file tree", c.toggleFileTree),
    c.panels && cmd("pane.files", "Show files", () => c.showPane("files")),
    c.panels && cmd("pane.changes", "Show changes", () => c.showPane("changes")),
    c.panels && c.isGit && cmd("pane.graph", "Show git graph", () => c.showPane("graph")),
    s && !s.draft && c.viewChanges && cmd("viewer.changes", "View changes in popup", c.viewChanges),
    s && !s.draft && c.viewPlan && cmd("viewer.plan", "View plan", c.viewPlan),
    c.showPlan && cmd("plan.show", "Show plan", c.showPlan),
    ...(c.moveKind && c.homes ? (["plan", "files", "graph"] as const).flatMap((k) => (c.homes![k] && (k !== "graph" || c.isGit) ? (["main", "side", "bottom"] as const).filter((to) => to !== c.homes![k]).map((to) => cmd(`${k}.move.${to}`, `Move ${PANE_LABEL[k].toLowerCase()} to ${HOME_LABEL[to].toLowerCase()}`, () => c.moveKind!(k, to))) : [])) : []),
    c.panels && cmd("terminal.toggle", "Toggle terminal", c.toggleTerminal),
    cmd("signal.toggle", "Toggle signal only", c.toggleSignalOnly),
    c.toggleKeepAwake && cmd("awake.toggle", "Toggle keep screen awake", c.toggleKeepAwake),
    c.panels && cmd("terminal.new", "New terminal", c.newTerminal),
    cmd("layout.reset", "Reset layout", c.resetLayout),
    c.panels && cmd("panel.flip", c.side === "left" ? "Move side panel to right" : "Move side panel to left", c.flipSide),
    s && cmd("prompt.focus", "Focus prompt", () => c.focusPrompt()),
    s &&
      c.models.length > 0 &&
      page(
        "model.choose",
        "Change model",
        "Choose model",
        c.models.map((m) => ({ id: `model:${m.value}`, group: "Models", title: m.displayName, description: m.description, checked: m.value === s.model, run: () => c.setModel(m.value) })),
      ),
    s &&
      efforts.length > 0 &&
      page(
        "effort.choose",
        "Change thinking effort",
        "Choose thinking effort",
        efforts.map((e) => ({ id: `effort:${e}`, group: "Thinking effort", title: EFFORT_LABEL[e], checked: e === s.effort, run: () => c.setEffort(e) })),
      ),
    s &&
      s.modes.length > 0 &&
      page(
        "mode.choose",
        "Change permission mode",
        "Choose permission mode",
        s.modes.map((m) => ({ id: `mode:${m}`, group: "Permission mode", title: MODE_LABEL[m].label, checked: m === s.mode, run: () => c.setMode(m) })),
        // Shown only: Shift+Tab in the prompt box cycles the mode (SessionPane).
        "shift+tab",
      ),
    // The daemon rejects a rewind while a turn runs.
    s &&
      !s.running &&
      s.prompts.length > 0 &&
      page(
        "rewind",
        "Rewind",
        "Rewind to before which message?",
        [...s.prompts].reverse().map((p) => ({ id: `rewind:${p.id}`, group: "Messages, newest first", title: firstLine(p.text), run: () => c.rewind(p.id) })),
      ),
    s?.running && { ...cmd("session.stop", "Stop", c.stop), keys: "escape" },
    c.runInBackground && cmd("shell.background", "Run in background", c.runInBackground),
    // The extension's command menu section "Customize".
    c.openMcp && { id: "mcp.open", group: "Customize", keys: specOf("mcp.open"), title: "MCP servers", description: "Configure Model Context Protocol servers", run: c.openMcp },
    c.openSkills && { id: "skills.open", group: "Customize", keys: specOf("skills.open"), title: "Slash commands", description: "Browse slash commands", run: c.openSkills },
    c.openPlugins && { id: "plugins.open", group: "Customize", keys: specOf("plugins.open"), title: "Manage plugins", description: "Install, enable, or disable plugins", run: c.openPlugins },
    // Newest first; the recent ones also show before anything is typed (OpenCode lists recent items there, not all).
    ...[...c.sessions]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((x, i) => ({
        id: `session:${x.id}`,
        group: "Sessions",
        title: x.title || "Untitled",
        description: projectName(x.cwd),
        cwd: x.cwd,
        open: c.tabs.includes(x.id),
        // OpenCode's palette: "Just now", "2m ago".
        meta: ((t) => (t === "now" ? "Just now" : `${t} ago`))(timeAgo(x.lastActivity)),
        searchOnly: i >= RECENT_SESSIONS,
        run: () => go(x.id),
      })),
  ];
  return items.filter((i): i is PaletteItem => !!i);
}

/** The command a key press runs: a page command opens the palette on its page. Esc and Shift+Tab stay with their own handlers. */
export const shortcutFor = (items: PaletteItem[], e: KeyboardEvent) =>
  items.find((i) => i.keys && shortcutById(i.id) && matchesKey(i.keys, e));

