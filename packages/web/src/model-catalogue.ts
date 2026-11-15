import { DEFAULT_ENGINE, type Engine, type EngineCapabilities, type ModelInfo } from "@claude-ui/protocol";

/** What a model list belongs to: an Engine, and for an Engine with `providers` the Side of the folder (that Side has its own providers). */
export type ModelSource = { engine: Engine; capabilities: EngineCapabilities; side?: string; cwd?: string };
type State = { lists: Record<string, ModelInfo[] | undefined>; errors: Record<string, string> };

const NO_MODELS: ModelInfo[] = [];

/**
 * Model lists per Engine (ADR 0012), no React. An Engine without `providers` has the daemon's list sent with the connection (`setDaemonList`);
 * one with `providers` is fetched the first time a session or draft of it shows, dropped on a provider change, and kept per Side (`engine@side`).
 */
export function createModelCatalogue({ fetch }: { fetch(engine: Engine, cwd?: string): Promise<ModelInfo[]> }) {
  let state: State = { lists: {}, errors: {} };
  const requested = new Set<string>();
  const listeners = new Set<() => void>();
  const set = (next: State) => ((state = next), listeners.forEach((l) => l()));
  const keyOf = ({ engine, capabilities, side }: ModelSource) => (capabilities.providers && side ? `${engine}@${side}` : engine);
  const without = <T>(rec: Record<string, T>, drop: (k: string) => boolean): Record<string, T> => Object.fromEntries(Object.entries(rec).filter(([k]) => !drop(k)));

  const load = (src: ModelSource) => {
    const key = keyOf(src);
    if (!src.capabilities.providers || requested.has(key)) return;
    requested.add(key);
    // The folder's own OpenCode instance lists its models (project providers), on this machine and on a Side: `cwd` routes the request.
    fetch(src.engine, src.cwd).then(
      (models) => set({ lists: { ...state.lists, [key]: models }, errors: without(state.errors, (k) => k === key) }),
      (e: Error) => (requested.delete(key), e.message !== "disconnected" && set({ ...state, errors: { ...state.errors, [key]: e.message } })),
    );
  };
  return {
    /** The Engine's own list that came with the connection. */
    setDaemonList: (models: ModelInfo[]) => set({ ...state, lists: { ...state.lists, [DEFAULT_ENGINE]: models } }),
    list: (src: ModelSource) => state.lists[keyOf(src)] ?? NO_MODELS,
    /** Why the list failed to load. */
    error: (src: ModelSource) => state.errors[keyOf(src)],
    load,
    retry: (src: ModelSource) => {
      const key = keyOf(src);
      requested.delete(key);
      set({ ...state, errors: without(state.errors, (k) => k === key) });
      load(src);
    },
    /** A new connection: lists are fetched again where they are missing. */
    reconnected: () => requested.clear(),
    /** The Engine read another provider set: every list of it (all Sides) is fetched again the next time it shows. */
    providersChanged: (engine: Engine) => {
      const of = (k: string) => k === engine || k.startsWith(`${engine}@`);
      for (const k of [...requested]) if (of(k)) requested.delete(k);
      set({ lists: without(state.lists, of), errors: without(state.errors, of) });
    },
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    snapshot: () => state,
  };
}
export type ModelCatalogue = ReturnType<typeof createModelCatalogue>;
