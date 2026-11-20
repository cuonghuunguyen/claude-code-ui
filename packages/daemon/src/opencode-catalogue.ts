// The OpenCode Engine catalogue (docs/spec.md "OpenCode engine"): OpenCode's server, its stored sessions and its provider state, moved out of server.ts.
import { existsSync } from "node:fs";
import { EFFORTS, type ClientMessage, type ModelInfo, type PermissionMode, type SessionListItem } from "@claude-ui/protocol";
import { EngineError, isModel, type CatalogueContext, type CatalogueList, type EngineCatalogue, type EngineRequest, type ListCtx, type SavedSession, type Settings } from "./engine-catalogue.ts";
import { brokenState, createOpenCodeEngine, loadOpenCodeHistory, OPENCODE_CAPABILITIES, OPENCODE_MODES, openCodeModels, primaryAgents, ProviderStateBroken, type ForkLink, type OpenCodeMcpRoute } from "./opencode-engine.ts";
import { forkAt } from "./opencode-fork.ts";
import { createOpenCodeMcpConfig } from "./opencode-config-mcp.ts";
import { checkLogin, listProviders, loginError } from "./opencode-providers.ts";
import { createOpenCodeServer, OpenCodeError, type OpenCodeServer } from "./opencode-server.ts";
import { mapLimit } from "./session-scan.ts";
import { Session, type SessionOpts, type SessionSettings } from "./session.ts";

/** The longest `session.list` waits for the OpenCode server (it may start, or hang, for the first list). */
const OPENCODE_LIST_WAIT_MS = 3000;
/** An OpenCode session id: it reaches a request path, so only this shape does. */
export const OPENCODE_ID = /^ses_[A-Za-z0-9]+$/;
/** OpenCode is wanted for a session list: the last created session was OpenCode's, or `sessions.json` has an OpenCode session (a stored one of any folder). */
export const openCodeWanted = (engine: string, linked: Map<string, SavedSession>) => engine === "opencode" || [...linked.keys()].some((id) => OPENCODE_ID.test(id));
type OpenCodeSessionRow = { id: string; directory: string; title: string; time: { created: number; updated: number; archived?: number } };
const OPENCODE_RESTART_BUSY = "OpenCode is busy: a turn runs, a login waits or a session is being created. Restart it when that is done.";
const PROVIDERS_BROKEN_BUSY = "OpenCode's provider list is broken. It is reloaded when no OpenCode turn runs: press Retry then.";

export type OpenCodeCatalogueOpts = {
  /** Test seam: `command` replaces the PATH lookup of `opencode` (argv prefix), `env` is added to the OpenCode child's environment. */
  server?: { command?: string[]; env?: () => NodeJS.ProcessEnv; startTimeoutMs?: number; /** The server to use instead of a new one (opencode-catalogues.ts shares one between both adapters). */ instance?: OpenCodeServer; /** How long `session.list` waits for OpenCode (default 3 s). */ listWaitMs?: number; /** How long the MCP servers dialog waits for OpenCode before it shows the servers as pending (default 3 s). */ mcpWaitMs?: number };
  /** How OpenCode reaches the daemon's MCP route (the route itself stays in server.ts). */
  mcp: OpenCodeMcpRoute;
};

export function createOpenCodeCatalogue(ctx: CatalogueContext, o: OpenCodeCatalogueOpts): EngineCatalogue {
  const { appSettings, settings } = ctx;
  /** The OpenCode server: started on first use (docs/spec.md "OpenCode engine"), stopped with the daemon. */
  const openCode = o.server?.instance ?? createOpenCodeServer({ path: () => appSettings.get().opencode.path, ...o.server });
  /** Directory and title of each OpenCode session this daemon listed, created or opened. */
  const openCodeMeta = new Map<string, { cwd: string; title: string }>();
  const openCodeFail = (err: unknown) => (err instanceof OpenCodeError ? { code: err.code, message: err.message } : { code: "opencode_failed", message: (err as Error).message });
  /** The forks of the Fork runs of session `id` (sessions.json). */
  const forksOf = (id: string): ForkLink[] => settings.entries().flatMap(([forkId, l]) => (l.forkOf?.sessionId === id ? [{ forkId, callId: l.forkOf.callId, prefix: l.forkOf.prefix }] : []));
  const openCodeEngine = createOpenCodeEngine(openCode, {
    onTitle: (id, title) => {
      const m = openCodeMeta.get(id);
      if (!m || m.title === title) return;
      openCodeMeta.set(id, { ...m, title });
      ctx.broadcast({ type: "sessions.changed" });
    },
    mcp: o.mcp,
    visualizeOn: () => appSettings.get().chat.visualize,
    onFork: (id, forkOf) => ctx.saveSettings(() => settings.set(id, { forkOf })),
    forksOf,
  });
  const ownsId = (id: string) => OPENCODE_ID.test(id);
  const sessionOpts = (initial: Partial<SessionSettings>) => ({ ...ctx.sessionOpts(initial), engine: openCodeEngine });

  /** One OAuth wait (`opencode.loginFinish`) per provider; a cancel or a new login aborts it. */
  const oauthWaits = new Map<string, AbortController>();
  /** Login and logout change OpenCode's provider set; `POST /global/dispose` makes its instances read it, but cancels running turns: it waits for idle. */
  let providersStale = false;
  const openCodeBusy = () => [...ctx.liveSessions()].some((s) => ownsId(s.id) && (s.currentState() !== "idle" || s.pendingCount() > 0));
  async function flushProviders() {
    if (!providersStale || openCodeBusy() || !openCode.running()) return;
    providersStale = false;
    // Clients drop their OpenCode model list only after OpenCode read the new providers.
    await openCode.request("/global/dispose", { method: "POST" }).then(() => (openCodeEngine.dropLimits(), ctx.broadcast({ type: "opencode.providersChanged" })), (err) => (providersStale = true, console.error("OpenCode dispose failed:", (err as Error).message)));
  }
  /** OpenCode sessions being created (POST /session in flight): a restart of OpenCode's server would lose them. */
  let openCodeCreating = 0;
  let openCodeRestarts = 0;
  let openCodeRestart: Promise<void> | undefined;
  /** A restart of OpenCode's server now would lose a turn, an OAuth login or a session creation. */
  const openCodeHeld = () => openCodeBusy() || oauthWaits.size > 0 || openCodeCreating > 0;
  /** Stops OpenCode's server (the next request starts it again; open sessions resync on the new event stream) and drops its cached limits. One at a time. */
  const restartOpenCode = () =>
    (openCodeRestart ??= (async () => {
      await openCode.reset();
      openCodeEngine.dropLimits();
      openCodeRestarts++;
    })().finally(() => (openCodeRestart = undefined)));
  /**
   * OpenCode's model list. Only a read that still answers 499 after the folder's instance was disposed means the provider state is broken server-wide
   * (nothing else clears it): then OpenCode's server restarts, unless a turn, an OAuth login or a session creation would be lost. A refused or failed
   * folder repair, or a busy server, is `models_failed` with the reason. One restart at a time; a caller that saw the break before a restart reads again.
   */
  async function openCodeModelsRepaired(cwd?: string): Promise<ModelInfo[]> {
    const seen = openCodeRestarts;
    try {
      return await openCodeModels(openCodeEngine, cwd);
    } catch (err) {
      if (err instanceof ProviderStateBroken) {
        if (seen === openCodeRestarts) {
          if (openCodeHeld()) throw new Error(PROVIDERS_BROKEN_BUSY);
          await restartOpenCode();
        } else await openCodeRestart;
        return openCodeModels(openCodeEngine, cwd);
      }
      throw brokenState(err) ? new Error(PROVIDERS_BROKEN_BUSY) : err;
    }
  }
  const refreshProviders = () => ((providersStale = true), flushProviders());

  /** A new OpenCode session in `cwd` with the rules of its mode (tracked, its project added); undefined when the folder is being removed meanwhile. Throws OpenCode's error. */
  async function createOpenCodeSession(cwd: string, initial: { model?: string; permissionMode: PermissionMode; effort?: SessionSettings["effort"] }): Promise<Session | undefined> {
    // No timeout: the first request of a cold folder boots its instance (> 3 s) and the user waits for the session; a timeout would lose the created session for good.
    // `resend`: a create cut off by a server that died is sent again to the next server; at worst (it died after creating) an empty session is left over.
    const permission = await openCodeEngine.block(initial.permissionMode, cwd); // may reject: before the counter goes up
    openCodeCreating++;
    const row = await openCode.request<OpenCodeSessionRow>("/session", { method: "POST", directory: cwd, timeoutMs: 0, resend: true, body: { permission } }).finally(() => openCodeCreating--);
    openCodeEngine.noteCreated(row.id, permission);
    if (ctx.isRemoving(cwd) || !existsSync(cwd)) return undefined;
    const opts = sessionOpts(initial);
    const s = ctx.track(new Session(cwd, opts, { id: row.id }));
    // The entry makes the next list start OpenCode for a user whose last engine is Claude. `fields` empty: only a session without an entry is saved (as Claude does on its first query).
    (opts as SessionOpts).onSettings?.(s.run.settings(), s.id, []);
    openCodeMeta.set(s.id, { cwd, title: row.title });
    ctx.addProject(cwd);
    return s;
  }

  /** The error text of the last failed OpenCode listing: logged once per change, not on every list. */
  let openCodeListError: string | undefined;
  /** OpenCode answered a session list once in this run. */
  let openCodeAnswered = false;
  /** The late push of a list that did not wait is pending. */
  let lateRefresh: Promise<unknown> | undefined;
  /** The `GET /session` of a folder in flight: concurrent lists, and a list that starts while an earlier one still waits, share it (the requests are never aborted, so they would pile up on a slow OpenCode). */
  const sessionReads = new Map<string, Promise<OpenCodeSessionRow[]>>();
  const readSessions = (cwd: string) => {
    let p = sessionReads.get(cwd);
    if (!p) sessionReads.set(cwd, (p = openCode.request<OpenCodeSessionRow[]>("/session?roots=true", { directory: cwd, timeoutMs: 0 }).finally(() => sessionReads.delete(cwd))));
    return p;
  };
  async function readOpenCodeList(cwds: string[], linked: Map<string, SavedSession>, links: (id: string) => object) {
    const out = { items: [] as SessionListItem[], ids: new Set<string>(), ran: false };
    try {
      // No timeout: a cold OpenCode answers after its folder's first load (> 3 s). `list()` waits `listWaitMs` for it; the late answer is pushed as `sessions.changed` (listOpenCode).
      const rows = await mapLimit(cwds, 4, async (cwd) => [cwd, await readSessions(cwd)] as const);
      openCodeListError = undefined;
      openCodeAnswered = true;
      out.ran = true;
      // A session without a saved agent lists as OpenCode's default agent of its folder; a slow answer must not hold the list back (build then).
      const defaults = new Map<string, Promise<string>>();
      const folderDefault = (cwd: string) => (defaults.get(cwd) ?? defaults.set(cwd, Promise.race([openCodeEngine.defaultAgent(cwd), new Promise<string>((r) => setTimeout(() => r(openCodeEngine.defaultAgentKnown(cwd)), 2_000).unref())])).get(cwd)!);
      for (const [cwd, list] of rows)
        for (const row of list) {
          const loaded = ctx.session(row.id);
          const saved = linked.get(row.id);
          // The fork of a Fork run shows in its parent's card only; its id stays known so its link is kept (`keep`).
          if (saved?.forkOf) {
            out.ids.add(row.id);
            continue;
          }
          const savedMode = OPENCODE_MODES.find((m) => m === saved?.permissionMode) ?? "default";
          // Plan is the plan agent (GH-684): a saved plan mode lists as default + agent plan.
          const mode = savedMode === "plan" ? "default" : savedMode;
          const agent = savedMode === "plan" ? "plan" : (saved?.agent ?? (await folderDefault(cwd)));
          const info = loaded?.info() ?? { id: row.id, cwd, state: "closed" as const, model: saved?.model ?? "default", permissionMode: mode, agent, effort: saved?.effort ?? "default", permissionModes: openCodeEngine.permissionModes({ allowBypass: ctx.allowBypass }), capabilities: OPENCODE_CAPABILITIES, engine: openCodeEngine.name };
          openCodeMeta.set(row.id, { cwd, title: row.title });
          out.ids.add(row.id);
          out.items.push({ ...info, id: row.id, cwd, title: row.title, lastActivity: row.time.updated, archived: !!row.time.archived, transcript: true, live: false, ...links(row.id) });
        }
    } catch (err) {
      const text = (err as Error).message;
      if (text !== openCodeListError) console.error("listing OpenCode sessions failed:", text);
      openCodeListError = text;
    }
    return out;
  }
  /**
   * OpenCode sessions of `cwds` (docs/spec.md "OpenCode engine"). Only when the server runs or OpenCode is wanted (`openCodeWanted`), so a Claude-only
   * user never starts it. shortcut: a user whose last engine is Claude and who has no stored OpenCode session sees OpenCode-TUI sessions only after the server started in this daemon run.
   * `ran`: the listing answered for every folder (an entry missing from it is gone); a failing OpenCode lists none and never fails the Claude list.
   */
  async function listOpenCode(cwds: string[], linked: Map<string, SavedSession>, links: (id: string) => object) {
    const none = () => ({ items: [] as SessionListItem[], ids: new Set<string>(), ran: false });
    if (!openCode.running() && !openCodeWanted(appSettings.get().sessions.engine, linked)) return none();
    // Not answering within the wait: no OpenCode items and no prune (`ran` false); the start goes on and the next list has them. The late result is dropped.
    // Before OpenCode's first answer the list does not wait: projects and Claude sessions show at once on page load.
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const late = new Promise<ReturnType<typeof none>>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        const text = "OpenCode did not answer the session list in time";
        if (openCodeAnswered && text !== openCodeListError) console.error(`listing OpenCode sessions failed: ${text}`);
        openCodeListError = text;
        resolve(none());
      }, openCodeAnswered ? (o.server?.listWaitMs ?? OPENCODE_LIST_WAIT_MS) : 0);
    });
    try {
      const read = readOpenCodeList(cwds, linked, links);
      const r = await Promise.race([read, late]);
      // The list that did not wait: clients ask again once OpenCode answered.
      // No pile-up: one read per folder is in flight and it has at most one push. A folder that stays slow for several reads can push once per read.
      if (!r.ran && timedOut && !lateRefresh) lateRefresh = read.then((x) => x.ran && ctx.broadcast({ type: "sessions.changed" })).finally(() => (lateRefresh = undefined));
      return r;
    } finally {
      clearTimeout(timer);
    }
  }

  /** An OpenCode session rebuilt from its stored messages. Its folder: the one listed or created, else asked of OpenCode. */
  async function restoreOpenCode(id: string): Promise<Session | undefined> {
    const known = openCodeMeta.get(id);
    // shortcut: a session of a folder not seen yet is found only when OpenCode answers `GET /session/{id}` without a directory (unverified against a real server).
    const row = await openCode.request<OpenCodeSessionRow>(`/session/${id}`, { directory: known?.cwd, timeoutMs: 0 }).catch(() => undefined);
    const cwd = row && ctx.allowed(known?.cwd ?? row.directory);
    if (!row || !cwd || ctx.isRemoving(cwd)) return undefined;
    const history = await loadOpenCodeHistory(openCode, id, cwd, forksOf(id));
    openCodeMeta.set(id, { cwd, title: row.title });
    const saved = settings.get(id);
    const permissionMode = OPENCODE_MODES.includes(saved?.permissionMode as never) ? (saved!.permissionMode as SessionSettings["permissionMode"]) : undefined;
    const effort = EFFORTS.includes(saved?.effort as never) ? (saved!.effort as SessionSettings["effort"]) : undefined;
    const model = isModel(saved?.model) ? saved.model : undefined;
    return ctx.track(Session.restore(id, cwd, history as never, sessionOpts({ model, permissionMode, effort })));
  }

  const requests: Partial<Record<ClientMessage["type"], EngineRequest>> = {};
  requests["opencode.status"] = async (_msg, reply) => reply(await openCode.status());
  requests["opencode.restart"] = async (_msg, reply, fail) => {
    if (openCodeHeld()) return fail("opencode_busy", OPENCODE_RESTART_BUSY);
    await restartOpenCode();
    ctx.broadcast({ type: "opencode.providersChanged" });
    return reply({});
  };
  const login: EngineRequest = async (request, reply, fail) => {
    const msg = request as Extract<ClientMessage, { type: "opencode.providers" | "opencode.login" | "opencode.loginFinish" | "opencode.loginCancel" | "opencode.logout" }>;
    // Credentials pass straight to OpenCode: never logged, never in an error text.
    const provider = "provider" in msg && typeof msg.provider === "string" ? msg.provider : "";
    const field = (m: string) => fail("invalid_input", m);
    let wait: AbortController | undefined;
    const cleanWait = () => wait && oauthWaits.get(provider) === wait && oauthWaits.delete(provider);
    try {
      if (msg.type === "opencode.loginCancel") return (oauthWaits.get(provider)?.abort(), oauthWaits.delete(provider), reply({}));
      // Registered before the slow list: a loginCancel in that window must reach this wait.
      wait = msg.type === "opencode.loginFinish" ? new AbortController() : undefined;
      if (wait) (oauthWaits.get(provider)?.abort(), oauthWaits.set(provider, wait));
      const providers = await listProviders(openCode).catch((err) => (cleanWait(), Promise.reject(err)));
      if (wait?.signal.aborted) return fail("cancelled", "Login cancelled");
      if (msg.type === "opencode.providers") return reply({ providers });
      if (msg.type === "opencode.logout") {
        if (!providers.some((p) => p.id === provider)) return field("provider: Unknown provider");
        await openCode.request(`/auth/${encodeURIComponent(provider)}`, { method: "DELETE" });
        await refreshProviders();
        return reply({ providers: await listProviders(openCode) });
      }
      const api = msg.type === "opencode.login" && providers.find((p) => p.id === provider)?.methods[msg.method as number]?.type === "api";
      const c = checkLogin(msg, providers, api ? "api" : "oauth");
      if ("error" in c) return (cleanWait(), field(c.error));
      const base = `/provider/${encodeURIComponent(provider)}/oauth`;
      if (msg.type === "opencode.login" && api) {
        await openCode.request(`/auth/${encodeURIComponent(provider)}`, { method: "PUT", body: { type: "api", key: c.key, ...(c.inputs && Object.keys(c.inputs).length && { metadata: c.inputs }) } });
        await refreshProviders();
        return reply({ providers: await listProviders(openCode) });
      }
      if (msg.type === "opencode.login") {
        oauthWaits.get(provider)?.abort();
        const r = await openCode.request<{ url: string; method: "auto" | "code"; instructions?: string } | null>(`${base}/authorize`, { method: "POST", body: { method: msg.method, ...(c.inputs && { inputs: c.inputs }) } });
        if (!r?.url) return fail("login_failed", "OpenCode gave no login page for this method.");
        return reply({ url: r.url, mode: r.method, instructions: r.instructions ?? "" });
      }
      const ctl = wait!;
      try {
        await openCode.request(`${base}/callback`, { method: "POST", body: { method: msg.method, ...(typeof msg.code === "string" && msg.code && { code: msg.code }) }, timeoutMs: 15 * 60_000, signal: ctl.signal });
      } catch (err) {
        if (ctl.signal.aborted) return fail("cancelled", "Login cancelled");
        throw err;
      } finally {
        if (oauthWaits.get(provider) === ctl) oauthWaits.delete(provider);
      }
      await refreshProviders();
      return reply({ providers: await listProviders(openCode) });
    } catch (err) {
      if (err instanceof OpenCodeError) return fail(err.code, err.message);
      return fail("login_failed", loginError(err));
    }
  };
  for (const type of ["opencode.providers", "opencode.login", "opencode.loginFinish", "opencode.loginCancel", "opencode.logout"] as const) requests[type] = login;

  return {
    engine: openCodeEngine,
    config: { mcp: createOpenCodeMcpConfig({ server: openCode, repair: (cwd) => openCodeEngine.repairFolder(cwd), hidden: (name) => openCodeEngine.attached.has(name), waitMs: o.server?.mcpWaitMs }) },
    listScope: "folders",
    ownsId,
    // Listed, created or opened here: not a UUID (the transcript scan's shape), so it is not found by one.
    isLocal: async (id) => openCodeMeta.has(id),
    knownIds: async () => [...openCodeMeta.keys()],
    entry: () => ({ engine: openCodeEngine.name, capabilities: OPENCODE_CAPABILITIES, permissionModes: openCodeEngine.permissionModes({ allowBypass: ctx.allowBypass }) }),
    // OpenCode's own permission config decides (GH-705); sessions.defaultMode is Claude's.
    startMode: async () => "config",
    create: async (cwd, initial) => {
      try {
        return await createOpenCodeSession(cwd, { model: initial.model, permissionMode: initial.permissionMode ?? "default", effort: initial.effort });
      } catch (err) {
        const e = openCodeFail(err);
        throw new EngineError(e.code, e.message);
      }
    },
    list: async (lctx: ListCtx): Promise<CatalogueList> => {
      const { linked, links } = lctx.read();
      const oc = await listOpenCode(lctx.folders ?? [], linked, links);
      return { items: oc.items, keep: (id) => ownsId(id) && !(oc.ran && !oc.ids.has(id)) };
    },
    restore: (id) => restoreOpenCode(id),
    locate: async (id, live) => {
      // The folder it was listed, created or opened in; its store is OpenCode's.
      const cwd = live?.cwd ?? openCodeMeta.get(id)?.cwd;
      return cwd && ctx.allowed(cwd) ? { cwd, transcript: false } : undefined;
    },
    title: async (s) => openCodeMeta.get(s.id)?.title ?? "New session",
    rename: async (id, cwd, title) => {
      await openCode.request(`/session/${id}`, { method: "PATCH", directory: cwd, body: { title } });
      openCodeMeta.set(id, { cwd, title });
    },
    // `time.archived` set; 0 clears it (null is accepted but keeps it, verified on 1.18.35).
    archive: async (id, cwd, archived) => void (await openCode.request(`/session/${id}`, { method: "PATCH", directory: cwd, body: { time: { archived: archived ? Date.now() : 0 } } })),
    delete: async (id, at) => {
      await openCode.request(`/session/${id}`, { method: "DELETE", directory: at.cwd });
      openCodeMeta.delete(id);
      // The forks of its Fork runs go with it (they show nowhere else); a fork already gone is no failure.
      const forks = settings.entries().filter(([, l]) => l.forkOf?.sessionId === id).map(([forkId]) => forkId);
      await Promise.all(forks.map((forkId) => openCode.request(`/session/${forkId}`, { method: "DELETE", directory: at.cwd }).catch(() => undefined)));
      if (forks.length) ctx.saveSettings(() => settings.delete(forks));
    },
    forkForAside: async (owner, title) => {
      const at = await forkAt(openCode, owner, "An aside");
      if ("unavailable" in at) return at;
      try {
        openCodeMeta.set(at.id, { cwd: owner.cwd, title });
        await openCode.request(`/session/${at.id}`, { directory: owner.cwd, method: "PATCH", body: { title } });
        return { id: at.id };
      } catch (e) {
        // The fork exists but is not usable: it is not left behind.
        await openCode.request(`/session/${at.id}`, { method: "DELETE", directory: owner.cwd }).then(() => openCodeMeta.delete(at.id), () => {});
        throw e;
      }
    },
    commands: (cwd) => openCodeEngine.commands(cwd),
    agents: async (cwd) => (await openCodeEngine.primaryFirst(cwd)).map(({ name, description }) => ({ name, ...(description && { description }) })),
    models: (cwd) => openCodeModelsRepaired(cwd),
    // A model refresh held back by a running OpenCode session no longer waits for it.
    settled: () => void flushProviders(),
    settingsChanged: (before: Settings, next: Settings) => {
      if (next.opencode.path === before.opencode.path) return;
      void restartOpenCode().then(() => ctx.broadcast({ type: "opencode.providersChanged" }));
    },
    requests,
    close: () => openCode.close(),
  };
}
