// Idempotent retry of a first send (docs/spec.md "New-session first send"): a reply lost on the way must not make a second Session or a second prompt.
// Daemon-wide, not per connection: the retry arrives on a new socket after a reconnect.
type Failure = { code: string; message: string };

export type FirstSend = {
  /** `session.create` `draft` token -> id of the session it made. */
  byDraft: Map<string, string>;
  /** Session id -> its last `once` key and the outcome of that send (`undefined` = sent). */
  /** Creates in flight by draft token: a retry waits for it instead of making a second session. */
  creating: Map<string, Promise<unknown>>;
  once: Map<string, { key: string; done: Promise<SendResult> }>;
};

const MAX_ENTRIES = 100;

export const createFirstSend = (): FirstSend => ({ byDraft: new Map(), creating: new Map(), once: new Map() });

/** Sets a key and drops the oldest entries above the cap. */
export function remember<V>(m: Map<string, V>, k: string, v: V): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as string);
}

/** The first message is taken: the draft token no longer names a session to join (a duplicated browser tab copies the token). */
function spend(first: FirstSend, sessionId: string): void {
  for (const [d, id] of first.byDraft) if (id === sessionId) first.byDraft.delete(d);
}

export type SendResult = { err?: Failure; reply?: object };

/**
 * Runs `send` once per (session, key): a repeat with the same key waits for the first one's outcome and returns it (reply included).
 * A failed send is forgotten, so the user may retry it. No key (or a non-string): runs `send` every time.
 */
export async function sendOnce(first: FirstSend, sessionId: string, key: unknown, send: () => Promise<SendResult>): Promise<SendResult> {
  if (typeof key !== "string" || !key) {
    const r = await send();
    if (!r.err) spend(first, sessionId);
    return r;
  }
  const prior = first.once.get(sessionId);
  if (prior?.key === key) return prior.done;
  const done = send();
  const entry = { key, done };
  remember(first.once, sessionId, entry);
  const res = await done.catch((e: unknown): SendResult => ({ err: { code: "internal", message: e instanceof Error ? e.message : String(e) } }));
  if (res.err) {
    if (first.once.get(sessionId) === entry) first.once.delete(sessionId);
  } else {
    spend(first, sessionId);
  }
  return done;
}
