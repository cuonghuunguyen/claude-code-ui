// Normalized message model (docs/spec.md "Message model"). The UI renders only parts.
// Every part has an `id`; the client store is keyed by it and replaces a part on update.

export type SessionState = "idle" | "running" | "needs_input" | "error" | "closed";

export type ToolStatus = "pending" | "running" | "done" | "error" | "denied";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type Part =
  | { type: "user_text"; id: string; text: string; images: string[] }
  | { type: "assistant_text"; id: string; text: string; streaming: boolean }
  | { type: "thinking"; id: string; text: string; streaming: boolean }
  /** `id` = `toolUseId`; re-emitted on every status change. */
  | { type: "tool_call"; id: string; toolUseId: string; tool: string; input: unknown; status: ToolStatus }
  /** `id` = `<toolUseId>:result`. */
  | { type: "tool_result"; id: string; toolUseId: string; output: unknown; isError: boolean }
  | { type: "session_state"; id: string; state: SessionState }
  | { type: "turn_result"; id: string; durationMs: number; costUsd: number; usage: TokenUsage; isError: boolean }
  | { type: "raw"; id: string; message: unknown };
