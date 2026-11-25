// The OpenCode 2 adapter's catalogue (ADR 0015): creates, lists and restores sessions of the daemon's OpenCode 2 server through `@opencode/client`.
// Create, list, restore, models, rename, archive, delete, the Aside fork, agents and the slash commands (the daemon's and OpenCode's).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { EFFORTS, type PermissionMode, type SessionListItem } from "@claude-ui/protocol";
import { EngineError, isModel, type CatalogueContext, type CatalogueList, type EngineCatalogue, type EngineConfig, type ListCtx, type SavedSession } from "./engine-catalogue.ts";
import { OPENCODE_MODES, type ForkLink, type OpenCodeMcpRoute } from "./opencode-engine.ts";
import { openCodeWanted } from "./opencode-catalogue.ts";
import { OpenCodeError, type OpenCodeServer } from "./opencode-server.ts";
import { createOpenCode2Engine, loadOpenCode2History, OPENCODE2_CAPABILITIES } from "./opencode2-engine.ts";
import { createOpenCode2McpConfig, createOpenCode2PluginsConfig, createOpenCode2SkillsConfig } from "./opencode2-config.ts";
import { createOpenCode2Login } from "./opencode2-providers.ts";
import { INLINE_META } from "./opencode2-inline.ts";
import { FORK_META, forkCut } from "./opencode2-fork.ts";
import { createFolderReloads } from "./folder-reload.ts";
import { mapLimit } from "./session-scan.ts";
import { Session, type SessionOpts, type SessionSettings } from "./session.ts";

/** The longest `session.list` waits for the OpenCode server (it may start, or hang, for the first list). */
const LIST_WAIT_MS = 3000;
const PAGE = 100;
/** A list of one folder reads at most this many pages (a folder with more sessions shows the newest ones). */
const MAX_PAGES = 10;

export type OpenCode2CatalogueOpts = { server: OpenCodeServer; /** The longest a config dialog read waits for OpenCode (default 3 s). */ mcpWaitMs?: number; /** How long `session.list` waits for OpenCode (default 3 s). */ listWaitMs?: number; /** Writes the adapter record of a session (ADR 0015); throws when it cannot be saved. */ record?: (id: string) => void; /** The daemon's `/opencode-mcp` route (the session's MCP servers). */ mcp?: OpenCodeMcpRoute };
export type OpenCode2Catalogue = Omit<EngineCatalogue, "listScope" | "ownsId" | "settingsChanged" | "forget"> & { /** An OAuth login waits (a server restart would lose it). */ loginBusy(): boolean };

export function createOpenCode2Catalogue(ctx: CatalogueContext, o: OpenCode2CatalogueOpts): OpenCode2Catalogue {
  const { appSettings, settings } = ctx;
  const server = o.server;
  /** Directory and title of each session this daemon listed, created or opened. */
  const meta = new Map<string, { cwd: string; title: string }>();
  /** The fork sessions of the Fork runs of session `id` (sessions.json `forkOf`). */
  const forksOf = (id: string): ForkLink[] => settings.entries().flatMap(([forkId, l]) => (l.forkOf?.sessionId === id ? [{ forkId, callId: l.forkOf.callId, prefix: l.forkOf.prefix }] : []));
  const engine = createOpenCode2Engine(server, {
    onTitle: (id, title) => {
      const m = meta.get(id);
      if (!m || m.title === title) return;
      meta.set(id, { ...m, title });
      ctx.broadcast({ type: "sessions.changed" });
    },
    record: o.record,
    mcp: o.mcp,
    visualizeOn: () => appSettings.get().chat.visualize,
    onFork: (id, forkOf) => ctx.saveSettings(() => settings.set(id, { forkOf })),
    forksOf,
  });
  /** A config change saved while a session runs: the reload waits for idle (folder-reload.ts). Nothing to reload while the server is down. */
  const reloads = createFolderReloads({ all: true, reload: async (_cwd, folders) => !server.running() || engine.reloadLocations(folders), changed: (kind, cwd) => ctx.broadcast({ type: "config.changed", kind, cwd }) });
  const config: EngineConfig = {
    mcp: createOpenCode2McpConfig({ server, reload: (cwd, kind) => reloads.request(cwd, [kind]), waitMs: o.mcpWaitMs }),
    skills: createOpenCode2SkillsConfig({ server, engine, reload: (cwd, kind) => reloads.request(cwd, [kind]), waitMs: o.mcpWaitMs }),
    plugins: createOpenCode2PluginsConfig({ server, reload: (cwd, kind) => reloads.request(cwd, [kind]), waitMs: o.mcpWaitMs }),
  };
  // Provider login (GH-879): integrations are listed per folder; the folder of an open session, else the last one listed, else the home folder.
  const login = createOpenCode2Login({
    server,
    folder: () => [...ctx.liveSessions()].find((s) => meta.has(s.id))?.cwd ?? [...meta.values()].at(-1)?.cwd ?? homedir(),
    // OpenCode 2 reads credentials per request (checked on 2.3.0): no reload, the model lists are read again.
    changed: () => (engine.dropLimits(), ctx.broadcast({ type: "opencode.providersChanged" })),
  });
  const sessionOpts = (initial: Partial<SessionSettings>) => ({ ...ctx.sessionOpts(initial), engine });
  const failure = (err: unknown) => (err instanceof OpenCodeError ? new EngineError(err.code, err.message) : new EngineError("opencode_failed", (err as Error).message));
  const notFound = async () => (await import("@opencode/client")).isSessionNotFoundError;

  /** The row of a new OpenCode 2 session in `cwd` with the rules of its mode (and agent), recorded; undefined when the folder is being removed meanwhile. */
  async function createRow(cwd: string, mode: PermissionMode, agent?: string) {
    const client = await server.client();
    // `plan` is the plan agent in the default mode; the rules have the agent's denials (a folder whose agents cannot be read fails the create).
    const created = await engine.createRules(mode, cwd, agent);
    const row = await client.session.create({ location: { directory: cwd }, permissions: created.rules, ...(created.agent && { agent: created.agent }) });
    engine.noteCreated(row.id, created);
    // A session of OpenCode 2 is recorded at once: an OpenCode 1 binary must not open it. A failed save fails the create (the empty session stays in OpenCode).
    o.record?.(row.id);
    return ctx.isRemoving(cwd) || !existsSync(cwd) ? undefined : row;
  }

  async function createSession(cwd: string, initial: { model?: string; permissionMode: PermissionMode; effort?: SessionSettings["effort"] }): Promise<Session | undefined> {
    const row = await createRow(cwd, initial.permissionMode);
    if (!row) return undefined;
    const opts = sessionOpts(initial);
    const s = ctx.track(new Session(cwd, opts, { id: row.id }));
    // The entry makes the next list start OpenCode for a user whose last session was Claude's. `fields` empty: only a session without an entry is saved.
    (opts as SessionOpts).onSettings?.(s.run.settings(), s.id, []);
    meta.set(s.id, { cwd, title: row.title ?? "New session" });
    ctx.addProject(cwd);
    return s;
  }

  /** `/clear` (docs/spec.md "Sessions"): a new session with the model, mode, effort and agent of the cleared one. Not tracked here: `onCleared` tracks it. */
  engine.createHeir = async (cwd, carried) => {
    const row = await createRow(cwd, carried.permissionMode, carried.agent);
    if (!row) return undefined;
    // Saved before the session exists: its `opts.agent(id)` gives the carried agent.
    ctx.saveSettings(() => settings.set(row.id, { model: carried.model, permissionMode: carried.permissionMode, effort: carried.effort, ...(carried.agent && { agent: carried.agent }) }));
    meta.set(row.id, { cwd, title: row.title ?? "New session" });
    return new Session(cwd, sessionOpts(carried), { id: row.id });
  };

  let listError: string | undefined;
  /** OpenCode answered a session list once in this run. */
  let answered = false;
  let lateRefresh: Promise<unknown> | undefined;
  /** The list of a folder in flight: concurrent lists share it (the requests are never aborted, so they would pile up on a slow OpenCode). */
  type Row = { id: string; title: string; updated: number; archived: boolean; agent?: string };
  const reads = new Map<string, Promise<Row[]>>();
  const readFolder = (cwd: string) => {
    let p = reads.get(cwd);
    if (!p)
      reads.set(
        cwd,
        (p = (async () => {
          const client = await server.client();
          const rows: Row[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < MAX_PAGES; page++) {
            const r = await client.session.list({ directory: cwd, parentID: null, limit: PAGE, ...(cursor && { cursor }) });
            // An inline task's and a Fork run's session (opencode2-inline.ts, opencode2-fork.ts) are no sessions of the user's.
            rows.push(...r.data.filter((x) => !x.metadata?.[INLINE_META] && !x.metadata?.[FORK_META]).map((x) => ({ id: x.id, title: x.title ?? "New session", updated: x.time.updated, archived: !!x.time.archived, ...(x.agent && { agent: x.agent }) })));
            cursor = r.data.length >= PAGE ? (r.cursor.next ?? undefined) : undefined;
            if (!cursor) break;
          }
          return rows;
        })().finally(() => reads.delete(cwd))),
      );
    return p;
  };
  async function readList(cwds: string[], linked: Map<string, SavedSession>, links: (id: string) => object) {
    const out = { items: [] as SessionListItem[], ids: new Set<string>(), ran: false };
    try {
      const folders = await mapLimit(cwds, 4, async (cwd) => [cwd, await readFolder(cwd)] as const);
      listError = undefined;
      answered = true;
      out.ran = true;
      for (const [cwd, rows] of folders)
        for (const row of rows) {
          const saved = linked.get(row.id);
          // A fork whose metadata PATCH failed: its link hides it.
          if (saved?.forkOf) {
            out.ids.add(row.id);
            continue;
          }
          const loaded = ctx.session(row.id);
          const savedMode = OPENCODE_MODES.find((m) => m === saved?.permissionMode) ?? "default";
          const mode = savedMode === "plan" ? "default" : savedMode;
          // The agent OpenCode has for it, else the folder's default as last read.
          const agent = savedMode === "plan" ? "plan" : (row.agent ?? engine.defaultAgentKnown(cwd));
          const info = loaded?.info() ?? { id: row.id, cwd, state: "closed" as const, model: saved?.model ?? "default", permissionMode: mode, agent, effort: saved?.effort ?? "default", permissionModes: engine.permissionModes({ allowBypass: ctx.allowBypass }), capabilities: OPENCODE2_CAPABILITIES, engine: engine.name };
          meta.set(row.id, { cwd, title: row.title });
          out.ids.add(row.id);
          out.items.push({ ...info, id: row.id, cwd, title: row.title, lastActivity: row.updated, archived: row.archived, transcript: true, live: false, ...links(row.id) });
        }
    } catch (err) {
      const text = (err as Error).message;
      if (text !== listError) console.error("listing OpenCode 2 sessions failed:", text);
      listError = text;
    }
    return out;
  }
  /**
   * The sessions of `cwds`. Only when the server runs or OpenCode is wanted, so a Claude-only user never starts it. `ran`: the listing answered for every
   * folder (an entry missing from it is gone). Before OpenCode's first answer the list does not wait; later lists wait at most the list wait, and the late answer is
   * pushed as `sessions.changed`.
   */
  async function listSessions(cwds: string[], linked: Map<string, SavedSession>, links: (id: string) => object) {
    const none = () => ({ items: [] as SessionListItem[], ids: new Set<string>(), ran: false });
    if (!server.running() && !openCodeWanted(appSettings.get().sessions.engine, linked)) return none();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const late = new Promise<ReturnType<typeof none>>((resolve) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          const text = "OpenCode did not answer the session list in time";
          if (answered && text !== listError) console.error(`listing OpenCode 2 sessions failed: ${text}`);
          listError = text;
          resolve(none());
        },
        answered ? (o.listWaitMs ?? LIST_WAIT_MS) : 0,
      );
    });
    try {
      const read = readList(cwds, linked, links);
      const r = await Promise.race([read, late]);
      if (!r.ran && timedOut && !lateRefresh) lateRefresh = read.then((x) => x.ran && ctx.broadcast({ type: "sessions.changed" })).finally(() => (lateRefresh = undefined));
      return r;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A session rebuilt from its stored messages. Its folder: the one listed or created, else the one OpenCode has for it. */
  async function restoreSession(id: string): Promise<Session | undefined> {
    const known = meta.get(id);
    const client = await server.client();
    // A session OpenCode 2 does not have (an OpenCode 1 one it did not import) answers 404: undefined here, the catalogue switch decides what that means.
    // Only "not found" means that; a timeout or a restarting server is an error, not a lost session.
    const { isSessionNotFoundError } = await import("@opencode/client");
    const row = await client.session.get({ sessionID: id }).catch((err) => (isSessionNotFoundError(err) ? undefined : Promise.reject(err)));
    const cwd = row && ctx.allowed(known?.cwd ?? row.location.directory);
    if (!row || !cwd || ctx.isRemoving(cwd)) return undefined;
    const history = await loadOpenCode2History(client, id, cwd, (sid) => engine.isOurs(id, sid), forksOf(id));
    meta.set(id, { cwd, title: row.title ?? "New session" });
    const saved = settings.get(id);
    const permissionMode = OPENCODE_MODES.includes(saved?.permissionMode as never) ? (saved!.permissionMode as SessionSettings["permissionMode"]) : undefined;
    const effort = EFFORTS.includes(saved?.effort as never) ? (saved!.effort as SessionSettings["effort"]) : undefined;
    const model = isModel(saved?.model) ? saved.model : undefined;
    return ctx.track(Session.restore(id, cwd, history as never, sessionOpts({ model, permissionMode, effort })));
  }

  async function forkForAside(owner: Session, title: string): Promise<{ id: string } | { unavailable: string }> {
    const client = await server.client();
    const cut = await forkCut(client, owner.id);
    if (!cut) return { unavailable: "An aside needs a message in this session first" };
    const row = await client.session.fork({ sessionID: owner.id, ...cut });
    try {
      meta.set(row.id, { cwd: owner.cwd, title });
      await client.session.update({ sessionID: row.id, title });
      // Recorded once usable: a failed save removes the fork like any other failure here.
      o.record?.(row.id);
      return { id: row.id };
    } catch (e) {
      // The fork exists but is not usable: it is not left behind.
      await client.session.remove({ sessionID: row.id }).then(
        () => meta.delete(row.id),
        () => {},
      );
      throw e;
    }
  }

  return {
    engine,
    config,
    requests: login.requests,
    loginBusy: login.busy,
    settled: () => reloads.settled(),
    close: async () => reloads.close(),
    // Listed, created or opened here: not a UUID (the transcript scan's shape), so it is not found by one.
    isLocal: async (id) => meta.has(id),
    knownIds: async () => [...meta.keys()],
    entry: () => ({ engine: engine.name, capabilities: OPENCODE2_CAPABILITIES, permissionModes: engine.permissionModes({ allowBypass: ctx.allowBypass }) }),
    // OpenCode's own permission config decides; sessions.defaultMode is Claude's.
    startMode: async () => "config",
    create: async (cwd, initial) => {
      try {
        return await createSession(cwd, { model: initial.model, permissionMode: initial.permissionMode ?? "default", effort: initial.effort });
      } catch (err) {
        throw failure(err);
      }
    },
    list: async (lctx: ListCtx): Promise<CatalogueList> => {
      const { linked, links } = lctx.read();
      const r = await listSessions(lctx.folders ?? [], linked, links);
      // Prunes nothing: a settings entry of an OpenCode 1 session is not in OpenCode 2's list, and nothing tells it from a deleted one here.
      return { items: r.items, keep: () => true };
    },
    restore: (id) => restoreSession(id).catch((err) => Promise.reject(failure(err))),
    locate: async (id, live) => {
      // The folder it was listed, created or opened in; its store is OpenCode's. One not seen in this run (an Aside left by a stopped daemon, GH-907) is asked:
      // undefined only when OpenCode 2 does not have it, so a failed read never drops what claude-ui keeps of a session that still exists.
      let cwd = live?.cwd ?? meta.get(id)?.cwd;
      if (!cwd) {
        const client = await server.client().catch((err) => Promise.reject(failure(err)));
        const gone = await notFound();
        const row = await client.session.get({ sessionID: id }).catch((err) => (gone(err) ? undefined : Promise.reject(failure(err))));
        cwd = row && ctx.allowed(row.location.directory);
        if (cwd) meta.set(id, { cwd, title: row!.title ?? "New session" });
      }
      return cwd && ctx.allowed(cwd) ? { cwd, transcript: false } : undefined;
    },
    title: async (s) => meta.get(s.id)?.title ?? "New session",
    rename: async (id, cwd, title) => {
      try {
        await (await server.client()).session.update({ sessionID: id, title });
      } catch (err) {
        throw failure(err);
      }
      meta.set(id, { cwd, title });
    },
    archive: async (id, _cwd, archived) => {
      try {
        await (await server.client()).session.update({ sessionID: id, archived });
      } catch (err) {
        throw failure(err);
      }
    },
    delete: async (id) => {
      try {
        const client = await server.client();
        const gone = await notFound();
        // Already gone in OpenCode 2 (deleted in its own app): the delete removes what claude-ui keeps of it.
        await client.session.remove({ sessionID: id }).catch((err) => (gone(err) ? undefined : Promise.reject(err)));
      } catch (err) {
        throw failure(err);
      }
      meta.delete(id);
      // Its Fork runs' forks go with it (OpenCode 1 does the same).
      const forks = forksOf(id).map((f) => f.forkId);
      if (forks.length) {
        const client = await server.client().catch(() => undefined);
        // One already gone (or a failed remove) is no failure of the delete.
        await Promise.all(forks.map((forkId) => client?.session.remove({ sessionID: forkId }).catch(() => undefined)));
        ctx.saveSettings(() => settings.delete(forks));
      }
    },
    forkForAside: (owner, title) => forkForAside(owner, title).catch((err) => Promise.reject(failure(err))),
    commands: (cwd) => engine.commands(cwd),
    agents: async (cwd) => (await engine.primaryFirst(cwd)).map(({ id, description }) => ({ name: id, ...(description && { description }) })),
    models: (cwd) => engine.modelInfos(cwd),
  };
}
