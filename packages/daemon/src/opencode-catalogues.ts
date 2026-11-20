// The one OpenCode Engine catalogue (ADR 0015): one `opencode serve` process shared by both adapters, and a switch by the major version of the installed binary.
import type { CatalogueContext, EngineCatalogue, EngineRequest } from "./engine-catalogue.ts";
import { createOpenCodeCatalogue, type OpenCodeCatalogueOpts } from "./opencode-catalogue.ts";
import { createOpenCode2Catalogue } from "./opencode2-catalogue.ts";
import { createOpenCodeServer } from "./opencode-server.ts";

/** A failed `--version` is not run again for this long. */
const NEGATIVE_MS = 60_000;
/** The longest `session.list` waits for `--version` (the normal list wait of the OpenCode catalogue). */
const LIST_WAIT_MS = 3000;
/** Requests that stay valid under version 2: they only touch the shared server. */
const SHARED_REQUESTS = new Set(["opencode.status", "opencode.restart"]);

export function createOpenCodeCatalogues(ctx: CatalogueContext, o: OpenCodeCatalogueOpts): EngineCatalogue {
  const srv = createOpenCodeServer({ path: () => ctx.appSettings.get().opencode.path, ...o.server });
  const v1 = createOpenCodeCatalogue(ctx, { ...o, server: { ...o.server, instance: srv } });
  const v2 = createOpenCode2Catalogue({ server: srv });
  /** Version 2 only when the binary said so; unknown = version 1, so a Claude-only user never starts a check. */
  const pick = () => (srv.major() === 2 ? v2 : v1);
  /** One `--version` run at a time, shared by every caller. A failure (missing, old, hung binary) is remembered for NEGATIVE_MS: it is not run again on every list. */
  let checking: Promise<void> | undefined;
  let failedAt = 0;
  const check = () =>
    (checking ??= srv.check().then(
      () => void (failedAt = 0),
      () => void (failedAt = Date.now()),
    ).finally(() => (checking = undefined)));
  const recentlyFailed = () => failedAt > 0 && Date.now() - failedAt < NEGATIVE_MS;
  /** Makes the major known before a method that needs the server. A missing or old binary is left to the adapter's own error. */
  const known = async () => {
    if (srv.major() === undefined && !recentlyFailed()) await check();
    return pick();
  };
  const requests: Record<string, EngineRequest> = {};
  for (const [type, handler] of Object.entries(v1.requests ?? {}))
    requests[type] = async (msg, reply, fail) => {
      if (SHARED_REQUESTS.has(type) || (await known()) === v1) return handler!(msg, reply, fail);
      return fail("opencode_v2_unsupported", "OpenCode 2 does not support provider login in claude-ui yet.");
    };
  return {
    engine: v1.engine,
    listScope: v1.listScope,
    ownsId: v1.ownsId,
    entry: v1.entry,
    isLocal: (id) => pick().isLocal(id),
    knownIds: () => pick().knownIds(),
    startMode: (cwd, model) => pick().startMode(cwd, model),
    // Creating starts the server anyway: always read the version first.
    create: async (cwd, initial, opts) => (await known()).create(cwd, initial, opts),
    // Only a user whose Engine is OpenCode asks the binary, and the list never waits longer than the normal list wait for it: a hung or slow `--version`
    // lists nothing and prunes nothing (the settings entries stay), the late answer is pushed as `sessions.changed`. A Claude-only user never starts a check.
    list: async (lctx) => {
      if (srv.major() === undefined && ctx.appSettings.get().sessions.engine === v1.engine.name && !recentlyFailed()) {
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), o.server?.listWaitMs ?? LIST_WAIT_MS)));
        const ran = check();
        const r = await Promise.race([ran.then(() => "done" as const), late]).finally(() => clearTimeout(timer));
        if (r === "late" && srv.major() === undefined) {
          void ran.then(() => srv.major() !== undefined && ctx.broadcast({ type: "sessions.changed" }));
          return { items: [], keep: () => true };
        }
      }
      return pick().list(lctx);
    },
    restore: async (id, background) => (await known()).restore(id, background),
    locate: async (id, live) => (await known()).locate(id, live),
    title: (s) => pick().title(s),
    rename: async (id, cwd, title) => (await known()).rename(id, cwd, title),
    archive: async (id, cwd, archived) => (await known()).archive(id, cwd, archived),
    delete: async (id, at) => (await known()).delete(id, at),
    forkForAside: async (owner, title) => (await known()).forkForAside(owner, title),
    commands: async (cwd) => (await known()).commands(cwd),
    agents: async (cwd) => (await known()).agents(cwd),
    models: async (cwd) => (await known()).models(cwd),
    settled: () => v1.settled?.(),
    forget: (id) => v1.forget?.(id),
    settingsChanged: (before, after) => v1.settingsChanged?.(before, after),
    requests,
    close: () => v1.close(),
  };
}
