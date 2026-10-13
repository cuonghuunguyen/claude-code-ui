// Orchestration links of a session for the agent map (and the Focus page, #306): its workers, its coordinator (docs/spec.md "Orchestration").
import type { SessionListItem, SessionState } from "@claude-ui/protocol";
import { shownState, type SessionView } from "./store.ts";

export type WorkerRow = { id: string; name: string; title: string; state: SessionState };
export type AgentLinks = { coordinator?: { id: string; title: string }; workers: WorkerRow[]; closed: WorkerRow[] };

export const NO_LINKS: AgentLinks = { workers: [], closed: [] };

/** Live view state first (as the sidebar), else the list's; idle without a CLI process (list `live: false`) is closed. */
export function workerState(s: SessionListItem, view?: SessionView): SessionState {
  const st = shownState(view) ?? s.state;
  return st === "idle" && s.live === false ? "closed" : st;
}

/**
 * Workers of `sessionId` sorted by name (as nestWorkers), split into open (running, needs input, idle, error) and closed; archived ones included.
 * `coordinator`: the list entry of the session's coordinator, when listed.
 */
export function agentLinks(list: SessionListItem[], views: Record<string, SessionView | undefined>, sessionId: string): AgentLinks {
  const me = list.find((s) => s.id === sessionId);
  const boss = me?.coordinatorId ? list.find((s) => s.id === me.coordinatorId) : undefined;
  const rows = list
    .filter((s) => s.coordinatorId === sessionId)
    .sort((a, b) => (a.workerName ?? a.title).localeCompare(b.workerName ?? b.title))
    .map((s): WorkerRow => ({ id: s.id, name: s.workerName ?? s.title, title: s.title, state: workerState(s, views[s.id]) }));
  if (!boss && !rows.length) return NO_LINKS;
  return { ...(boss && { coordinator: { id: boss.id, title: boss.title } }), workers: rows.filter((w) => w.state !== "closed"), closed: rows.filter((w) => w.state === "closed") };
}

/** `prev` while `next` equals it: memo panes do not re-render on every list refresh. */
export function sameLinks(prev: AgentLinks | undefined, next: AgentLinks): AgentLinks {
  return prev && (prev === next || JSON.stringify(prev) === JSON.stringify(next)) ? prev : next;
}
