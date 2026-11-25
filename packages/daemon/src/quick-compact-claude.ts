// Quick compact, Claude Code side (docs/spec.md "Quick compact"): the SDK main chain as digest events, the synthetic transcript the CLI resumes, the Haiku summariser.
import { randomUUID } from "node:crypto";
import { query as sdkQuery, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv } from "./claude-env.ts";
import { stripText, type DigestEvent, type Summarise } from "./quick-compact.ts";

type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };
const resultText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: Block) => (b.type === "text" ? b.text ?? "" : `[${b.type}]`)).join("\n") : "";

/**
 * The events of `getSessionMessages()`'s main chain. After a native compact the chain starts at the compact summary row
 * (earlier rows are gone), whose text is `earlier`. Subagent rows and meta rows are left out.
 */
export function claudeDigestEvents(main: SessionMessage[]): { earlier?: string; events: DigestEvent[] } {
  const events: DigestEvent[] = [];
  const byId = new Map<string, Extract<DigestEvent, { kind: "tool" }>>();
  let earlier: string | undefined;
  for (const row of main) {
    const r = row as SessionMessage & { isCompactSummary?: boolean; isMeta?: boolean; is_meta?: boolean };
    if (r.type !== "user" && r.type !== "assistant") continue;
    if (r.parent_tool_use_id) continue;
    const content = (r.message as { content?: unknown } | undefined)?.content;
    if (r.isCompactSummary) {
      earlier = stripText(resultText(content)) || undefined;
      continue;
    }
    if (r.isMeta || r.is_meta) continue;
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type === "text") {
        const text = stripText(b.text ?? "");
        if (text) events.push({ kind: r.type, text });
      } else if (b.type === "image") events.push({ kind: "user", text: "[image]" });
      else if (b.type === "tool_use") {
        const e = { kind: "tool" as const, name: b.name ?? "tool", input: b.input ?? {} };
        if (b.id) byId.set(b.id, e);
        events.push(e);
      } else if (b.type === "tool_result") {
        const e = b.tool_use_id ? byId.get(b.tool_use_id) : undefined;
        if (e) Object.assign(e, { out: resultText(b.content), err: !!b.is_error });
      }
    }
  }
  return { ...(earlier && { earlier }), events };
}

/** The two rows of the new session's transcript: the digest as the user's message and an assistant ack in the CLI's own `<synthetic>` shape (a file ending on a user row gets such a reply appended by the CLI). Two JSONL lines. */
export function syntheticTranscript(o: { id: string; cwd: string; digest: string; now: Date; uuid?: () => string }): string {
  const uuid = o.uuid ?? randomUUID;
  const userUuid = uuid();
  const base = { isSidechain: false, userType: "external", cwd: o.cwd, sessionId: o.id };
  const user = { parentUuid: null, ...base, type: "user", uuid: userUuid, timestamp: o.now.toISOString(), message: { role: "user", content: o.digest } };
  const assistant = {
    parentUuid: userUuid,
    ...base,
    type: "assistant",
    uuid: uuid(),
    timestamp: new Date(o.now.getTime() + 1).toISOString(),
    message: {
      id: uuid(),
      model: "<synthetic>",
      role: "assistant",
      type: "message",
      stop_reason: "stop_sequence",
      stop_sequence: "",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: "text", text: "Quick compact loaded. Continue the conversation here." }],
    },
  };
  return `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`;
}

const SYSTEM = (n: number) => `You condense the oldest part of a coding conversation. Keep decisions, facts, file paths, names, numbers and open tasks. Reply with the summary only, at most ${n} tokens.`;
export const SUMMARY_TIMEOUT_MS = 120_000;

/** One tool-less Haiku turn per call (no warm spare: a quick compact over the cap is rare). `env`: the Project's Claude account. */
export function claudeSummarise(o: { cwd: string; env?: NodeJS.ProcessEnv; query?: typeof sdkQuery; timeoutMs?: number }): Summarise {
  return async (text, maxTokens, signal) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? SUMMARY_TIMEOUT_MS);
    signal?.addEventListener("abort", () => ctl.abort(), { once: true });
    try {
      const q = (o.query ?? sdkQuery)({
        prompt: text,
        options: { systemPrompt: SYSTEM(maxTokens), thinking: { type: "disabled" }, tools: [], maxTurns: 1, persistSession: false, model: "haiku", cwd: o.cwd, env: o.env ?? claudeEnv(), settingSources: [], mcpServers: {}, strictMcpConfig: true, settings: { disableAllHooks: true }, abortController: ctl } as never,
      });
      for await (const m of q) {
        if (m.type !== "result") continue;
        if (m.subtype !== "success" || m.is_error) throw new Error(("result" in m && m.result) || `Claude failed (${m.subtype})`);
        if (!m.result.trim()) throw new Error("Claude returned no summary");
        return m.result.trim();
      }
      throw new Error(ctl.signal.aborted ? "the summary timed out" : "Claude returned no summary");
    } finally {
      clearTimeout(timer);
    }
  };
}
