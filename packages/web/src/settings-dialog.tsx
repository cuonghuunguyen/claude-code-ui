// Settings dialog (docs/spec.md "Settings"): two panes on the ConfigDialog shell, a list of groups under category headings on the left
// and the sections of the selected group on the right (below md: the list first, a group drills in with a Back button). App-wide,
// daemon-side settings come from SECTIONS; per-browser choices (General, Layout, Keyboard, most of Notifications) never reach the daemon.
// A later setting is one more row in SECTIONS or a section component; a later section joins a group in `groups`, a later group is one
// more entry there.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LOCAL_SIDE, type DockerState, type Settings, type SettingsPatch, type SettingsResult, type SideInfo } from "@claude-ui/protocol";
import { sideStatus } from "./sides.tsx";
import type { Request } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { isImeKey } from "./ime.ts";
import { Switch } from "./plugins-dialog.tsx";
import { saveKeepAwake, useKeepAwakeSetting, wakeLockReason, wakeLockSupported } from "./keep-awake.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TERMINAL_DOCKS, saveTerminalDock, useTerminalDock, type Area } from "./layout.ts";
import { DIFF_MODES, saveDiffMode, useDefaultDiffMode, type DiffMode } from "./diff-mode.ts";
import { loadSidebarView, saveSidebarView, VIEW_EVENT } from "./sessions.ts";
import { AUTO_CLOSE, type AutoClose } from "./tab-cleanup.ts";
import { TAB_GROUPINGS, type TabGrouping } from "./tab-grouping.ts";
import { USAGE_RINGS, saveUsageRing, useUsageRing, type UsageRing } from "./usage-ring.ts";
import { GuideSection } from "./guide-settings.tsx";
import { AboutSection } from "./about-settings.tsx";
import { PerformanceSection } from "./perf-settings.tsx";
import { SEND_MODES, saveSendMode, useSendMode, type SendMode } from "./send-mode.ts";
import { saveSignalOnly, useSignalOnly } from "./signal.ts";
import { IN_APP_EVENT, loadInApp, saveInApp } from "./notify.ts";
import { useKeymap } from "./keymap.ts";
import { keyText } from "./shortcuts.ts";
import { KeyTipsRow } from "./key-tip.tsx";
import { ChevronLeftIcon } from "lucide-react";
import { ListSetting } from "./list-setting.tsx";
import { JiraSection } from "./jira-settings.tsx";
import { setColorTheme, useColorTheme, useDark } from "./theme.ts";
import { swatchOf, THEMES, type ThemeId } from "./themes.ts";

const GROUP_KEY = "claude-ui.settingsGroup";
/** Groups merged into larger ones: a remembered old id opens the group that holds its section now. */
const MOVED: Record<string, string> = { timeline: "general", sending: "general", screen: "general", changes: "layout", sidebar: "layout", tabs: "layout", terminal: "layout", guide: "about" };
const loadGroup = () => {
  try {
    const id = localStorage.getItem(GROUP_KEY) ?? undefined;
    return id && (MOVED[id] ?? id);
  } catch {
    return undefined;
  }
};
/** Settings opens at this group next time (also the Create worktree modal's "Open Settings › Jira"). */
export const saveGroup = (id: string) => {
  try {
    localStorage.setItem(GROUP_KEY, id);
  } catch {
    // Storage blocked: the group lasts while the page is open.
  }
};

type Category = "App" | "Sessions" | "Integrations" | "System";
type Group = { id: string; title: string; category: Category; body: ReactNode };

/** One titled block of rows inside a group's panel. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`settings-${id}`} className="flex flex-col" data-testid={`settings-${id}`}>
      <h3 id={`settings-${id}`} className="pb-1 font-medium text-[13px] text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}


/** The titlebar usage ring's window (per browser); a row of the Usage limits group. */
function UsageRingRow() {
  const ring = useUsageRing();
  return (
    <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11" data-testid="settings-usage-ring-row">
      <div className="min-w-0 flex-1">
        <span id="settings-usage-ring-label" className="block text-sm">Usage ring shows</span>
        <span id="settings-usage-ring-hint" className="block text-muted-foreground text-xs">The window the titlebar ring and percent show. The warning color and icon always follow the worst window. Kept in this browser.</span>
      </div>
      <Select value={ring} onValueChange={(v) => v && saveUsageRing(v as UsageRing)}>
        <SelectTrigger aria-labelledby="settings-usage-ring-label" aria-describedby="settings-usage-ring-hint" data-testid="settings-usage-ring" className="w-40 max-md:data-[size=default]:h-11">
          <SelectValue>{(v: UsageRing) => USAGE_RINGS.find((r) => r.value === v)?.label ?? v}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {USAGE_RINGS.map((r) => (
            <SelectItem key={r.value} value={r.value} data-testid={`settings-usage-ring-${r.value}`}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The Signal only row (GH-205): one browser-wide preference, also toggled by the palette command and its shortcut. */
function TimelineSection() {
  const on = useSignalOnly();
  const keys = keyText(useKeymap()("signal.toggle"));
  return (
    <Section id="timeline" title="Timeline">
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-timeline-signal-label" className="block text-sm">
            Signal only {keys && <kbd className="ml-1 rounded border px-1 font-mono text-[10px] text-muted-foreground" data-testid="settings-signal-keys">{keys}</kbd>}
          </span>
          <span id="settings-timeline-signal-hint" className="block text-muted-foreground text-xs">
            Folds each run of tool calls into one line, such as “4 tool calls · Read 3 · Grep 1”, in every session. Your prompts, Claude’s text, errors and requests waiting for you stay. Kept in this browser.
          </span>
        </div>
        <Switch on={on} label="Signal only" held={false} onToggle={saveSignalOnly} title={on ? "Show every tool call" : "Fold tool calls into one line"} describedBy="settings-timeline-signal-hint" testId="settings-signal-only" />
      </div>
    </Section>
  );
}

/** While Claude works, what Enter does: steer the turn or queue the message (per browser). */
function SendingSection() {
  const mode = useSendMode();
  return (
    <Section id="sending" title="Sending">
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-send-mode-label" className="block text-sm">While Claude works, Enter</span>
          <span id="settings-send-mode-hint" className="block text-muted-foreground text-xs">Steering adds your message to the running turn; a queued message waits and starts its own turn when Claude is idle. Alt+Enter does the other one. Kept in this browser.</span>
        </div>
        <Select value={mode} onValueChange={(v) => v && saveSendMode(v as SendMode)}>
          <SelectTrigger aria-labelledby="settings-send-mode-label" aria-describedby="settings-send-mode-hint" data-testid="settings-send-mode" className="w-44 max-md:data-[size=default]:h-11">
            <SelectValue>{(v: SendMode) => SEND_MODES.find((m) => m.value === v)?.label ?? v}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SEND_MODES.map((m) => (
              <SelectItem key={m.value} value={m.value} data-testid={`settings-send-mode-${m.value}`}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Section>
  );
}

/** Light half = the theme's light card, dark half = its dark card. */
function Swatch({ id }: { id: ThemeId }) {
  const [l, d] = swatchOf(id);
  return (
    <span className="inline-flex h-4 w-7 shrink-0 overflow-hidden rounded-[4px] ring-1 ring-border" aria-hidden data-testid="settings-theme-swatch">
      <span className="flex-1" style={{ background: l }} />
      <span className="flex-1" style={{ background: d }} />
    </span>
  );
}

/** The colour theme (per browser; the titlebar button still cycles light / dark / system inside it). */
function AppearanceSection() {
  const id = useColorTheme();
  const dark = useDark();
  return (
    <section aria-labelledby="settings-appearance-title" className="flex flex-col" data-testid="settings-appearance">
      <h3 id="settings-appearance-title" className="pb-1 font-medium text-[13px] text-muted-foreground">
        Appearance
      </h3>
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-theme-label" className="block text-sm">Theme</span>
          <span id="settings-theme-hint" className="block text-muted-foreground text-xs">Colors of the app, the editor, diffs and the terminal. Light, dark or system: the theme button in the titlebar. Kept in this browser.</span>
        </div>
        <Select value={id} onValueChange={(v) => v && setColorTheme(v as ThemeId)}>
          <SelectTrigger aria-labelledby="settings-theme-label" aria-describedby="settings-theme-hint" data-testid="settings-theme" className="w-44 max-md:data-[size=default]:h-11">
            <SelectValue>
              {(v: ThemeId) => (
                <>
                  <Swatch id={v} />
                  {THEMES.find((t) => t.id === v)?.name ?? v}
                </>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {THEMES.map((t) => (
              <SelectItem key={t.id} value={t.id} data-testid={`settings-theme-${t.id}`}>
                <Swatch id={t.id} />
                {t.name}
                {!t.light && t.dark && <span className="text-muted-foreground text-xs">dark only</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {id === "dracula" && !dark && (
        <div data-testid="settings-theme-dracula-warning" className="flex flex-col pb-2">
          <Banner kind="warning">Dracula has no light colors: light mode shows Default.</Banner>
        </div>
      )}
    </section>
  );
}

/** The Sides group (GH-458): per WSL distro and container, "Start with Claude UI" and "Update automatically" (daemon side.prefs). */
function SidesSection({ sides, request, onError }: { sides: SideInfo[]; request: <T>(msg: Request) => Promise<T>; onError: (m: string) => void }) {
  const rows = sides.filter((x) => x.id !== LOCAL_SIDE);
  const set = (side: string, patch: { start?: boolean; update?: boolean }) => void request({ type: "side.prefs", side, ...patch }).catch((e: Error) => onError(e.message));
  return (
    <section aria-labelledby="settings-sides" className="flex flex-col" data-testid="settings-sides">
      <h3 id="settings-sides" className="pb-1 font-medium text-[13px] text-muted-foreground">
        Sides
      </h3>
      {!rows.length && <p className="border-t py-2 text-muted-foreground text-sm">No WSL distro or container is listed. A running container shows up here.</p>}
      {rows.map((r) => (
        <div key={r.id} className="flex flex-col gap-1 border-t py-2" data-testid={`settings-side-${r.id}`}>
          <div className="flex items-center gap-3 max-md:min-h-11">
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm">{r.label}</span>
              <span className="block break-words text-muted-foreground text-xs">{r.state === "ready" ? "Running" : (sideStatus(r)?.text ?? "")}</span>
            </div>
          </div>
          <div className="flex items-center gap-3 max-md:min-h-11">
            <span className="min-w-0 flex-1 text-sm">Start with Claude UI</span>
            <Switch on={!!r.autoStart} label={`Start ${r.label} with Claude UI`} held={false} onToggle={(on) => set(r.id, { start: on })} title="Start with Claude UI" testId={`settings-side-start-${r.id}`} />
          </div>
          <div className="flex items-center gap-3 max-md:min-h-11">
            <span className="min-w-0 flex-1 text-sm">Update automatically</span>
            <Switch on={r.autoUpdate !== false} label={`Update ${r.label} automatically`} held={!r.autoStart} onToggle={(on) => set(r.id, { update: on })} title={r.autoStart ? "Update automatically" : "Needs Start with Claude UI"} testId={`settings-side-update-${r.id}`} />
          </div>
        </div>
      ))}
      <p className="pt-1 text-muted-foreground text-xs">Start with Claude UI takes effect at the next start of Claude UI. Off also removes the projects of the side from the sidebar. Update automatically installs a new Claude UI build from the bundle only; npm is never run inside a side.</p>
    </section>
  );
}

/** The Keep screen awake rows (GH-361): this browser only; the titlebar button and the palette command change the same setting. */
function ScreenSection() {
  const s = useKeepAwakeSetting();
  const supported = wakeLockSupported();
  return (
    <Section id="screen" title="Screen">
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span className="block text-sm">Keep screen awake</span>
          <span id="settings-awake-hint" className="block text-muted-foreground text-xs">
            {supported
              ? "Keeps this device's screen on while this page is visible. The browser lets it sleep when you switch away and it turns back on when you return. Kept in this browser."
              : `Not available here: ${wakeLockReason()}. The choice is kept and applies when this browser opens the app over HTTPS or localhost.`}
          </span>
        </div>
        <Switch on={s.on} label="Keep screen awake" held={!supported} onToggle={(on) => saveKeepAwake({ ...s, on })} title="Keep screen awake" describedBy="settings-awake-hint" testId="settings-keep-awake" />
      </div>
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span className="block text-sm">Only while a session is running</span>
          <span id="settings-awake-running-hint" className="block text-muted-foreground text-xs">
            Holds the screen on only while a session is running or waits for you.
          </span>
        </div>
        <Switch on={s.onlyRunning} label="Only while a session is running" held={!s.on || !supported} onToggle={(onlyRunning) => saveKeepAwake({ ...s, onlyRunning })} title="Only while a session is running" describedBy="settings-awake-running-hint" testId="settings-keep-awake-running" />
      </div>
    </Section>
  );
}

/** In-app (per browser; the page hears it through IN_APP_EVENT), Push (this browser's subscription) and Desktop (daemon-side) rows. */
function NotificationsSection({ push, settings, daemon, saving, save }: { push?: PushUi; settings?: Settings; daemon?: SettingsResult["daemon"]; saving: boolean; save: (patch: SettingsPatch) => Promise<void> }) {
  const [inApp, setInApp] = useState(loadInApp);
  useEffect(() => {
    const sync = (e: Event) => setInApp((e as CustomEvent<boolean>).detail ?? loadInApp());
    window.addEventListener(IN_APP_EVENT, sync);
    return () => window.removeEventListener(IN_APP_EVENT, sync);
  }, []);
  return (
    <section aria-labelledby="settings-notifications-title" className="flex flex-col" data-testid="settings-notifications">
      <h3 id="settings-notifications-title" className="pb-1 font-medium text-[13px] text-muted-foreground">
        Notifications
      </h3>
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span className="block text-sm">In-app notifications</span>
          <span id="settings-in-app-hint" className="block text-muted-foreground text-xs">
            A notice in this page when a session you are not looking at needs input or finishes. Read-only requests can be allowed or denied from the notice. Kept in this browser.
          </span>
        </div>
        <Switch on={inApp} label="In-app notifications" held={false} onToggle={(on) => (setInApp(on), saveInApp(on))} title="In-app notifications" describedBy="settings-in-app-hint" testId="settings-in-app" />
      </div>
      {push && (
        <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
          <div className="min-w-0 flex-1">
            <span className="block text-sm">Push notifications</span>
            <span id="settings-push-hint" className="block text-muted-foreground text-xs">
              {push.supported
                ? "This browser notifies you when a session needs input or finishes, also with the page closed. Not sent while this page is in front and shows in-app notifications. Kept in this browser."
                : "Not available in this browser here: Web Push needs HTTPS or localhost. The daemon's desktop notifications are used instead."}
            </span>
            {push.error && (
              <span role="alert" className="mt-1 block text-destructive text-xs">
                {push.error}
              </span>
            )}
          </div>
          <Switch on={push.on} label="Push notifications" held={!push.supported || push.busy} onToggle={push.toggle} title="Push notifications" describedBy="settings-push-hint" testId="settings-push" />
        </div>
      )}
      {/* An older daemon sends no `notifications`: no row. */}
      {settings?.notifications && (
        <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
          <div className="min-w-0 flex-1">
            <span className="block text-sm">{daemon?.host ? `Desktop notifications on ${daemon.host}` : "Desktop notifications on the daemon's computer"}</span>
            <span id="settings-notifications-desktop-hint" className="block text-muted-foreground text-xs">
              {daemon?.desktopForcedOff
                ? "Turned off when the daemon started (--no-os-notify or CLAUDE_UI_OS_NOTIFY=0)."
                : "The daemon's computer shows a system notification when no browser has push notifications on. For every browser of this daemon."}
            </span>
          </div>
          <Switch
            on={settings.notifications.desktop && !daemon?.desktopForcedOff}
            label="Desktop notifications"
            held={saving || !!daemon?.desktopForcedOff}
            onToggle={(on) => void save({ notifications: { desktop: on } })}
            title="Desktop notifications"
            describedBy="settings-notifications-desktop-hint"
            testId="settings-notifications-desktop"
          />
        </div>
      )}
    </section>
  );
}

/** The sidebar's own per-browser view (its options menu writes the same object). */
function SidebarSection() {
  const [view, setView] = useState(loadSidebarView);
  useEffect(() => {
    const sync = () => setView(loadSidebarView());
    window.addEventListener(VIEW_EVENT, sync);
    return () => window.removeEventListener(VIEW_EVENT, sync);
  }, []);
  return (
    <Section id="sidebar" title="Sidebar">
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-sidebar-active-label" className="block text-sm">Show only active sessions</span>
          <span id="settings-sidebar-active-hint" className="block text-muted-foreground text-xs">Lists sessions that are running or need input. Search still finds every session, and the one you have open stays listed. Kept in this browser.</span>
        </div>
        <Switch on={view.onlyActive} label="Show only active sessions" held={false} onToggle={(on) => saveSidebarView({ ...loadSidebarView(), onlyActive: on })} title="Show only active sessions" describedBy="settings-sidebar-active-hint" testId="settings-sidebar-active-only" />
      </div>
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-sidebar-layout-label" className="block text-sm">Group by</span>
          <span id="settings-sidebar-layout-hint" className="block text-muted-foreground text-xs">Worktree groups a project's sessions by worktree. Project lists them directly under the project, with each session's state as text. Kept in this browser.</span>
        </div>
        <Select value={view.layout} onValueChange={(v) => v && saveSidebarView({ ...loadSidebarView(), layout: v as "default" | "classic" })}>
          <SelectTrigger aria-labelledby="settings-sidebar-layout-label" aria-describedby="settings-sidebar-layout-hint" data-testid="settings-sidebar-layout" className="w-40 max-md:data-[size=default]:h-11">
            <SelectValue>{(v: string) => (v === "classic" ? "Project" : "Worktree")}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default" data-testid="settings-sidebar-layout-default">Worktree</SelectItem>
            <SelectItem value="classic" data-testid="settings-sidebar-layout-classic">Project</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </Section>
  );
}

/** Tab bar choices; App owns them (per browser) and passes the values in. */
function TabsSection({ grouping, onGrouping, compact, onCompact, autoClose, onAutoClose }: { grouping: TabGrouping; onGrouping: (g: TabGrouping) => void; compact: boolean; onCompact?: (on: boolean) => void; autoClose: AutoClose; onAutoClose?: (v: AutoClose) => void }) {
  return (
    <Section id="tabs" title="Tabs">
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-tabs-grouping-label" className="block text-sm">Tab grouping</span>
          <span id="settings-tabs-grouping-hint" className="block text-muted-foreground text-xs">How the tab bar groups open tabs. Kept in this browser.</span>
        </div>
        <Select value={grouping} onValueChange={(v) => v && onGrouping(v as TabGrouping)}>
          <SelectTrigger aria-labelledby="settings-tabs-grouping-label" aria-describedby="settings-tabs-grouping-hint" data-testid="settings-tabs-grouping" className="w-36 max-md:data-[size=default]:h-11">
            <SelectValue>{(v: TabGrouping) => TAB_GROUPINGS.find((g) => g.value === v)?.label ?? v}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TAB_GROUPINGS.map((g) => (
              <SelectItem key={g.value} value={g.value} data-testid={`settings-tabs-grouping-${g.value}`}>
                {g.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {onCompact && (
        <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
          <div className="min-w-0 flex-1">
            <span id="settings-tabs-compact-label" className="block text-sm">Compact tabs</span>
            <span id="settings-tabs-compact-hint" className="block text-muted-foreground text-xs">
              {grouping === "none" ? "Needs a tab grouping" : "Show each group as one chip; open its tabs from the chip."}
            </span>
          </div>
          <Switch on={compact && grouping !== "none"} label="Compact tabs" held={grouping === "none"} onToggle={onCompact} title="Compact tabs" describedBy="settings-tabs-compact-hint" testId="settings-tabs-compact" />
        </div>
      )}
      {onAutoClose && (
        <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
          <div className="min-w-0 flex-1">
            <span id="settings-tabs-autoclose-label" className="block text-sm">Auto-close idle tabs after</span>
            <span id="settings-tabs-autoclose-hint" className="block text-muted-foreground text-xs">
              Closes idle tabs not used for this long. Never pinned, running, unread or with a draft. Sessions keep running. Kept in this browser.
            </span>
          </div>
          <Select value={autoClose} onValueChange={(v) => v && onAutoClose(v as AutoClose)}>
            <SelectTrigger aria-labelledby="settings-tabs-autoclose-label" aria-describedby="settings-tabs-autoclose-hint" data-testid="settings-tabs-autoclose" className="w-36 max-md:data-[size=default]:h-11">
              <SelectValue>{(v: AutoClose) => AUTO_CLOSE.find((a) => a.value === v)?.label ?? v}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {AUTO_CLOSE.map((a) => (
                <SelectItem key={a.value} value={a.value} data-testid={`settings-tabs-autoclose-${a.value}`}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </Section>
  );
}

/** The mode a session's Changes panel opens in (per browser). */
function ChangesSection() {
  const diffMode = useDefaultDiffMode();
  return (
    <Section id="changes" title="Changes">
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-changes-mode-label" className="block text-sm">Default diff view</span>
          <span id="settings-changes-mode-hint" className="block text-muted-foreground text-xs">The mode the Changes panel opens in. A choice in a session's panel lasts for that session until the page reloads. Kept in this browser.</span>
        </div>
        <Select value={diffMode} onValueChange={(v) => v && saveDiffMode(v as DiffMode)}>
          <SelectTrigger aria-labelledby="settings-changes-mode-label" aria-describedby="settings-changes-mode-hint" data-testid="settings-diff-mode" className="w-40 max-md:data-[size=default]:h-11">
            <SelectValue>{(v: DiffMode) => DIFF_MODES.find((m) => m.value === v)?.label ?? v}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {DIFF_MODES.map((m) => (
              <SelectItem key={m.value} value={m.value} data-testid={`settings-diff-mode-${m.value}`}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Section>
  );
}

/** Where the terminal docks (per browser); App passes `onPosition` to move a live terminal with its shells. */
function TerminalSection({ onPosition }: { onPosition?: (a: Area) => void }) {
  const terminalDock = useTerminalDock();
  return (
    <Section id="terminal" title="Terminal">
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-terminal-position-label" className="block text-sm">Terminal position</span>
          <span id="settings-terminal-position-hint" className="block text-muted-foreground text-xs">Where the terminal opens on wide screens: a tab of the bottom panel, under the session and side panel, a tab of the side panel, or a tab of the main area next to the session. Narrow screens show it as the terminal pane; with Main area, as the session's Terminal tab. Kept in this browser.</span>
        </div>
        <Select value={terminalDock} onValueChange={(v) => v && (onPosition ?? saveTerminalDock)(v as Area)}>
          <SelectTrigger aria-labelledby="settings-terminal-position-label" aria-describedby="settings-terminal-position-hint" data-testid="settings-terminal-position" className="w-40 max-md:data-[size=default]:h-11">
            <SelectValue>{(v: Area) => TERMINAL_DOCKS.find((d) => d.value === v)?.label ?? v}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TERMINAL_DOCKS.map((d) => (
              <SelectItem key={d.value} value={d.value} data-testid={`settings-terminal-position-${d.value}`}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Section>
  );
}

/** Opens the Keyboard shortcuts dialog; the shortcut tips switch below it. */
function KeyboardSection({ onShortcuts }: { onShortcuts: () => void }) {
  return (
    <Section id="keyboard" title="Keyboard">
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-keyboard-label" className="block text-sm">Keyboard shortcuts</span>
          <span id="settings-keyboard-hint" className="block text-muted-foreground text-xs">See every shortcut and rebind it. Kept in this browser.</span>
        </div>
        <button type="button" onClick={onShortcuts} aria-describedby="settings-keyboard-hint" className="h-8 rounded-md border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:h-11" data-testid="settings-shortcuts">
          Customize…
        </button>
      </div>
      <KeyTipsRow />
    </Section>
  );
}

type Row = { key: string; label: string; hint: string } & ({ kind: "switch" } | { kind: "number"; min: number; max: number } | { kind: "list" } | { kind: "select"; options: { value: string; label: string }[]; parse?: (v: string) => unknown });
const SECTIONS: { id: keyof Settings; title: string; rows: Row[] }[] = [
  {
    id: "orchestration",
    title: "Orchestration",
    rows: [
      { key: "enabled", kind: "switch", label: "Enable orchestration", hint: "Every session may start and supervise worker sessions, workers too (up to Maximum tree depth). Applies at a session's next start." },
      { key: "workerCap", kind: "number", min: 1, max: 20, label: "Maximum workers per tree", hint: "Workers one root coordinator's tree may run at the same time, at every depth (1 to 20). Each coordinator you start counts its own tree." },
      { key: "workerCapTotal", kind: "number", min: 0, max: 100, label: "Maximum workers in total", hint: "Workers this daemon may run at the same time across every tree (0 = no limit, up to 100)." },
      { key: "maxDepth", kind: "number", min: 1, max: 5, label: "Maximum tree depth", hint: "How deep workers may start workers of their own: 1 = only you start workers; 2 = a worker may start its own (e.g. a tester and a reviewer)." },
      { key: "maxChildren", kind: "number", min: 1, max: 20, label: "Maximum workers per coordinator", hint: "Workers one session (you or a worker) may run at the same time. Maximum workers per tree still counts its whole tree." },
      {
        key: "workerMode",
        kind: "select",
        label: "Worker mode",
        hint: "Permission mode of a new worker when the coordinator does not name one. Coordinator's mode: the coordinator's own (bypass gives auto). A mode above the coordinator's still asks you on the worker_start card.",
        options: [
          { value: "coordinator", label: "Coordinator's mode" },
          { value: "default", label: "Default" },
          { value: "acceptEdits", label: "Accept edits" },
          { value: "plan", label: "Plan" },
          { value: "auto", label: "Auto" },
        ],
      },
      { key: "workerNotifications", kind: "switch", label: "Notifications from workers", hint: "Push, desktop and in-app notifications when a worker finishes, needs input or stops with an error. Off: only its coordinator hears about it; a request the coordinator escalates to you still notifies." },
      { key: "coordinatorPermissions", kind: "switch", label: "Coordinator may answer permission requests", hint: "Allows the coordinator to approve or deny, once, reads and file edits inside the worker folder, reads of the repository's main checkout and agent docs (.claude/skills, CLAUDE.md), and read-only git commands (status, log, diff, show). Other commands and everything else wait for you; no permission rule is saved. Edits can change code that commands you approve later will run." },
    ],
  },
  {
    id: "focus",
    title: "Focus",
    rows: [
      { key: "nextForYou", kind: "switch", label: "Next for you", hint: "After a turn, Claude predicts your next prompt; finished rows on Focus show it as a chip. The chip appears a few seconds after the turn and is often absent: none on a session’s first turn, in plan mode, near the usage limit or with a cold prompt cache. Uses a small extra request per turn that reuses the prompt cache: nearly free, not free. Applies to sessions started or resumed after the change; turning it off removes the chips shown." },
    ],
  },
  {
    id: "usageLimit",
    title: "Usage limits",
    rows: [
      { key: "autoContinue", kind: "switch", label: "Continue automatically after a usage limit resets", hint: "A session stopped by the plan usage limit gets the prompt “continue” once the limit resets; several sessions continue one after another. Sending a message yourself cancels it. A daemon restart drops scheduled continues." },
    ],
  },
  {
    id: "performance",
    title: "Performance",
    rows: [
      { key: "monitor", kind: "switch", label: "Performance monitor", hint: "Measures responsiveness on this computer. Durations and counts only; nothing leaves this computer. Off stops all measuring." },
    ],
  },
  {
    id: "git",
    title: "Git",
    rows: [
      { key: "autoRepositoryDetection", kind: "select", label: "Auto repository detection", hint: "Configures when repositories should be automatically detected. true: Scan for both subfolders of the current opened folder and parent folders of open files. subFolders: Scan for subfolders of the currently opened folder. openEditors: Scan for parent folders of open files. false: Disable automatic repository scanning.", options: ["true", "false", "subFolders", "openEditors"].map((v) => ({ value: v, label: v })), parse: (v) => (v === "true" ? true : v === "false" ? false : v) },
      { key: "repositoryScanMaxDepth", kind: "number", min: -1, max: 10, label: "Repository scan max depth", hint: "Controls the depth used when scanning workspace folders for Git repositories when Auto repository detection is set to true or subFolders. Can be set to -1 for no limit." },
      { key: "repositoryScanIgnoredFolders", kind: "list", label: "Repository scan ignored folders", hint: "List of folders that are ignored while scanning for Git repositories when Auto repository detection is set to true or subFolders." },
      { key: "scanRepositories", kind: "list", label: "Scan repositories", hint: "List of paths to search for Git repositories in. Relative to the project folder." },
      { key: "ignoredRepositories", kind: "list", label: "Ignored repositories", hint: "List of Git repositories to ignore." },
      { key: "detectSubmodules", kind: "switch", label: "Detect submodules", hint: "Controls whether to automatically detect Git submodules." },
      { key: "detectSubmodulesLimit", kind: "number", min: 0, max: 100, label: "Detect submodules limit", hint: "Controls the limit of Git submodules detected." },
      { key: "ignoreSubmodules", kind: "switch", label: "Ignore submodules", hint: "Ignore modifications to submodules in the file tree." },
      { key: "openRepositoryInParentFolders", kind: "select", label: "Open repository in parent folders", hint: "Control whether a repository in parent folders of workspaces or open files should be opened. Default always (VS Code: prompt); prompt behaves as always here until a prompt exists.", options: ["always", "never", "prompt"].map((v) => ({ value: v, label: v })) },
    ],
  },
];

/** This browser's Web Push switch (App owns the subscription: it needs the daemon connection). */
export type PushUi = { on: boolean; supported: boolean; busy: boolean; error?: string; toggle: () => void };

/** `changed`: bumped when another client changed the settings (reloads them). */
export function SettingsDialog({ open, changed = 0, request, onClose, tabGrouping, onTabGrouping, onTerminalPosition, tabCompact = false, onTabCompact, tabAutoClose = "off", onTabAutoClose, onShortcuts, onRestartGuide, push, sides, docker }: { sides?: SideInfo[]; docker?: DockerState; tabAutoClose?: AutoClose; onTabAutoClose?: (v: AutoClose) => void; push?: PushUi; open: boolean; changed?: number; request: <T>(msg: Request) => Promise<T>; onClose: () => void; tabGrouping?: TabGrouping; onTerminalPosition?: (a: Area) => void; onTabGrouping?: (g: TabGrouping) => void; tabCompact?: boolean; onTabCompact?: (on: boolean) => void; onShortcuts?: () => void; onRestartGuide?: () => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [daemon, setDaemon] = useState<SettingsResult["daemon"]>();
  const [saving, setSaving] = useState(false);
  const [jiraToken, setJiraToken] = useState(false);
  const [jiraTokenReset, setJiraTokenReset] = useState(false);
  // The number field's text while typing; committed on Enter or blur.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const ask = useRef(request);
  ask.current = request;

  useEffect(() => {
    // A refetch (the own save's settings_changed included) keeps the drafts: a field still being edited is not overwritten.
    if (!open) return void setDraft({});
    let live = true;
    ask.current<SettingsResult>({ type: "settings.get" }).then(
      (r) => live && (setSettings(r.settings), setDaemon(r.daemon), setJiraToken(!!r.jiraToken), setJiraTokenReset(!!r.jiraTokenReset), setError(undefined)),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [open, changed]);

  const save = async (patch: SettingsPatch, field?: string, rethrow = false) => {
    setSaving(true);
    try {
      const r = await ask.current<SettingsResult>({ type: "settings.set", patch });
      setSettings(r.settings);
      setDaemon(r.daemon);
      setJiraToken(!!r.jiraToken);
      setJiraTokenReset(!!r.jiraTokenReset);
      setError(undefined);
      if (field) setDraft(({ [field]: _, ...rest }) => rest);
    } catch (e) {
      setError((e as Error).message);
      if (rethrow) throw e;
    } finally {
      setSaving(false);
    }
  };

  const [pick, setPick] = useState(loadGroup);
  // Every way of opening Settings shows the stored group (one set while it was closed included).
  useEffect(() => void (open && setPick(loadGroup())), [open]);
  // Below md: false shows the list of groups, true the settings of the selected group.
  const [drilled, setDrilled] = useState(false);
  useEffect(() => void (open && setDrilled(false)), [open]);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const daemonSection = (sec: (typeof SECTIONS)[number]) => (
    <>
      {!settings && !error && <p className="text-muted-foreground text-sm">Loading…</p>}
      {settings && (
    <section key={sec.id} aria-labelledby={`settings-${sec.id}`} className="flex flex-col" data-testid={`settings-${sec.id}`}>
      <h3 id={`settings-${sec.id}`} className="pb-1 font-medium text-[13px] text-muted-foreground">
        {sec.title}
      </h3>
      {sec.id === "git" && (
        <p className="pb-1 text-muted-foreground text-xs" data-testid="settings-git-intro">
          Same settings as VS Code's Git extension; they apply to every project.
        </p>
      )}
      {sec.rows.map((row) => {
        const id = `settings-${sec.id}-${row.key}`;
        const value = (settings[sec.id] as Record<string, unknown>)[row.key];
        const patch = (v: unknown) => ({ [sec.id]: { [row.key]: v } }) as SettingsPatch;
        if (row.kind === "list") return <ListSetting key={row.key} id={id} label={row.label} hint={row.hint} value={value as string[]} saving={saving} onSave={(next) => save(patch(next), undefined, true)} />;
        return (
          <div key={row.key} className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
            <div className="min-w-0 flex-1">
              <label htmlFor={id} className="block text-sm">{row.label}</label>
              <span id={`${id}-hint`} className="block text-muted-foreground text-xs">{row.hint}</span>
            </div>
            {row.kind === "switch" ? (
              <Switch on={value === true} label={row.label} held={saving} onToggle={(on) => void save(patch(on))} title={row.label} describedBy={`${id}-hint`} testId={id} />
            ) : row.kind === "select" ? (
              <Select value={String(value)} onValueChange={(v) => v && void save(patch(row.parse ? row.parse(v) : v))}>
                <SelectTrigger id={id} aria-describedby={`${id}-hint`} aria-label={row.label} data-testid={id} className="w-44 max-md:data-[size=default]:h-11">
                  <SelectValue>{(v: string) => row.options.find((o) => o.value === v)?.label ?? v}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {row.options.map((o) => (
                    <SelectItem key={o.value} value={o.value} data-testid={`${id}-${o.value}`}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <input
                id={id}
                aria-describedby={`${id}-hint`}
                type="number"
                inputMode="numeric"
                min={row.min}
                max={row.max}
                step={1}
                value={draft[id] ?? String(value)}
                onChange={(e) => setDraft((d) => ({ ...d, [id]: e.target.value }))}
                onBlur={() => id in draft && void save(patch(draft[id] === "" ? NaN : Number(draft[id])), id)}
                onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && (e.preventDefault(), e.currentTarget.blur())} // preventDefault: on a phone the focus falls to Back and this Enter would click it
                className="h-8 w-16 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
                data-testid={id}
              />
            )}
          </div>
        );
      })}
    </section>
      )}
    </>
  );
  const daemonGroup = (id: keyof Settings) => {
    const sec = SECTIONS.find((x) => x.id === id)!;
    // A section the daemon does not know (an older daemon lacks `performance`) is left out.
    return settings && !settings[id] ? undefined : sec;
  };
  const orchestration = daemonGroup("orchestration");
  const usageLimit = daemonGroup("usageLimit");
  const performance = daemonGroup("performance");
  const focus = daemonGroup("focus");
  const git = daemonGroup("git");
  // One entry per group, in list order; `category` puts it under a heading. A group holds one or more sections.
  const groups: Group[] = [
    { id: "appearance", title: "Appearance", category: "App", body: <AppearanceSection /> },
    {
      id: "general",
      title: "General",
      category: "App",
      body: (
        <>
          <TimelineSection />
          <SendingSection />
          <ScreenSection />
        </>
      ),
    },
    {
      id: "layout",
      title: "Layout",
      category: "App",
      body: (
        <>
          <SidebarSection />
          {onTabGrouping && <TabsSection grouping={tabGrouping ?? "project"} onGrouping={onTabGrouping} compact={tabCompact} onCompact={onTabCompact} autoClose={tabAutoClose} onAutoClose={onTabAutoClose} />}
          <ChangesSection />
          <TerminalSection onPosition={onTerminalPosition} />
        </>
      ),
    },
    { id: "notifications", title: "Notifications", category: "App", body: <NotificationsSection push={push} settings={settings} daemon={daemon} saving={saving} save={save} /> },
    ...(onShortcuts ? [{ id: "keyboard", title: "Keyboard", category: "App" as const, body: <KeyboardSection onShortcuts={onShortcuts} /> }] : []),
    ...(orchestration ? [{ id: "orchestration", title: orchestration.title, category: "Sessions" as const, body: daemonSection(orchestration) }] : []),
    ...(focus ? [{ id: "focus", title: focus.title, category: "Sessions" as const, body: daemonSection(focus) }] : []),
    ...(usageLimit
      ? [
          {
            id: "usageLimit",
            title: usageLimit.title,
            category: "Sessions" as const,
            body: (
              <>
                {daemonSection(usageLimit)}
                <UsageRingRow />
              </>
            ),
          },
        ]
      : []),
    ...(git ? [{ id: "git", title: git.title, category: "Integrations" as const, body: daemonSection(git) }] : []),
    // GH-447: an older daemon has no `jira` settings: no group.
    ...(settings?.jira
      ? [{ id: "jira", title: "Jira", category: "Integrations" as const, body: <JiraSection jira={settings.jira} tokenSet={jiraToken} tokenReset={jiraTokenReset} saving={saving} save={save} request={request} onResult={(r) => (setSettings(r.settings), setJiraToken(!!r.jiraToken), setJiraTokenReset(!!r.jiraTokenReset), setError(undefined))} onError={setError} /> }]
      : []),
    ...(sides?.some((x) => x.id !== LOCAL_SIDE) || docker ? [{ id: "sides", title: "Sides", category: "System" as const, body: <SidesSection sides={sides ?? []} request={request} onError={setError} /> }] : []),
    ...(performance
      ? [
          {
            id: "performance",
            title: performance.title,
            category: "System" as const,
            body: (
              <>
                {daemonSection(performance)}
                <PerformanceSection request={request} />
              </>
            ),
          },
        ]
      : []),
    {
      id: "about",
      title: onRestartGuide ? "Help & about" : "About",
      category: "System",
      body: (
        <>
          {onRestartGuide && <GuideSection onRestart={onRestartGuide} />}
          <AboutSection daemonVersion={daemon?.version} />
        </>
      ),
    },
  ];
  const selected = groups.find((g) => g.id === pick) ?? groups[0]!;
  const choose = (id: string, focus = false) => {
    setPick(id);
    saveGroup(id);
    if (focus) tabRefs.current.get(id)?.focus();
  };
  const onListKey = (e: KeyboardEvent) => {
    const at = groups.findIndex((g) => g.id === selected.id);
    const to = e.key === "ArrowDown" ? (at + 1) % groups.length : e.key === "ArrowUp" ? (at - 1 + groups.length) % groups.length : e.key === "Home" ? 0 : e.key === "End" ? groups.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    choose(groups[to]!.id, true);
  };
  // Back from a drilled-in group: the focus returns to its entry in the list.
  const backRef = useRef<HTMLButtonElement>(null);
  // Drilling in below md hides the list, so the tapped group loses its focus (it fell to the dialog): the Back button takes it.
  // On desktop the Back button is not shown, focus() does nothing and the group keeps the focus.
  const drillIn = (id: string) => {
    choose(id);
    setDrilled(true);
    setTimeout(() => backRef.current?.focus(), 0);
  };
  const back = () => {
    setDrilled(false);
    setTimeout(() => tabRefs.current.get(selected.id)?.focus(), 0);
  };

  return (
    <ConfigDialog title="Settings" open={open} onClose={onClose} testId="settings-dialog">
      {error && <Banner kind="error">{error}</Banner>}
      <div className="flex min-h-0 gap-4 md:h-[480px] max-md:flex-1" data-testid="settings-layout">
        <div role="tablist" aria-label="Settings groups" aria-orientation="vertical" onKeyDown={onListKey} className={`flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto max-md:w-full ${drilled ? "max-md:hidden" : ""}`} data-testid="settings-groups">
          {groups.map((g, i) => [
            // A category heading is a visual divider only: the tablist holds tabs, and every tab name stands on its own.
            g.category !== groups[i - 1]?.category && (
              <div key={`cat-${g.category}`} aria-hidden="true" className={`px-3 pb-0.5 font-medium text-[11px] text-muted-foreground/70 uppercase tracking-wide max-md:pb-1 ${i ? "pt-2 max-md:pt-3" : ""}`} data-testid={`settings-category-${g.category.toLowerCase()}`}>
                {g.category}
              </div>
            ),
            <button
              key={g.id}
              ref={(el) => void (el ? tabRefs.current.set(g.id, el) : tabRefs.current.delete(g.id))}
              type="button"
              role="tab"
              id={`settings-tab-${g.id}`}
              aria-selected={g.id === selected.id}
              aria-controls="settings-panel"
              tabIndex={g.id === selected.id ? 0 : -1}
              onClick={() => drillIn(g.id)}
              className={`flex h-7 shrink-0 items-center rounded-md px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 ${g.id === selected.id ? "bg-accent text-foreground md:font-medium" : "text-muted-foreground hover:bg-accent/60"}`}
              data-testid={`settings-group-${g.id}`}
            >
              {g.title}
            </button>,
          ])}
        </div>
        <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${selected.id}`} className={`flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto pr-3 pl-0.5 ${drilled ? "" : "max-md:hidden"}`} data-testid="settings-panel">
          <button ref={backRef} type="button" onClick={back} className="flex h-11 items-center gap-1 self-start rounded-md pr-3 text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:hidden" data-testid="settings-back">
            <ChevronLeftIcon className="size-4" />
            Settings
          </button>
          {selected.body}
        </div>
      </div>
    </ConfigDialog>
  );
}
