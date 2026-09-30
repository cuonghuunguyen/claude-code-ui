// Per-session client store keyed by part id; events apply idempotently by seq (docs/spec.md "Client state").
import type { Event, Part, SessionState } from "@claude-ui/protocol";

export type SessionView = {
  lastSeq: number;
  state: SessionState;
  order: string[];
  parts: Map<string, Part>;
};

export const emptySession = (): SessionView => ({ lastSeq: 0, state: "idle", order: [], parts: new Map() });

export function applyEvent(s: SessionView, e: Event): SessionView {
  if (e.seq <= s.lastSeq) return s;
  const { part } = e;
  if (part.type === "session_state") return { ...s, lastSeq: e.seq, state: part.state };
  const parts = new Map(s.parts).set(part.id, part);
  const order = s.parts.has(part.id) ? s.order : [...s.order, part.id];
  return { ...s, lastSeq: e.seq, order, parts };
}
