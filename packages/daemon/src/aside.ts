// Aside (docs/spec.md "Aside"): fork point of a session's transcript for /btw.
import { connect } from "node:net";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

/** Tools removed while an Aside is read-only (until its permission mode changes; stays after Keep as session). */
export const ASIDE_NO_EDIT = ["Edit", "Write", "NotebookEdit"];
/** Removed while the Aside is not kept: an Aside starts no workers (the orchestration MCP server's tools). */
export const ASIDE_NO_WORKERS = ["mcp__orchestration"];

/** `disallowedTools` of a session's CLI by its link (session-settings.ts); undefined: none. */
export const asideDisallowed = (link: { ownerId?: string; readOnly?: true } | undefined) => {
  const list = [...(link?.readOnly ? ASIDE_NO_EDIT : []), ...(link?.ownerId ? ASIDE_NO_WORKERS : [])];
  return list.length ? list : undefined;
};

/**
 * Last main-chain entry the Aside may fork at: an assistant entry with a text block, or a user entry with tool_result blocks,
 * after which every tool_use so far has its result. During a turn the transcript can end on a call without a result; resuming
 * there is rejected by the API. Undefined: nothing to fork (no reply yet).
 */
export function asideForkPoint(chain: SessionMessage[]): string | undefined {
  const open = new Set<string>();
  let at: string | undefined;
  for (const m of chain) {
    if (m.parent_tool_use_id) continue;
    const content = (m.message as { content?: unknown } | undefined)?.content;
    const blocks = (Array.isArray(content) ? content : []) as { type?: string; id?: string; tool_use_id?: string }[];
    if (m.type === "assistant") blocks.forEach((b) => b.type === "tool_use" && b.id && open.add(b.id));
    else blocks.forEach((b) => b.type === "tool_result" && b.tool_use_id && open.delete(b.tool_use_id));
    if (open.size) continue;
    if ((m.type === "assistant" && blocks.some((b) => b.type === "text")) || (m.type === "user" && blocks.some((b) => b.type === "tool_result"))) at = m.uuid;
  }
  return at;
}

/** Whether something listens on a local port. Only ECONNREFUSED means no: a timeout or another error counts as listening (the safe side, nothing is deleted). */
export const portListening = (port: number, host = "127.0.0.1", timeoutMs = 3000) =>
  new Promise<boolean>((resolve) => {
    const sock = connect({ port, host });
    const done = (v: boolean) => (sock.destroy(), resolve(v));
    sock.setTimeout(timeoutMs, () => done(true));
    sock.once("connect", () => done(true));
    sock.once("error", (e: NodeJS.ErrnoException) => done(e.code !== "ECONNREFUSED"));
  });
