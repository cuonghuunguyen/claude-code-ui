// OpenCode messages and events as Parts (docs/spec.md "OpenCode engine"): one stateful mapper for stored history and live events, so both
// give the same part ids. User message = one `user_text` (id = message id); text/reasoning/tool part ids = the OpenCode part id; a tool call's id = its callID.
import type { Part, ToolStatus, TodoItem } from "@claude-ui/protocol";

type ToolState = { status: string; title?: string; input?: Record<string, unknown>; output?: string; error?: string; metadata?: Record<string, unknown>; time?: { start?: number; end?: number } };
export type OpenCodePart = {
  id: string;
  type: string;
  sessionID?: string;
  messageID?: string;
  text?: string;
  synthetic?: boolean;
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
export type OpenCodeMessage = { info: { id: string; role: "user" | "assistant"; agent?: string }; parts: OpenCodePart[] };
export type OpenCodeTodo = { content: string; status: string };

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
  const rule = RENAME[name];
  if (!rule) return { tool: name, input };
  const mapped = Object.fromEntries(Object.entries(input).map(([k, v]) => [rule[1][k] ?? k, v]));
  if (name === "question" && Array.isArray(mapped.questions))
    mapped.questions = mapped.questions.map(({ multiple, ...q }: Record<string, unknown>) => ({ ...q, multiSelect: multiple === true }));
  return { tool: rule[0], input: mapped };
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
  private readonly finishes = new Map<string, OpenCodePart>();
  /** Message ids of prompts this daemon sent: their echo adds nothing (user_text was emitted at once). */
  readonly own = new Set<string>();

  /** The call id of a child session, undefined for the root session. */
  parentOf = (sessionId: string | undefined) => (sessionId ? this.children.get(sessionId) : undefined);
  isChild = (sessionId: string) => this.children.has(sessionId);
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
    if ((p.type === "text" || p.type === "file") && !role) {
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
    if (this.denied.has(callId) && status !== "done") status = "denied";
    const times = { ...(s.time?.start && { startedAt: s.time.start }), ...(s.time?.end && { endedAt: s.time.end }) };
    if (p.tool === "task") {
      const child = s.metadata?.sessionId;
      if (typeof child === "string") this.children.set(child, callId);
      const sub = { type: "subagent" as const, id: callId, toolUseId: callId, description: String(s.input?.description ?? s.title ?? ""), status, startedAt: s.time?.start ?? 0, ...(s.time?.end && { endedAt: s.time.end }) };
      this.calls.set(callId, sub);
      return [sub];
    }
    const { tool, input } = mapTool(p.tool ?? "", s.input);
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
export function openCodeParts(messages: readonly OpenCodeMessage[], children: Readonly<Record<string, readonly OpenCodeMessage[]>> = {}, m = new OpenCodeMapper()): Part[] {
  const walk = (list: readonly OpenCodeMessage[], sessionID?: string): Part[] =>
    list.flatMap((msg) => [
      ...m.message(msg.info, false),
      ...msg.parts.flatMap((p) => {
        const out = m.part({ ...p, messageID: p.messageID ?? msg.info.id, sessionID: p.sessionID ?? sessionID }, false);
        const child = p.state?.metadata?.sessionId;
        return typeof child === "string" && children[child] ? [...out, ...walk(children[child]!, child)] : out;
      }),
    ]);
  return dedupeUser(walk(messages));
}

/** A user message's several parts re-emit its one `user_text`: the last wins, at the first position. */
function dedupeUser(parts: Part[]): Part[] {
  const last = new Map<string, Part>();
  for (const p of parts) if (p.type === "user_text") last.set(p.id, p);
  const seen = new Set<string>();
  return parts.flatMap((p) => (p.type !== "user_text" ? [p] : seen.has(p.id) ? [] : (seen.add(p.id), [last.get(p.id)!])));
}
