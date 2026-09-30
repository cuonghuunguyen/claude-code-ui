// A live session: one long-lived streaming-input query() whose SDK messages become logged events.
import { randomUUID } from "node:crypto";
import { query as sdkQuery, type ModelInfo, type Query, type SDKMessage, type SDKUserMessage, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createAdapter,
  imageBlock,
  type Event,
  type Part,
  type RewindMode,
  type RewindPreview,
  type SessionInfo,
  type SessionState,
} from "@claude-ui/protocol";

type Listener = (e: Event) => void;

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
  private readonly adapter = createAdapter();
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

  constructor(
    readonly cwd: string,
    private readonly opts: SessionOpts = {},
    restored?: { id: string; history: SessionMessage[] },
  ) {
    this.id = restored?.id ?? randomUUID();
    this.model = opts.model ?? "default";
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
        settingSources: ["user", "project"],
        // Thinking text is omitted by default; summaries feed the thinking parts.
        extraArgs: { "thinking-display": "summarized", "replay-user-messages": null },
        // ADR 0002: subscription login only. An inherited API key would take precedence and bill per token.
        env: withoutApiKeys(process.env),
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
    this.setState("running");
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
    if (this.state === "running") throw new Error("session is running: interrupt the turn first");
    if (!this.checkpoints.has(userMessageId)) throw new Error(`unknown user message ${userMessageId}`);
    return this.query ?? this.start({ resume: this.id });
  }

  private async drive(q: AsyncIterable<SDKMessage>) {
    const generation = this.generation;
    try {
      for await (const m of q) {
        if (generation !== this.generation) return;
        // Echo of a prompt() message (replay-user-messages); its user_text is already logged.
        if (m.type === "user" && "isReplay" in m && m.isReplay) continue;
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

/** supportedModels() needs a query; this one gets no prompt and is closed right after the answer. */
export async function listModels(query: typeof sdkQuery = sdkQuery): Promise<ModelInfo[]> {
  const q = query({ prompt: new InputQueue(), options: { settingSources: ["user", "project"], env: withoutApiKeys(process.env) } });
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
