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
  /**
   * Setting `inlineTask`, read by the caller at the call; each Engine takes its own model from it when the spec names none:
   * Claude `model`, OpenCode `openCodeModel` ("" or absent = OpenCode's `small_model`, else the parent's model).
   */
  settings?: { model?: string; openCodeModel?: string };
};
export type InlineStatus = "done" | "limit" | "stopped" | "error" | "denied";
export type InlineResult = {
  status: InlineStatus;
  limit?: "turns" | "tokens" | "time";
  error?: string;
  /** Steps the user (or a permission rule) denied, one line each (`Bash: rm -rf build`). On `denied`, and on a run that finished despite them. */
  denied?: string[];
  /** The last steps of a run that did not end `done`, one line each (`Bash: npm test`, ` (failed)` appended on a failed step), so the caller can act. */
  steps?: string[];
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

/** A Fork run (docs/spec.md "Fork runs"): the daemon `fork` tool's input and what an engine's `forkRun` returns to the tool. */
export type ForkSpec = { description: string; prompt: string };
export type ForkResult = Pick<InlineResult, "status" | "limit" | "error" | "text" | "truncated" | "filesChanged" | "durationMs">;

/** One line of a tool step: the tool and the most telling input field, cut to 80 chars. */
export function stepLine(tool: string, input: Record<string, unknown> | undefined): string {
  const v = ["command", "file_path", "path", "pattern", "url", "description"].map((k) => input?.[k]).find((x) => typeof x === "string") as string | undefined;
  const one = (v ?? "").replace(/\s+/g, " ").trim();
  return one ? `${tool}: ${one.length > 80 ? `${one.slice(0, 79)}…` : one}` : tool;
}

/** The denied steps of one OpenCode inline run (a user Deny, Don't ask, a rule), one line each, once per call. */
export class Denials {
  private readonly lines = new Map<string, string>();
  add(callId: string, line: string) {
    if (!this.lines.has(callId)) this.lines.set(callId, line);
  }
  has = (callId: string) => this.lines.has(callId);
  list = () => [...this.lines.values()];
  /** The denied call ids. */
  ids = () => [...this.lines.keys()];
}

/**
 * The result with its denials (docs/spec.md "Inline tasks"): `denied` lists them; a run that ended in error, or done with no text, after a denial ends `denied`
 * (the run could not do its task); any other status stays.
 */
export function withDenials(r: InlineResult, denied: readonly string[]): InlineResult {
  if (!denied.length) return r;
  const out = { ...r, denied: [...denied] };
  return r.status === "error" || (r.status === "done" && !r.text.trim()) ? { ...out, status: "denied", error: `The user denied ${denied.join("; ")}.` } : out;
}
