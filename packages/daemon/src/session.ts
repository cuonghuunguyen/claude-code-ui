// A live session: one long-lived streaming-input query() whose SDK messages become logged events.
import { randomUUID } from "node:crypto";
import {
  query as sdkQuery,
  type CanUseTool,
  type ModelInfo,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createAdapter,
  imageBlock,
  type Event,
  type Part,
  type PermissionDecision,
  type Question,
  type RewindMode,
  type RewindPreview,
  type SessionInfo,
  type SessionState,
} from "@claude-ui/protocol";

type Listener = (e: Event) => void;
// Claude Code's wording, so Claude reads the feedback as the user's instruction rather than as tool output.
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
type PermissionPart = Extract<Part, { type: "permission_request" }>;
type QuestionPart = Extract<Part, { type: "question" }>;
type Answer = { decision: "allow" | "allow_always" | "deny"; ruleIndex?: number; message?: string; updatedInput?: Record<string, unknown> };

// Claude Code's sources: "local" (.claude/settings.local.json) holds the rules "don't ask again" saves.
const SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

type SessionOpts = { model?: string; query?: typeof sdkQuery };

export class Session {
  readonly id: string;
  readonly createdAt = Date.now();
  private state: SessionState = "idle";
  // ponytail: in-memory log grows for the session lifetime; trim when memory matters.
  private readonly log: Event[] = [];
  private readonly listeners = new Set<Listener>();
  private input = new InputQueue();
  private query?: Query;
  private model: string;
  private readonly adapter: ReturnType<typeof createAdapter>;
  /** Bumped when a conversation rewind drops the query; the old drive loop then stops logging. */
  private generation = 0;
  /**
   * Checkpoints: user prompt UUID -> UUID of the last main-thread assistant message before it, which is the
   * `resumeSessionAt` fork point of a conversation rewind (undefined for the first prompt). Insertion order = prompt order.
   */
  private readonly checkpoints = new Map<string, string | undefined>();
  private lastAssistant?: string;
  /** Fork point for the next start() after a conversation rewind. */
  private resumeAt?: string;
  /** True while rewind() awaits rewindFiles(): a prompt then would run on the query the rewind closes. */
  private rewinding = false;
  /** Pending permission requests and questions by requestId (docs/spec.md "Permission bridge", "Questions"). */
  private readonly pending = new Map<string, { part: PermissionPart | QuestionPart; resolve: (r: PermissionResult) => void }>();

  constructor(
    readonly cwd: string,
    private readonly opts: SessionOpts = {},
    restored?: { id: string; history: SessionMessage[] },
  ) {
    this.id = restored?.id ?? randomUUID();
    this.model = opts.model ?? "default";
    this.adapter = createAdapter({ resumed: !!restored });
    if (!restored) {
      this.start({ sessionId: this.id });
      return;
    }
    // ADR 0001: after a daemon restart the SDK transcript is the history; the query resumes on the first prompt.
    const adapter = createAdapter();
    for (const m of restored.history) {
      for (const part of adapter.convert(m as SDKMessage)) {
        if (part.type === "user_text") this.checkpoints.set(part.id, this.lastAssistant);
        this.emit(part);
      }
      if (m.type === "assistant" && !m.parent_tool_use_id) this.lastAssistant = m.uuid;
    }
    this.setState("idle");
  }

  /** Rebuilds a session from its SDK transcript (`getSessionMessages()`); a prompt resumes it with the same ID. */
  static restore(id: string, cwd: string, history: SessionMessage[], opts: SessionOpts = {}) {
    return new Session(cwd, opts, { id, history });
  }

  private start(ids: { sessionId: string } | { resume: string }) {
    const q = (this.query = (this.opts.query ?? sdkQuery)({
      prompt: this.input,
      options: {
        ...ids,
        resumeSessionAt: this.resumeAt,
        // Checkpoints: file backups per user message, and the user message UUIDs echoed back.
        enableFileCheckpointing: true,
        cwd: this.cwd,
        model: this.model === "default" ? undefined : this.model,
        includePartialMessages: true,
        settingSources: SETTING_SOURCES,
        // Thinking text is omitted by default; summaries feed the thinking parts.
        extraArgs: { "thinking-display": "summarized", "replay-user-messages": null },
        // Subagent text and thinking too, not only its tool calls: the UI shows the nested transcript.
        forwardSubagentText: true,
        // ADR 0002: subscription login only. An inherited API key would take precedence and bill per token.
        // Todo tools are off by default on current models; TodoWrite (not the Task* tools) sends the whole list.
        env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_ENABLE_TASKS: "0", ...withoutApiKeys(process.env) },
        canUseTool: this.canUseTool,
      },
    }));
    this.resumeAt = undefined;
    void this.drive(q);
    // Later changes arrive as system/commands_changed through drive().
    q.supportedCommands().then(
      (list) => this.adapter.commands(list).forEach((p) => this.emit(p)),
      (err) => console.error(`session ${this.id}: supportedCommands failed:`, err),
    );
    return q;
  }

  info(): SessionInfo {
    return { id: this.id, cwd: this.cwd, state: this.state, model: this.model };
  }

  /** Replays events with seq > sinceSeq, then follows. Returns an unsubscribe function. */
  subscribe(sinceSeq: number, listener: Listener): () => void {
    for (const e of this.log) if (e.seq > sinceSeq) listener(e);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** False once the query ended or failed: nothing reads the input queue any more. */
  isLive() {
    return this.state !== "error" && this.state !== "closed";
  }

  /** `images`: data URLs already checked with imageBlock(). */
  prompt(text: string, images: string[] = []) {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    if (this.rewinding) throw new Error("session is rewinding");
    const uuid = randomUUID();
    this.checkpoints.set(uuid, this.lastAssistant);
    this.emit({ type: "user_text", id: uuid, text, images });
    this.setState(this.pending.size ? "needs_input" : "running");
    if (!this.query) this.start({ resume: this.id });
    const content = images.length
      ? [...(text ? [{ type: "text" as const, text }] : []), ...images.map((i) => imageBlock(i)!)]
      : text;
    this.input.push({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null });
  }

  /** Switches the live query's model; "default" resets to the SDK default. A restored session not yet resumed resumes with it. */
  async setModel(model: string) {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    await this.query?.setModel(model);
    this.model = model;
    this.emit({ type: "session_model", id: "session_model", model });
  }

  /**
   * Claude Code's Esc: denies pending permission requests and cancels pending questions, then `interrupt()`. The CLI
   * ends the turn with a turn_interrupted marker and an aborted result, which returns the session to idle; the query stays live.
   */
  async interrupt() {
    if (!this.query || (this.state !== "running" && this.state !== "needs_input")) return;
    for (const [id, { part }] of [...this.pending]) {
      if (part.type === "question") {
        this.cancel(id, REJECTED);
        continue;
      }
      for (const p of this.adapter.deny(part.toolUseId)) this.emit(p);
      this.settle(id, { decision: "deny" }, { behavior: "deny", message: REJECTED, interrupt: true });
    }
    await this.query.interrupt();
  }

  /** Dry run of a code rewind to before this prompt. */
  async previewRewind(userMessageId: string): Promise<RewindPreview> {
    const r = await this.control(userMessageId).rewindFiles(userMessageId, { dryRun: true });
    // canRewind false: no file checkpoint for this message, so nothing to restore.
    const files = r.canRewind ? (r.filesChanged ?? []) : [];
    return {
      filesChanged: files,
      insertions: files.length ? (r.insertions ?? 0) : 0,
      deletions: files.length ? (r.deletions ?? 0) : 0,
      conversation: this.checkpoints.get(userMessageId) !== undefined,
    };
  }

  /** Claude Code `/rewind` to before this prompt: files via `rewindFiles()`, conversation via `resumeSessionAt` on the next prompt. */
  async rewind(userMessageId: string, mode: RewindMode) {
    const q = this.control(userMessageId);
    const forkAt = this.checkpoints.get(userMessageId);
    if (mode !== "code" && forkAt === undefined) throw new Error("cannot rewind the conversation to before the first prompt");
    if (mode !== "conversation") {
      this.rewinding = true;
      try {
        const r = await q.rewindFiles(userMessageId);
        if (!r.canRewind) throw new Error(r.error ?? "cannot rewind files");
      } finally {
        this.rewinding = false;
      }
    }
    if (mode === "code") return;
    // The running CLI holds the full conversation: drop it; the next prompt resumes the transcript truncated at forkAt.
    // resumeDropsTurn is not passed: it refuses any discarded range longer than one turn (verified with SDK 0.3.285).
    this.generation++;
    this.query?.close();
    this.query = undefined;
    this.input = new InputQueue();
    this.resumeAt = this.lastAssistant = forkAt;
    let drop = false;
    for (const id of [...this.checkpoints.keys()]) if ((drop ||= id === userMessageId)) this.checkpoints.delete(id);
    this.emit({ type: "rewind", id: randomUUID(), userMessageId });
  }

  /** The query to send control requests to, started (resumed) without a prompt if none runs. */
  private control(userMessageId: string): Query {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    if (this.rewinding) throw new Error("session is rewinding");
    if (this.state !== "idle") throw new Error("session is running: interrupt the turn first");
    if (!this.checkpoints.has(userMessageId)) throw new Error(`unknown user message ${userMessageId}`);
    return this.query ?? this.start({ resume: this.id });
  }

  /** Rules already saved never reach this callback. No timeout: the promise waits for respond() or the SDK's abort. */
  private readonly canUseTool: CanUseTool = (tool, input, { signal, suggestions = [], toolUseID, title }) =>
    new Promise((resolve) => {
      const requestId = randomUUID();
      const part: PermissionPart | QuestionPart =
        tool === "AskUserQuestion"
          ? { type: "question", id: requestId, requestId, toolUseId: toolUseID, questions: (input as { questions: Question[] }).questions, settled: false }
          : {
              type: "permission_request",
              id: requestId,
              requestId,
              toolUseId: toolUseID,
              tool,
              input,
              ...(title ? { title } : {}),
              suggestions,
              settled: false,
            };
      this.pending.set(requestId, { part, resolve });
      this.emit(part);
      this.setState("needs_input");
      signal.addEventListener("abort", () => this.cancel(requestId, "Request cancelled"), { once: true });
    });

  /** Answers a pending permission request. False when it is already settled or unknown: the first answer wins. */
  respond(requestId: string, { decision, ruleIndex, message, updatedInput }: Answer): boolean {
    const req = this.pending.get(requestId);
    if (req?.part.type !== "permission_request") return false;
    const { input, suggestions, toolUseId } = req.part;
    const text = message?.trim();
    if (decision === "deny") {
      for (const part of this.adapter.deny(toolUseId)) this.emit(part);
      // Like Claude Code: "No" with feedback lets Claude continue with it; a bare "No" stops the turn.
      return this.settle(
        requestId,
        { decision: "deny", ...(text ? { message: text } : {}) },
        text ? { behavior: "deny", message: `${REJECTED} To tell you how to proceed, the user said:\n${text}` } : { behavior: "deny", message: REJECTED, interrupt: true },
      );
    }
    const updatedPermissions = ruleIndex === undefined ? suggestions : suggestions.slice(ruleIndex, ruleIndex + 1);
    // Edit before accept: the timeline shows what runs, not Claude's proposal.
    if (updatedInput) for (const part of this.adapter.edit(toolUseId, updatedInput)) this.emit(part);
    return this.settle(
      requestId,
      { decision, ...(updatedInput ? { input: updatedInput, editedByUser: true } : {}) },
      { behavior: "allow", updatedInput: updatedInput ?? (input as Record<string, unknown>), ...(decision === "allow_always" ? { updatedPermissions } : {}) },
    );
  }

  /** Answers a pending question (answers: question text -> answer). False when already settled or unknown: the first answer wins. */
  answer(requestId: string, answers: Record<string, string>): boolean {
    const req = this.pending.get(requestId);
    if (req?.part.type !== "question") return false;
    // The SDK docs: updatedInput must carry the original questions next to the answers.
    return this.settle(requestId, { answers }, { behavior: "allow", updatedInput: { questions: req.part.questions, answers } });
  }

  /** A cancelled permission request gets decision "cancelled"; a cancelled question settles without answers. */
  private cancel(requestId: string, message: string) {
    const done = this.pending.get(requestId)?.part.type === "permission_request" ? { decision: "cancelled" as PermissionDecision } : {};
    this.settle(requestId, done, { behavior: "deny", message });
  }

  private settle(requestId: string, done: Partial<PermissionPart> | Partial<QuestionPart>, result: PermissionResult) {
    const req = this.pending.get(requestId);
    if (!req) return false;
    this.pending.delete(requestId);
    this.emit({ ...req.part, ...done, settled: true } as Part);
    if (!this.pending.size && this.state === "needs_input") this.setState("running");
    req.resolve(result);
    return true;
  }

  private async drive(q: AsyncIterable<SDKMessage>) {
    const generation = this.generation;
    try {
      for await (const m of q) {
        if (generation !== this.generation) return;
        // Echo of a prompt() message (replay-user-messages); its user_text is already logged. The CLI took it now:
        // a steering message pushed as the turn ended starts a turn of its own.
        if (m.type === "user" && "isReplay" in m && m.isReplay) {
          if (this.state === "idle") this.setState("running");
          continue;
        }
        if (m.type === "assistant" && !m.parent_tool_use_id) this.lastAssistant = m.uuid;
        for (const part of this.adapter.convert(m)) this.emit(part);
        if (m.type === "result") this.setState("idle");
      }
      if (generation === this.generation) this.setState("closed");
    } catch (err) {
      if (generation !== this.generation) return;
      console.error(`session ${this.id} failed:`, err);
      this.emit({ type: "raw", id: randomUUID(), message: { error: String(err) } });
      this.setState("error");
    } finally {
      // Nothing waits for these answers any more.
      for (const id of [...this.pending.keys()]) this.cancel(id, "Session ended");
    }
  }

  private setState(state: SessionState) {
    this.state = state;
    this.emit({ type: "session_state", id: "session_state", state });
  }

  private emit(part: Part) {
    const e: Event = { type: "event", sessionId: this.id, seq: this.log.length + 1, part };
    this.log.push(e);
    for (const l of this.listeners) l(e);
  }
}

// The CLI's echo of a model switch, with the resolved model ID in parentheses.
const SET_MODEL = /^<local-command-stdout>Set model to `.*\(([^()\s]+)\)`<\/local-command-stdout>$/s;

/** Model ID a transcript last ran on (main-thread reply) or switched to (model switch echo); undefined when it has none. */
export function transcriptModel(history: SessionMessage[]): string | undefined {
  let model: string | undefined;
  for (const m of history) {
    const { model: used, content } = m.message as { model?: unknown; content?: unknown };
    // "<synthetic>": a CLI-made reply (API error), no model ran.
    if (m.type === "assistant" && !m.parent_tool_use_id && typeof used === "string" && !used.startsWith("<")) model = used;
    if (m.type === "user" && typeof content === "string") model = SET_MODEL.exec(content)?.[1] ?? model;
  }
  return model;
}

/** supportedModels() needs a query; this one gets no prompt and is closed right after the answer. */
export async function listModels(query: typeof sdkQuery = sdkQuery): Promise<ModelInfo[]> {
  const q = query({ prompt: new InputQueue(), options: { settingSources: SETTING_SOURCES, env: withoutApiKeys(process.env) } });
  try {
    return await q.supportedModels();
  } finally {
    q.close();
  }
}

function withoutApiKeys(env: NodeJS.ProcessEnv) {
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  return rest;
}

/** Async iterable fed by prompt(); stays open for the session lifetime (streaming input mode). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;

  push(m: SDKUserMessage) {
    this.items.push(m);
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}
