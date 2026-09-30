// A live session: one long-lived streaming-input query() whose SDK messages become logged events.
import { randomUUID } from "node:crypto";
import { query as sdkQuery, type ModelInfo, type Query, type SDKMessage, type SDKUserMessage, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAdapter, imageBlock, type Event, type Part, type SessionInfo, type SessionState } from "@claude-ui/protocol";

type Listener = (e: Event) => void;

type SessionOpts = { model?: string; query?: typeof sdkQuery };

export class Session {
  readonly id: string;
  private state: SessionState = "idle";
  // ponytail: in-memory log grows for the session lifetime; trim when memory matters.
  private readonly log: Event[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly input = new InputQueue();
  private query?: Query;
  private model: string;

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
    for (const m of restored.history) for (const part of adapter.convert(m as SDKMessage)) this.emit(part);
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
        cwd: this.cwd,
        model: this.model === "default" ? undefined : this.model,
        includePartialMessages: true,
        settingSources: ["user", "project"],
        // Thinking text is omitted by default; summaries feed the thinking parts.
        extraArgs: { "thinking-display": "summarized" },
        // ADR 0002: subscription login only. An inherited API key would take precedence and bill per token.
        env: withoutApiKeys(process.env),
      },
    }));
    void this.drive(q);
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
    const uuid = randomUUID();
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

  private async drive(q: AsyncIterable<SDKMessage>) {
    const adapter = createAdapter();
    try {
      for await (const m of q) {
        for (const part of adapter.convert(m)) this.emit(part);
        if (m.type === "result") this.setState("idle");
      }
      this.setState("closed");
    } catch (err) {
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
