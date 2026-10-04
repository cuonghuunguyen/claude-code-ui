// Per-session client store keyed by part id; events apply idempotently by seq (docs/spec.md "Client state").
import type { ContextUsage, Effort, Event, Part, PermissionMode, SessionState, SlashCommand, SubscribeResult, TodoItem } from "@claude-ui/protocol";
import { CONTEXT_TOOLS } from "./tools.ts";

export type ToolCall = Extract<Part, { type: "tool_call" }>;
export type PermissionRequest = Extract<Part, { type: "permission_request" }>;
export type QuestionRequest = Extract<Part, { type: "question" }>;
export type TimelineItem = { kind: "part"; part: Part } | { kind: "context"; id: string; calls: ToolCall[] };

export type SessionView = {
  /** Daemon run the seqs belong to (docs/spec.md "Event log and sequence numbers"). */
  logEpoch?: string;
  lastSeq: number;
  state: SessionState;
  /** Seq of the last "needs input" or "finished" (idle or error after work): what makes a session unread. 0 = none. */
  attentionSeq: number;
  /** Model, mode and effort: from the subscribe reply, then from later session_model / _permission_mode / _effort parts. */
  model?: string;
  permissionMode?: PermissionMode;
  effort?: Effort;
  /** Seq of the subscribe reply: replayed changes up to it are older than the reply's values. */
  settingsSeq: number;
  commands: SlashCommand[];
  /** Latest context_usage; undefined until the daemon reports it. */
  contextUsage?: ContextUsage;
  /** A terminal CLI turn runs in this session (external_turn): the prompt box sends nothing until it ends. */
  externalTurn?: boolean;
  /** Latest todo list (todo_update) of the live turn; cleared on idle, error and rewind. */
  todos: TodoItem[];
  order: string[];
  parts: Map<string, Part>;
};

export const emptySession = (): SessionView => ({ lastSeq: 0, settingsSeq: 0, state: "idle", attentionSeq: 0, commands: [], todos: [], order: [], parts: new Map() });

export function applyEvent(s: SessionView, e: Event): SessionView {
  if (e.seq <= s.lastSeq) return s;
  const { part } = e;
  if (part.type === "session_state") {
    const busy = s.state === "running" || s.state === "needs_input";
    const attention = part.state === "needs_input" || (busy && (part.state === "idle" || part.state === "error"));
    // Not live: drop the list, so a later turn without TodoWrite shows no stale one (OpenCode todoState "clear").
    const todos = part.state === "idle" || part.state === "error" ? [] : s.todos;
    return { ...s, lastSeq: e.seq, state: part.state, attentionSeq: attention ? e.seq : s.attentionSeq, todos };
  }
  if ((part.type === "session_model" || part.type === "session_permission_mode" || part.type === "session_effort") && e.seq <= s.settingsSeq)
    return { ...s, lastSeq: e.seq };
  if (part.type === "session_model") return { ...s, lastSeq: e.seq, model: part.model };
  if (part.type === "session_permission_mode") return { ...s, lastSeq: e.seq, permissionMode: part.mode };
  if (part.type === "session_effort") return { ...s, lastSeq: e.seq, effort: part.effort };
  if (part.type === "commands") return { ...s, lastSeq: e.seq, commands: part.commands };
  if (part.type === "context_usage") return { ...s, lastSeq: e.seq, contextUsage: part.usage };
  if (part.type === "rewind") {
    const at = s.order.indexOf(part.userMessageId);
    if (at < 0) return { ...s, lastSeq: e.seq };
    const parts = new Map(s.parts);
    for (const id of s.order.slice(at)) parts.delete(id);
    return { ...s, lastSeq: e.seq, order: s.order.slice(0, at), parts, todos: [] };
  }
  if (part.type === "retract") {
    const gone = new Set(part.partIds);
    const parts = new Map(s.parts);
    gone.forEach((id) => parts.delete(id));
    return { ...s, lastSeq: e.seq, order: s.order.filter((id) => !gone.has(id)), parts };
  }
  if (part.type === "external_turn") return { ...s, lastSeq: e.seq, externalTurn: part.running };
  // Not rendered: App moves a tab that shows the session live.
  if (part.type === "session_cleared") return { ...s, lastSeq: e.seq };
  if (part.type === "todo_update") return { ...s, lastSeq: e.seq, todos: part.items };
  const parts = new Map(s.parts).set(part.id, part);
  const order = s.parts.has(part.id) ? s.order : [...s.order, part.id];
  return { ...s, lastSeq: e.seq, order, parts };
}

/**
 * Call with the `session.subscribe` reply before its events: a different logEpoch empties the view for the full replay.
 * The reply's model, mode and effort are current; the replay must not override them with older values (e.g. a long log
 * replays an old plan mode for seconds).
 */
export function withSubscribe(s: SessionView, { logEpoch, seq, session }: SubscribeResult): SessionView {
  const view = s.logEpoch === logEpoch ? s : { ...emptySession(), logEpoch };
  return { ...view, model: session.model, permissionMode: session.permissionMode, effort: session.effort, settingsSeq: seq };
}

const HIDDEN = new Set<Part["type"]>(["tool_result", "thinking", "permission_request"]);

const isContextCall = (p: Part): p is ToolCall => p.type === "tool_call" && CONTEXT_TOOLS.has(p.tool);

/**
 * Render order: tool_result parts fold into their tool card; thinking and permission_request parts are not shown; consecutive read/search calls form one context group.
 * Top level by default; with `parentId`, the child parts of that subagent.
 */
export function timeline(s: SessionView, parentId?: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const id of s.order) {
    const part = s.parts.get(id)!;
    // Results fold into their card; reasoning is hidden; a permission request is marked by its tool card.
    if (HIDDEN.has(part.type) || part.parentId !== parentId) continue;
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

const awaiting = new WeakMap<SessionView["parts"], Set<string>>();

/** Tool use ids, and subagent ids, of calls waiting for a permission answer; their cards render expanded. Cached per `parts` map, which every update replaces. */
export function awaitingPermission(s: SessionView): Set<string> {
  let ids = awaiting.get(s.parts);
  if (ids) return ids;
  ids = new Set();
  for (const p of s.parts.values())
    if (p.type === "permission_request" && !p.settled) {
      ids.add(p.toolUseId);
      // The daemon sends no parentId on permission requests; walk up from the call, so every enclosing subagent opens too.
      for (let parent = s.parts.get(p.toolUseId)?.parentId; parent && !ids.has(parent); parent = s.parts.get(parent)?.parentId)
        ids.add(parent);
    }
  awaiting.set(s.parts, ids);
  return ids;
}

/** The oldest unsettled question; while one exists (and no permission request) the question panel replaces the prompt box. */
export function pendingQuestion(s: SessionView): QuestionRequest | undefined {
  for (const id of s.order) {
    const p = s.parts.get(id)!;
    if (p.type === "question" && !p.settled) return p;
  }
}
