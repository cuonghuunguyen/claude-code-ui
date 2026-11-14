// Shared types of the inline task (docs/spec.md "Inline tasks (GH-734)"): the `inline_task` tool group builds an InlineSpec,
// an engine's `EngineSession.inlineTask` runs it and returns an InlineResult.

/** The built-in tools an inline run can be granted. */
export const INLINE_BUILTINS = ["Bash", "Read", "Write", "Edit", "Grep", "Glob"] as const;
export type InlineBuiltin = (typeof INLINE_BUILTINS)[number];
export const INLINE_DEFAULT_TOOLS: InlineBuiltin[] = ["Read", "Grep", "Glob"];
export const INLINE_OUTPUT_TOKENS = 16_000;
export const INLINE_TIMEOUT_MS = 600_000;
export const INLINE_MAX_PER_SESSION = 3;
export const INLINE_TEXT_CHARS = 16_000;

export type InlineSpec = {
  /** The prompt with the `files` already appended as <file path="…">…</file>. */
  text: string;
  /** Short title (first line of the prompt, at most 60 chars). */
  title: string;
  tools: InlineBuiltin[];
  /** Server names (whole server) or `mcp__<server>__<tool>` (one tool) of the parent's MCP servers. Already refused: `claude-ui`, `orchestration`. */
  mcp: string[];
  /** Explicit `model` input; undefined = the setting's default for the engine. */
  model?: string;
  maxTurns: number;
};
export type InlineHooks = {
  signal: AbortSignal;
  /** Claude: the SDK tool_use id of the call (`_meta["claudecode/toolUseId"]`); undefined on OpenCode (the runner finds the call itself). */
  toolUseId?: string;
  /** The same input as the call (OpenCode correlates by it). */
  input?: Record<string, unknown>;
  /** OpenCode only: setting `inlineTask.openCodeModel` ("" or absent = OpenCode's `small_model`, else the parent's model). Read by the caller at the call. */
  openCodeModel?: string;
};
export type InlineStatus = "done" | "limit" | "stopped" | "error";
export type InlineResult = {
  status: InlineStatus;
  limit?: "turns" | "tokens" | "time";
  error?: string;
  text: string;
  truncated?: boolean;
  model: string;
  turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
  filesChanged: string[];
  durationMs: number;
};
/** The engine-neutral entry: step parts go to the parent session (parentId = the call), the final result back to the tool. */
export type InlineRunner = (spec: InlineSpec, hooks: InlineHooks) => Promise<InlineResult>;
