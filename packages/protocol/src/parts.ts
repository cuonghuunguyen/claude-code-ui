// Normalized message model (docs/spec.md "Message model"). The UI renders only parts.
// Every part has an `id`; the client store is keyed by it and replaces a part on update.

export type SessionState = "idle" | "running" | "needs_input" | "error" | "closed";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type Part =
  | { type: "user_text"; id: string; text: string; images: string[] }
  | { type: "assistant_text"; id: string; text: string; streaming: boolean }
  | { type: "session_state"; id: string; state: SessionState }
  /** Model switched with session.setModel. `model` is a `ModelInfo.value`; "default" = the SDK default. */
  | { type: "session_model"; id: string; model: string }
  | { type: "turn_result"; id: string; durationMs: number; costUsd: number; usage: TokenUsage; isError: boolean }
  | { type: "raw"; id: string; message: unknown };
