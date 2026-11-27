// OpenCode messages and events as Parts (docs/spec.md "OpenCode engine"): one stateful mapper for stored history and live events, so both
// give the same part ids. User message = one `user_text` (id = message id); text/reasoning/tool part ids = the OpenCode part id; a tool call's id = its callID.
import type { Part, ToolStatus, TodoItem } from "@claude-ui/protocol";
import { errorText, type OpenCodeError } from "./opencode-errors.ts";
import { FORK_TOOL } from "./opencode-fork.ts";

type ToolState = { status: string; title?: string; input?: Record<string, unknown>; output?: string; error?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } };
export type OpenCodePart = {
  id: string;
  type: string;
  sessionID?: string;
  messageID?: string;
  text?: string;
  synthetic?: boolean;
  /** `compaction` part: OpenCode compacted by itself (true) or on request (false). */
  auto?: boolean;
  ignored?: boolean;
  mime?: string;
  url?: string;
  callID?: string;
  tool?: string;
  state?: ToolState;
  time?: { start?: number; end?: number };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
};
export type OpenCodeMessage = { info: { id: string; role: "user" | "assistant"; /** An assistant message: the user message it answers. */ parentID?: string; agent?: string; providerID?: string; modelID?: string; time?: { created?: number; completed?: number }; /** Why the step ended (`tool-calls`: the loop goes on). */ finish?: string; /** OpenCode's error of the message (a turn it aborted: `MessageAbortedError`). */ error?: OpenCodeError & { name: string }; summary?: { diffs?: { file: string; additions: number; deletions: number }[] }; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }; parts: OpenCodePart[] };
export type OpenCodeTodo = { content: string; status: string };

/** The error text of a tool OpenCode 1 refused: the user's rejection, or a permission rule that denies it. */
export const REJECTED = /^The user (rejected permission to use this specific tool call|has specified a rule which prevents you from using this specific tool call)/;

type BackgroundEnd = { status: ToolStatus; at?: number };
const STATUS: Record<string, ToolStatus> = { completed: "done", error: "error", pending: "pending", running: "running" };

/** OpenCode tool -> Claude card name and input shape; other tools keep their name and input. */
const RENAME: Record<string, [string, Record<string, string>]> = {
  bash: ["Bash", {}],
  read: ["Read", { filePath: "file_path" }],
  edit: ["Edit", { filePath: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" }],
  write: ["Write", { filePath: "file_path" }],
  glob: ["Glob", {}],
  grep: ["Grep", { include: "glob" }],
  webfetch: ["WebFetch", {}],
  websearch: ["WebSearch", {}],
  todowrite: ["TodoWrite", {}],
  question: ["AskUserQuestion", {}],
};

export function mapTool(name: string, input: Record<string, unknown> = {}): { tool: string; input: Record<string, unknown> } {
  // A session's orchestration MCP tool (`orchestration-<last 10 of its id>_<tool>`, opencode-engine.ts mcpName) shows as Claude's.
  const orch = /^orchestration-[\w-]{10}_(\w+)$/.exec(name);
  if (orch) return { tool: `mcp__orchestration__${orch[1]}`, input };
  // Likewise the claude-ui server's tools (`claude-ui-<last 10 of the id>_<tool>`).
  const daemon = /^claude-ui-[\w-]{10}_(\w+)$/.exec(name);
  if (daemon) return { tool: `mcp__claude-ui__${daemon[1]}`, input };
  const rule = RENAME[name];
  if (!rule) return { tool: name, input };
  const mapped = Object.fromEntries(Object.entries(input).map(([k, v]) => [rule[1][k] ?? k, v]));
  if (name === "question" && Array.isArray(mapped.questions))
    mapped.questions = mapped.questions.map(({ multiple, ...q }: Record<string, unknown>) => ({ ...q, multiSelect: multiple === true }));
  return { tool: rule[0], input: mapped };
}

/** A value with its object keys sorted, for comparing inputs. */
/** `v` with its object keys sorted: inputs compared by value. */
export const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);

/** A value that says nothing in a call's input: absent, null, empty text, list or object. */
const unset = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length);
const trimmed = (i: Record<string, unknown> | undefined) => JSON.stringify(canon(Object.fromEntries(Object.entries(i ?? {}).filter(([, v]) => !unset(v)))));

/**
 * The running call (oldest first in `running`) an inline run belongs to, in order: the newest with an input equal to `input`; else the newest equal once keys with no
 * value are dropped on both sides (the model's call may carry what the tool's schema dropped, or the other way round); else the only candidate (`lone`: no other run waits for a call, or the call could be another run's).
 */
export function pickCall(running: readonly { id: string; input: Record<string, unknown> }[], input: Record<string, unknown> | undefined, lone = true): string | undefined {
  const newest = [...running].reverse();
  const want = JSON.stringify(canon(input ?? {}));
  const exact = newest.find((c) => JSON.stringify(canon(c.input)) === want);
  if (exact) return exact.id;
  const lean = trimmed(input);
  return newest.find((c) => trimmed(c.input) === lean)?.id ?? (lone && running.length === 1 ? running[0]!.id : undefined);
}

const sumTokens = (parts: Iterable<OpenCodePart>) => {
  const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let cost = 0;
  for (const p of parts) {
    t.inputTokens += p.tokens?.input ?? 0;
    t.outputTokens += (p.tokens?.output ?? 0) + (p.tokens?.reasoning ?? 0);
    t.cacheReadTokens += p.tokens?.cache?.read ?? 0;
    t.cacheCreationTokens += p.tokens?.cache?.write ?? 0;
    cost += p.cost ?? 0;
  }
  return { usage: t, cost };
};

export class OpenCodeMapper {
  private readonly roles = new Map<string, "user" | "assistant">();
  /** Parts whose message role is not known yet (a part before its message.updated). */
  private readonly early = new Map<string, OpenCodePart[]>();
  private readonly userParts = new Map<string, Map<string, OpenCodePart>>();
  private readonly texts = new Map<string, Part & { type: "assistant_text" | "thinking" }>();
  private readonly calls = new Map<string, Part & { type: "tool_call" | "subagent" }>();
  private readonly denied = new Set<string>();
  /** child session id -> the task call that started it. */
  private readonly children = new Map<string, string>();
  /** Background task calls (GH-1014; OpenCode's `background` task option): the call returns at once, the card runs until the child ends. Call id -> child session id. */
  private readonly bgCalls = new Map<string, string>();
  /** How each background child ended (the first end stays), and ends that came before the call's update. */
  private readonly bgEnds = new Map<string, BackgroundEnd>();
  private readonly bgEarly = new Map<string, BackgroundEnd>();
  /** Input of each Fork run's call (a Fork run shows as a `subagent` part, which has none): `runningFork` matches a run to its call by it. */
  private readonly forkInputs = new Map<string, Record<string, unknown>>();
  private readonly finishes = new Map<string, OpenCodePart>();
  /** Message ids of prompts this daemon sent: their echo adds nothing (user_text was emitted at once). */
  readonly own = new Set<string>();

  /** The call id of a child session, undefined for the root session. */
  parentOf = (sessionId: string | undefined) => (sessionId ? this.children.get(sessionId) : undefined);
  /** The child session of a task call. */
  childOf = (callId: string) => [...this.children].find(([, c]) => c === callId)?.[0];
  isChild = (sessionId: string) => this.children.has(sessionId);
  /** Whether a background task call of this session still runs: the session is working while it idles. */
  backgroundRunning = () => [...this.bgCalls.keys()].some((id) => this.calls.get(id)?.status === "running");
  /** The card of the background task whose child session is `sessionId`; none for the root, a foreground child or an inline run. */
  backgroundOf(sessionId: string | undefined): (Part & { type: "subagent" }) | undefined {
    const callId = sessionId ? this.children.get(sessionId) : undefined;
    const call = callId && this.bgCalls.has(callId) ? this.calls.get(callId) : undefined;
    return call?.type === "subagent" ? call : undefined;
  }
  /** Whether the background child `sessionId` ended already (its leftover permission asks are no longer asked). */
  backgroundEnded = (sessionId: string) => this.bgEnds.has(sessionId);
  /** The child of a background task call ended (its session idle, error or abort): the card shows how. The first end stays; an unlinked child's end waits for its call. */
  childEnded(childId: string, status: ToolStatus, at?: number): Part[] {
    const end: BackgroundEnd = { status, ...(at && { at }) };
    const callId = this.children.get(childId);
    if (!callId || !this.bgCalls.has(callId)) {
      // Linked to a foreground task or a run: no background end. Unlinked: its call's update has not come.
      if (!callId && !this.bgEarly.has(childId)) this.bgEarly.set(childId, end);
      return [];
    }
    if (!this.bgEnds.has(childId)) this.bgEnds.set(childId, end);
    const call = this.calls.get(callId);
    if (!call || call.type !== "subagent") return [];
    const { status: st, at: endedAt } = this.bgEnds.get(childId)!;
    if (call.status === st && call.endedAt === endedAt) return [];
    const next = { ...call, status: st, ...(endedAt && { endedAt }) };
    this.calls.set(callId, next);
    return [next];
  }
  /** An inline task's child session (GH-734): its parts show under the call `callId`. */
  adopt = (childId: string, callId: string) => void this.children.set(childId, callId);
  /** Forgets an inline task's child session after its run ended. */
  release = (childId: string) => void this.children.delete(childId);
  /** Whether call `id` is still pending or running. */
  isRunning = (id: string) => {
    const c = this.calls.get(id);
    return !!c && c.type === "tool_call" && (c.status === "running" || c.status === "pending");
  };
  /** The newest running call of `tool` whose input equals `input` and is not in `skip` (the call an inline run belongs to). */
  runningCall(tool: string, input: Record<string, unknown> | undefined, skip: ReadonlySet<string>, lone = true): string | undefined {
    return pickCall([...this.calls.values()].flatMap((c) => (c.type === "tool_call" && c.tool === tool && (c.status === "running" || c.status === "pending") && !skip.has(c.id) ? [{ id: c.id, input: c.input as Record<string, unknown> }] : [])), input, lone);
  }
  /** The newest running Fork run call (`fork` tool) whose input equals `input` and is not in `skip`. */
  runningFork(input: Record<string, unknown> | undefined, skip: ReadonlySet<string>): string | undefined {
    const want = JSON.stringify(canon(input ?? {}));
    return [...this.calls.values()].reverse().find((c) => c.type === "subagent" && c.agentType === "fork" && (c.status === "running" || c.status === "pending") && !skip.has(c.id) && JSON.stringify(canon(this.forkInputs.get(c.id))) === want)?.id;
  }
  /** The mapped call of a tool call id (Claude card name and input). */
  call = (callId: string) => this.calls.get(callId);
  /** Usage and cost summed over the step-finish parts since the last `resetTurn`. */
  turn = () => sumTokens(this.finishes.values());
  resetTurn = () => this.finishes.clear();

  /** The user denied a call: its card stays `denied` when the error update comes. Returns the card to show now. */
  deny(callId: string): Part | undefined {
    this.denied.add(callId);
    const c = this.calls.get(callId);
    if (!c || c.type !== "tool_call") return;
    const next = { ...c, status: "denied" as const };
    this.calls.set(callId, next);
    return next;
  }

  message(info: OpenCodeMessage["info"], live = true): Part[] {
    this.roles.set(info.id, info.role);
    const early = this.early.get(info.id);
    this.early.delete(info.id);
    return early ? early.flatMap((p) => this.part(p, live)) : [];
  }

  part(p: OpenCodePart, live = true): Part[] {
    const role = p.messageID ? this.roles.get(p.messageID) : undefined;
    if ((p.type === "text" || p.type === "file" || p.type === "compaction") && !role) {
      this.early.set(p.messageID!, [...(this.early.get(p.messageID!) ?? []), p]);
      return [];
    }
    const parentId = this.parentOf(p.sessionID);
    const out = this.one(p, role, live);
    return parentId ? out.map((x) => ({ ...x, parentId })) : out;
  }

  private one(p: OpenCodePart, role: "user" | "assistant" | undefined, live: boolean): Part[] {
    if (role === "user") return this.userText(p);
    if (p.type === "text" || p.type === "reasoning") {
      if (p.type === "text" && (p.ignored || p.synthetic)) return [];
      const streaming = live && !!p.time?.start && !p.time.end;
      if (!p.text && !streaming) return [];
      const part = { type: p.type === "text" ? ("assistant_text" as const) : ("thinking" as const), id: p.id, text: p.text ?? "", streaming };
      this.texts.set(p.id, part);
      return [part];
    }
    if (p.type === "step-finish") {
      // Stored history is no part of the running turn: only live updates count (shortcut: after a stream reconnect the steps before it are missing from the turn's sum).
      if (live) this.finishes.set(p.id, p);
      return [];
    }
    if (p.type === "tool" && p.state && p.callID) return this.tool(p, p.callID, p.state);
    return [];
  }

  private userText(p: OpenCodePart): Part[] {
    // The marker OpenCode stores when it compacts (`/compact`, or its own auto compaction): the summary follows as an assistant message.
    if (p.type === "compaction") return [{ type: "compaction", id: p.id, trigger: p.auto ? "auto" : "manual" }];
    const id = p.messageID!;
    if (this.own.has(id) || (p.type !== "text" && p.type !== "file")) return [];
    const parts = this.userParts.get(id) ?? new Map<string, OpenCodePart>();
    this.userParts.set(id, parts);
    parts.set(p.id, p);
    const all = [...parts.values()];
    const text = all.filter((x) => x.type === "text" && !x.synthetic && !x.ignored).map((x) => x.text ?? "").join("\n");
    const images = all.filter((x) => x.type === "file" && x.mime?.startsWith("image/") && x.url).map((x) => x.url!);
    return text || images.length ? [{ type: "user_text", id, text, images }] : [];
  }

  private tool(p: OpenCodePart, callId: string, s: ToolState): Part[] {
    let status = STATUS[s.status] ?? "pending";
    if ((this.denied.has(callId) && status !== "done") || (s.status === "error" && REJECTED.test(s.error ?? ""))) status = "denied";
    const times = { ...(s.time?.start && { startedAt: s.time.start }), ...(s.time?.end && { endedAt: s.time.end }) };
    if (p.tool === "task") {
      const child = s.metadata?.sessionId;
      if (typeof child === "string") this.children.set(child, callId);
      // A background call is "completed" at once and the child runs on (metadata.background): the card runs until the child's end.
      const background = status === "done" && s.metadata?.background === true && typeof child === "string";
      if (background) {
        this.bgCalls.set(callId, child);
        const early = this.bgEarly.get(child);
        if (early && !this.bgEnds.has(child)) (this.bgEnds.set(child, early), this.bgEarly.delete(child));
      }
      const ended = background ? this.bgEnds.get(child) : undefined;
      if (background) status = ended?.status ?? "running";
      const endedAt = background ? ended?.at : s.time?.end;
      const sub = { type: "subagent" as const, id: callId, toolUseId: callId, description: String(s.input?.description ?? s.title ?? ""), status, startedAt: s.time?.start ?? 0, ...(endedAt && { endedAt }) };
      this.calls.set(callId, sub);
      return [sub];
    }
    const { tool, input } = mapTool(p.tool ?? "", s.input);
    // A Fork run (docs/spec.md "Fork runs"): the `fork` tool of the claude-ui server shows as the Fork run card (a `subagent` part), as Claude's fork does.
    if (tool === FORK_TOOL) {
      this.forkInputs.set(callId, input);
      const run = { type: "subagent" as const, id: callId, toolUseId: callId, description: String(input.description ?? s.title ?? ""), status, startedAt: s.time?.start ?? 0, agentType: "fork", ...(s.time?.end && { endedAt: s.time.end }) };
      this.calls.set(callId, run);
      return [run];
    }
    const exit = s.metadata?.exit;
    const call = { type: "tool_call" as const, id: callId, toolUseId: callId, tool, input, status, ...times, ...(typeof exit === "number" && { exitCode: exit }) };
    this.calls.set(callId, call);
    const out: Part[] = [call];
    if (s.status === "completed" || s.status === "error") out.push({ type: "tool_result", id: `${callId}:result`, toolUseId: callId, output: (s.status === "error" ? s.error : s.output) ?? "", isError: s.status === "error" });
    return out;
  }

  /** A streamed text addition; unknown part: nothing (its first full update has not come). */
  delta(partId: string, delta: string): Part[] {
    const t = this.texts.get(partId);
    if (!t) return [];
    const next = { ...t, text: t.text + delta };
    this.texts.set(partId, next);
    return [next];
  }

  todos(sessionId: string, todos: OpenCodeTodo[]): Part {
    const items: TodoItem[] = todos.map((t) => ({ content: t.content, status: t.status === "in_progress" ? "in_progress" : t.status === "pending" ? "pending" : "completed" }));
    return { type: "todo_update", id: `${sessionId}:todos`, items, ...(this.parentOf(sessionId) && { parentId: this.parentOf(sessionId) }) };
  }
}

/**
 * History of a session: its messages in order, a task call's child session (`children`: child id -> its messages) right after the call.
 * Nothing streams (an unfinished part shows as it was stored).
 */
export function openCodeParts(messages: readonly OpenCodeMessage[], children: Readonly<Record<string, readonly OpenCodeMessage[]>> = {}, m = new OpenCodeMapper(), forks: readonly { forkId: string; callId: string; prefix: number; messages: readonly OpenCodeMessage[] }[] = [], inlines: readonly { inlineId: string; callId: string; messages: readonly OpenCodeMessage[] }[] = []): Part[] {
  const walk = (list: readonly OpenCodeMessage[], sessionID?: string): Part[] =>
    list.flatMap((msg) => [
      ...m.message(msg.info, false),
      ...msg.parts.flatMap((p) => {
        const out = m.part({ ...p, messageID: p.messageID ?? msg.info.id, sessionID: p.sessionID ?? sessionID }, false);
        const child = p.state?.metadata?.sessionId;
        if (typeof child === "string" && children[child]) return [...out, ...walk(children[child]!, child), ...backgroundEnd(m, child, children[child]!)];
        // A Fork run: its fork session holds a copy of the parent's history first (`prefix` messages), which is no step of the run.
        const fork = p.callID ? forks.find((f) => f.callId === p.callID) : undefined;
        // An inline task: its session's assistant messages are the steps (its prompt is the call's input).
        const inline = p.callID ? inlines.find((f) => f.callId === p.callID) : undefined;
        if (inline) {
          m.adopt(inline.inlineId, inline.callId);
          return [...out, ...walk(inline.messages.filter((x) => x.info.role === "assistant"), inline.inlineId)];
        }
        if (!fork) return out;
        m.adopt(fork.forkId, fork.callId);
        // The fork's prompt (a user message) is the card's task, not a step: live it is not echoed either (`own`).
        return [...out, ...walk(fork.messages.slice(fork.prefix).filter((x) => x.info.role === "assistant"), fork.forkId)];
      }),
      // Why the turn failed (the live `session.error` shows the same notice, same id); an aborted message is a Stop or OpenCode's own abort, shown elsewhere.
      ...(!sessionID ? failure(msg.info) : []),
    ]);
  return dedupeUser(walk(messages));
}

/** A stored background task: its end is the child's last assistant message (completed, aborted or failed); one still unfinished keeps the card running. */
function backgroundEnd(m: OpenCodeMapper, child: string, messages: readonly OpenCodeMessage[]): Part[] {
  const last = [...messages].reverse().find((x) => x.info.role === "assistant");
  const at = last?.info.time?.completed;
  // A step that ends with tool calls is complete but the child goes on.
  const error = last?.info.error?.name;
  if (!last || !at || (!error && last.info.finish === "tool-calls")) return [];
  return m.childEnded(child, error === "MessageAbortedError" ? "stopped" : error ? "error" : "done", at);
}

/** The warning notice of a root assistant message that ended with an error (not an abort); id `error:<message id>`. */
export function failure(info: OpenCodeMessage["info"]): Part[] {
  if (info.role !== "assistant" || !info.error || info.error.name === "MessageAbortedError") return [];
  const model = info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : undefined;
  return [{ type: "notice", id: `error:${info.id}`, level: "warning", text: errorText(info.error, { ...(model && { model }) }) }];
}

/** A user message's several parts re-emit its one `user_text`: the last wins, at the first position. */
function dedupeUser(parts: Part[]): Part[] {
  const last = new Map<string, Part>();
  for (const p of parts) if (p.type === "user_text") last.set(p.id, p);
  const seen = new Set<string>();
  return parts.flatMap((p) => (p.type !== "user_text" ? [p] : seen.has(p.id) ? [] : (seen.add(p.id), [last.get(p.id)!])));
}
