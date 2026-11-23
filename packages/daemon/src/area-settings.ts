// Area: settings, Claude accounts, Jira, performance monitor, push, addons, updates, launcher shortcut.
// The handlers keep no per-connection state; they read the daemon only through the context.
import type { SettingsTypes } from "./areas.ts";
import type { DaemonContext } from "./daemon-context.ts";
import { claudeEnv } from "./claude-env.ts";
import { ConfigError } from "./config.ts";
import type { AddonsRequest } from "./addons.ts";
import type { Area, Connection, Handlers, Msg, Respond } from "./dispatch.ts";
import { JiraError, jiraOrigin } from "./jira.ts";
import { usesOauthToken } from "./plan-usage.ts";
import type { ProjectRef, Settings, SettingsPatch } from "@claude-ui/protocol";
import { jiraOriginsInUse, jiraSettings, ownJiraUrl } from "./project-overrides.ts";
import { overrideAccounts, withoutOverrideAccount } from "./settings.ts";

const REF_MAX = 4096;
/** The `project` of a jira.* request: absent, or a Side id and a folder as short strings. */
const projectRefProblem = (p: unknown): string | undefined => {
  if (p === undefined) return undefined;
  const o = p as Partial<ProjectRef> | null;
  const ok = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= REF_MAX && !v.includes("\0");
  return o && typeof o === "object" && ok(o.side) && ok(o.cwd) ? undefined : "project must be { side, cwd } of strings";
};

export type SettingsAreaContext = Pick<
  DaemonContext,
  | "appSettings"
  | "secrets"
  | "jira"
  | "settingsReply"
  | "broadcastSettings"
  | "testAccount"
  | "applyAccountToken"
  | "claudeLoginChanged"
  | "projectAccountsChanged"
  | "warmCommit"
  | "catalogues"
  | "autoContinue"
  | "sessions"
  | "perfMon"
  | "syncRunning"
  | "addons"
  | "updater"
  | "focused"
  | "covered"
> & { opts: Pick<DaemonContext["opts"], "keepAwake" | "push" | "shortcut"> };

export function createSettingsArea(ctx: SettingsAreaContext, conn: Pick<Connection, "ws" | "sameHost" | "fromHub">): Area<SettingsTypes> {
  const { appSettings, secrets, jira, opts } = ctx;

  const jiraToken = async (msg: Msg<"jira.token">, { reply, fail }: Respond) => {
    if (msg.token !== null && typeof msg.token !== "string") return fail("bad_settings", "token must be a string or null");
    const bad = projectRefProblem(msg.project);
    if (bad) return fail("bad_settings", bad);
    const settings = appSettings.get();
    // GH-915: only a Project with its own Jira URL has a token of its own; the global token is changed without `project`.
    if (msg.project && !ownJiraUrl(settings, msg.project)) return fail("bad_settings", "The project has no own Jira URL: its token is the global one");
    try {
      // The token is saved for the origin of the Jira URL in effect (a Project's, else the global one); the global origin's token is also kept in the old format.
      secrets.setJiraToken(msg.token === null ? null : msg.token.trim(), jiraOrigin(jiraSettings(settings, msg.project).url), jiraOrigin(settings.jira.url));
    } catch (err) {
      return fail("bad_settings", (err as Error).message);
    }
    ctx.broadcastSettings();
    return reply(ctx.settingsReply());
  };

  const accountAdd = async (msg: Msg<"claude.account.add">, { reply, fail }: Respond) => {
    if (typeof msg.name !== "string" || typeof msg.token !== "string") return fail("bad_settings", "name and token must be strings");
    try {
      secrets.addClaudeAccount(msg.name.trim(), msg.token.trim());
    } catch (err) {
      return fail("bad_settings", (err as Error).message);
    }
    ctx.broadcastSettings();
    return reply(ctx.settingsReply());
  };

  const accountRemove = async (msg: Msg<"claude.account.remove">, { reply, fail }: Respond) => {
    if (typeof msg.id !== "string") return fail("bad_settings", "id must be a string");
    try {
      const active = appSettings.get().claude.account === msg.id;
      const before = appSettings.get();
      secrets.removeClaudeAccount(msg.id);
      // One write: the global account and every Project that named it are Default again.
      const cleaned = withoutOverrideAccount(appSettings.get().projects.overrides, msg.id);
      if (active || cleaned) appSettings.set({ ...(active && { claude: { account: "" } }), ...(cleaned && { projects: { overrides: cleaned } }) });
      ctx.applyAccountToken();
      if (active) ctx.claudeLoginChanged();
      else ctx.projectAccountsChanged(before);
    } catch (err) {
      return fail("bad_settings", (err as Error).message);
    }
    ctx.broadcastSettings();
    return reply(ctx.settingsReply());
  };

  const accountTest = async (msg: Msg<"claude.account.test">, { reply, fail }: Respond) => {
    const token = typeof msg.id === "string" ? secrets.claudeToken(msg.id) : undefined;
    if (!token) return fail("bad_settings", "Claude account: unknown account");
    const env = { ...claudeEnv(process.env, token), CLAUDE_CODE_MAX_RETRIES: "0" };
    if (!usesOauthToken(env)) return fail("bad_settings", "a cloud provider (Bedrock, Vertex, Foundry) is on in the daemon environment: token accounts are not used");
    try {
      const o = await ctx.testAccount(msg.id, token, env);
      return o.ok ? reply({}) : fail(o.code, o.message);
    } catch (e) {
      if (e instanceof ConfigError) return fail("claude_test_failed", e.message.replaceAll(token, "***"));
      throw e;
    }
  };

  const jiraRun = async (msg: Msg<"jira.test" | "jira.search">, { reply, fail }: Respond) => {
    if (msg.type === "jira.search" && msg.text !== undefined && (typeof msg.text !== "string" || msg.text.length > 500)) return fail("bad_request", "text must be a string of at most 500 characters");
    const bad = projectRefProblem(msg.project);
    if (bad) return fail("bad_request", bad);
    try {
      return reply(msg.type === "jira.test" ? await jira.test(msg.project) : { tickets: await jira.search(msg.text, msg.project) });
    } catch (e) {
      if (e instanceof JiraError) return fail(e.code, e.message);
      throw e;
    }
  };

  /** `patch`: what the change sets (the checks and follow-ups read it); `write` saves it and returns the new settings. */
  const settingsWrite = async (patch: SettingsPatch | undefined, write: () => Settings, { reply, fail }: Respond) => {
    // The command runs on the daemon machine's desktop: a remote browser must not plant it for the local user's next click.
    if (patch?.editor !== undefined && !conn.sameHost) return fail("not_local", "Only a browser on the daemon machine can change the editor command");
    try {
      const picked = patch?.claude?.account;
      if (picked !== undefined && picked !== "" && picked !== "cli" && !secrets.claudeAccounts().some((a) => a.id === picked)) return fail("bad_settings", "Claude account: unknown account");
      const unknown = overrideAccounts(patch?.projects?.overrides ?? {}).find((a) => a !== "" && a !== "cli" && !secrets.claudeAccounts().some((x) => x.id === a));
      if (unknown !== undefined) return fail("bad_settings", "Claude account: unknown account");
      const before = appSettings.get().claude.account;
      const settingsBefore = appSettings.get();
      const settings = write();
      if (patch?.git?.commitMessageWarm !== undefined) (settings.git.commitMessageWarm ? ctx.warmCommit.prewarm() : ctx.warmCommit.stop());
      for (const c of ctx.catalogues.all) c.settingsChanged?.(settingsBefore, settings);
      if (settings.claude.account !== before) (ctx.applyAccountToken(), ctx.claudeLoginChanged());
      else ctx.projectAccountsChanged(settingsBefore);
      const origin = jiraOrigin(settings.jira.url);
      const urlPatched = patch?.jira?.url !== undefined;
      // GH-487: a token saved without URL takes the first URL set here, in one write: only when the URL before was empty, so never a URL a hand edit
      // or a Hub sync set (GH-915). Dropped (cleanup, never sent anyway): the token of an origin this change stops using (neither the global URL nor a
      // Project override names it any more), and the token saved without URL once the global URL is set.
      // GH-915: never on another computer's Hub's sync: its settings name its own sites, not those this machine's own users saved tokens for; and only
      // origins this change stops using, so a later change here keeps the tokens whose URLs a sync replaced.
      if (!conn.fromHub) {
        if (urlPatched && origin && !jiraOrigin(settingsBefore.jira.url)) secrets.bindJiraToken(origin);
        const now = jiraOriginsInUse(settings);
        secrets.pruneJiraTokens([...jiraOriginsInUse(settingsBefore), ""].filter((o) => !now.includes(o)), origin);
        if (urlPatched && !origin) secrets.endJiraTokenReset();
      }
      if (!settings.usageLimit.autoContinue) ctx.autoContinue.clear();
      if (!settings.focus.nextForYou) for (const s of ctx.sessions.values()) s.clearSuggestion();
      ctx.perfMon.setEnabled(settings.performance.monitor);
      if (!settings.power.keepAwake) opts.keepAwake?.reset();
      ctx.syncRunning();
      ctx.broadcastSettings(settings);
      return reply(ctx.settingsReply(settings));
    } catch (err) {
      return fail("bad_settings", (err as Error).message);
    }
  };

  const settingsSet = (msg: Msg<"settings.set">, r: Respond) => settingsWrite(msg.patch, () => appSettings.set(msg.patch), r);

  /** One Project's overrides (GH-903): merged into the map under the store's change(), so a save of another Project is never undone. */
  const settingsProject = (msg: Msg<"settings.project">, r: Respond) => {
    if (typeof msg.side !== "string" || typeof msg.cwd !== "string") return r.fail("bad_settings", "side and cwd must be strings");
    const entry = msg.overrides === undefined ? null : msg.overrides;
    // Own key, never a prototype name: the checks and the account lookup read this shape.
    const patch = { projects: { overrides: Object.fromEntries([[msg.side, Object.fromEntries([[msg.cwd, entry ?? {}]])]]) } } as SettingsPatch;
    return settingsWrite(patch, () => appSettings.setProject(msg.side, msg.cwd, entry), r);
  };

  const pushFocus = (msg: Msg<"push.focus">, { reply, fail }: Respond) => {
    if (msg.sessionId !== undefined && typeof msg.sessionId !== "string") return fail("bad_request", "sessionId must be a string");
    if (msg.covered !== undefined && !(Array.isArray(msg.covered) && msg.covered.length <= 2000 && msg.covered.every((x) => typeof x === "string" && x.length <= 200)))
      return fail("bad_request", "covered must be an array of at most 2000 session ids");
    if (msg.sessionId === undefined) ctx.focused.delete(conn.ws);
    else ctx.focused.set(conn.ws, msg.sessionId);
    if (msg.covered === undefined) ctx.covered.delete(conn.ws);
    else ctx.covered.set(conn.ws, new Set(msg.covered));
    return reply({});
  };

  const addonsRun = async (msg: Msg<Extract<SettingsTypes, `addons.${string}`>>, { reply, fail }: Respond) => {
    if (!ctx.addons) return fail("addons_unavailable", "addons live on the Hub");
    try {
      return reply(await ctx.addons.handle(msg as AddonsRequest));
    } catch (e) {
      return fail(e instanceof ConfigError ? e.code : "addons_failed", (e as Error).message);
    }
  };

  const updateRun = async (msg: Msg<"update.check" | "update.install" | "update.restart">, { reply, fail }: Respond) => {
    const updater = ctx.updater;
    if (!updater) return fail("update_unavailable", "updates are off (source checkout, --no-update-check or not started by claude-ui)");
    try {
      if (msg.type === "update.check") return reply(await updater.checkNow());
      return reply(msg.type === "update.install" ? { installed: await updater.install() } : { waitingFor: updater.restart(msg.now === true) });
    } catch (e) {
      return fail((e as { code?: string }).code ?? "update_failed", (e as Error).message);
    }
  };

  const handlers: Handlers<SettingsTypes> = {
    "perf.report": (_msg, { reply }) => reply({ daemon: ctx.perfMon.report() }),
    "perf.client": (msg, { reply, fail }) => {
      if (typeof msg.marks !== "object" || msg.marks === null || Array.isArray(msg.marks)) return fail("bad_request", "marks must be an object");
      ctx.perfMon.client(msg.marks);
      reply({});
    },
    "perf.clear": (_msg, { reply }) => (ctx.perfMon.clear(), reply({})),
    "settings.get": (_msg, { reply }) => reply(ctx.settingsReply()),
    "jira.token": jiraToken,
    "claude.account.add": accountAdd,
    "claude.account.remove": accountRemove,
    "claude.account.test": accountTest,
    "jira.test": jiraRun,
    "jira.search": jiraRun,
    "settings.set": settingsSet,
    "settings.project": settingsProject,
    "push.key": (_msg, { reply, fail }) => (opts.push ? reply({ publicKey: opts.push.publicKey }) : fail("push_unavailable", "push is not configured")),
    "push.subscribe": (msg, { reply, fail }) => {
      if (!opts.push) return fail("push_unavailable", "push is not configured");
      return opts.push.subscribe(msg.subscription) ? reply({}) : fail("bad_subscription", "subscription needs an https endpoint and keys");
    },
    "push.focus": pushFocus,
    "addons.list": addonsRun,
    "addons.install": addonsRun,
    "addons.discover": addonsRun,
    "addons.checkUpdate": addonsRun,
    "addons.update": addonsRun,
    "addons.approve": addonsRun,
    "addons.setEnabled": addonsRun,
    "addons.uninstall": addonsRun,
    "addons.pickRenderer": addonsRun,
    "update.check": updateRun,
    "update.install": updateRun,
    "update.restart": updateRun,
    "launcher.shortcut": async (msg, { reply, fail }) => {
      if (!opts.shortcut) return fail("shortcut_unavailable", "this daemon cannot make a launcher shortcut");
      if (typeof msg.on !== "boolean") return fail("bad_request", "on must be true or false");
      try {
        return reply({ installed: await opts.shortcut.set(msg.on) });
      } catch (e) {
        return fail("shortcut_failed", (e as Error).message);
      }
    },
  };
  return { handlers };
}
