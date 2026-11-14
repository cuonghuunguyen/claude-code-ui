/** `session.list {since}` replies (GH-767): a delta holds only the rows added or changed since the version the page sent, plus every listed id in order. */
type Listed<T> = { sessions: T[]; delta?: true; ids?: string[] };

/**
 * The full session rows of a list reply. A whole reply is its `sessions`. A delta is rebuilt from the rows of the last applied list
 * (`base`) by `ids`: a changed row replaces the one of `base`, a removed id is gone. `undefined`: the delta cannot be applied
 * (no base, or an id with no known row): the caller asks for the whole list.
 */
export function applyListReply<T extends { id: string }>(base: readonly T[] | undefined, reply: Listed<T>): T[] | undefined {
  if (!reply.delta) return reply.sessions;
  if (!base || !reply.ids) return undefined;
  const rows = new Map(base.map((s) => [s.id, s] as const));
  for (const s of reply.sessions) rows.set(s.id, s);
  const out: T[] = [];
  for (const id of reply.ids) {
    const row = rows.get(id);
    if (!row) return undefined;
    out.push(row);
  }
  return out;
}
