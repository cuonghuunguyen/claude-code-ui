// OpenCode 2 messages and events as Parts (docs/spec.md "OpenCode engine"): one stateful mapper for stored history and live events, so both give the same part
// ids. User message = one `user_text` (id = message id); text and reasoning = `<assistant message id>:<text|reasoning>:<ordinal>` (the ordinal counts per kind inside
// the message, as the `session.text.*` events do); a tool call's id = its call id. Shapes recorded in development-docs (planner-spike/v2-events.json).
import type { Part, ToolStatus } from "@claude-ui/protocol";
import { canon, mapTool } from "./opencode-parts.ts";
import { FORK_TOOL } from "./opencode-fork.ts";

/** `SessionStructuredError` of OpenCode 2. */
export type Failure = { type?: string; message?: string };
type Json = Record<string, any>;
type Content = { type: string; text?: string; id?: string; name?: string; state?: Json; time?: Json };
/** An entry of `GET /api/session/{id}/message`. `user`, `assistant`, `shell` (bash mode) and `compaction` show in the timeline. */
export type OpenCode2Message = {
  id: string;
  type: string;
  text?: string;
  files?: { data: string; mime: string }[];
  content?: Content[];
  error?: Failure;
  tokens?: Json;
  cost?: number;
  model?: { id: string; providerID: string };
  /** `shell`: the command run, its state and output. */
  shellID?: string;
  command?: string;
  status?: string;
  exit?: number | string;
  output?: { output?: string };
  /** `compaction`: why it ran and the summary it wrote. */
  reason?: string;
  summary?: string;
  /** `synthetic`: the notice of a background shell's end (`metadata.source` `shell`). */
  metadata?: Json;
  time?: Json;
};
/** A bash mode command of OpenCode 2 (`ShellInfo`, `session.shell.*`). */
export type Shell2 = { id: string; command: string; status: string; exit?: number | string };

/** The `bash` part of a bash mode command (id = OpenCode's shell id, live and stored): killed or timed out = stopped, an exit code other than 0 = error. */
export function bashPart(sh: Shell2, stdout: string): Extract<Part, { type: "bash" }> {
  const exit = typeof sh.exit === "number" ? sh.exit : undefined;
  const status = sh.status === "running" ? "running" : sh.status === "exited" ? (exit ? "error" : "done") : "stopped";
  return { type: "bash", id: sh.id, command: sh.command, stdout, stderr: "", status, ...(exit !== undefined && { exitCode: exit }) };
}
/** The compaction marker (id = the compaction's inbox id, live and stored) and, when it failed, OpenCode's reason as a warning. */
const compactionParts = (id: string, reason: string | undefined, summary: string | undefined, error: Failure | undefined): Part[] => [
  { type: "compaction", id, trigger: reason === "auto" ? "auto" : "manual", ...(summary && { summary }) },
  ...(error ? [{ type: "notice" as const, id: `error:${id}`, level: "warning" as const, text: failureText(error) }] : []),
];

/** How a background shell of the model ended: the card's status, the exit code and the output OpenCode's end notice carried (none for a killed one). */
type ShellEnd = { status: "done" | "error" | "stopped"; exit?: number; output?: string; at?: number };
/** Ends of foreign shells (another session's) one mapper keeps. */
const SHELL_ENDS_KEPT = 100;
/** The id of the shell a background call started, from the call's result text. */
const SHELL_ID = /shell ID: (sh_\w+)/;
/** The output inside a shell end notice (`<shell id=… state=…>\noutput\n</shell>`). */
const noticeOutput = (text: string) => /^<shell[^>]*>\n([\s\S]*)\n<\/shell>\s*$/.exec(text)?.[1] ?? "";

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
  /** The compaction running now: its inbox id (`session.compaction.ended` and `failed` do not carry it). */
  private compacting: { id: string; reason?: string } | undefined;
  /** Message ids of prompts this daemon sent: their echo and a re-read add nothing (user_text was emitted at once; a re-emit would look like a new message). */
  readonly own = new Set<string>();
  /** Prompts of ours a revert cut: the next read that lists one again (a redo or clear) shows it once, then it is ours again. */
  private readonly forgotten = new Set<string>();
  /** A revert cut at `id`: the prompts sent here from it on are hidden, a later read (redo) must show them again. Ids ascend with time (`opencode-id.ts`). */
  forgetFrom(id: string) {
    for (const o of this.own) if (o >= id) (this.own.delete(o), this.forgotten.add(o));
  }

  /** Background shells of the model (`shell` call with `background: true`): call id -> shell id, and how each shell ended. */
  private readonly shellOfCall = new Map<string, string>();
  private readonly shellEnds = new Map<string, ShellEnd>();
  /** The shell id of background call `callId`. */
  shellOf = (callId: string) => this.shellOfCall.get(callId);
  shellEnd = (shellId: string) => this.shellEnds.get(shellId);
  /** `[call id, shell id]` of the background calls whose shell has not ended. */
  openShells = () => [...this.shellOfCall].filter(([callId, sh]) => !this.shellEnds.has(sh) && this.calls.has(callId));
  /** `shell.exited` (killed, or finished with `exit`): the call's card shows how it ended. Another session's shell changes nothing. */
  shellExited(shellId: string, status: string | undefined, exit: number | undefined): Part[] {
    this.shellEnds.set(shellId, { ...this.shellEnds.get(shellId), status: status === "exited" ? (exit ? "error" : "done") : "stopped", ...(exit !== undefined && { exit }), at: Date.now() });
    this.pruneShellEnds();
    return this.shellCard(shellId);
  }
  /** `shell.exited` reaches every session: the ends of shells no call of this session started (and none claimed yet) are kept up to SHELL_ENDS_KEPT, oldest dropped first. */
  private pruneShellEnds() {
    const own = new Set(this.shellOfCall.values());
    const foreign = [...this.shellEnds.keys()].filter((id) => !own.has(id));
    for (const id of foreign.slice(0, Math.max(0, foreign.length - SHELL_ENDS_KEPT))) this.shellEnds.delete(id);
  }
  /** The end notice of a shell (live inbox item or stored message): its output. The shell's own end (`shell.exited`) decides the status; a notice alone (a shell gone while the daemon was away) does. */
  private shellNotice(m: Json, at: number | undefined): Part[] {
    const id = m?.shellID;
    if (typeof id !== "string") return [];
    const prev = this.shellEnds.get(id);
    const done = m.state === "completed";
    const exit = typeof m.exit === "number" ? m.exit : undefined;
    this.shellEnds.set(id, { status: done ? (exit ? "error" : "done") : "stopped", ...(exit !== undefined && { exit }), ...(at && { at }), ...prev, ...(done && m.output !== undefined && { output: m.output }) });
    return this.shellCard(id);
  }
  /** The card of the call that started shell `shellId`, in its ended state. */
  private shellCard(shellId: string): Part[] {
    const callId = [...this.shellOfCall].find(([, sh]) => sh === shellId)?.[0];
    const call = callId ? this.calls.get(callId) : undefined;
    const end = this.shellEnds.get(shellId);
    if (!call || call.type !== "tool_call" || !end) return [];
    const next = { ...call, status: end.status, ...(end.at && { endedAt: end.at }), ...(end.exit !== undefined && { exitCode: end.exit }) };
    this.calls.set(call.id, next);
    return [next];
  }

  /** The OpenCode name and input of each call (the card has the mapped ones): later events of a call carry only its id. */
  private readonly raw = new Map<string, { name: string; input: Json }>();
  call = (callId: string) => this.calls.get(callId);
  /** Whether call `id` is still pending or running. */
  isRunning = (id: string) => {
    const c = this.calls.get(id);
    return !!c && (c.type === "tool_call" || c.agentType === "fork") && (c.status === "running" || c.status === "pending");
  };
  /** The OpenCode names (tool keys) of the calls still pending or running. */
  runningTools = (): string[] => [...this.calls.keys()].filter(this.isRunning).map((id) => this.raw.get(id)?.name ?? "");
  /** The newest running Fork run call (`fork` tool) whose input equals `input` and is not in `skip`. */
  runningFork(input: Record<string, unknown> | undefined, skip: ReadonlySet<string>): string | undefined {
    const want = JSON.stringify(canon(input ?? {}));
    return [...this.calls.values()].reverse().find((c) => c.type === "subagent" && c.agentType === "fork" && (c.status === "running" || c.status === "pending") && !skip.has(c.id) && JSON.stringify(canon(this.raw.get(c.id)?.input ?? {})) === want)?.id;
  }
  /** The newest running call of `tool` (its card name) whose input equals `input` and is not in `skip` (the call an inline run belongs to). */
  runningCall(tool: string, input: Record<string, unknown> | undefined, skip: ReadonlySet<string>): string | undefined {
    const want = JSON.stringify(canon(input ?? {}));
    return [...this.calls.values()].reverse().find((c) => c.type === "tool_call" && c.tool === tool && (c.status === "running" || c.status === "pending") && !skip.has(c.id) && JSON.stringify(canon(c.input)) === want)?.id;
  }
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
    // The end notices of background shells come after the calls: read first, so each call shows its shell's end.
    for (const m of messages) if (m.type === "synthetic" && m.metadata?.source === "shell") this.shellNotice({ ...m.metadata, output: noticeOutput(m.text ?? "") }, m.time?.created);
    return messages.flatMap((m) => {
      if (m.type === "user") return this.user(m);
      if (m.type === "shell" && m.shellID) return [bashPart({ id: m.shellID, command: m.command ?? "", status: m.status ?? "exited", exit: m.exit }, m.output?.output ?? "")];
      if (m.type === "compaction") return m.status === "running" ? [] : compactionParts(m.id, m.reason, m.summary, m.error);
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

  /** A stored user message; one sent here only once after a cut forgot it (its bubble was taken away: the first read after the clear brings it back). */
  private user(m: OpenCode2Message): Part[] {
    if (this.own.has(m.id)) return [];
    if (this.forgotten.delete(m.id)) this.own.add(m.id);
    const images = (m.files ?? []).filter((f) => f.mime?.startsWith("image/") && f.data).map((f) => `data:${f.mime};base64,${f.data}`);
    return m.text || images.length ? [{ type: "user_text", id: m.id, text: m.text ?? "", images }] : [];
  }

  /** A prompt of this turn that came from elsewhere (OpenCode's own UI): `session.inbox.enqueued`. */
  inbox(data: Json): Part[] {
    const item = data.item as Json | undefined;
    // A background shell's end notice starts OpenCode's next execution: no bubble, the call's card ends.
    if (item?.type === "synthetic" && item.payload?.metadata?.source === "shell") return this.shellNotice({ ...item.payload.metadata, output: noticeOutput(String(item.payload.text ?? "")) }, Date.now());
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
      const sub = { type: "subagent" as const, id: callId, toolUseId: callId, description: String(parsed.description ?? ""), status: st, startedAt: time?.ran ?? time?.created ?? this.calls.get(callId)?.startedAt ?? 0, ...(time?.completed && { endedAt: time.completed }) };
      this.calls.set(callId, sub);
      return [sub];
    }
    const { tool, input: mapped } = mapTool2(name, parsed);
    // A Fork run (docs/spec.md "Fork runs"): the `fork` tool of the claude-ui server shows as the Fork run card (a `subagent` part), as on OpenCode 1.
    if (tool === FORK_TOOL) {
      const run = { type: "subagent" as const, id: callId, toolUseId: callId, description: String(mapped.description ?? ""), status: st, startedAt: time?.ran ?? time?.created ?? this.calls.get(callId)?.startedAt ?? Date.now(), agentType: "fork", ...(time?.completed && { endedAt: time.completed }) };
      this.calls.set(callId, run);
      return [run];
    }
    let exit = state.metadata?.exit;
    // A background shell runs on after its call returned: the card runs until the shell's end (`shell.exited`, its notice), the call's own end is only "moved to the background".
    const background = name === "shell" && parsed.background === true;
    let ended: ShellEnd | undefined;
    if (background) {
      const sh = this.shellOfCall.get(callId) ?? SHELL_ID.exec(outputOf(state.content))?.[1];
      if (sh) this.shellOfCall.set(callId, sh);
      ended = sh ? this.shellEnds.get(sh) : undefined;
      if (sh && st === "done") st = ended?.status ?? "running";
      if (ended) exit = ended.exit ?? exit;
    }
    const stamps: { startedAt?: number; endedAt?: number } = { ...times };
    if (background && (st === "running" || st === "pending")) delete stamps.endedAt;
    else if (ended?.at) stamps.endedAt = ended.at;
    const call = { type: "tool_call" as const, id: callId, toolUseId: callId, tool, input: mapped, status: st, ...stamps, ...(background && { shell: "background" as const }), ...(typeof exit === "number" && { exitCode: exit }) };
    this.calls.set(callId, call);
    const out: Part[] = [call];
    if (status === "completed" || status === "error") {
      const error = status === "error";
      const output = error ? [failureText(state.error), outputOf(state.content)].filter(Boolean).join("\n") : outputOf(state.content);
      out.push({ type: "tool_result", id: `${callId}:result`, toolUseId: callId, output, isError: error });
    }
    return out;
  }

  /** One live `session.text.*`, `session.reasoning.*`, `session.tool.*` or `session.compaction.*` event; other types: nothing. */
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
      case "session.compaction.started":
        this.compacting = { id: d.inputID, reason: d.reason };
        return compactionParts(d.inputID, d.reason, undefined, undefined);
      case "session.compaction.ended":
      case "session.compaction.failed": {
        const c = this.compacting;
        this.compacting = undefined;
        return c ? compactionParts(c.id, c.reason, type === "session.compaction.ended" ? d.text : undefined, d.error) : [];
      }
      case "session.tool.input.started":
        return this.tool(d.id, d.name, "streaming", undefined, {}, { created: Date.now() });
      case "session.tool.progress": {
        const shellID = d.metadata?.shellID;
        if (typeof shellID === "string" && this.raw.get(d.id)?.name === "shell") this.shellOfCall.set(d.id, shellID);
        return [];
      }
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
