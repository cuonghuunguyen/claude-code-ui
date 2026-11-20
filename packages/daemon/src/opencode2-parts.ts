// OpenCode 2 messages and events as Parts (docs/spec.md "OpenCode engine"): one stateful mapper for stored history and live events, so both give the same part
// ids. User message = one `user_text` (id = message id); text and reasoning = `<assistant message id>:<text|reasoning>:<ordinal>` (the ordinal counts per kind inside
// the message, as the `session.text.*` events do); a tool call's id = its call id. Shapes recorded in development-docs (planner-spike/v2-events.json).
import type { Part, ToolStatus } from "@claude-ui/protocol";
import { mapTool } from "./opencode-parts.ts";

/** `SessionStructuredError` of OpenCode 2. */
export type Failure = { type?: string; message?: string };
type Json = Record<string, any>;
type Content = { type: string; text?: string; id?: string; name?: string; state?: Json; time?: Json };
/** An entry of `GET /api/session/{id}/message`. Only `user` and `assistant` show in the timeline in this version. */
export type OpenCode2Message = { id: string; type: string; text?: string; files?: { data: string; mime: string }[]; content?: Content[]; error?: Failure; tokens?: Json; cost?: number; model?: { id: string; providerID: string } };

const STATUS: Record<string, ToolStatus> = { completed: "done", error: "error", streaming: "pending", running: "running" };

/** OpenCode 2 tool names that differ from OpenCode 1's (`shell`) and their input keys (`path`): the Claude card name and input shape the web knows. */
const KEYS: Record<string, string> = { path: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" };
export function mapTool2(name: string, input: Record<string, unknown> = {}): { tool: string; input: Record<string, unknown> } {
  if (name === "shell") return mapTool("bash", input);
  if (name === "read" || name === "edit" || name === "write") return mapTool(name, Object.fromEntries(Object.entries(input).map(([k, v]) => [KEYS[k] ?? k, v])));
  return mapTool(name, input);
}

/** The text of a tool result: its text blocks joined; a file block shows as its name or type. */
const outputOf = (content: unknown): string =>
  (Array.isArray(content) ? (content as Json[]) : [])
    .map((c) => (c.type === "text" ? String(c.text ?? "") : `[${c.name ?? c.mime ?? c.type ?? "file"}]`))
    .join("\n");

/** The first line of an error message: OpenCode may append stack lines. */
export const failureText = (e: Failure | undefined) => (e?.message ?? "").split("\n")[0]!.trim() || e?.type || "OpenCode reported an error";

export class OpenCode2Mapper {
  private readonly texts = new Map<string, Part & { type: "assistant_text" | "thinking" }>();
  private readonly calls = new Map<string, Part & { type: "tool_call" | "subagent" }>();
  private readonly denied = new Set<string>();
  /** Per assistant message id: tokens and cost of its step, summed for a turn's result. */
  private readonly steps = new Map<string, { tokens: Json; cost: number }>();
  /** Message ids of prompts this daemon sent: their echo adds nothing (user_text was emitted at once). */
  readonly own = new Set<string>();

  /** The OpenCode name and input of each call (the card has the mapped ones): later events of a call carry only its id. */
  private readonly raw = new Map<string, { name: string; input: Json }>();
  call = (callId: string) => this.calls.get(callId);
  /** Usage and cost summed over the steps since the last `resetTurn`. */
  turn() {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let cost = 0;
    for (const s of this.steps.values()) {
      usage.inputTokens += s.tokens?.input ?? 0;
      usage.outputTokens += (s.tokens?.output ?? 0) + (s.tokens?.reasoning ?? 0);
      usage.cacheReadTokens += s.tokens?.cache?.read ?? 0;
      usage.cacheCreationTokens += s.tokens?.cache?.write ?? 0;
      cost += s.cost;
    }
    return { usage, cost };
  }
  resetTurn = () => this.steps.clear();
  /** `step.ended`: the step's tokens and cost. */
  step(assistantMessageID: string, tokens: Json | undefined, cost: number | undefined) {
    if (tokens) this.steps.set(assistantMessageID, { tokens, cost: cost ?? 0 });
  }

  /** The user denied a call: its card stays `denied` when the failure comes. Returns the card to show now. */
  deny(callId: string): Part | undefined {
    this.denied.add(callId);
    const c = this.calls.get(callId);
    if (!c || c.type !== "tool_call") return;
    const next = { ...c, status: "denied" as const };
    this.calls.set(callId, next);
    return next;
  }

  /** Stored messages in order (nothing streams: an unfinished part shows as it was stored). */
  history(messages: readonly OpenCode2Message[]): Part[] {
    return messages.flatMap((m) => {
      if (m.type === "user") return this.user(m);
      if (m.type !== "assistant") return [];
      let text = 0;
      let reasoning = 0;
      const parts = (m.content ?? []).flatMap((c): Part[] => {
        if (c.type === "text") return this.text(`${m.id}:text:${text++}`, "assistant_text", c.text ?? "", false);
        if (c.type === "reasoning") return this.text(`${m.id}:reasoning:${reasoning++}`, "thinking", c.text ?? "", false);
        if (c.type === "tool" && c.id && c.name && c.state) return this.tool(c.id, c.name, c.state.status, c.state.input, c.state, c.time);
        return [];
      });
      // Why the step failed (the live `session.execution.failed` shows the same notice, same id); an interrupted step is the Stop, shown elsewhere.
      return m.error && m.error.type !== "aborted" ? [...parts, { type: "notice", id: `error:${m.id}`, level: "warning", text: failureText(m.error) }] : parts;
    });
  }

  private user(m: OpenCode2Message): Part[] {
    if (this.own.has(m.id)) return [];
    const images = (m.files ?? []).filter((f) => f.mime?.startsWith("image/") && f.data).map((f) => `data:${f.mime};base64,${f.data}`);
    return m.text || images.length ? [{ type: "user_text", id: m.id, text: m.text ?? "", images }] : [];
  }

  /** A prompt of this turn that came from elsewhere (OpenCode's own UI): `session.inbox.enqueued`. */
  inbox(data: Json): Part[] {
    const item = data.item as Json | undefined;
    if (item?.type !== "user" || this.own.has(data.inboxID)) return [];
    return [{ type: "user_text", id: data.inboxID, text: String(item.payload?.text ?? ""), images: [] }];
  }

  private text(id: string, type: "assistant_text" | "thinking", text: string, streaming: boolean): Part[] {
    if (!text && !streaming) return [];
    const part = { type, id, text, streaming };
    this.texts.set(id, part);
    return [part];
  }

  private tool(callId: string, name: string, status: string, input: Json | undefined, state: Json, time?: Json): Part[] {
    this.raw.set(callId, { name, input: status === "streaming" ? (this.raw.get(callId)?.input ?? {}) : (input ?? this.raw.get(callId)?.input ?? {}) });
    input = this.raw.get(callId)!.input;
    let st = STATUS[status] ?? "pending";
    // A rejected permission request ends the call with `permission.rejected` (live and stored): the card is denied, not failed.
    if ((this.denied.has(callId) && st !== "done") || state.error?.type === "permission.rejected") st = "denied";
    const times = { ...(time?.ran && { startedAt: time.ran }), ...(time?.completed && { endedAt: time.completed }) };
    const parsed = status === "streaming" ? {} : (input ?? {});
    if (name === "subagent") {
      const sub = { type: "subagent" as const, id: callId, toolUseId: callId, description: String(parsed.description ?? ""), status: st, startedAt: time?.ran ?? time?.created ?? 0, ...(time?.completed && { endedAt: time.completed }) };
      this.calls.set(callId, sub);
      return [sub];
    }
    const { tool, input: mapped } = mapTool2(name, parsed);
    const exit = state.metadata?.exit;
    const call = { type: "tool_call" as const, id: callId, toolUseId: callId, tool, input: mapped, status: st, ...times, ...(typeof exit === "number" && { exitCode: exit }) };
    this.calls.set(callId, call);
    const out: Part[] = [call];
    if (status === "completed" || status === "error") {
      const error = status === "error";
      const output = error ? [failureText(state.error), outputOf(state.content)].filter(Boolean).join("\n") : outputOf(state.content);
      out.push({ type: "tool_result", id: `${callId}:result`, toolUseId: callId, output, isError: error });
    }
    return out;
  }

  /** One live `session.text.*`, `session.reasoning.*` or `session.tool.*` event; other types: nothing. */
  event(type: string, d: Json): Part[] {
    switch (type) {
      case "session.text.started":
        return this.text(`${d.assistantMessageID}:text:${d.ordinal}`, "assistant_text", "", true);
      case "session.reasoning.started":
        return this.text(`${d.assistantMessageID}:reasoning:${d.ordinal}`, "thinking", "", true);
      case "session.text.delta":
        return this.delta(`${d.assistantMessageID}:text:${d.ordinal}`, d.delta);
      case "session.reasoning.delta":
        return this.delta(`${d.assistantMessageID}:reasoning:${d.ordinal}`, d.delta);
      case "session.text.ended":
        return this.ended(`${d.assistantMessageID}:text:${d.ordinal}`, "assistant_text", d.text);
      case "session.reasoning.ended":
        return this.ended(`${d.assistantMessageID}:reasoning:${d.ordinal}`, "thinking", d.text);
      case "session.tool.input.started":
        return this.tool(d.id, d.name, "streaming", undefined, {}, { created: Date.now() });
      case "session.tool.called": {
        const name = this.raw.get(d.id)?.name;
        return name ? this.tool(d.id, name, "running", d.input, {}, { created: Date.now(), ran: Date.now() }) : [];
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const name = this.raw.get(d.id)?.name;
        const done = type === "session.tool.success";
        return name ? this.tool(d.id, name, done ? "completed" : "error", undefined, { content: d.content, error: d.error, metadata: d.metadata }, { completed: Date.now() }) : [];
      }
    }
    return [];
  }

  private delta(id: string, delta: string): Part[] {
    const t = this.texts.get(id);
    if (!t) return [];
    const next = { ...t, text: t.text + delta };
    this.texts.set(id, next);
    return [next];
  }
  private ended(id: string, type: "assistant_text" | "thinking", text: string): Part[] {
    const part = { type, id, text: text ?? this.texts.get(id)?.text ?? "", streaming: false };
    this.texts.set(id, part);
    return part.text ? [part] : [];
  }
}
