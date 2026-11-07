// The Engine interface (CONTEXT.md "Engine", ADR 0012): the agent runtime behind a Session. Slice 1 has one, the Claude Engine.
import type { Effort, EngineCapabilities, PermissionMode, RewindMode, RewindPreview } from "@claude-ui/protocol";
import type { Query } from "./claude-engine.ts";
import type { Session, SessionOpts, SessionSettings } from "./session.ts";

export interface Engine {
  readonly name: "claude";
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
  | { kind: "answer"; answers: Record<string, string> }
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

  prompt(text: string, images?: string[]): string;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setEffort(effort: Effort): Promise<void>;
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
  liveQuery(): Query | undefined;
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
