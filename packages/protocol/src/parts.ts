// Normalized message model (docs/spec.md "Message model"). The UI renders only parts.
// Every part has an `id`; the client store is keyed by it and replaces a part on update.
import type { EffortLevel, PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type { EffortLevel, PermissionMode, PermissionUpdate };

/** Thinking effort; "default" = the model's default (no `effort` option). */
export type Effort = EffortLevel | "default";

export type SessionState = "idle" | "running" | "needs_input" | "error" | "closed";

/** `stopped`: a subagent run or background task stopped (Stop agent, or its CLI exited mid-run). */
export type ToolStatus = "pending" | "running" | "done" | "error" | "denied" | "stopped";

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

/**
 * Claude Code `/context` numbers (`getContextUsage()`): `totalTokens` of the `maxTokens` window, `percentage` rounded.
 * `categories`: what fills the window, deferred ones (not loaded) left out; `kind` `buffer` (autocompact reserve) and `free` are not in `totalTokens`.
 */
export type ContextUsage = { totalTokens: number; maxTokens: number; percentage: number; categories: { name: string; tokens: number; kind: "used" | "free" | "buffer" }[] };

/**
 * One Claude Code `/usage` plan window as the server sends it (`kind` e.g. session, weekly_all, weekly_scoped; `label` made from kind and scope).
 * `percent` 0-100; `resetsAt` ms; `severity` the server's grade (normal, warning, critical); `active` the server's headline window.
 */
export type PlanWindow = { kind: string; label: string; percent: number; resetsAt: number | null; severity: string; active: boolean };
/**
 * Claude subscription limits, account-wide. `plan`: subscription type (pro, max, team, enterprise).
 * `status`: last `rate_limit_event`; allowed_warning = near a limit, rejected = a limit is hit, until `statusResetsAt` (ms).
 * `statusLimit`: label of the window that status is about (e.g. "Current week (Opus)"), when the event names it.
 */
export type PlanUsage = { plan: string | null; windows: PlanWindow[]; status: "allowed" | "allowed_warning" | "rejected"; statusResetsAt?: number; statusLimit?: string };

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
  /**
   * `id` = `<toolUseId>:result`. `original`: the file before this call, on the first Edit/Write of a path in a live
   * query (null = the call created it); absent in a restored transcript, which does not keep it.
   */
  | { type: "tool_result"; id: string; toolUseId: string; output: unknown; isError: boolean; original?: string | null }
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
  /** Permission mode changed: by session.setPermissionMode, or by the CLI (plan approved, "all edits this session"). */
  | { type: "session_permission_mode"; id: string; mode: PermissionMode }
  /** Effort changed with session.setEffort. */
  | { type: "session_effort"; id: string; effort: Effort }
  | { type: "commands"; id: "commands"; commands: SlashCommand[] }
  /** `costUsd`: this turn's cost; absent when unknown (first turn after a daemon restart). */
  | { type: "turn_result"; id: string; durationMs: number; costUsd?: number; usage: TokenUsage; isError: boolean }
  /** Context window usage, after each turn and each compaction; a restored session gets it before its first prompt. */
  | { type: "context_usage"; id: "context_usage"; usage: ContextUsage }
  /** Latest TodoWrite list of the main agent; `id` = `<toolUseId>:todos`. */
  | { type: "todo_update"; id: string; items: TodoItem[] }
  /**
   * A subagent run (Agent/Task call); `id` = `toolUseId`, its `tool_result` is `<toolUseId>:result`, child parts have `parentId` = `id`.
   * Its own `parentId`: the run that started it (absent = the session). `startedAt` / `endedAt` (ms): transcript timestamps, else the
   * daemon's clock; `endedAt` once the status is done, error, denied or stopped (a background run: at its task_notification; a run
   * no query runs any more: at its last message).
   */
  | { type: "subagent"; id: string; toolUseId: string; description: string; status: ToolStatus; startedAt: number; endedAt?: number }
  /** The turn was stopped (session.interrupt, or No without feedback); replaces its turn_result. */
  | { type: "turn_interrupted"; id: string }
  /** A CLI banner (system/informational, model refusal fallback): `notice` gray, `warning` prominent; `id` = its uuid. */
  | { type: "notice"; id: string; level: "notice" | "warning"; text: string }
  | { type: "raw"; id: string; message: unknown }
  /**
   * Compaction: live from `system/compact_boundary` (`trigger`), re-emitted with `summary` once the CLI sends the summary
   * Claude continues from; a restored transcript starts at that summary (no boundary).
   */
  | { type: "compaction"; id: string; trigger?: "manual" | "auto"; summary?: string }
  /** Conversation rewind: the client drops `userMessageId` and every part after it. */
  | { type: "rewind"; id: string; userMessageId: string }
  /** Refusal fallback (`retracted_message_uuids`): the client drops these parts of the refused messages. `id` = `<notice id>:retract`. */
  | { type: "retract"; id: string; partIds: string[] }
  /**
   * /clear (SDK `conversation_reset`): the live query goes on as session `sessionId`, a new transcript; this session keeps its
   * history and resumes its own transcript on its next prompt. Not rendered; a tab that shows this session live switches to `sessionId`.
   */
  | { type: "session_cleared"; id: string; sessionId: string }
  /**
   * A terminal CLI turn runs in this session (the live mirror sees its transcript growing, its last message not ending a turn);
   * the web app sends no prompt until `running` is false.
   */
  | { type: "external_turn"; id: "external_turn"; running: boolean }
);
