// sessions.json: each session's model, permission mode and effort for a restore after a restart (docs/spec.md "Sessions").
import { createJsonFile } from "./json-file.ts";
import type { SessionSettings } from "./session.ts";

/** sessions.json keeps the settings of this many sessions (most recently changed). */
export const MAX_SETTINGS = 1000;

/**
 * `prune` keeps a transcript-less entry saved this recently: it may belong to a new session live on another daemon of the
 * user (other port), whose transcript appears only with its first prompt.
 */
export const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Orchestration links (orchestration.ts): a worker has its coordinator's ID, its name, its cwd and the port of the daemon that
 * started it. A coordinator is any session that has a worker. (Files from before may still hold `role: "coordinator"`: ignored.)
 */
export type Link = { coordinatorId?: string; name?: string; cwd?: string; port?: number };
/** `saved`: when the entry last changed (ms); absent in files written before GH-91. */
type Entry = Partial<SessionSettings> & Link & { saved?: number };
const SETTINGS: (keyof SessionSettings)[] = ["model", "permissionMode", "effort"];
type Stored = Record<string, Entry>;

/** Without `file` the settings live in memory only (tests). Changes throw when the save fails; reads never throw. */
export function createSessionSettings({ file, max = MAX_SETTINGS, now = Date.now }: { file?: string; max?: number; now?: () => number } = {}) {
  // Insertion order = last change order: the oldest entries go first past `max`.
  const store = createJsonFile<Stored>(file, (raw) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Stored) : {}), "session settings");
  const remove = (ids: string[]) => store.change((d) => ids.forEach((id) => delete d[id]));
  return {
    get: (id: string): Entry | undefined => store.get()[id],
    ids: () => Object.keys(store.get()),
    entries: () => Object.entries(store.get()),
    /**
     * Sets only `fields` of `s` (default: all it has): another daemon's change to the other fields of the session stays.
     * Without settings in the latest file's entry (new session, only a link, or another daemon deleted it) all of `s` is saved.
     */
    set<S extends Partial<SessionSettings & Link>>(id: string, s: S, fields = Object.keys(s) as (keyof S)[]) {
      store.change((d) => {
        const old = d[id];
        const some = old && SETTINGS.some((k) => old[k] !== undefined);
        const entry = { ...old, ...(some ? Object.fromEntries(fields.map((k) => [k, s[k]])) : s), saved: now() };
        delete d[id];
        d[id] = entry;
        const ids = Object.keys(d);
        for (const old of ids.slice(0, Math.max(0, ids.length - max))) delete d[old];
      });
    },
    delete: remove,
    /** Removes the entries `keep` rejects (no transcript, not live here) that were saved before the grace period. */
    prune(keep: (id: string) => boolean) {
      const old = now() - PRUNE_GRACE_MS;
      const stale = Object.entries(store.get()).filter(([id, e]) => !keep(id) && !((e.saved ?? 0) > old)).map(([id]) => id);
      if (stale.length) remove(stale);
    },
  };
}

export type SessionSettingsStore = ReturnType<typeof createSessionSettings>;
