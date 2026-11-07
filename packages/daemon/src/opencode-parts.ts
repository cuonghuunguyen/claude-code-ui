// OpenCode stored messages (`GET /session/{id}/message`) as Parts, read-only history of an OpenCode session (docs/spec.md "OpenCode engine").
import type { Part, ToolStatus } from "@claude-ui/protocol";

type ToolState = { status: string; input?: unknown; output?: string; error?: string };
type OpenCodePart = { id: string; type: string; text?: string; callID?: string; tool?: string; state?: ToolState; ignored?: boolean };
export type OpenCodeMessage = { info: { id: string; role: "user" | "assistant" }; parts: OpenCodePart[] };

const STATUS: Record<string, ToolStatus> = { completed: "done", error: "error", pending: "pending", running: "running" };

/**
 * User and assistant text, reasoning and tool calls in message order. Other part types (step-start/finish, snapshot, patch, file,
 * agent, subtask) are skipped. Tool names and inputs stay as OpenCode sent them (mapping to the Claude cards comes with prompting).
 * `tool_call.id` is the call id (the part model's `toolUseId`); every other id is the OpenCode part id.
 */
export function openCodeParts(messages: readonly OpenCodeMessage[]): Part[] {
  const out: Part[] = [];
  for (const { info, parts } of messages)
    for (const p of parts) {
      if (p.type === "text" && !p.ignored) out.push(info.role === "user" ? { type: "user_text", id: p.id, text: p.text ?? "", images: [] } : { type: "assistant_text", id: p.id, text: p.text ?? "", streaming: false });
      else if (p.type === "reasoning") out.push({ type: "thinking", id: p.id, text: p.text ?? "", streaming: false });
      else if (p.type === "tool" && p.state && p.callID) {
        const status = STATUS[p.state.status] ?? "pending";
        out.push({ type: "tool_call", id: p.callID, toolUseId: p.callID, tool: p.tool ?? "", input: p.state.input ?? {}, status });
        if (status === "done" || status === "error") out.push({ type: "tool_result", id: `${p.callID}:result`, toolUseId: p.callID, output: (status === "error" ? p.state.error : p.state.output) ?? "", isError: status === "error" });
      }
    }
  return out;
}
