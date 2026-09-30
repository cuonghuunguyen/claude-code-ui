// Per-session client store keyed by part id; events apply idempotently by seq (docs/spec.md "Client state").
import type { Event, Part, SessionState } from "@claude-ui/protocol";

export type SessionView = {
  /** Daemon run the seqs belong to (docs/spec.md "Event log and sequence numbers"). */
  logEpoch?: string;
  lastSeq: number;
  state: SessionState;
  /** Latest model from a session_model part; undefined until the model was switched. */
  model?: string;
  order: string[];
  parts: Map<string, Part>;
};

export const emptySession = (): SessionView => ({ lastSeq: 0, state: "idle", order: [], parts: new Map() });

export function applyEvent(s: SessionView, e: Event): SessionView {
  if (e.seq <= s.lastSeq) return s;
  const { part } = e;
  if (part.type === "session_state") return { ...s, lastSeq: e.seq, state: part.state };
  if (part.type === "session_model") return { ...s, lastSeq: e.seq, model: part.model };
  const parts = new Map(s.parts).set(part.id, part);
  const order = s.parts.has(part.id) ? s.order : [...s.order, part.id];
  return { ...s, lastSeq: e.seq, order, parts };
}

/** Call with the `session.subscribe` reply before its events: a different logEpoch empties the view for the full replay. */
export const withEpoch = (s: SessionView, logEpoch: string): SessionView =>
  s.logEpoch === logEpoch ? s : { ...emptySession(), logEpoch };
