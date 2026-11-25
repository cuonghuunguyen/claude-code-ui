// Quick compact, OpenCode side (docs/spec.md "Quick compact"): OpenCode 1 and 2 messages as digest events, and the small-model summarisers.
import type { OpenCodeClient } from "@opencode/client";
import { configDir } from "./token.ts";
import { ascending } from "./opencode-id.ts";
import { loadMessages } from "./opencode2-engine.ts";
import { join } from "node:path";
import type { OpenCodeMessage } from "./opencode-parts.ts";
import type { OpenCode2Message } from "./opencode2-parts.ts";
import type { OpenCodeServer } from "./opencode-server.ts";
import { foldDigest, stripText, summarySystem, type DigestEvent, type Summarise } from "./quick-compact.ts";

/** The folder of a quick-compacted OpenCode session's tool output files (`uploads.dirFor` takes Claude's UUID ids only). */
export const openCodeDigestDir = (id: string) => join(configDir(), "quick-compact", id);

const text = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * OpenCode 1 messages as events, starting after the last native compaction (a user message with a `compaction` part, the summary is the assistant message
 * after it). Reasoning, steps, snapshots and patches are left out; subagent sessions are not read (like Claude's sidechains).
 */
export function oc1DigestEvents(messages: OpenCodeMessage[]): { earlier?: string; events: DigestEvent[] } {
  let start = 0;
  let earlier: string | undefined;
  messages.forEach((m, i) => {
    if (m.info.role !== "user" || !m.parts.some((p) => p.type === "compaction")) return;
    const j = messages.findIndex((x, k) => k > i && x.info.role === "assistant");
    const summary = j < 0 ? undefined : messages[j]!;
    earlier = summary?.parts.filter((p) => p.type === "text").map((p) => text(p.text)).join("\n").trim() || undefined;
    start = j < 0 ? i + 1 : j + 1;
  });
  const events: DigestEvent[] = [];
  for (const m of messages.slice(start)) {
    for (const p of m.parts) {
      if (p.type === "text") {
        if (p.synthetic || p.ignored) continue;
        const t = stripText(text(p.text));
        if (t) events.push({ kind: m.info.role, text: t });
      } else if (p.type === "file") events.push({ kind: "user", text: p.mime?.startsWith("image/") ? "[image]" : `[file ${(p as { filename?: string }).filename ?? p.mime ?? ""}]`.replace(" ]", "]") });
      else if (p.type === "tool" && p.state) {
        const s = p.state;
        const done = s.status === "completed" || s.status === "error";
        events.push({ kind: "tool", name: p.tool ?? "tool", input: s.input ?? {}, ...(done && { out: s.status === "error" ? (s.error ?? "") : (s.output ?? ""), err: s.status === "error" }) });
      }
    }
  }
  return foldDigest({ ...(earlier && { earlier }), events });
}

type Item = { type: string; text?: string; name?: string; state?: { status?: string; input?: Record<string, unknown>; content?: unknown; error?: { message?: string } } };
const outputOf = (content: unknown): string =>
  (Array.isArray(content) ? (content as { type?: string; text?: string; name?: string; mime?: string }[]) : []).map((c) => (c.type === "text" ? text(c.text) : `[${c.name ?? c.mime ?? c.type ?? "file"}]`)).join("\n");

/**
 * OpenCode 2 messages as events, after the last `compaction` message. `shell` (bash mode) is a `bash` call; a `synthetic` message is an earlier quick-compact
 * digest (kept as the history's start) or a notice (left out).
 */
export function oc2DigestEvents(messages: OpenCode2Message[]): { earlier?: string; events: DigestEvent[] } {
  let start = 0;
  let earlier: string | undefined;
  messages.forEach((m, i) => {
    if (m.type !== "compaction" || m.status === "running") return;
    start = i + 1;
    earlier = m.summary || undefined;
  });
  const events: DigestEvent[] = [];
  for (const m of messages.slice(start)) {
    if (m.type === "user") {
      const t = stripText(text(m.text));
      if (t) events.push({ kind: "user", text: t });
      for (const f of m.files ?? []) events.push({ kind: "user", text: f.mime?.startsWith("image/") ? "[image]" : `[file ${f.mime}]` });
    } else if (m.type === "synthetic" && (m.metadata as { source?: string } | undefined)?.source === "quick-compact") events.push({ kind: "user", text: text(m.text) });
    else if (m.type === "shell") events.push({ kind: "tool", name: "bash", input: { command: m.command ?? "" }, out: m.output?.output ?? "", err: typeof m.exit === "number" && m.exit !== 0 });
    else if (m.type === "assistant") {
      for (const c of (m.content ?? []) as Item[]) {
        if (c.type === "text") {
          const t = stripText(text(c.text));
          if (t) events.push({ kind: "assistant", text: t });
        } else if (c.type === "tool" && c.name && c.state) {
          const done = c.state.status === "completed" || c.state.status === "error";
          const err = c.state.status === "error";
          events.push({ kind: "tool", name: c.name, input: c.state.input ?? {}, ...(done && { out: err ? [c.state.error?.message, outputOf(c.state.content)].filter(Boolean).join("\n") : outputOf(c.state.content), err }) });
        }
      }
    }
  }
  return foldDigest({ ...(earlier && { earlier }), events });
}

/** `provider/model` of OpenCode's `small_model` setting, if any. */
const smallModel = async (server: OpenCodeServer, cwd: string) => {
  const v = (await server.request<{ small_model?: string }>("/config", { directory: cwd, timeoutMs: 10_000 }).catch(() => undefined))?.small_model;
  const [providerID, ...rest] = (v ?? "").split("/");
  return v && rest.length ? { providerID: providerID!, modelID: rest.join("/") } : undefined;
};

export const SUMMARY_TIMEOUT_MS = 120_000;

/**
 * OpenCode 1: a temporary session with every tool denied answers one message (the request waits for the reply); the model is OpenCode's `small_model`
 * when set, else `fallback` (the source model), else OpenCode's default. The session is deleted in any case.
 */
export function openCode1Summarise(server: OpenCodeServer, o: { cwd: string; fallback?: { providerID: string; modelID: string } }): Summarise {
  return async (input, maxTokens) => {
    const at = { directory: o.cwd };
    const row = await server.request<{ id: string }>("/session", { ...at, method: "POST", timeoutMs: SUMMARY_TIMEOUT_MS, body: { permission: [{ permission: "*", pattern: "*", action: "deny" }] } });
    try {
      const model = (await smallModel(server, o.cwd)) ?? o.fallback;
      const reply = await server.request<{ parts?: { type: string; text?: string }[] }>(`/session/${row.id}/message`, {
        ...at,
        method: "POST",
        timeoutMs: SUMMARY_TIMEOUT_MS,
        body: { system: summarySystem(maxTokens), ...(model && { model }), parts: [{ type: "text", text: input }] },
      });
      const out = (reply.parts ?? []).filter((p) => p.type === "text").map((p) => text(p.text)).join("").trim();
      if (!out) throw new Error("OpenCode returned no summary");
      return out;
    } finally {
      await server.request(`/session/${row.id}`, { ...at, method: "DELETE", timeoutMs: 10_000 }).catch(() => undefined);
    }
  };
}

/** OpenCode 2: a temporary session with every tool denied answers one prompt; the stored reply is polled (no event stream is needed). Deleted in any case. */
export function openCode2Summarise(client: OpenCodeClient, o: { cwd: string; timeoutMs?: number }): Summarise {
  return async (input, maxTokens, signal) => {
    const row = await client.session.create({ location: { directory: o.cwd }, permissions: [{ action: "*", resource: "*", effect: "deny" }] });
    try {
      await client.session.prompt({ sessionID: row.id, id: ascending("msg"), text: `${summarySystem(maxTokens)}\n\n---\n${input}` });
      const until = Date.now() + (o.timeoutMs ?? SUMMARY_TIMEOUT_MS);
      for (;;) {
        if (signal?.aborted) throw new Error("cancelled");
        const last = (await loadMessages(client, row.id)).filter((m) => m.type === "assistant").at(-1) as (OpenCode2Message & { time?: { completed?: number } }) | undefined;
        if (last?.time?.completed) {
          const out = (last.content ?? []).filter((c) => c.type === "text").map((c) => text(c.text)).join("").trim();
          if (!out) throw new Error("OpenCode returned no summary");
          return out;
        }
        if (Date.now() > until) throw new Error("the summary timed out");
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await client.session.remove({ sessionID: row.id }).catch(() => undefined);
    }
  };
}
