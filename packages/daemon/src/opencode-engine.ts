// The OpenCode Engine (ADR 0012): sessions run on the daemon's OpenCode server (opencode-server.ts). This version opens and lists sessions
// (history read-only); prompting, streaming and the other controls come in later versions, so their flags are false.
import { permissionModesFor, type Effort, type EngineCapabilities, type PermissionMode } from "@claude-ui/protocol";
import type { Engine, EngineSession } from "./engine.ts";
import { openCodeParts, type OpenCodeMessage } from "./opencode-parts.ts";
import type { Session, SessionOpts, SessionSettings } from "./session.ts";

/** Modes OpenCode sessions will switch to (applied with prompting); no `auto` or `dontAsk`. */
export const OPENCODE_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const OPENCODE_CAPABILITIES: EngineCapabilities = { permissionModes: OPENCODE_MODES, effort: false, rewind: false, fork: false, steering: false, slashCommands: false, planMeter: false, account: false, contextUsage: false };
const LATER = "Prompting OpenCode sessions comes in a later version";

class OpenCodeSession implements EngineSession {
  private model: string;
  private permissionMode: PermissionMode;
  private effort: Effort;
  staleLogin = false;

  constructor(
    private readonly session: Session,
    private readonly opts: SessionOpts,
    private readonly history?: readonly unknown[],
  ) {
    this.model = opts.model ?? "default";
    this.permissionMode = opts.permissionMode ?? "default";
    this.effort = opts.effort ?? "default";
  }

  begin() {
    if (!this.history) return;
    for (const part of openCodeParts(this.history as OpenCodeMessage[])) this.session.emit(part);
    this.session.setState("idle");
  }
  settings(): SessionSettings {
    return { model: this.model, permissionMode: this.permissionMode, effort: this.effort };
  }
  private changed(field: keyof SessionSettings) {
    this.opts.onSettings?.(this.settings(), this.session.id, [field]);
  }
  // Stored and saved like Claude's; nothing is sent to OpenCode before prompting exists.
  async setModel(model: string) {
    this.model = model;
    this.session.emit({ type: "session_model", id: "session_model", model });
    this.changed("model");
  }
  async setPermissionMode(mode: PermissionMode) {
    if (!this.session.info().permissionModes.includes(mode)) throw new Error(`permission mode ${mode} is not enabled`);
    this.permissionMode = mode;
    this.session.emit({ type: "session_permission_mode", id: "session_permission_mode", mode });
    this.changed("permissionMode");
  }
  async setEffort(effort: Effort) {
    this.effort = effort;
    this.session.emit({ type: "session_effort", id: "session_effort", effort });
    this.changed("effort");
  }
  prompt(): string {
    throw new Error(LATER);
  }
  bash(): void {
    throw new Error(LATER);
  }
  subscribed() {}
  beforeStateEvent() {}
  idle() {}
  bashCwdPinned = () => false;
  interrupt = async () => {};
  stopSubagent = async () => false;
  backgroundShell = async () => false;
  stopShell = async () => false;
  shellOutput = async () => undefined;
  previewRewind = async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false });
  rewind = async () => {};
  sync = async () => {};
  close = async () => {};
  activity = () => ({ received: 0, at: 0, progress: 0 });
  live = () => false;
  reloadPlugins = async () => undefined;
  restartQuery() {}
  releaseQuery = () => false;
  externalTurnRunning = () => false;
  untitled = () => false;
  bashRunning = () => false;
  working = () => false;
  takesQueued = () => false;
}

export const openCodeEngine: Engine = {
  name: "opencode",
  capabilities: OPENCODE_CAPABILITIES,
  permissionModes: (o) => permissionModesFor({ ...o, modes: OPENCODE_MODES }),
  open: (session, opts, restored) => new OpenCodeSession(session, opts, restored?.history),
};
