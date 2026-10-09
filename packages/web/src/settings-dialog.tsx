// Settings dialog (docs/spec.md "Settings"): two panes on the ConfigDialog shell, a list of groups on the left and the settings of the
// selected group on the right (below md: the list first, a group drills in with a Back button). App-wide, daemon-side settings come from
// SECTIONS, per-browser choices (Notifications, Timeline, Changes, Sidebar, Tabs, Keyboard, Guide) never reach the daemon.
// A later setting is one more row in SECTIONS; a later group is one more entry in `groups`.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Settings, SettingsPatch, SettingsResult } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { isImeKey } from "./ime.ts";
import { Switch } from "./plugins-dialog.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DIFF_MODES, saveDiffMode, useDefaultDiffMode, type DiffMode } from "./diff-mode.ts";
import { loadSidebarView, saveSidebarView, VIEW_EVENT } from "./sessions.ts";
import { TAB_GROUPINGS, type TabGrouping } from "./tab-grouping.ts";
import { GuideSection } from "./guide-settings.tsx";
import { saveSignalOnly, useSignalOnly } from "./signal.ts";
import { IN_APP_EVENT, loadInApp, saveInApp } from "./notify.ts";
import { useKeymap } from "./keymap.ts";
import { keyText } from "./shortcuts.ts";
import { ChevronLeftIcon } from "lucide-react";

const GROUP_KEY = "claude-ui.settingsGroup";
const loadGroup = () => {
  try {
    return localStorage.getItem(GROUP_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
const saveGroup = (id: string) => {
  try {
    localStorage.setItem(GROUP_KEY, id);
  } catch {
    // Storage blocked: the group lasts while the page is open.
  }
};

type Group = { id: string; title: string; body: ReactNode };

/** The Signal only row (GH-205): one browser-wide preference, also toggled by the palette command and its shortcut. */
function TimelineSection() {
  const on = useSignalOnly();
  const keys = keyText(useKeymap()("signal.toggle"));
  return (
    <section aria-labelledby="settings-timeline" className="flex flex-col" data-testid="settings-timeline">
      <h3 id="settings-timeline" className="pb-1 font-medium text-[13px] text-muted-foreground">
        Timeline
      </h3>
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
    </section>
  );
}

type Row = { key: string; label: string; hint: string } & ({ kind: "switch" } | { kind: "number"; min: number; max: number } | { kind: "select"; options: { value: string; label: string }[] });
const SECTIONS: { id: keyof Settings; title: string; rows: Row[] }[] = [
  {
    id: "orchestration",
    title: "Orchestration",
    rows: [
      { key: "enabled", kind: "switch", label: "Enable orchestration", hint: "Every session (except workers) may start and supervise worker sessions. Applies at a session's next start." },
      { key: "workerCap", kind: "number", min: 1, max: 20, label: "Maximum workers", hint: "Worker sessions running at the same time (1 to 20)." },
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
      { key: "coordinatorPermissions", kind: "switch", label: "Coordinator may answer permission requests", hint: "Allows the coordinator to approve or deny, once, reads and file edits inside the worker folder, reads of the repository's main checkout and agent docs (.claude/skills, CLAUDE.md), and read-only git commands (status, log, diff, show). Other commands and everything else wait for you; no permission rule is saved. Edits can change code that commands you approve later will run." },
    ],
  },
  {
    id: "usageLimit",
    title: "Usage limits",
    rows: [
      { key: "autoContinue", kind: "switch", label: "Continue automatically after a usage limit resets", hint: "A session stopped by the plan usage limit gets the prompt “continue” once the limit resets; several sessions continue one after another. Sending a message yourself cancels it. A daemon restart drops scheduled continues." },
    ],
  },
];

/** This browser's Web Push switch (App owns the subscription: it needs the daemon connection). */
export type PushUi = { on: boolean; supported: boolean; busy: boolean; error?: string; toggle: () => void };

/** `changed`: bumped when another client changed the settings (reloads them). */
export function SettingsDialog({ open, changed = 0, request, onClose, tabGrouping, onTabGrouping, tabCompact = false, onTabCompact, onShortcuts, onRestartGuide, push }: { push?: PushUi; open: boolean; changed?: number; request: <T>(msg: Request) => Promise<T>; onClose: () => void; tabGrouping?: TabGrouping; onTabGrouping?: (g: TabGrouping) => void; tabCompact?: boolean; onTabCompact?: (on: boolean) => void; onShortcuts?: () => void; onRestartGuide?: () => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [daemon, setDaemon] = useState<SettingsResult["daemon"]>();
  const [saving, setSaving] = useState(false);
  // "Show only active sessions": the sidebar's own per-browser setting (its options menu writes it too).
  const [onlyActive, setOnlyActive] = useState(() => loadSidebarView().onlyActive);
  useEffect(() => {
    const sync = () => setOnlyActive(loadSidebarView().onlyActive);
    sync();
    window.addEventListener(VIEW_EVENT, sync);
    return () => window.removeEventListener(VIEW_EVENT, sync);
  }, [open]);
  // In-app notifications: per browser; the page (App) hears the choice through IN_APP_EVENT.
  const [inApp, setInApp] = useState(loadInApp);
  useEffect(() => {
    const sync = (e: Event) => setInApp((e as CustomEvent<boolean>).detail ?? loadInApp());
    window.addEventListener(IN_APP_EVENT, sync);
    return () => window.removeEventListener(IN_APP_EVENT, sync);
  }, []);
  // The number field's text while typing; committed on Enter or blur.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const diffMode = useDefaultDiffMode();
  const ask = useRef(request);
  ask.current = request;

  useEffect(() => {
    if (!open) return;
    let live = true;
    ask.current<SettingsResult>({ type: "settings.get" }).then(
      (r) => live && (setSettings(r.settings), setDaemon(r.daemon), setError(undefined), setDraft({})),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [open, changed]);

  const save = async (patch: SettingsPatch, field?: string) => {
    setSaving(true);
    try {
      const r = await ask.current<SettingsResult>({ type: "settings.set", patch });
      setSettings(r.settings);
      setDaemon(r.daemon);
      setError(undefined);
      if (field) setDraft(({ [field]: _, ...rest }) => rest);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const [pick, setPick] = useState(loadGroup);
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
      {sec.rows.map((row) => {
        const id = `settings-${sec.id}-${row.key}`;
        const value = (settings[sec.id] as Record<string, unknown>)[row.key];
        const patch = (v: unknown) => ({ [sec.id]: { [row.key]: v } }) as SettingsPatch;
        return (
          <div key={row.key} className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
            <div className="min-w-0 flex-1">
              <label htmlFor={id} className="block text-sm">{row.label}</label>
              <span id={`${id}-hint`} className="block text-muted-foreground text-xs">{row.hint}</span>
            </div>
            {row.kind === "switch" ? (
              <Switch on={value === true} label={row.label} held={saving} onToggle={(on) => void save(patch(on))} title={row.label} describedBy={`${id}-hint`} testId={id} />
            ) : row.kind === "select" ? (
              <Select value={String(value)} onValueChange={(v) => v && void save(patch(v))}>
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
                onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && e.currentTarget.blur()}
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
  // One entry per group; a later group (e.g. Notifications) is one more line here.
  const groups: Group[] = [
    { id: "timeline", title: "Timeline", body: <TimelineSection /> },
    {
      id: "notifications",
      title: "Notifications",
      body: (
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
      ),
    },
    {
      id: "changes",
      title: "Changes",
      body: (
    <section aria-labelledby="settings-changes" className="flex flex-col" data-testid="settings-changes">
      <h3 id="settings-changes" className="pb-1 font-medium text-[13px] text-muted-foreground">
        Changes
      </h3>
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
    </section>
      ),
    },
    {
      id: "sidebar",
      title: "Sidebar",
      body: (
    <section aria-labelledby="settings-sidebar" className="flex flex-col" data-testid="settings-sidebar">
      <h3 id="settings-sidebar" className="pb-1 font-medium text-[13px] text-muted-foreground">
        Sidebar
      </h3>
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-sidebar-active-label" className="block text-sm">Show only active sessions</span>
          <span id="settings-sidebar-active-hint" className="block text-muted-foreground text-xs">Lists sessions that are running or need input. Search still finds every session, and the one you have open stays listed. Kept in this browser.</span>
        </div>
        <Switch on={onlyActive} label="Show only active sessions" held={false} onToggle={(on) => saveSidebarView({ ...loadSidebarView(), onlyActive: on })} title="Show only active sessions" describedBy="settings-sidebar-active-hint" testId="settings-sidebar-active-only" />
      </div>
    </section>
      ),
    },
    ...(onTabGrouping
      ? [
          {
            id: "tabs",
            title: "Tabs",
            body: (
        <section aria-labelledby="settings-tabs" className="flex flex-col" data-testid="settings-tabs">
          <h3 id="settings-tabs" className="pb-1 font-medium text-[13px] text-muted-foreground">
            Tabs
          </h3>
          <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
            <div className="min-w-0 flex-1">
              <span id="settings-tabs-grouping-label" className="block text-sm">Tab grouping</span>
              <span id="settings-tabs-grouping-hint" className="block text-muted-foreground text-xs">How the tab bar groups open tabs. Kept in this browser.</span>
            </div>
            <Select value={tabGrouping ?? "project"} onValueChange={(v) => v && onTabGrouping(v as TabGrouping)}>
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
          {onTabCompact && (
            <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
              <div className="min-w-0 flex-1">
                <span id="settings-tabs-compact-label" className="block text-sm">Compact tabs</span>
                <span id="settings-tabs-compact-hint" className="block text-muted-foreground text-xs">
                  {tabGrouping === "none" ? "Needs a tab grouping" : "Show each group as one chip; open its tabs from the chip."}
                </span>
              </div>
              <Switch on={tabCompact && tabGrouping !== "none"} label="Compact tabs" held={tabGrouping === "none"} onToggle={onTabCompact} title="Compact tabs" describedBy="settings-tabs-compact-hint" testId="settings-tabs-compact" />
            </div>
          )}
        </section>
            ),
          },
        ]
      : []),
    ...(onShortcuts
      ? [
          {
            id: "keyboard",
            title: "Keyboard",
            body: (
        <section aria-labelledby="settings-keyboard" className="flex flex-col" data-testid="settings-keyboard">
          <h3 id="settings-keyboard" className="pb-1 font-medium text-[13px] text-muted-foreground">
            Keyboard
          </h3>
          <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
            <div className="min-w-0 flex-1">
              <span id="settings-keyboard-label" className="block text-sm">Keyboard shortcuts</span>
              <span id="settings-keyboard-hint" className="block text-muted-foreground text-xs">See every shortcut and rebind it. Kept in this browser.</span>
            </div>
            <button type="button" onClick={onShortcuts} aria-describedby="settings-keyboard-hint" className="h-8 rounded-md border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:h-11" data-testid="settings-shortcuts">
              Customize…
            </button>
          </div>
        </section>
            ),
          },
        ]
      : []),
    ...(onRestartGuide ? [{ id: "guide", title: "Guide", body: <GuideSection onRestart={onRestartGuide} /> }] : []),
    ...SECTIONS.map((sec) => ({ id: sec.id, title: sec.title, body: daemonSection(sec) })),
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
  const back = () => {
    setDrilled(false);
    setTimeout(() => tabRefs.current.get(selected.id)?.focus(), 0);
  };

  return (
    <ConfigDialog title="Settings" open={open} onClose={onClose} testId="settings-dialog">
      {error && <Banner kind="error">{error}</Banner>}
      <div className="flex min-h-0 gap-4 md:h-[380px] max-md:flex-1" data-testid="settings-layout">
        <div role="tablist" aria-label="Settings groups" aria-orientation="vertical" onKeyDown={onListKey} className={`flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto max-md:w-full ${drilled ? "max-md:hidden" : ""}`} data-testid="settings-groups">
          {groups.map((g) => (
            <button
              key={g.id}
              ref={(el) => void (el ? tabRefs.current.set(g.id, el) : tabRefs.current.delete(g.id))}
              type="button"
              role="tab"
              id={`settings-tab-${g.id}`}
              aria-selected={g.id === selected.id}
              aria-controls="settings-panel"
              tabIndex={g.id === selected.id ? 0 : -1}
              onClick={() => (choose(g.id), setDrilled(true))}
              className={`flex h-8 items-center rounded-md px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 ${g.id === selected.id ? "bg-accent text-foreground md:font-medium" : "text-muted-foreground hover:bg-accent/60"}`}
              data-testid={`settings-group-${g.id}`}
            >
              {g.title}
            </button>
          ))}
        </div>
        <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${selected.id}`} className={`flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto ${drilled ? "" : "max-md:hidden"}`} data-testid="settings-panel">
          <button type="button" onClick={back} className="flex h-11 items-center gap-1 self-start rounded-md pr-3 text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:hidden" data-testid="settings-back">
            <ChevronLeftIcon className="size-4" />
            Settings
          </button>
          {selected.body}
        </div>
      </div>
    </ConfigDialog>
  );
}
