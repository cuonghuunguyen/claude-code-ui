// Types of the claude-ui addon SDK, bridge v1. MIT license. Keep next to claude-ui-addon.js.
// claude-ui's own host code imports these types: a request, event or part shape the host sends that this file does not accept fails its typecheck.

export type ToolStatus = "pending" | "running" | "done" | "error" | "denied" | "stopped";
export type SessionState = "idle" | "running" | "needs_input" | "error" | "closed";
export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
export type Question = { question: string; header: string; options: { label: string; description: string; preview?: string }[]; multiSelect: boolean };

/** One item of a session, as claude-ui shows it. Narrow by `type`. `parentId`: the subagent part when the part comes from inside a subagent. */
export type Part = { parentId?: string } & (
  | { type: "user_text"; id: string; text: string; images: string[] }
  | { type: "assistant_text"; id: string; text: string; streaming: boolean }
  | { type: "thinking"; id: string; text: string; streaming: boolean }
  /** `id` = `toolUseId`; sent again on every status change. */
  | { type: "tool_call"; id: string; toolUseId: string; tool: string; input: unknown; status: ToolStatus; editedByUser?: boolean; shell?: "foreground" | "background"; startedAt?: number; endedAt?: number; exitCode?: number }
  /** `id` = `<toolUseId>:result`. */
  | { type: "tool_result"; id: string; toolUseId: string; output: unknown; isError: boolean; original?: string | null }
  /** A shell command the user ran with `!`. */
  | { type: "bash"; id: string; command: string; stdout: string; stderr: string; status: "running" | "done" | "error" | "stopped"; exitCode?: number; shell?: "background" }
  | { type: "permission_request"; id: string; requestId: string; toolUseId: string; tool: string; input: unknown; plan?: string; title?: string; suggestions: unknown[]; settled: boolean; decision?: "allow" | "allow_always" | "deny" | "cancelled"; message?: string; editedByUser?: boolean; escalated?: boolean; at?: number; tier?: "low" }
  | { type: "question"; id: string; requestId: string; toolUseId: string; questions: Question[]; settled: boolean; answers?: Record<string, string>; escalated?: boolean; at?: number }
  | { type: "session_state"; id: string; state: SessionState; working?: true; keepWarm?: true }
  | { type: "session_model"; id: string; model: string }
  | { type: "session_permission_mode"; id: string; mode: string }
  | { type: "session_effort"; id: string; effort: string }
  | { type: "session_agent"; id: "session_agent"; agent: string }
  | { type: "agents"; id: "agents"; agents: { name: string; description?: string }[]; failed?: true }
  | { type: "commands"; id: "commands"; commands: { name: string; description: string; argumentHint: string; aliases?: string[] }[] }
  | { type: "turn_result"; id: string; durationMs: number; costUsd?: number; usage: TokenUsage; isError: boolean }
  | { type: "context_usage"; id: "context_usage"; usage: { totalTokens: number; maxTokens: number; percentage: number; categories: { name: string; tokens: number; kind: "used" | "free" | "buffer" }[] } }
  | { type: "todo_update"; id: string; items: { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }[] }
  | { type: "subagent"; id: string; toolUseId: string; description: string; status: ToolStatus; startedAt: number; endedAt?: number }
  | { type: "turn_interrupted"; id: string }
  | { type: "notice"; id: string; level: "notice" | "warning"; text: string }
  | { type: "raw"; id: string; message: unknown }
  | { type: "compaction"; id: string; trigger?: "manual" | "auto"; summary?: string }
  | { type: "rewind"; id: string; userMessageId: string }
  | { type: "retract"; id: string; partIds: string[] }
  | { type: "session_cleared"; id: string; sessionId: string }
  | { type: "external_turn"; id: "external_turn"; running: boolean }
  | { type: "auto_continue"; id: "auto_continue"; at: number | null }
  | { type: "limit_stop"; id: "limit_stop"; stopped: boolean; resetsAt?: number }
  | { type: "model_retry"; id: "model_retry"; retry: { attempt: number; message: string; next?: number } | null }
  | { type: "prompt_suggestion"; id: "prompt_suggestion"; text: string | null }
  | { type: "prompt_queue"; id: "prompt_queue"; items: { id: string; text: string; imageCount: number; bash?: true; error?: string }[]; held?: { reason: "usage_limit" | "not_live"; until?: number } }
);
export type PartType = Part["type"];

/** Frame to host: payload and result of each request. Any other type is refused whatever was approved. */
export type Requests = {
  /** Frame height in px (24-480, a band at most 160). No capability. */
  "ui.ready": { payload: { height?: number }; result: {} };
  /** Needs `session.read`. Afterwards the host pushes `session.parts`. */
  "session.read": { payload: {}; result: { parts: Part[] } };
  /** At most 32 KiB. Needs `prompt.insert`. Never sends. */
  "prompt.insert": { payload: { text: string }; result: {} };
  /** At most 80 characters; `null` clears. Needs `ui.status`. */
  "ui.status": { payload: { text: string | null }; result: {} };
  /** At most 200 characters. Needs `ui.toast`. */
  "ui.toast": { payload: { text: string }; result: {} };
  /** A line in the addon's log (Addons dialog), at most 500 characters, 20 lines per second. Needs `log`. Allowed in renderers. */
  log: { payload: { level?: LogLevel; text: string }; result: {} };
};
export type LogLevel = "info" | "warn" | "error";
export type RequestType = keyof Requests;

export type Theme = { theme: string; mode: "light" | "dark" };
export type FenceRender = { fence: { lang: string; source: string } };
export type ToolRender = { tool: { name: string; input: unknown; result: unknown } };

/** Host to frame: the fields of each event. */
export type Events = {
  /** On the frame's load. `session`: "" in a renderer (no session). `view`: "" in a command handler or renderer. */
  init: { addon: string; view: string; role: "pane" | "band" | "command" | "render"; session: string } & Theme;
  "theme.changed": Theme;
  /** New or changed parts, after the first `session.read`. */
  "session.parts": { parts: Part[] };
  /** `/<addon>:<name> <args>` typed in the prompt box. */
  "command.run": { name: string; args: string };
  /** What a renderer draws. */
  render: FenceRender | ToolRender;
  /** Effect frames only (`ui.effect`), on load. `rect`: the target box in CSS px; the frame is `bleed` px larger on each side. `dpr`: the pixel ratio to draw at (capped at 2, lower when the canvas would pass 1.2 megapixels). `motion`: false under reduced motion. */
  "effect.init": { rect: EffectRect; bleed: number; dpr: number; theme: "dark" | "light"; colors: EffectColors; motion: boolean };
  /** The target state changed. */
  "effect.state": { state: EffectState };
  /** `input`: an input event in the target (no key, no text); `focus`: focus moved into it; `state`: `effect.state` follows. */
  "effect.pulse": { name: EffectPulse };
  /** The target was resized; `dpr` follows the area cap. */
  "effect.rect": { rect: EffectRect; dpr: number };
  /** The target left the screen or the tab is hidden (`true`), or it is back. */
  "effect.pause": { paused: boolean };
  /** `when` turned false: finish and post `effect.done` (the host removes the frame after 1000 ms anyway). */
  "effect.fade": {};
};
export type EffectRect = { w: number; h: number };
/** Resolved CSS colours of the app theme: `primary`, `ink` (muted text), `bg` (page), `fg` (text), `card` (panels). */
export type EffectColors = { primary: string; ink: string; bg: string; fg: string; card: string };
/** `attrs`: the public `data-*` attributes the manifest names in `when` and `watch`; `null` when absent. */
export type EffectState = { "focus-within": boolean; hover: boolean; attrs: Record<string, string | null> };
export type EffectPulse = "input" | "focus" | "state";
/** Effect frame to host: plain messages, no id and no reply. `frameCost`: mean ms per drawn frame over the last 2 s. */
export type EffectMessages = { "effect.ready": {}; "effect.done": {}; "effect.frameCost": { ms: number } };
/** What `frame` and the hooks of `defineEffect` see. `width` / `height`: the canvas in CSS px (target plus bleed). `time`: seconds since init; `dt`: seconds since the last frame (0 on the first, at most 0.1). */
export type EffectInfo = { width: number; height: number; bleed: number; rect: EffectRect; dpr: number; theme: "dark" | "light"; colors: EffectColors; motion: boolean; state: EffectState; time: number; dt: number };
export type EffectHooks = {
  /** Draws one frame in CSS px; the canvas is cleared before. */
  frame(ctx: CanvasRenderingContext2D, fx: EffectInfo): void;
  init?(fx: EffectInfo): void;
  state?(state: EffectState, fx: EffectInfo): void;
  pulse?(name: EffectPulse, fx: EffectInfo): void;
  rect?(fx: EffectInfo): void;
  /** Before the host removes the frame; the default fades the canvas out in 300 ms. */
  fade?(fx: EffectInfo): void | Promise<void>;
};
export type EventType = keyof Events;
/** An event as posted: `{v: 1, type, ...fields}`. */
export type EventMessage<T extends EventType = EventType> = { [K in T]: { type: K } & Events[K] }[T];

export type ErrorCode = "refused" | "bad_request" | "unknown";
export declare class AddonError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string);
}

/** Sends a request to the host. Resolves with its result; rejects with an AddonError. */
export declare function call<T extends RequestType>(type: T, ...payload: {} extends Requests[T]["payload"] ? [payload?: Requests[T]["payload"]] : [payload: Requests[T]["payload"]]): Promise<Requests[T]["result"]>;
/** Handles an event the host pushes. Returns a function that removes the handler. */
export declare function on<T extends EventType>(type: T, fn: (m: EventMessage<T>) => void): () => void;

export declare function ready(height?: number): Promise<{}>;
export declare function readSession(): Promise<Part[]>;
export declare function insertPrompt(text: string): Promise<{}>;
export declare function setStatus(text: string | null): Promise<{}>;
export declare function toast(text: string): Promise<{}>;
export declare function log(text: string, level?: LogLevel): Promise<{}>;
/** Sends the content height now and whenever the body resizes. Returns a function that stops it. */
export declare function autoHeight(): () => void;
/** All parts after `init`, then the full list again on every change. Needs `session.read`. Returns a function that stops it. */
export declare function watchSession(fn: (parts: Part[]) => void): () => void;
/** Runs an effect (`ui.effect`): canvas sizing at the host's pixel ratio, the animation loop, pause, reduced motion, fade and cost reports. Returns a function that stops it. */
export declare function defineEffect(hooks: EffectHooks): () => void;
