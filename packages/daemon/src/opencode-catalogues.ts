// The one OpenCode Engine catalogue (ADR 0015): one `opencode serve` process shared by both adapters, and a switch by the major version of the installed binary.
import { EngineError, type CatalogueContext, type CatalogueList, type EngineCatalogue, type EngineRequest, type ListCtx } from "./engine-catalogue.ts";
import { createOpenCodeAdapters } from "./opencode-adapters.ts";
import { createOpenCodeCatalogue, OPENCODE_ID, openCodeWanted, type OpenCodeCatalogueOpts } from "./opencode-catalogue.ts";
import { createOpenCode2Catalogue } from "./opencode2-catalogue.ts";
import { createOpenCodeServer } from "./opencode-server.ts";

/** A failed `--version` is not run again for this long. */
const NEGATIVE_MS = 60_000;
/** The longest `session.list` waits for `--version` (the normal list wait of the OpenCode catalogue). */
const LIST_WAIT_MS = 3000;
/** Requests that stay valid under version 2: they only touch the shared server. */
const SHARED_REQUESTS = new Set(["opencode.status", "opencode.restart"]);

export function createOpenCodeCatalogues(ctx: CatalogueContext, o: OpenCodeCatalogueOpts & { /** opencode-adapters.json (default: in memory). */ adaptersFile?: string }): EngineCatalogue {
  const srv = createOpenCodeServer({ path: () => ctx.appSettings.get().opencode.path, ...o.server });
  const adapters = createOpenCodeAdapters(o.adaptersFile);
  const v1 = createOpenCodeCatalogue(ctx, { ...o, server: { ...o.server, instance: srv } });
  const v2 = createOpenCode2Catalogue(ctx, {
    server: srv,
    mcp: o.mcp,
    listWaitMs: o.server?.listWaitMs,
    record: (id) => {
      try {
        adapters.set2(id);
      } catch (err) {
        throw new Error(`Could not save which OpenCode version the session belongs to (opencode-adapters.json): ${(err as Error).message}`);
      }
    },
  });
  /** Version 2 only when the binary said so; unknown = version 1, so a Claude-only user never starts a check. */
  const pick = () => (srv.major() === 2 ? v2 : v1);
  /** One `--version` run at a time, shared by every caller. A failure (missing, old, hung binary) is remembered for NEGATIVE_MS: it is not run again on every list.
   * A change of `opencode.path` and `opencode.restart` forget it. The memory never lets the OpenCode 1 adapter start an OpenCode 2 server: the server refuses a binary
   * of the other major (opencode-server.ts ensure). */
  let checking: Promise<void> | undefined;
  let failedAt = 0;
  /** A check ended (either way): later lists wait for the next one, the first list does not (as the OpenCode 1 list before OpenCode first answered). */
  let checkedOnce = false;
  /** Bumped by `forget()`: the answer of a check of the previous binary is dropped. */
  let gen = 0;
  const check = () => {
    if (checking) return checking;
    const g = gen;
    const run: Promise<void> = srv
      .check()
      .then(
        () => void (g === gen && (failedAt = 0)),
        () => void (g === gen && (failedAt = Date.now())),
      )
      .finally(() => {
        if (checking === run) checking = undefined;
        checkedOnce = true;
      });
    return (checking = run);
  };
  const forget = () => ((gen += 1), (failedAt = 0), (checking = undefined));
  const recentlyFailed = () => failedAt > 0 && Date.now() - failedAt < NEGATIVE_MS;
  /** Makes the major known before a method that needs the server. A missing or old binary is left to the adapter's own error. */
  const known = async () => {
    if (srv.major() === undefined && !recentlyFailed()) await check();
    return pick();
  };
  const mismatch = (needs: 1 | 2) => new EngineError("opencode_version_mismatch", `This session needs an OpenCode ${needs} binary. Set Settings › OpenCode › path to one.`);
  /**
   * The adapter of a stored session (ADR 0015). A session recorded as version 2 never opens under an OpenCode 1 binary: its copy there (an import from before) misses the version 2 turns.
   * A session with no record belongs to version 1, unless the installed version 2 has it (the adapter looks, see `restore`). An unknown version (missing or old binary) is left to the adapter's own error.
   */
  const forId = async (id: string) => {
    const a = await known();
    if (a === v1 && srv.major() === 1 && adapters.get(id) === 2) throw mismatch(2);
    return a;
  };
  /** The list of the adapter in use. Only a user whose Engine is OpenCode or who has a stored OpenCode session asks the binary. The first list does not wait for it, later lists at most the normal list wait: a hung or slow
   * `--version` lists nothing and prunes nothing (the settings entries stay), the late sessions are pushed as `sessions.changed`. While the major is unknown
   * (check pending or failed) no adapter lists. A Claude-only user never starts a check. */
  const listOf = async (lctx: ListCtx): Promise<CatalogueList> => {
    if (srv.major() === undefined && openCodeWanted(ctx.appSettings.get().sessions.engine, lctx.read().linked)) {
      if (recentlyFailed()) return { items: [], keep: () => true };
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), checkedOnce ? (o.server?.listWaitMs ?? LIST_WAIT_MS) : 0)));
      const ran = check();
      await Promise.race([ran, late]).finally(() => clearTimeout(timer));
      if (srv.major() === undefined) {
        // The answer goes on as the adapter's own list would have gone on: OpenCode 1 starts its server and pushes `sessions.changed` when it answered.
        void ran
          .then(async () => {
            if (srv.major() !== undefined && (await pick().list(lctx)).items.length) ctx.broadcast({ type: "sessions.changed" });
          })
          .catch(() => {});
        return { items: [], keep: () => true };
      }
    }
    return pick().list(lctx);
  };
  const requests: Record<string, EngineRequest> = {};
  for (const [type, handler] of Object.entries(v1.requests ?? {}))
    requests[type] = async (msg, reply, fail) => {
      if (type === "opencode.restart") forget();
      if (SHARED_REQUESTS.has(type) || (await known()) === v1) return handler!(msg, reply, fail);
      return fail("opencode_v2_unsupported", "OpenCode 2 does not support provider login in claude-ui yet.");
    };
  return {
    engine: v1.engine,
    // The config dialogs of OpenCode 2 wait for its adapter (GH-863): until then the request is answered, not routed to version 1.
    config: {
      mcp: async (msg, cwd, c) => {
        if ((await known()) !== v1) throw new EngineError("opencode_v2_unsupported", "OpenCode 2 does not support the MCP servers dialog in claude-ui yet.");
        return v1.config!.mcp(msg, cwd, c);
      },
      skills: async (msg, cwd) => {
        if ((await known()) !== v1) throw new EngineError("opencode_v2_unsupported", "OpenCode 2 does not support the skills dialog in claude-ui yet.");
        return v1.config!.skills(msg, cwd);
      },
      plugins: async (msg, cwd) => {
        if ((await known()) !== v1) throw new EngineError("opencode_v2_unsupported", "OpenCode 2 does not support the Plugins dialog in claude-ui yet.");
        return v1.config!.plugins(msg, cwd);
      },
    },
    listScope: v1.listScope,
    ownsId: v1.ownsId,
    entry: () => pick().entry(),
    isLocal: (id) => pick().isLocal(id),
    knownIds: () => pick().knownIds(),
    startMode: (cwd, model) => pick().startMode(cwd, model),
    // Creating starts the server anyway: always read the version first.
    create: async (cwd, initial, opts) => (await known()).create(cwd, initial, opts),
    list: async (lctx) => {
      const r = await listOf(lctx);
      // A session recorded as version 2 is no entry to prune when the binary is version 1: its settings come back with the version 2 binary.
      return { ...r, keep: (id) => adapters.get(id) === 2 || r.keep(id) };
    },
    restore: async (id, background) => {
      const a = await forId(id);
      const s = await a.restore(id, background);
      // Version 2 lacks a session with no record: an OpenCode 1 session it did not import. Known to this daemon (it has an entry) = it needs the OpenCode 1 binary; else it is gone.
      if (!s && a === v2 && adapters.get(id) === 1 && ctx.settings.get(id)) throw mismatch(1);
      return s;
    },
    locate: async (id, live) => {
      const a = await known();
      // Recorded as version 2 under an OpenCode 1 binary: the session is not found there (opening it says why).
      return a === v1 && srv.major() === 1 && adapters.get(id) === 2 ? undefined : a.locate(id, live);
    },
    title: (s) => pick().title(s),
    rename: async (id, cwd, title) => (await forId(id)).rename(id, cwd, title),
    archive: async (id, cwd, archived) => (await forId(id)).archive(id, cwd, archived),
    delete: async (id, at) => {
      const a = await forId(id);
      await a.delete(id, at);
      if (a !== v2) return;
      // The session is gone already: a record that cannot be removed only costs its line in the file.
      try {
        adapters.drop(id);
      } catch (err) {
        console.error(`session ${id}: removing its OpenCode adapter record failed:`, (err as Error).message);
      }
    },
    forkForAside: async (owner, title) => (await forId(owner.id)).forkForAside(owner, title),
    commands: async (cwd) => (await known()).commands(cwd),
    agents: async (cwd) => (await known()).agents(cwd),
    models: async (cwd) => (await known()).models(cwd),
    // A leftover Aside is looked up in OpenCode: while the server is down that waits for its start (GH-945).
    deferCleanup: (id) => OPENCODE_ID.test(id) && !srv.running(),
    onServerUp: (cb) => void srv.onUp(cb),
    settled: () => v1.settled?.(),
    forget: (id) => v1.forget?.(id),
    settingsChanged: (before, after) => {
      if (after.opencode.path === before.opencode.path) return v1.settingsChanged?.(before, after);
      const wasRunning = srv.running();
      v1.settingsChanged?.(before, after); // resets the server and its remembered version synchronously
      forget();
      // The sidebar list and Settings show the old binary's sessions and version until the new binary was asked: ask now, then tell the clients.
      if (wasRunning || openCodeWanted(after.sessions.engine, new Map(ctx.settings.entries()))) void check().finally(() => ctx.broadcast({ type: "sessions.changed" }));
    },
    requests,
    close: () => v1.close(),
  };
}
