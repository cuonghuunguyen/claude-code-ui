// Inline task on OpenCode (GH-734, docs/spec.md "Inline tasks"): what the daemon reads of a child session's events (usage, turns, last text, files)
// and the request bodies it sends. The session side (child create, abort, waiting) is OpenCodeSession.inlineTask.
import { INLINE_OUTPUT_TOKENS, INLINE_TEXT_CHARS, type InlineBuiltin, type InlineResult, type InlineSpec } from "./inline-types.ts";
import { errorText, type OpenCodeError } from "./opencode-errors.ts";
import type { OpenCodeMessage, OpenCodePart } from "./opencode-parts.ts";

type Payload = { type: string; properties: Record<string, any> };

/** The system text of the child: the engine appends it to OpenCode's own prompt (OpenCode keeps its base prompt and AGENTS.md). */
export const INLINE_SYSTEM =
  "You run one delegated task. Use only the tools you have. Do not ask the user questions. Reply with only the result of the task, short and exact.";

const BUILTIN: Record<InlineBuiltin, string> = { Bash: "bash", Read: "read", Write: "write", Edit: "edit", Grep: "grep", Glob: "glob" };
/** OpenCode names an MCP tool `<server>_<tool>` with every other character of both replaced by `_`. */
const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/** The `tools` map of the child prompt: nothing but the granted built-ins and MCP servers or tools. */
export function inlineTools(spec: Pick<InlineSpec, "tools" | "mcp">): Record<string, boolean> {
  const tools: Record<string, boolean> = { "*": false };
  for (const t of spec.tools) tools[BUILTIN[t]] = true;
  for (const m of spec.mcp) {
    const one = /^mcp__(.+?)__(.+)$/.exec(m);
    tools[one ? `${clean(one[1]!)}_${clean(one[2]!)}` : `${clean(m)}_*`] = true;
  }
  return tools;
}

export type InlineCap = "turns" | "tokens";

/** Reads the events of one child session. */
export class InlineCollector {
  private readonly roles = new Map<string, string>();
  private readonly texts = new Map<string, { messageId: string; text: string }>();
  private readonly steps = new Map<string, OpenCodePart & { reason?: string }>();
  private readonly files = new Set<string>();
  private model: string | undefined;
  /** Set by `session.idle` of the child. */
  idle = false;
  /** Set by a `session.error` of the child (an abort is none). */
  error: string | undefined;

  constructor(private readonly sessionId: string) {}

  feed(e: Payload) {
    const p = e.properties;
    switch (e.type) {
      case "message.updated": {
        const info = p.info as OpenCodeMessage["info"] & { sessionID?: string };
        if (info.sessionID !== this.sessionId) return;
        this.roles.set(info.id, info.role);
        if (info.role === "assistant" && info.providerID && info.modelID) this.model = `${info.providerID}/${info.modelID}`;
        return;
      }
      case "message.part.updated": {
        const part = p.part as OpenCodePart & { reason?: string };
        if (part.sessionID !== this.sessionId) return;
        if (part.type === "text" && part.messageID && !part.synthetic && !part.ignored) this.texts.set(part.id, { messageId: part.messageID, text: part.text ?? "" });
        else if (part.type === "step-finish") this.steps.set(part.id, part);
        else if (part.type === "tool" && part.state?.status === "completed" && (part.tool === "edit" || part.tool === "write")) {
          const file = part.state.input?.filePath;
          if (typeof file === "string") this.files.add(file);
        }
        return;
      }
      case "message.part.delta": {
        const t = this.texts.get(p.partID);
        if (t && p.field === "text") this.texts.set(p.partID, { ...t, text: t.text + p.delta });
        return;
      }
      case "session.idle":
        if (p.sessionID === this.sessionId) this.idle = true;
        return;
      case "session.error":
        if (p.sessionID !== this.sessionId || p.error?.name === "MessageAbortedError") return;
        this.error = errorText(p.error as OpenCodeError, { ...(this.model && { model: this.model }) });
    }
  }

  get turns() {
    return this.steps.size;
  }
  tokens() {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const s of this.steps.values()) {
      t.input += s.tokens?.input ?? 0;
      t.output += (s.tokens?.output ?? 0) + (s.tokens?.reasoning ?? 0);
      t.cacheRead += s.tokens?.cache?.read ?? 0;
      t.cacheWrite += s.tokens?.cache?.write ?? 0;
    }
    return t;
  }
  cost() {
    let c = 0;
    for (const s of this.steps.values()) c += s.cost ?? 0;
    return c;
  }
  filesChanged() {
    return [...this.files];
  }
  /** The last assistant text (the answer), "" when none came. */
  text() {
    const last = [...this.texts.values()].reverse().find((t) => this.roles.get(t.messageId) === "assistant" && t.text);
    return last?.text ?? "";
  }
  modelName(fallback: string) {
    return this.model ?? fallback;
  }
  /** A cap the run is over: the step that just ended did not stop the model, and turns or output tokens reached the limit. */
  cap(maxTurns: number): InlineCap | undefined {
    const last = [...this.steps.values()].at(-1);
    if (!last || last.reason === "stop") return;
    if (this.turns >= maxTurns) return "turns";
    if (this.tokens().output >= INLINE_OUTPUT_TOKENS) return "tokens";
  }
}

/** The tail of `text` that fits the result. */
export const clip = (text: string): Pick<InlineResult, "text" | "truncated"> =>
  text.length > INLINE_TEXT_CHARS ? { text: text.slice(-INLINE_TEXT_CHARS), truncated: true } : { text };

/** The text of the last assistant message of a stored child session (the fallback when its events were missed). */
export function lastAssistantText(messages: readonly OpenCodeMessage[]): string {
  for (const m of [...messages].reverse()) {
    if (m.info.role !== "assistant") continue;
    const t = m.parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text ?? "").join("");
    if (t) return t;
  }
  return "";
}
