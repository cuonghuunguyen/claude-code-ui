// Per-session client store keyed by part id; events apply idempotently by seq (docs/spec.md "Client state").
import { isAttention, type ContextUsage, type Cursor, type Effort, type Event, type Part, type PermissionMode, type PosPart, type SearchHit, type SessionState, type SlashCommand, type SubscribeResult, type TimelinePage, type TodoItem } from "@claude-ui/protocol";
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
  /** A continue is scheduled at this time (ms) after a usage limit (auto_continue); undefined = none. */
  continueAt?: number;
  /** Idle, but a background task of the session's own query still runs (session_state `working`). */
  working?: boolean;
  /** Latest todo list (todo_update) of the live turn; cleared on idle, error and rewind. */
  todos: TodoItem[];
  order: string[];
  parts: Map<string, Part>;
  /** Paging (docs/spec.md "Event log and sequence numbers"): the cursor of the oldest loaded turn; absent = the whole session is loaded. */
  older?: Cursor;
  /** Parts of the not loaded region that whole-session features need (subagent runs, turn results, running background shells, loaded on demand Edit/Write calls), in pos order. */
  aux: PosPart[];
  /** `session.edits` of this boundary is merged into `aux`. */
  auxEdits?: boolean;
  /** The view cannot follow a rewind into the not loaded region: App takes a fresh snapshot. */
  stale?: boolean;
};

export const emptySession = (): SessionView => ({ lastSeq: 0, settingsSeq: 0, state: "idle", attentionSeq: 0, commands: [], todos: [], order: [], parts: new Map(), aux: [] });

/** A bash mode command of this session still runs: the prompt box shows Stop, Esc kills it. */
export const bashRunning = (s: SessionView) => [...s.parts.values()].some((p) => p.type === "bash" && p.status === "running");

/** The state tabs, sidebar and header show: an idle session in which a terminal CLI turn or background work runs shows running. */
export const shownState = (s: SessionView | undefined) => ((s?.externalTurn || s?.working) && s.state === "idle" ? "running" : s?.state);

export function applyEvent(s: SessionView, e: Event): SessionView {
  if (e.seq <= s.lastSeq) return s;
  const { part } = e;
  if (part.type === "session_state") {
    const attention = isAttention(s.state, part);
    // Not live: drop the list, so a later turn without TodoWrite shows no stale one (OpenCode todoState "clear").
    const todos = part.state === "idle" || part.state === "error" ? [] : s.todos;
    return { ...s, lastSeq: e.seq, state: part.state, working: !!part.working, attentionSeq: attention ? e.seq : s.attentionSeq, todos };
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
    // A paged view that does not hold the message: it is in the not loaded region, so the loaded parts are all after it.
    if (at < 0) return s.older ? { ...s, lastSeq: e.seq, order: [], parts: new Map(), todos: [], stale: true } : { ...s, lastSeq: e.seq, todos: [] };
    const parts = new Map(s.parts);
    for (const id of s.order.slice(at)) parts.delete(id);
    return { ...s, lastSeq: e.seq, order: s.order.slice(0, at), parts, todos: [] };
  }
  if (part.type === "retract") {
    const gone = new Set(part.partIds);
    const parts = new Map(s.parts);
    gone.forEach((id) => parts.delete(id));
    return { ...s, lastSeq: e.seq, order: s.order.filter((id) => !gone.has(id)), parts, aux: s.aux.filter((a) => !gone.has(a.part.id)) };
  }
  if (part.type === "external_turn") return { ...s, lastSeq: e.seq, externalTurn: part.running };
  if (part.type === "auto_continue") return { ...s, lastSeq: e.seq, continueAt: part.at ?? undefined };
  // Not rendered: App moves a tab that shows the session live.
  if (part.type === "session_cleared") return { ...s, lastSeq: e.seq };
  if (part.type === "todo_update") return { ...s, lastSeq: e.seq, todos: part.items };
  // An update of a part in the not loaded region (pos below the cursor): only its aux entry follows; the page fetched later has the latest value.
  if (s.older && e.pos !== undefined && e.pos < s.older.pos && !s.parts.has(part.id)) {
    const i = s.aux.findIndex((a) => a.part.id === part.id);
    if (i < 0) return { ...s, lastSeq: e.seq };
    const aux = s.aux.slice();
    aux[i] = { part, pos: e.pos };
    return { ...s, lastSeq: e.seq, aux };
  }
  const parts = new Map(s.parts).set(part.id, part);
  const order = s.parts.has(part.id) ? s.order : [...s.order, part.id];
  return { ...s, lastSeq: e.seq, order, parts };
}

/**
 * Call with the `session.subscribe` reply before its events: a different logEpoch empties the view for the full replay.
 * The reply's model, mode and effort are current; the replay must not override them with older values (e.g. a long log
 * replays an old plan mode for seconds).
 */
export function withSubscribe(s: SessionView, { logEpoch, seq, session, snapshot }: Omit<SubscribeResult, "title">): SessionView {
  if (snapshot) {
    // A snapshot is authoritative as of `seq`: heads give the state, the page the parts. Nothing is replayed after it.
    let v: SessionView = { ...emptySession(), logEpoch };
    for (const h of snapshot.heads) v = applyEvent(v, h);
    const { page } = snapshot;
    return {
      ...v,
      lastSeq: seq,
      settingsSeq: seq,
      model: session.model,
      permissionMode: session.permissionMode,
      effort: session.effort,
      attentionSeq: snapshot.attentionSeq,
      order: page.parts.map((p) => p.id),
      parts: new Map(page.parts.map((p) => [p.id, p])),
      older: page.older,
      aux: snapshot.aux,
      auxEdits: false,
      stale: false,
    };
  }
  const view = s.logEpoch === logEpoch ? s : { ...emptySession(), logEpoch };
  return { ...view, model: session.model, permissionMode: session.permissionMode, effort: session.effort, settingsSeq: seq };
}

/** The page before `before` arrived: prepends it. Ignored when the view's cursor moved on (reset, double request). Aux entries the page now holds are dropped. */
export function withPage(s: SessionView, before: string, page: TimelinePage): SessionView {
  if (s.older?.before !== before) return s;
  const fresh = page.parts.filter((p) => !s.parts.has(p.id));
  const parts = new Map(s.parts);
  fresh.forEach((p) => parts.set(p.id, p));
  const boundary = page.older?.pos ?? 0;
  return { ...s, order: [...fresh.map((p) => p.id), ...s.order], parts, older: page.older, aux: s.aux.filter((a) => a.pos < boundary) };
}

/** `session.edits` for the cursor `before` arrived: merges the Edit/Write parts into aux (by pos, no duplicates). */
export function withEdits(s: SessionView, before: string, edits: PosPart[]): SessionView {
  if (s.older?.before !== before) return s;
  const have = new Set(s.aux.map((a) => a.part.id));
  const aux = [...s.aux, ...edits.filter((e) => !have.has(e.part.id) && !s.parts.has(e.part.id))].filter((a) => a.pos < s.older!.pos).sort((a, b) => a.pos - b.pos);
  return { ...s, aux, auxEdits: true };
}

/** A part by id: loaded, else from the not loaded region's aux. */
export const partOf = (s: SessionView, id: string): Part | undefined => s.parts.get(id) ?? s.aux.find((a) => a.part.id === id)?.part;

/** Every part a whole-session feature (agents, totals, background shells, changes) reads: aux (older) then the loaded parts in order. */
export function wholeParts(s: SessionView): Part[] {
  const loaded = s.order.map((id) => s.parts.get(id)!);
  return s.aux.length ? [...s.aux.filter((a) => !s.parts.has(a.part.id)).map((a) => a.part), ...loaded] : loaded;
}

const HIDDEN = new Set<Part["type"]>(["tool_result", "thinking", "permission_request"]);

const isContextCall = (p: Part): p is ToolCall => p.type === "tool_call" && CONTEXT_TOOLS.has(p.tool);

/** Timeline key of a content search hit: a prompt by its uuid; an answer by its API message id, the text block that has the query (else its first). Undefined until loaded. */
export function hitKey(items: TimelineItem[], hit: SearchHit, query: string): string | undefined {
  const parts = items.flatMap((i) => (i.kind === "part" ? [i.part] : []));
  if (hit.role === "user") return parts.find((p) => p.type === "user_text" && p.id === hit.messageId)?.id;
  const blocks = parts.filter((p) => p.type === "assistant_text" && p.id.startsWith(`${hit.messageId}:`));
  const q = query.toLowerCase();
  return (blocks.find((p) => p.type === "assistant_text" && p.text.toLowerCase().includes(q)) ?? blocks[0])?.id;
}

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

/** The assistant text of the turn up to and including item `index` (back to its prompt), blocks joined by a blank line; tool calls and reasoning are not text parts. */
export function turnText(items: TimelineItem[], index: number): string {
  const texts: string[] = [];
  for (let i = index; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== "part") continue;
    if (item.part.type === "user_text" || item.part.type === "bash") break;
    if (item.part.type === "assistant_text" && item.part.streaming) return "";
    if (item.part.type === "assistant_text" && item.part.text) texts.unshift(item.part.text);
  }
  return texts.join("\n\n");
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
      for (let parent = partOf(s, p.toolUseId)?.parentId; parent && !ids.has(parent); parent = partOf(s, parent)?.parentId)
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
