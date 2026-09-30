// Per-session client store keyed by part id; events apply idempotently by seq (docs/spec.md "Client state").
import type { Event, Part, SessionState, SlashCommand, TodoItem } from "@claude-ui/protocol";
import { CONTEXT_TOOLS } from "./tools.ts";

export type ToolCall = Extract<Part, { type: "tool_call" }>;
export type PermissionRequest = Extract<Part, { type: "permission_request" }>;
export type TimelineItem = { kind: "part"; part: Part } | { kind: "context"; id: string; calls: ToolCall[] };

export type SessionView = {
  /** Daemon run the seqs belong to (docs/spec.md "Event log and sequence numbers"). */
  logEpoch?: string;
  lastSeq: number;
  state: SessionState;
  /** Latest model from a session_model part; undefined until the model was switched. */
  model?: string;
  commands: SlashCommand[];
  /** Latest todo list (todo_update); pinned above the prompt box while a turn runs. */
  todos: TodoItem[];
  order: string[];
  parts: Map<string, Part>;
};

export const emptySession = (): SessionView => ({ lastSeq: 0, state: "idle", commands: [], todos: [], order: [], parts: new Map() });

export function applyEvent(s: SessionView, e: Event): SessionView {
  if (e.seq <= s.lastSeq) return s;
  const { part } = e;
  if (part.type === "session_state") return { ...s, lastSeq: e.seq, state: part.state };
  if (part.type === "session_model") return { ...s, lastSeq: e.seq, model: part.model };
  if (part.type === "commands") return { ...s, lastSeq: e.seq, commands: part.commands };
  if (part.type === "rewind") {
    const at = s.order.indexOf(part.userMessageId);
    if (at < 0) return { ...s, lastSeq: e.seq };
    const parts = new Map(s.parts);
    for (const id of s.order.slice(at)) parts.delete(id);
    return { ...s, lastSeq: e.seq, order: s.order.slice(0, at), parts };
  }
  if (part.type === "todo_update") return { ...s, lastSeq: e.seq, todos: part.items };
  const parts = new Map(s.parts).set(part.id, part);
  const order = s.parts.has(part.id) ? s.order : [...s.order, part.id];
  return { ...s, lastSeq: e.seq, order, parts };
}

/** Call with the `session.subscribe` reply before its events: a different logEpoch empties the view for the full replay. */
export const withEpoch = (s: SessionView, logEpoch: string): SessionView =>
  s.logEpoch === logEpoch ? s : { ...emptySession(), logEpoch };

const isContextCall = (p: Part): p is ToolCall => p.type === "tool_call" && CONTEXT_TOOLS.has(p.tool);

/**
 * Render order: tool_result parts fold into their tool card; consecutive read/search calls form one context group.
 * Top level by default; with `parentId`, the child parts of that subagent.
 */
export function timeline(s: SessionView, parentId?: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const id of s.order) {
    const part = s.parts.get(id)!;
    if (part.type === "tool_result" || part.parentId !== parentId) continue;
    const prev = items.at(-1);
    if (isContextCall(part) && prev?.kind === "context") prev.calls.push(part);
    else if (isContextCall(part) && prev?.kind === "part" && isContextCall(prev.part))
      items[items.length - 1] = { kind: "context", id: prev.part.id, calls: [prev.part, part] };
    else items.push({ kind: "part", part });
  }
  return items;
}

/** The oldest unsettled permission request; while one exists the permission panel replaces the prompt box. */
export function pendingPermission(s: SessionView): PermissionRequest | undefined {
  for (const id of s.order) {
    const p = s.parts.get(id)!;
    if (p.type === "permission_request" && !p.settled) return p;
  }
}
