/**
 * `session.list` versions (GH-767): a reconnecting page asks for the list again and gets about the same 200 KB. The daemon keeps the
 * last few list results it sent, each under a version; a request that names one (`since`) gets only the session rows that were added
 * or changed since, plus every id in list order. Everything else in the result (projects, worktrees, sides, ...) stays whole: it is small.
 * A `since` the daemon does not hold (restart, evicted) gets the full result. Per daemon, not per connection: a reconnect is a new connection.
 */

type Row = { id: string };
type Listed = { sessions: Row[] };
/** What the page gets: the result with a `version`; a delta carries `delta`, `ids` (all listed ids, in order) and only the changed `sessions`. */
export type Versioned<T extends Listed> = T & { version: string; delta?: true; ids?: string[] };

interface Held {
  version: string;
  /** Row id -> JSON of the row. */
  rows: Map<string, string>;
  order: string[];
  /** JSON of the result without its sessions. */
  rest: string;
}

/** Versions held: 8 lists of ~200 KB. */
export const LIST_VERSIONS_KEPT = 8;

export function createListVersions(epoch: string, kept = LIST_VERSIONS_KEPT) {
  const held: Held[] = [];
  let n = 0;
  return {
    /** The reply for `result`: a delta against version `since` when it is held, else the full result. Records `result` as a version unless it equals the newest. */
    encode<T extends Listed>(result: T, since?: unknown): Versioned<T> {
      const { sessions, ...others } = result;
      const rows = new Map(sessions.map((s) => [s.id, JSON.stringify(s)] as const));
      const order = [...rows.keys()];
      const rest = JSON.stringify(others);
      const newest = held.at(-1);
      let current: Held;
      if (newest && newest.rest === rest && sameRows(newest, rows, order)) current = newest;
      else {
        current = { version: `${epoch}:${++n}`, rows, order, rest };
        held.push(current);
        if (held.length > kept) held.shift();
      }
      const base = typeof since === "string" ? held.find((h) => h.version === since) : undefined;
      if (!base) return { ...result, version: current.version };
      const changed = sessions.filter((s) => base.rows.get(s.id) !== rows.get(s.id));
      return { ...others, sessions: changed, ids: order, delta: true, version: current.version } as unknown as Versioned<T>;
    },
  };
}

function sameRows(h: Held, rows: Map<string, string>, order: string[]): boolean {
  if (h.order.length !== order.length) return false;
  return order.every((id, i) => h.order[i] === id && h.rows.get(id) === rows.get(id));
}
