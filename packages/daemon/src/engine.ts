// The Engine interface (CONTEXT.md "Engine", ADR 0012): the agent runtime behind a Session: the Claude Engine and the OpenCode Engine.
import type { Effort, Engine as EngineName, EngineCapabilities, PermissionMode, RewindMode, RewindPreview } from "@claude-ui/protocol";
import type { Session, SessionOpts, SessionSettings } from "./session.ts";

export interface Engine {
  readonly name: EngineName;
  readonly capabilities: EngineCapabilities;
  /** Modes a session can switch to now. */
  permissionModes(o: { allowBypass?: boolean; supportsAuto?: boolean }): PermissionMode[];
  /** The runtime of one Session. It emits nothing until `begin()`. */
  open(session: Session, opts: SessionOpts, restored?: Restored): EngineSession;
}

/** `history`: the Engine's own transcript messages of a restored session; none = a new session with a given id. */
export type Restored = { id: string; history?: readonly unknown[]; read?: Iterable<string> };

/** The engine-neutral answer to a pending permission request or question; the runtime turns it into its own reply. */
export type Reply =
  | { kind: "allow"; decision: "allow" | "allow_always"; ruleIndex?: number; updatedInput?: Record<string, unknown> }
  | { kind: "deny"; message?: string } // user "No"; no message stops the turn
  | { kind: "interrupt" } // Stop or Esc
  | { kind: "coordinator"; decision: "allow" | "deny"; message: string }
  | { kind: "answer"; answers: Record<string, string>; choices?: Record<string, string[]> }
  | { kind: "cancel"; message: string };

/** The engine-specific half of a Session: the Session forwards its public calls here and calls the hooks. */
export interface EngineSession {
  /** Starts what the constructor must not (it emits through the Session, whose `run` is set only after `open`). */
  begin(): void;
  settings(): SessionSettings;
  /** A client subscribes; `Infinity` = the daemon's own observer. */
  subscribed(sinceSeq: number): void;
  /** Session state changes: before and after its session_state event. */
  beforeStateEvent(): void;
  idle(): void;
  bashCwdPinned(): boolean;
  /** The login or account changed: the live runtime is replaced at the end of the running turn. */
  staleLogin: boolean;

  /** The message id of the prompt (its `user_text` is emitted); undefined = the Engine ran the text as its own command and echoes nothing. */
  prompt(text: string, images?: string[]): string | undefined;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setEffort(effort: Effort): Promise<void>;
  /** Engines with `agents` (OpenCode); Claude has none. */
  setAgent?(agent: string): Promise<void>;
  /** Engines with `agents`: reads the agent list again and emits the `agents` part (the chooser's retry). */
  refreshAgents?(): Promise<void>;
  interrupt(): Promise<void>;
  stopSubagent(callId: string): Promise<boolean>;
  backgroundShell(toolUseId: string): Promise<boolean>;
  stopShell(id: string): Promise<boolean>;
  shellOutput(toolUseId: string): Promise<{ output: string; truncated: boolean } | undefined>;
  previewRewind(userMessageId: string): Promise<RewindPreview>;
  rewind(userMessageId: string, mode: RewindMode): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
  activity(): { received: number; at: number; progress: number };
  /** The runtime process of the session runs (Claude: its CLI query). */
  live(): boolean;
  reloadPlugins(): Promise<number | undefined>;
  restartQuery(): void;
  releaseQuery(): boolean;
  externalTurnRunning(): boolean;
  untitled(): boolean;
  bash(command: string): void;
  bashRunning(): boolean;
  working(): boolean;
  takesQueued(): boolean;
}
