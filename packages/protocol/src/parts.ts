// Normalized message model (docs/spec.md "Message model"). The UI renders only parts.
// Every part has an `id`; the client store is keyed by it and replaces a part on update.
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type { PermissionUpdate };

export type SessionState = "idle" | "running" | "needs_input" | "error" | "closed";

export type ToolStatus = "pending" | "running" | "done" | "error" | "denied";

/** "allow" = Yes, "allow_always" = Yes and don't ask again, "deny" = No; "cancelled" = the SDK withdrew the request. */
export type PermissionDecision = "allow" | "allow_always" | "deny" | "cancelled";

/** One `AskUserQuestion` question as the SDK sends it; "Other" is not among `options`, the UI adds it. */
export type Question = {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/** A slash command or skill; invoked by sending `/name args` as prompt text. */
export type SlashCommand = { name: string; description: string; argumentHint: string; aliases?: string[] };

/** One TodoWrite item. */
export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

/** `parentId` = the subagent part id when the part comes from inside that subagent. */
export type Part = { parentId?: string } & (
  | { type: "user_text"; id: string; text: string; images: string[] }
  | { type: "assistant_text"; id: string; text: string; streaming: boolean }
  | { type: "thinking"; id: string; text: string; streaming: boolean }
  /** `id` = `toolUseId`; re-emitted on every status change. `editedByUser`: `input` is the user's edit of Claude's input, accepted in the permission panel. */
  | { type: "tool_call"; id: string; toolUseId: string; tool: string; input: unknown; status: ToolStatus; editedByUser?: boolean }
  /** `id` = `<toolUseId>:result`. */
  | { type: "tool_result"; id: string; toolUseId: string; output: unknown; isError: boolean }
  /**
   * `id` = `requestId`; re-emitted once settled. `suggestions` are the SDK's rules for "don't ask again";
   * `title` is the SDK's prompt sentence when it sends one.
   */
  | {
      type: "permission_request";
      id: string;
      requestId: string;
      toolUseId: string;
      tool: string;
      input: unknown;
      title?: string;
      suggestions: PermissionUpdate[];
      settled: boolean;
      decision?: PermissionDecision;
      /** Feedback sent to Claude with a "deny" decision. */
      message?: string;
      /** Accepted with the user's edit: `input` is then the applied input. */
      editedByUser?: boolean;
    }
  /**
   * `AskUserQuestion` waiting for an answer. `id` = `requestId`; re-emitted once settled.
   * `answers`: question text -> answer (several choices joined with ", "); absent when settled = cancelled.
   */
  | { type: "question"; id: string; requestId: string; toolUseId: string; questions: Question[]; settled: boolean; answers?: Record<string, string> }
  | { type: "session_state"; id: string; state: SessionState }
  /** Model switched with session.setModel. `model` is a `ModelInfo.value`; "default" = the SDK default. */
  | { type: "session_model"; id: string; model: string }
  | { type: "commands"; id: "commands"; commands: SlashCommand[] }
  /** `costUsd`: this turn's cost; absent when unknown (first turn after a daemon restart). */
  | { type: "turn_result"; id: string; durationMs: number; costUsd?: number; usage: TokenUsage; isError: boolean }
  /** Latest TodoWrite list of the main agent; `id` = `<toolUseId>:todos`. */
  | { type: "todo_update"; id: string; items: TodoItem[] }
  /** An Agent/Task call; `id` = `toolUseId`, its `tool_result` is `<toolUseId>:result`, child parts have `parentId` = `id`. */
  | { type: "subagent"; id: string; toolUseId: string; description: string; status: ToolStatus }
  /** The turn was stopped (session.interrupt, or No without feedback); replaces its turn_result. */
  | { type: "turn_interrupted"; id: string }
  | { type: "raw"; id: string; message: unknown }
  /** Conversation rewind: the client drops `userMessageId` and every part after it. */
  | { type: "rewind"; id: string; userMessageId: string }
);
