// One mapping of the daemon's settings to the app's derived settings, for both settings.get (connect, reconnect) and settings_changed.
import { DEFAULT_ENGINE, type ClaudeAccountInfo, type Engine, type PermissionMode, type Settings, type SettingsResult } from "@claude-ui/protocol";
import { setApp } from "./app-icon.ts";
import { setBack } from "./back-marks.ts";
import { setLabels } from "./labels.ts";
import { customEditor, type EditorInfo } from "./open-external-menu.ts";

export type SettingsChangedMessage = { settings: Settings; claudeAccounts?: ClaudeAccountInfo[] };

export type SettingsView = {
  lastEngine: Engine;
  sessionsMode?: PermissionMode;
  workerNotices: boolean;
  ignoreSubmodules: boolean;
  chromeOn?: boolean;
  visualizeOn: boolean;
  /** Settings › Performance monitor: the app reports its first-send marks (perf.client) only while on. */
  perfMonitor: boolean;
  claudeAccount: string;
  claudeAccounts: ClaudeAccountInfo[];
  /** Settings › Notifications › desktop. */
  desktop: boolean;
  // Daemon facts: only settings.get carries them; settings_changed keeps the previous value.
  desktopForcedOff: boolean;
  claudeEnvToken: boolean;
  /** undefined: the daemon reports no keep-awake (side, older daemon). */
  keepAwakeSupported?: boolean;
  computerAwake?: { on: boolean; supported: boolean };
  /** The editors the daemon found, without its "custom" entry; undefined: none listed. */
  detectedEditors?: EditorInfo[];
  /** detectedEditors plus the custom editor of the settings. */
  appEditors?: EditorInfo[];
};

type Facts = Pick<SettingsView, "desktopForcedOff" | "claudeEnvToken" | "keepAwakeSupported" | "detectedEditors">;
const NO_FACTS: Facts = { desktopForcedOff: false, claudeEnvToken: false };

function project(s: Settings, accounts: ClaudeAccountInfo[] | undefined, f: Facts): SettingsView {
  return {
    lastEngine: s.sessions?.engine ?? DEFAULT_ENGINE,
    sessionsMode: s.sessions?.defaultMode,
    workerNotices: s.orchestration.workerNotifications !== false,
    ignoreSubmodules: s.git?.ignoreSubmodules === true,
    chromeOn: s.chrome?.enabled,
    visualizeOn: s.chat?.visualize === true,
    perfMonitor: s.performance?.monitor === true,
    claudeAccount: s.claude?.account ?? "",
    claudeAccounts: accounts ?? [],
    desktop: s.notifications?.desktop === true,
    desktopForcedOff: f.desktopForcedOff,
    claudeEnvToken: f.claudeEnvToken,
    keepAwakeSupported: f.keepAwakeSupported,
    detectedEditors: f.detectedEditors,
    computerAwake: s.power && f.keepAwakeSupported !== undefined ? { on: s.power.keepAwake, supported: f.keepAwakeSupported } : undefined,
    appEditors: f.detectedEditors && [...f.detectedEditors, ...customEditor(s.editor)],
  };
}

export function fromSettingsGet(r: SettingsResult): SettingsView {
  const d = r.daemon;
  return project(r.settings, r.claudeAccounts, {
    desktopForcedOff: !!d?.desktopForcedOff,
    claudeEnvToken: !!d?.claudeEnvToken,
    keepAwakeSupported: d?.keepAwake?.supported,
    detectedEditors: d?.editors?.filter((e) => e.id !== "custom"),
  });
}

export function applySettingsChanged(prev: SettingsView | undefined, m: SettingsChangedMessage): SettingsView {
  return project(m.settings, m.claudeAccounts, prev ?? NO_FACTS);
}

/** Module stores: labels, back marks (settings.get is `first`: no reminder card, a reconnect must not replay them), app name and icon. */
export function publishSettings(s: Settings, source: "get" | "changed") {
  setLabels(s.labels);
  setBack(s.back, source === "get");
  setApp(s.app);
}
