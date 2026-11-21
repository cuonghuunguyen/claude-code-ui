import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@claude-ui/protocol";
import { createSettingsArea, type SettingsAreaContext } from "../src/area-settings.ts";
import type { Respond } from "../src/dispatch.ts";
import { createSecrets } from "../src/secrets.ts";
import { createSettings } from "../src/settings.ts";

// The settings area with a fake context: no port, no socket, no config dir.
const setup = (sameHost: boolean) => {
  const appSettings = createSettings();
  const secrets = createSecrets();
  const sent: ServerMessage[] = [];
  const claudeLoginChanged = vi.fn();
  const ctx: SettingsAreaContext = {
    appSettings,
    secrets,
    jira: {} as never,
    settingsReply: (settings = appSettings.get()) => ({ settings, claudeAccounts: secrets.claudeAccounts() }),
    broadcastSettings: (settings = appSettings.get()) => void sent.push({ type: "settings_changed", settings, claudeAccounts: secrets.claudeAccounts() } as ServerMessage),
    testAccount: vi.fn(),
    applyAccountToken: vi.fn(),
    claudeLoginChanged,
    projectAccountsChanged: vi.fn(),
    warmCommit: { prewarm: vi.fn(), stop: vi.fn() } as never,
    catalogues: { all: [] } as never,
    autoContinue: { clear: vi.fn() } as never,
    sessions: new Map(),
    perfMon: { setEnabled: vi.fn() } as never,
    syncRunning: vi.fn(),
    addons: undefined,
    updater: undefined,
    focused: new Map(),
    covered: new Map(),
    opts: {},
  };
  const area = createSettingsArea(ctx, { ws: {} as never, sameHost, fromHub: false });
  /** The reply or error a handler gives, in the shape of dispatch.ts. */
  const call = async (type: keyof typeof area.handlers, msg: object) => {
    let out: ServerMessage | undefined;
    const r: Respond = { reply: (result) => (out = { type: "reply", reqId: "1", result }), fail: (code, message) => (out = { type: "error", reqId: "1", code, message }) };
    await (area.handlers[type] as (m: never, r: Respond) => unknown)({ type, reqId: "1", ...msg } as never, r);
    return out as ServerMessage;
  };
  return { ctx, call, sent, claudeLoginChanged };
};

describe("settings area", () => {
  it("an editor command from a browser on another machine is refused and not saved", async () => {
    const { ctx, call } = setup(false);
    expect(await call("settings.set", { patch: { editor: { command: "evil" } } })).toMatchObject({ type: "error", code: "not_local" });
    expect(ctx.appSettings.get().editor.command).toBe("");
  });

  it("picking an unknown Claude account is refused and keeps the current account", async () => {
    const { ctx, call } = setup(true);
    expect(await call("settings.set", { patch: { claude: { account: "nope" } } })).toMatchObject({ type: "error", code: "bad_settings" });
    expect(ctx.appSettings.get().claude.account).toBe("");
  });

  it("removing the active Claude account falls back to the default login", async () => {
    const { ctx, call, sent, claudeLoginChanged } = setup(true);
    await call("claude.account.add", { name: "work", token: "sk-ant-oat01-abc" });
    const id = ctx.secrets.claudeAccounts()[0]!.id;
    await call("settings.set", { patch: { claude: { account: id } } });
    expect(ctx.appSettings.get().claude.account).toBe(id);
    claudeLoginChanged.mockClear();
    sent.length = 0;
    const reply = await call("claude.account.remove", { id });
    expect(reply).toMatchObject({ type: "reply", result: { settings: { claude: { account: "" } }, claudeAccounts: [] } });
    expect(claudeLoginChanged).toHaveBeenCalledTimes(1);
    expect(sent.some((m) => m.type === "settings_changed")).toBe(true);
  });

  it("a Project override naming an unknown Claude account is refused and not saved", async () => {
    const { ctx, call } = setup(true);
    expect(await call("settings.set", { patch: { projects: { overrides: { local: { "/p": { account: "nope" } } } } } })).toMatchObject({ type: "error", code: "bad_settings" });
    expect(ctx.appSettings.get().projects.overrides).toEqual({});
  });

  it("removing a Claude account clears it from every Project override in the same write; other overrides stay", async () => {
    const { ctx, call } = setup(true);
    await call("claude.account.add", { name: "work", token: "sk-ant-oat01-abc" });
    await call("claude.account.add", { name: "home", token: "sk-ant-oat01-def" });
    const [work, home] = ctx.secrets.claudeAccounts().map((a) => a.id) as [string, string];
    const patch = { projects: { overrides: { local: { "/a": { account: work, mode: "plan" }, "/b": { account: work }, "/c": { account: home } } } } };
    expect(await call("settings.set", { patch })).toMatchObject({ type: "reply" });
    await call("claude.account.remove", { id: work });
    expect(ctx.appSettings.get().projects.overrides).toEqual({ local: { "/a": { mode: "plan" }, "/c": { account: home } } });
  });
});
