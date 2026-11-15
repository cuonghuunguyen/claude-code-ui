import { describe, expect, it } from "vitest";
import type { Settings, SettingsResult } from "@claude-ui/protocol";
import { applySettingsChanged, fromSettingsGet } from "./settings-projection.ts";

const base = {
  orchestration: { workerNotifications: true },
  sessions: { defaultMode: "default", engine: "claude" },
  notifications: { desktop: false },
  power: { keepAwake: false },
  git: { ignoreSubmodules: false },
  chrome: { enabled: false },
  chat: { visualize: false },
  claude: { account: "" },
  editor: { command: "", name: "" },
  labels: {},
  back: { marks: {} },
  app: {},
} as unknown as Settings;
const daemon = { host: "h", keepAwake: { supported: true }, editors: [{ id: "code", label: "VS Code" }] } as NonNullable<SettingsResult["daemon"]>;
const get = (settings: Settings, extra: Partial<SettingsResult> = {}): SettingsResult => ({ settings, daemon, claudeAccounts: [], ...extra });
const msg = (settings: Settings, claudeAccounts?: SettingsResult["claudeAccounts"]) => ({ type: "settings_changed" as const, settings, claudeAccounts });
const patch = (p: Record<string, unknown>) => ({ ...base, ...p }) as unknown as Settings;

describe("settings_changed gives the same view as settings.get", () => {
  const accounts = [{ id: "a1", name: "Work" }];
  const variants: [string, Settings, SettingsResult["claudeAccounts"]?][] = [
    ["engine", patch({ sessions: { defaultMode: "default", engine: "opencode" } })],
    ["default mode", patch({ sessions: { defaultMode: "plan", engine: "claude" } })],
    ["worker notifications off", patch({ orchestration: { workerNotifications: false } })],
    ["ignore submodules", patch({ git: { ignoreSubmodules: true } })],
    ["chrome on", patch({ chrome: { enabled: true } })],
    ["chrome absent", patch({ chrome: undefined })],
    ["visualize", patch({ chat: { visualize: true } })],
    ["claude account", patch({ claude: { account: "a1" } }), accounts],
    ["claude accounts list", base, accounts],
    ["desktop notifications", patch({ notifications: { desktop: true } })],
    ["keep awake", patch({ power: { keepAwake: true } })],
    ["custom editor set", patch({ editor: { command: "subl {path}", name: "" } })],
    ["custom editor cleared", base],
  ];
  it.each(variants)("%s", (_n, next, accs) => {
    const from = get(patch({ editor: { command: "subl {path}", name: "Sub" } }), { claudeAccounts: [{ id: "x", name: "X" }] });
    expect(applySettingsChanged(fromSettingsGet(from), msg(next, accs))).toEqual(fromSettingsGet(get(next, { claudeAccounts: accs })));
  });
  it("older daemon: no power, daemon, editors or workerNotifications", () => {
    const old = patch({ power: undefined, orchestration: {} });
    const r: SettingsResult = { settings: old };
    expect(applySettingsChanged(fromSettingsGet(r), msg(old))).toEqual(fromSettingsGet(r));
    expect(fromSettingsGet(r)).toMatchObject({ workerNotices: true, computerAwake: undefined, appEditors: undefined, claudeAccounts: [], lastEngine: "claude" });
  });
});

describe("settings_changed keeps the daemon facts", () => {
  it("of the last settings.get", () => {
    const d = { ...daemon, desktopForcedOff: true, claudeEnvToken: true } as NonNullable<SettingsResult["daemon"]>;
    const v = applySettingsChanged(fromSettingsGet(get(base, { daemon: d })), msg(patch({ editor: { command: "subl", name: "" } })));
    expect(v).toMatchObject({ desktopForcedOff: true, claudeEnvToken: true, keepAwakeSupported: true });
    expect(v.appEditors).toEqual([{ id: "code", label: "VS Code" }, { id: "custom", label: "subl" }]);
  });
  it("with no prior get they take the initial values", () => {
    const v = applySettingsChanged(undefined, msg(patch({ power: { keepAwake: true } })));
    expect(v).toMatchObject({ desktopForcedOff: false, claudeEnvToken: false, computerAwake: undefined, appEditors: undefined });
  });
});

describe("custom editor without a name", () => {
  const labelled = (command: string, name: string) => {
    const settings = patch({ editor: { command, name } });
    const custom = (v: ReturnType<typeof fromSettingsGet>) => v.appEditors?.filter((e) => e.id === "custom");
    // The daemon lists "custom" for any non-empty command, labelled as the web does.
    const daemonList = [...daemon.editors!, ...(command ? [{ id: "custom" as const, label: command.split(" ")[0]!.split("/").pop()! }] : [])];
    const viaGet = fromSettingsGet(get(settings, { daemon: { ...daemon, editors: daemonList } }));
    const viaChange = applySettingsChanged(fromSettingsGet(get(base)), msg(settings));
    return [custom(viaGet), custom(viaChange)];
  };
  it("is labelled by the program, on both paths", () => {
    expect(labelled("echo {path}", "")).toEqual([[{ id: "custom", label: "echo" }], [{ id: "custom", label: "echo" }]]);
  });
  it("is labelled by the name when set, on both paths", () => {
    expect(labelled("echo {path}", "Probe")).toEqual([[{ id: "custom", label: "Probe" }], [{ id: "custom", label: "Probe" }]]);
  });
});

