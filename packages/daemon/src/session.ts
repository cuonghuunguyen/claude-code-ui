// A live session: one long-lived streaming-input query() whose SDK messages become logged events.
import { randomUUID } from "node:crypto";
import { query as sdkQuery, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAdapter, type Event, type Part, type SessionInfo, type SessionState } from "@claude-ui/protocol";

type Listener = (e: Event) => void;

export class Session {
  readonly id = randomUUID();
  private state: SessionState = "idle";
  // ponytail: in-memory log grows for the session lifetime; trim when memory matters.
  private readonly log: Event[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly input = new InputQueue();

  constructor(
    readonly cwd: string,
    opts: { model?: string; query?: typeof sdkQuery } = {},
  ) {
    const q = (opts.query ?? sdkQuery)({
      prompt: this.input,
      options: {
        sessionId: this.id,
        cwd,
        model: opts.model,
        includePartialMessages: true,
        settingSources: ["user", "project"],
        // ADR 0002: subscription login only. An inherited API key would take precedence and bill per token.
        env: withoutApiKeys(process.env),
      },
    });
    void this.drive(q);
  }

  info(): SessionInfo {
    return { id: this.id, cwd: this.cwd, state: this.state };
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

  prompt(text: string) {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    const uuid = randomUUID();
    this.emit({ type: "user_text", id: uuid, text, images: [] });
    this.setState("running");
    this.input.push({ type: "user", uuid, message: { role: "user", content: text }, parent_tool_use_id: null });
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
