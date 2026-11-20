// The OpenCode 2 adapter's catalogue (ADR 0015). Slice 1: a stub. OpenCode 2 is detected and its server runs; nothing of its API is used yet.
import { EngineError, type EngineCatalogue } from "./engine-catalogue.ts";
import type { OpenCodeServer } from "./opencode-server.ts";

export type OpenCode2CatalogueOpts = { server: OpenCodeServer };
export type OpenCode2Catalogue = Omit<EngineCatalogue, "engine" | "listScope" | "ownsId" | "entry" | "requests" | "settingsChanged" | "settled" | "forget" | "close">;

/** Shown wherever an OpenCode 2 binary would need the adapter that is not there yet. */
export const openCode2Unsupported = (what = "OpenCode 2 sessions") =>
  new EngineError("opencode_v2_unsupported", `${what} are not supported yet. Set Settings › OpenCode › path to an OpenCode 1 binary.`);

export function createOpenCode2Catalogue(_o: OpenCode2CatalogueOpts): OpenCode2Catalogue {
  const unsupported = async (): Promise<never> => {
    throw openCode2Unsupported();
  };
  return {
    isLocal: async () => false,
    knownIds: async () => [],
    startMode: async () => "config",
    // No server start: OpenCode 2's first start imports the user's OpenCode 1 history once and changes `opencode.db`, after which OpenCode 1 cannot start on it.
    create: unsupported,
    // Lists nothing and prunes nothing: the OpenCode 1 entries of the settings file stay.
    list: async () => ({ items: [], keep: () => true }),
    restore: async () => undefined,
    locate: async () => undefined,
    title: async () => "New session",
    rename: unsupported,
    archive: unsupported,
    delete: unsupported,
    forkForAside: unsupported,
    commands: async () => [],
    agents: async () => [],
    models: async () => [],
  };
}
