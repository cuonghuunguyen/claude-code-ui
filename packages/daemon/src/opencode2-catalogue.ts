// The OpenCode 2 adapter's catalogue (ADR 0015): creates, lists and restores sessions of the daemon's OpenCode 2 server through `@opencode/client`.
// Slice 2: create, list, restore, models. Rename, archive, delete, Aside, agents and slash commands are later slices and answer `opencode_v2_unsupported`.
import { existsSync } from "node:fs";
import { EFFORTS, type PermissionMode, type SessionListItem } from "@claude-ui/protocol";
import { EngineError, isModel, type CatalogueContext, type CatalogueList, type EngineCatalogue, type ListCtx, type SavedSession } from "./engine-catalogue.ts";
import { OPENCODE_MODES } from "./opencode-engine.ts";
import { openCodeWanted } from "./opencode-catalogue.ts";
import { OpenCodeError, type OpenCodeServer } from "./opencode-server.ts";
import { createOpenCode2Engine, loadOpenCode2History, modeRules, OPENCODE2_CAPABILITIES } from "./opencode2-engine.ts";
import { mapLimit } from "./session-scan.ts";
import { Session, type SessionOpts, type SessionSettings } from "./session.ts";

/** The longest `session.list` waits for the OpenCode server (it may start, or hang, for the first list). */
const LIST_WAIT_MS = 3000;
const PAGE = 100;
/** A list of one folder reads at most this many pages (a folder with more sessions shows the newest ones). */
const MAX_PAGES = 10;

export type OpenCode2CatalogueOpts = { server: OpenCodeServer; /** How long `session.list` waits for OpenCode (default 3 s). */ listWaitMs?: number };
export type OpenCode2Catalogue = Omit<EngineCatalogue, "listScope" | "ownsId" | "requests" | "settingsChanged" | "settled" | "forget" | "close">;

/** Shown wherever OpenCode 2 would need an adapter feature that is not there yet. */
export const openCode2Unsupported = (what = "OpenCode 2 sessions") =>
  new EngineError("opencode_v2_unsupported", `${what} are not supported yet. Set Settings › OpenCode › path to an OpenCode 1 binary.`);

export function createOpenCode2Catalogue(ctx: CatalogueContext, o: OpenCode2CatalogueOpts): OpenCode2Catalogue {
  const { appSettings, settings } = ctx;
  const server = o.server;
  /** Directory and title of each session this daemon listed, created or opened. */
  const meta = new Map<string, { cwd: string; title: string }>();
  const engine = createOpenCode2Engine(server, {
    onTitle: (id, title) => {
      const m = meta.get(id);
      if (!m || m.title === title) return;
      meta.set(id, { ...m, title });
      ctx.broadcast({ type: "sessions.changed" });
    },
  });
  const sessionOpts = (initial: Partial<SessionSettings>) => ({ ...ctx.sessionOpts(initial), engine });
  const failure = (err: unknown) => (err instanceof OpenCodeError ? new EngineError(err.code, err.message) : new EngineError("opencode_failed", (err as Error).message));
  const unsupported = (what: string) => async (): Promise<never> => {
    throw openCode2Unsupported(what);
  };

  async function createSession(cwd: string, initial: { model?: string; permissionMode: PermissionMode; effort?: SessionSettings["effort"] }): Promise<Session | undefined> {
    const client = await server.client();
    // `plan` is the plan agent (a later slice): it starts as the default mode.
    const mode = initial.permissionMode === "plan" ? "default" : initial.permissionMode;
    const row = await client.session.create({ location: { directory: cwd }, permissions: modeRules(mode) });
    if (ctx.isRemoving(cwd) || !existsSync(cwd)) return undefined;
    const opts = sessionOpts({ ...initial, permissionMode: mode });
    const s = ctx.track(new Session(cwd, opts, { id: row.id }));
    // The entry makes the next list start OpenCode for a user whose last session was Claude's. `fields` empty: only a session without an entry is saved.
    (opts as SessionOpts).onSettings?.(s.run.settings(), s.id, []);
    meta.set(s.id, { cwd, title: row.title ?? "New session" });
    ctx.addProject(cwd);
    return s;
  }

  let listError: string | undefined;
  /** OpenCode answered a session list once in this run. */
  let answered = false;
  let lateRefresh: Promise<unknown> | undefined;
  /** The list of a folder in flight: concurrent lists share it (the requests are never aborted, so they would pile up on a slow OpenCode). */
  const reads = new Map<string, Promise<{ id: string; title: string; updated: number; archived: boolean }[]>>();
  const readFolder = (cwd: string) => {
    let p = reads.get(cwd);
    if (!p)
      reads.set(
        cwd,
        (p = (async () => {
          const client = await server.client();
          const rows: { id: string; title: string; updated: number; archived: boolean }[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < MAX_PAGES; page++) {
            const r = await client.session.list({ directory: cwd, parentID: null, limit: PAGE, ...(cursor && { cursor }) });
            rows.push(...r.data.map((x) => ({ id: x.id, title: x.title ?? "New session", updated: x.time.updated, archived: !!x.time.archived })));
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
          const loaded = ctx.session(row.id);
          const saved = linked.get(row.id);
          const savedMode = OPENCODE_MODES.find((m) => m === saved?.permissionMode) ?? "default";
          const mode = savedMode === "plan" ? "default" : savedMode;
          const info = loaded?.info() ?? { id: row.id, cwd, state: "closed" as const, model: saved?.model ?? "default", permissionMode: mode, agent: "build", effort: saved?.effort ?? "default", permissionModes: engine.permissionModes({ allowBypass: ctx.allowBypass }), capabilities: OPENCODE2_CAPABILITIES, engine: engine.name };
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
    // A session OpenCode 2 does not have (an OpenCode 1 one, until the adapter record lands) answers 404: it is gone here.
    // Only "not found" means gone; a timeout or a restarting server is an error, not a lost session.
    const row = await client.session.get({ sessionID: id }).catch((err) => ((err as { _tag?: string })._tag === "SessionNotFoundError" ? undefined : Promise.reject(err)));
    const cwd = row && ctx.allowed(known?.cwd ?? row.location.directory);
    if (!row || !cwd || ctx.isRemoving(cwd)) return undefined;
    const history = await loadOpenCode2History(client, id, cwd, (sid) => engine.isOurs(id, sid));
    meta.set(id, { cwd, title: row.title ?? "New session" });
    const saved = settings.get(id);
    const permissionMode = OPENCODE_MODES.includes(saved?.permissionMode as never) ? (saved!.permissionMode as SessionSettings["permissionMode"]) : undefined;
    const effort = EFFORTS.includes(saved?.effort as never) ? (saved!.effort as SessionSettings["effort"]) : undefined;
    const model = isModel(saved?.model) ? saved.model : undefined;
    return ctx.track(Session.restore(id, cwd, history as never, sessionOpts({ model, permissionMode, effort })));
  }

  return {
    engine,
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
      // Prunes nothing: a settings entry of an OpenCode 1 session is not in OpenCode 2's list, and only the adapter record of a later slice tells the two apart.
      return { items: r.items, keep: () => true };
    },
    restore: (id) => restoreSession(id).catch((err) => Promise.reject(failure(err))),
    locate: async (id, live) => {
      // The folder it was listed, created or opened in; its store is OpenCode's.
      const cwd = live?.cwd ?? meta.get(id)?.cwd;
      return cwd && ctx.allowed(cwd) ? { cwd, transcript: false } : undefined;
    },
    title: async (s) => meta.get(s.id)?.title ?? "New session",
    rename: unsupported("Renaming, archiving and deleting OpenCode 2 sessions"),
    archive: unsupported("Renaming, archiving and deleting OpenCode 2 sessions"),
    delete: unsupported("Renaming, archiving and deleting OpenCode 2 sessions"),
    forkForAside: async () => ({ unavailable: "An aside is not available for OpenCode 2 sessions yet" }),
    commands: async () => [],
    agents: async () => [],
    models: (cwd) => engine.modelInfos(cwd),
  };
}
