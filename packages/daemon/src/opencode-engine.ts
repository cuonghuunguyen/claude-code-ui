// The OpenCode Engine (ADR 0012, docs/spec.md "OpenCode engine"): sessions run on the daemon's OpenCode server (opencode-server.ts). One event
// stream of the server feeds every open session; prompts, permissions and questions go back as HTTP calls.
import { randomUUID } from "node:crypto";
import { permissionModesFor, type Effort, type EngineCapabilities, type ModelInfo, type PermissionMode, type PermissionUpdate, type Question, type RewindMode, type RewindPreview, type SlashCommand } from "@claude-ui/protocol";
import { ASIDE_NO_EDIT, ASIDE_NO_WORKERS } from "./aside.ts";
import { COORDINATOR_DENIED } from "./claude-engine.ts";
import type { Engine, EngineSession, Reply, Restored } from "./engine.ts";
import { MAX_WAIT_MS } from "./orchestration.ts";
import { ascending } from "./opencode-id.ts";
import { mapTool, openCodeParts, OpenCodeMapper, type OpenCodeMessage, type OpenCodeTodo } from "./opencode-parts.ts";
import type { OpenCodeServer } from "./opencode-server.ts";
import { mapLimit } from "./session-scan.ts";
import type { Session, SessionOpts, SessionSettings } from "./session.ts";

/** Modes OpenCode sessions switch to; no `auto` or `dontAsk`. */
export const OPENCODE_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const OPENCODE_CAPABILITIES: EngineCapabilities = { permissionModes: OPENCODE_MODES, effort: false, rewind: true, fork: true, steering: true, slashCommands: true, planMeter: false, account: false, contextUsage: true, shell: false };

export type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" };
const MARK = "claude-ui";
const marker = (pattern: string): Rule => ({ permission: MARK, pattern, action: "allow" });
const star = (permission: string, action: Rule["action"]): Rule => ({ permission, pattern: "*", action });
const ANSWERED = "Answered in OpenCode";
/** The name of a session's orchestration MCP server in OpenCode; its tool keys are `<name>_<tool>` (fit OpenCode's tool name limit). */
export const mcpName = (id: string) => `orchestration-${id.slice(-10)}`;
const WORKER_START = "mcp__orchestration__worker_start";
const ORCHESTRATION = { name: "orchestration", source: "sdk" };

/**
 * The rules a permission mode appends to a session (OpenCode evaluates last match wins; rules cannot be removed through the API, so a mode
 * change appends a whole new block). Marker rules (`claude-ui`) match no tool: they tell a restore which mode is in force and where the
 * "always allow" rules start. `planEdit`: the `plan` agent's own `edit` rules, so earlier edit rules no longer win.
 * shortcut: every mode change appends one block; fine for hundreds of switches.
 */
export function modeBlock(mode: PermissionMode, always: Rule[], planEdit: Rule[], { readOnly = false, mcp }: { readOnly?: boolean; /** The session's own orchestration MCP server name, when attached. */ mcp?: string } = {}): Rule[] {
  const asks = [star("webfetch", "ask"), star("websearch", "ask")];
  const rules =
    mode === "bypassPermissions" ? ["bash", "edit", "webfetch", "websearch", "external_directory", "doom_loop"].map((p) => star(p, "allow"))
    : mode === "acceptEdits" ? [star("bash", "ask"), star("edit", "allow"), ...asks]
    : mode === "plan" ? [star("bash", "ask"), ...asks, ...planEdit]
    : [star("bash", "ask"), star("edit", "ask"), ...asks];
  // Orchestration MCP servers are attached per folder: hide every session's tools but the own ones; worker_start asks (the user's gate on new workers).
  const orchestration = [star("orchestration-*", "deny"), ...(mcp ? [star(`${mcp}_*`, "allow"), ...(mode === "bypassPermissions" ? [] : [star(`${mcp}_worker_start`, "ask")])] : [])];
  // A read-only Aside: the last matching rule hides edit, write and apply_patch, whatever the mode allows.
  return [marker(`mode:${mode}`), ...rules, ...orchestration, ...(readOnly ? [star("edit", "deny")] : []), marker("always"), ...always];
}
const lastMarker = (rules: readonly Rule[], test: (pattern: string) => boolean) => rules.map((r) => r.permission === MARK && test(r.pattern)).lastIndexOf(true);
/** The "always allow" rules of a session: the ones after the last `always` marker. */
export const alwaysOf = (rules: readonly Rule[]): Rule[] => {
  const i = lastMarker(rules, (p) => p === "always");
  return i < 0 ? [] : rules.slice(i + 1).filter((r) => r.permission !== MARK);
};
/** The rules of the last block (all rules when there is none). */
const lastBlock = (rules: readonly Rule[]) => rules.slice(Math.max(lastMarker(rules, (p) => p.startsWith("mode:")), 0));
/** The mode of the last block, undefined for a session without one. */
export const modeOf = (rules: readonly Rule[]): PermissionMode | undefined => {
  const i = lastMarker(rules, (p) => p.startsWith("mode:"));
  return i < 0 ? undefined : (rules[i]!.pattern.slice(5) as PermissionMode);
};

type PermissionAsked = { id: string; sessionID: string; permission: string; patterns?: string[]; metadata?: Record<string, unknown>; always?: string[]; tool?: { callID?: string } };
type QuestionAsked = { id: string; sessionID: string; questions: { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean }[]; tool?: { callID?: string } };
type Status = { type: "idle" | "busy" | "retry"; attempt?: number; message?: string };
type Payload = { type: string; properties: Record<string, any> };

/** What `begin()` and `resync()` read of a session: stored messages (and those of its subagents), busy state, pending requests of the folder. */
export type OpenCodeHistory = { messages: OpenCodeMessage[]; children: Record<string, OpenCodeMessage[]>; busy: boolean; /** The message OpenCode's `revert` cuts the conversation at (it and everything after are hidden). */ revert?: string; permission: Rule[]; permissions: PermissionAsked[]; questions: QuestionAsked[] };

export async function loadOpenCodeHistory(server: OpenCodeServer, id: string, cwd: string): Promise<OpenCodeHistory> {
  const at = { directory: cwd };
  const [all, row, status, permissions, questions] = await Promise.all([
    server.request<OpenCodeMessage[]>(`/session/${id}/message`, at),
    server.request<{ permission?: Rule[]; revert?: { messageID: string } | null }>(`/session/${id}`, at).catch(() => ({}) as { permission?: Rule[]; revert?: null }),
    server.request<Record<string, Status>>("/session/status", at).catch(() => ({}) as Record<string, Status>),
    server.request<PermissionAsked[]>("/permission", at).catch(() => []),
    server.request<QuestionAsked[]>("/question", at).catch(() => []),
  ]);
  const revert = row.revert?.messageID;
  const cut = revert ? all.findIndex((m) => m.info.id === revert) : -1;
  const messages = cut < 0 ? all : all.slice(0, cut);
  const childIds = messages.flatMap((m) => m.parts.map((p) => p.state?.metadata?.sessionId).filter((c): c is string => typeof c === "string"));
  const children = Object.fromEntries(await mapLimit(childIds, 4, async (c) => [c, await server.request<OpenCodeMessage[]>(`/session/${c}/message`, at).catch(() => [])] as const));
  return { messages, children, busy: status[id]?.type === "busy", revert, permission: row.permission ?? [], permissions, questions };
}

/** The models of the connected providers (`GET /config/providers`): Default, then every provider's models under the provider name. */
export async function openCodeModels(server: OpenCodeServer): Promise<ModelInfo[]> {
  const r = await server.request<{ providers: { id: string; name: string; models: Record<string, { name: string }> }[]; default?: Record<string, string> }>("/config/providers");
  const [defProvider, defModel] = Object.entries(r.default ?? {})[0] ?? [];
  const p = r.providers.find((x) => x.id === defProvider);
  const name = p && defModel ? `Default (${p.name} ${p.models[defModel]?.name ?? defModel})` : "Default";
  return [{ value: "default", displayName: name, description: "" }, ...r.providers.flatMap((x) => Object.entries(x.models).map(([id, m]) => ({ value: `${x.id}/${id}`, displayName: m.name, description: "", group: x.name })))];
}

/** A multi-select answer is the chosen labels joined with ", ": cut it at the option labels (longest first), so a label holding ", " stays whole; the rest is the user's own text. */
export function splitLabels(value: string, labels: string[]): string[] {
  const out: string[] = [];
  const byLength = [...labels].sort((a, b) => b.length - a.length);
  for (let rest = value; rest; ) {
    const hit = byLength.find((l) => rest === l || rest.startsWith(`${l}, `));
    const part = hit ?? rest;
    out.push(part);
    rest = rest.length > part.length ? rest.slice(part.length + 2) : "";
  }
  return out;
}

/** The longest a prompt sent after Stop waits for the aborted turn to end. */
const TURN_END_WAIT_MS = 10_000;
const dataUrlMime = (url: string) => /^data:([^;,]+)/.exec(url)?.[1] ?? "image/png";

class OpenCodeSession implements EngineSession {
  private model: string;
  private permissionMode: PermissionMode;
  private effort: Effort;
  staleLogin = false;
  private readonly mapper = new OpenCodeMapper();
  /** "Always allow" rules of this session (the ones in OpenCode's session ruleset after the last `always` marker). */
  private always: Rule[] = [];
  /** The mode of the block last written to OpenCode, undefined when the session has none. */
  private written: PermissionMode | undefined;
  private readonly reqs = new Map<string, { kind: "permission" | "question"; permission?: string; always?: string[]; callId?: string; questions?: Question[] }>();
  private turnAt = 0;
  private aborted = false;
  private failed = false;
  private resyncing: Promise<void> | undefined;
  /** Stop was pressed since the last prompt: a prompt still waiting for the stream is not sent. */
  private stopped = false;
  /** When the last prompt was posted, Infinity while it is on its way (OpenCode may not be busy yet: a resync must not end that turn). */
  private sentAt = 0;
  private leavingPlan = false;
  /** Settles when the running turn goes idle. */
  private turnEnd: { done: Promise<void>; resolve: () => void } | undefined;
  /** Tokens and model of the last completed assistant message of this session (its context window use). */
  /** The message OpenCode's revert cuts the conversation at, undefined when none (a prompt clears it: OpenCode removes the cut messages then). */
  private revertAt: string | undefined;
  /** Names of the commands last listed: `/name` of one of them runs it. */
  private commandNames = new Set<string>();
  private usage: { tokens: NonNullable<OpenCodeMessage["info"]["tokens"]>; providerID: string; modelID: string } | undefined;
  /** The orchestration MCP server is attached (orchestration on, no unkept Aside); `writtenMcp`: the last block written allows its tools. */
  private mcpOn = false;
  private writtenMcp: boolean;
  private attaching: Promise<void> | undefined;

  constructor(
    private readonly engine: OpenCodeEngineImpl,
    private readonly session: Session,
    private readonly opts: SessionOpts,
    private readonly history?: OpenCodeHistory,
  ) {
    this.model = opts.model ?? "default";
    // A restored session without a saved mode has the one of its last block in OpenCode (bypass only when the daemon allows it).
    const marked = history && modeOf(history.permission);
    this.permissionMode = opts.permissionMode ?? (marked && OPENCODE_MODES.includes(marked) && (marked !== "bypassPermissions" || opts.allowBypass) ? marked : "default");
    this.effort = opts.effort ?? "default";
    // A new session got its block with `POST /session`.
    this.written = history ? modeOf(history.permission) : this.permissionMode;
    this.always = history ? alwaysOf(history.permission) : [];
    this.revertAt = history?.revert;
    this.writtenMcp = !!history && lastBlock(history.permission).some((r) => r.permission === `${mcpName(session.id)}_*` && r.action === "allow");
  }

  private get server() {
    return this.engine.server;
  }
  private get id() {
    return this.session.id;
  }
  private get cwd() {
    return this.session.cwd;
  }
  owns = (sessionId: string) => sessionId === this.id || this.mapper.isChild(sessionId);

  begin() {
    this.engine.add(this);
    void this.emitCommands();
    void this.attach();
    if (!this.history) return;
    this.apply(this.history);
    this.session.setState(this.history.busy ? "running" : "idle");
    if (this.history.busy) this.turnAt = Date.now();
    this.requests(this.history);
    // Events between the history read and the stream connecting are lost: read again once it is open.
    void this.server.streamReady().then(() => this.resync());
  }

  /** Emits stored history (also after a stream reconnect: part ids are stable, a re-emit replaces). */
  private apply(h: OpenCodeHistory) {
    // A revert or unrevert missed as an event (stream drop): parts of an unrevert are re-emitted below, a revert drops them.
    if (h.revert !== this.revertAt && (this.revertAt = h.revert)) this.session.emit({ type: "rewind", id: randomUUID(), userMessageId: h.revert! });
    for (const part of openCodeParts(h.messages, h.children, this.mapper)) this.session.emit(part);
    for (const m of h.messages) this.noteUsage(m.info);
    void this.emitUsage();
  }

  private async emitCommands() {
    const commands = await this.engine.commands(this.cwd).catch(() => undefined);
    if (!commands) return;
    this.commandNames = new Set(commands.map((c) => c.name));
    this.session.emit({ type: "commands", id: "commands", commands });
  }

  private noteUsage(info: OpenCodeMessage["info"]) {
    if (info.role === "assistant" && info.time?.completed && info.tokens && info.providerID && info.modelID) this.usage = { tokens: info.tokens, providerID: info.providerID, modelID: info.modelID };
  }

  /** The `context_usage` part from the last completed assistant message; none while the window of its model is unknown. */
  private async emitUsage() {
    const u = this.usage;
    const max = u && (await this.engine.contextLimit(u.providerID, u.modelID));
    if (!u || !max) return;
    const used = u.tokens.input + u.tokens.output + u.tokens.reasoning + u.tokens.cache.read + u.tokens.cache.write;
    this.session.emit({ type: "context_usage", id: "context_usage", usage: { totalTokens: used, maxTokens: max, percentage: Math.round((used / max) * 100), categories: [{ name: "Used", tokens: used, kind: "used" }, { name: "Free", tokens: Math.max(max - used, 0), kind: "free" }] } });
  }

  /** Asks again what OpenCode still waits for (permissions and questions of this session and its subagents); settles what it no longer lists. */
  private requests(h: OpenCodeHistory) {
    const live = new Set<string>();
    for (const p of h.permissions) if (this.owns(p.sessionID)) (live.add(p.id), this.askPermission(p));
    for (const q of h.questions) if (this.owns(q.sessionID)) (live.add(q.id), this.askQuestion(q));
    for (const id of [...this.reqs.keys()]) if (!live.has(id) && this.session.pendingRequest(id)) this.session.cancel(id, ANSWERED);
  }

  resync(): Promise<void> {
    return (this.resyncing ??= loadOpenCodeHistory(this.server, this.id, this.cwd)
      .then((h) => {
        this.apply(h);
        void this.emitCommands();
        this.requests(h);
        const state = this.session.currentState();
        if (h.busy && state === "idle") (this.turnAt = Date.now()), this.session.setState("running");
        // A prompt just sent may not be busy in OpenCode yet.
        else if (!h.busy && state === "running" && Date.now() - this.sentAt > 3000) this.finish();
      })
      .catch(() => {})
      .finally(() => (this.resyncing = undefined)));
  }

  settings(): SessionSettings {
    return { model: this.model, permissionMode: this.permissionMode, effort: this.effort };
  }
  private changed(field: keyof SessionSettings) {
    this.opts.onSettings?.(this.settings(), this.id, [field]);
  }
  private notice(id: string, text: string) {
    this.session.emit({ type: "notice", id: `${this.id}:${id}`, level: "warning", text });
  }

  async setModel(model: string) {
    this.model = model;
    this.session.emit({ type: "session_model", id: "session_model", model });
    this.changed("model");
  }
  async setPermissionMode(mode: PermissionMode) {
    if (!this.session.info().permissionModes.includes(mode)) throw new Error(`permission mode ${mode} is not enabled`);
    await this.writeBlock(mode);
    this.permissionMode = mode;
    this.session.emit({ type: "session_permission_mode", id: "session_permission_mode", mode });
    this.changed("permissionMode");
  }
  async setEffort(effort: Effort) {
    this.effort = effort;
    this.session.emit({ type: "session_effort", id: "session_effort", effort });
    this.changed("effort");
  }

  private async writeBlock(mode: PermissionMode) {
    const mcp = this.mcpOn;
    const permission = modeBlock(mode, this.always, mode === "plan" ? await this.engine.planEdit(this.cwd) : [], { readOnly: !!this.opts.disallowedTools?.(this.id)?.some((t) => ASIDE_NO_EDIT.includes(t)), ...(mcp && { mcp: mcpName(this.id) }) });
    await this.server.request(`/session/${this.id}`, { method: "PATCH", directory: this.cwd, body: { permission } });
    this.written = mode;
    this.writtenMcp = mcp;
  }

  /**
   * Attaches this session's orchestration MCP server to OpenCode (its folder's instance) unless it is connected: at begin and before each
   * prompt, so a restart or dispose of OpenCode (which drops it) is repaired by the next prompt. Only while orchestration is on and the
   * session is no unkept Aside; `mcpServers` binds the tools to this session, as at a Claude query start.
   */
  private attach(): Promise<void> {
    return (this.attaching ??= (async () => {
      const route = this.engine.mcp;
      const url = route?.url();
      this.mcpOn = !!url && !this.opts.disallowedTools?.(this.id)?.some((t) => ASIDE_NO_WORKERS.includes(t)) && this.opts.mcpServers?.(this.id) !== undefined;
      if (!this.mcpOn) return;
      const name = mcpName(this.id);
      const status = await this.server.request<Record<string, { status: string }>>("/mcp", { directory: this.cwd });
      if (status[name]?.status === "connected") return;
      const config = { type: "remote", url, headers: { authorization: `Bearer ${route!.token(this.id)}` }, oauth: false, timeout: MAX_WAIT_MS + 60_000 };
      await this.server.request("/mcp", { method: "POST", directory: this.cwd, body: { name, config } });
    })()
      .catch((err) => this.notice("mcp_failed", `Could not attach the orchestration tools to OpenCode: ${(err as Error).message}`))
      .finally(() => (this.attaching = undefined)));
  }

  prompt(text: string, images: string[] = []): string {
    // Stop was pressed and the aborted turn still runs: a joining prompt would be lost with the loop, so it starts the next turn when this one has ended.
    const afterStop = this.stopped && this.session.currentState() !== "idle";
    const messageID = ascending("msg");
    this.mapper.own.add(messageID);
    this.revertAt = undefined;
    this.session.emit({ type: "user_text", id: messageID, text, images });
    const start = () => this.start(messageID, text, images);
    if (!afterStop) start();
    else void Promise.race([this.turnEnd?.done, new Promise((r) => setTimeout(r, TURN_END_WAIT_MS))]).then(start);
    return messageID;
  }

  /** Sends a prompt: it joins the running turn (steering: the model sees it at the next step; the turn still ends at one session.idle) or starts one. */
  private start(messageID: string, text: string, images: string[]) {
    const steer = this.session.currentState() !== "idle";
    this.stopped = false;
    if (!steer) {
      this.sentAt = Infinity;
      this.beginTurn();
      this.session.setState("running");
    }
    const cmd = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    void this.send(messageID, text, images, !steer && cmd && this.commandNames.has(cmd[1]!) ? { name: cmd[1]!, args: cmd[2] ?? "" } : undefined).catch((err) => {
      this.notice("prompt_failed", `Could not send the prompt to OpenCode: ${(err as Error).message}`);
      if (!steer) this.toIdle();
    });
  }

  private async send(messageID: string, text: string, images: string[], command?: { name: string; args: string }) {
    // Whatever the outcome (POST failure, Stop, command), the turn-end check of a resync may run 3 s later.
    try {
      // Events of the turn must find the stream open; a block of a mode the session was restored with (or the first one) goes in before the turn.
      await Promise.all([this.server.streamReady(), this.attach()]);
      if (this.written !== this.permissionMode || this.writtenMcp !== this.mcpOn) await this.writeBlock(this.permissionMode);
      if (this.stopped) {
        this.session.emit({ type: "turn_interrupted", id: `interrupted:${ascending("msg")}` });
        return this.toIdle();
      }
      const [providerID, ...rest] = this.model.split("/");
      const agent = this.permissionMode === "plan" ? "plan" : "build";
      if (command) {
        // The turn runs inside this request: no timeout.
        await this.server.request(`/session/${this.id}/command`, {
          method: "POST",
          directory: this.cwd,
          timeoutMs: 0,
          body: { messageID, command: command.name, arguments: command.args, agent, ...(this.model !== "default" && { model: this.model }), parts: images.map((url) => ({ type: "file", mime: dataUrlMime(url), url, filename: "image" })) },
        });
        return;
      }
      const parts = [
        ...(text ? [{ id: ascending("prt"), type: "text", text }] : []),
        ...images.map((url) => ({ type: "file", mime: dataUrlMime(url), url, filename: "image" })),
      ];
      await this.server.request(`/session/${this.id}/prompt_async`, {
        method: "POST",
        directory: this.cwd,
        body: { messageID, parts, agent, ...(this.model !== "default" && rest.length && { model: { providerID, modelID: rest.join("/") } }) },
      });
    } finally {
      this.sentAt = Date.now();
    }
  }

  private beginTurn() {
    this.turnEnd = {} as NonNullable<typeof this.turnEnd>;
    this.turnEnd.done = new Promise<void>((r) => (this.turnEnd!.resolve = r));
    this.turnAt = Date.now();
    this.aborted = false;
    this.failed = false;
    this.mapper.resetTurn();
  }

  /** The turn ended (session idle): its result, then idle. */
  private finish() {
    if (this.session.currentState() === "idle") return;
    const { usage, cost } = this.mapper.turn();
    if (!this.aborted) this.session.emit({ type: "turn_result", id: `turn:${ascending("msg")}`, durationMs: Date.now() - this.turnAt, ...(cost > 0 && { costUsd: cost }), usage, isError: this.failed });
    this.toIdle();
    void this.emitUsage();
  }

  /** The turn is over: idle, and a prompt waiting for the end of an aborted turn goes on. */
  private toIdle() {
    this.session.setState("idle");
    this.turnEnd?.resolve();
    this.turnEnd = undefined;
  }

  async interrupt() {
    if (this.session.currentState() === "idle") return;
    this.stopped = true;
    this.session.interruptPending();
    await this.server.request(`/session/${this.id}/abort`, { method: "POST", directory: this.cwd });
  }

  /** One event of the server for this session or one of its subagent sessions. */
  event(payload: Payload) {
    const p = payload.properties;
    const root = (p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID ?? p.info?.id) === this.id;
    switch (payload.type) {
      case "message.updated": {
        const info = p.info;
        // plan_exit "Yes" (or a build prompt from OpenCode's own UI) leaves plan mode.
        if (root && info.role === "user" && info.agent === "build" && !this.mapper.own.has(info.id) && this.permissionMode === "plan" && !this.leavingPlan) {
          this.leavingPlan = true;
          void this.setPermissionMode("default").catch(() => {}).finally(() => (this.leavingPlan = false));
        }
        if (root) this.noteUsage(info);
        return this.emitAll(this.mapper.message(info));
      }
      case "message.part.updated":
        return this.emitAll(this.mapper.part(p.part));
      case "message.part.delta":
        return p.field === "text" ? this.emitAll(this.mapper.delta(p.partID, p.delta)) : undefined;
      case "todo.updated":
        return this.session.emit(this.mapper.todos(p.sessionID, p.todos as OpenCodeTodo[]));
      case "permission.asked":
        return this.askPermission(p as PermissionAsked);
      case "question.asked":
        return this.askQuestion(p as QuestionAsked);
      case "permission.replied":
      case "question.replied":
      case "question.rejected":
        // Settled in OpenCode's own UI, or by the "always" cascade of another answer: our reply was settled before this event.
        return this.session.pendingRequest(p.requestID) ? this.session.cancel(p.requestID, ANSWERED) : undefined;
      case "session.status": {
        if (!root) return;
        const s = p.status as Status;
        if (s.type === "busy" && this.session.currentState() === "idle") (this.beginTurn(), this.session.setState("running"));
        else if (s.type === "retry") this.notice("retry", `Retrying (attempt ${s.attempt ?? 1}): ${s.message ?? ""}`);
        return;
      }
      case "session.idle":
        return root ? this.finish() : undefined;
      case "session.error": {
        if (!root) return;
        if (p.error?.name === "MessageAbortedError") {
          this.aborted = true;
          return this.session.emit({ type: "turn_interrupted", id: `interrupted:${ascending("msg")}` });
        }
        this.failed = true;
        return this.notice("error", p.error?.data?.message ?? p.error?.name ?? "OpenCode reported an error");
      }
      case "session.updated": {
        if (!root) return;
        const revert: string | undefined = p.info?.revert?.messageID;
        // Reverted elsewhere (OpenCode's /undo): cut like our own rewind. Unreverted elsewhere (/redo): read the restored messages again.
        if (revert && revert !== this.revertAt) (this.revertAt = revert, this.session.emit({ type: "rewind", id: randomUUID(), userMessageId: revert }));
        else if (!revert && this.revertAt) void (this.resyncing?.then(() => this.resync()) ?? this.resync()); // a read already in flight may predate the unrevert
        return typeof p.info?.title === "string" ? this.engine.onTitle?.(this.id, p.info.title) : undefined;
      }
    }
  }
  private emitAll(parts: ReturnType<OpenCodeMapper["part"]>) {
    for (const part of parts) this.session.emit(part);
  }

  private askPermission(e: PermissionAsked) {
    // `reqs` without a pending request: the worker_start card is being made.
    if (this.session.pendingRequest(e.id) || this.reqs.has(e.id)) return;
    const call = e.tool?.callID ? this.mapper.call(e.tool.callID) : undefined;
    const mapped = call?.type === "tool_call" ? call : undefined;
    // The ask can come before the call has its input (the call is still pending): the permission's own metadata then names it (bash: the command).
    const fallback = mapTool(e.permission, e.metadata);
    const tool = mapped?.tool ?? fallback.tool;
    const edit = e.permission === "edit" && !!e.always?.includes("*");
    // worker_start: no "always" rule, the card is the user's only gate on new workers (as for Claude).
    const start = tool === WORKER_START;
    const suggestions: PermissionUpdate[] = edit
      ? [{ type: "setMode", mode: "acceptEdits", destination: "session" }]
      : e.always?.length && !start
        ? [{ type: "addRules", rules: e.always.map((ruleContent) => ({ toolName: tool, ruleContent })), behavior: "allow", destination: "session" }]
        : [];
    this.reqs.set(e.id, { kind: "permission", permission: e.permission, always: edit || start ? undefined : e.always, callId: e.tool?.callID });
    const input: Record<string, unknown> = mapped && Object.keys(mapped.input as object).length ? (mapped.input as Record<string, unknown>) : { ...(!mapped && { patterns: e.patterns ?? [] }), ...fallback.input };
    const part = {
      type: "permission_request" as const,
      id: e.id,
      requestId: e.id,
      toolUseId: e.tool?.callID ?? e.id,
      tool,
      input,
      ...(!mapped && { title: `OpenCode asks to use ${e.permission}: ${(e.patterns ?? []).join(", ")}` }),
      noEdit: true as const,
      suggestions,
      settled: false,
      at: Date.now(),
    };
    const reply = (r: Reply) => this.answerPermission(e.id, r);
    if (!start) return this.session.request({ part, reply });
    // Over a limit: no card, the call runs and the tool repeats the refusal (orchestration.ts preflight).
    if (this.opts.preflight?.(this.id, tool, input, ORCHESTRATION) !== undefined) return (this.reqs.delete(e.id), this.post(`/permission/${e.id}/reply`, { reply: "once" }));
    // shortcut: noEdit, so the card's input (the inherited mode pinned) is not sent; the handler reads the coordinator's mode when it runs.
    void Promise.resolve(this.opts.permissionCard?.(this.id, tool, input, ORCHESTRATION))
      .catch(() => undefined)
      .then((card) => this.reqs.has(e.id) && this.session.request({ part: { ...part, ...(card && { title: card.title }) }, onAllow: card?.onAllow, reply }));
  }

  private askQuestion(e: QuestionAsked) {
    if (this.session.pendingRequest(e.id)) return;
    const questions: Question[] = e.questions.map((q) => ({ question: q.question, header: q.header, options: q.options.map((o) => ({ label: o.label, description: o.description })), multiSelect: q.multiple ?? false }));
    this.reqs.set(e.id, { kind: "question", questions });
    this.session.request({ part: { type: "question", id: e.id, requestId: e.id, toolUseId: e.tool?.callID ?? e.id, questions, settled: false, at: Date.now() }, reply: (r) => this.answerQuestion(e.id, r) });
  }

  private post(path: string, body: unknown) {
    void this.server.request(path, { method: "POST", directory: this.cwd, body }).catch((err) => this.notice("answer_failed", `Could not answer OpenCode: ${(err as Error).message}`));
  }

  private answerPermission(id: string, r: Reply) {
    const req = this.reqs.get(id);
    this.reqs.delete(id);
    if (!req) return;
    const path = `/permission/${id}/reply`;
    const denied = () => req.callId && this.mapper.deny(req.callId);
    switch (r.kind) {
      case "allow":
        if (r.decision === "allow") return this.post(path, { reply: "once" });
        if (req.always) {
          this.post(path, { reply: "always" });
          return this.persist(req.permission!, req.always);
        }
        // Edit: "always" would only live in the server's memory; "all edits" is the acceptEdits mode, saved with the session.
        this.post(path, { reply: "once" });
        return void this.setPermissionMode("acceptEdits").catch((err) => this.notice("mode_failed", `Could not switch the mode: ${(err as Error).message}`));
      case "deny":
      case "interrupt":
      case "coordinator": {
        const message = r.kind === "deny" ? r.message : r.kind === "coordinator" && r.decision === "deny" ? COORDINATOR_DENIED + r.message : undefined;
        if (r.kind === "coordinator" && r.decision === "allow") return this.post(path, { reply: "once" });
        const card = denied();
        if (card) this.session.emit(card);
        return this.post(path, { reply: "reject", ...(message && { message }) });
      }
      case "cancel":
        if (r.message !== ANSWERED) this.post(path, { reply: "reject" });
    }
  }

  private answerQuestion(id: string, r: Reply) {
    const req = this.reqs.get(id);
    this.reqs.delete(id);
    if (!req) return;
    if (r.kind === "answer") {
      const answers = req.questions!.map((q) => (r.answers[q.question] === undefined ? [] : q.multiSelect ? splitLabels(r.answers[q.question]!, q.options.map((o) => o.label)) : [r.answers[q.question]!]));
      return this.post(`/question/${id}/reply`, { answers });
    }
    if (r.kind !== "cancel" || r.message !== ANSWERED) this.post(`/question/${id}/reject`, {});
  }

  /** "Always allow" of a permission other than edit: the patterns join the session ruleset (and survive restarts). */
  private persist(permission: string, patterns: string[]) {
    const rules = patterns.map((pattern): Rule => ({ permission, pattern, action: "allow" }));
    this.always.push(...rules);
    void this.server.request(`/session/${this.id}`, { method: "PATCH", directory: this.cwd, body: { permission: rules } }).catch((err) => this.notice("persist_failed", `Could not save the rule: ${(err as Error).message}`));
  }

  bash(): void {
    throw new Error("Shell commands in OpenCode sessions come in a later version");
  }
  subscribed() {}
  beforeStateEvent() {}
  idle() {}
  bashCwdPinned = () => false;
  /** Stop agent: aborts the child session of the task call. */
  stopSubagent = async (callId: string) => {
    const child = this.mapper.childOf(callId);
    if (!child) return false;
    await this.server.request(`/session/${child}/abort`, { method: "POST", directory: this.cwd });
    return true;
  };
  backgroundShell = async () => false;
  stopShell = async () => false;
  shellOutput = async () => undefined;

  /** The stored messages and what a revert to before the user message `id` covers: the files its turn and every later turn changed. */
  private async rewindPlan(id: string) {
    const all = await this.server.request<OpenCodeMessage[]>(`/session/${this.id}/message`, { directory: this.cwd });
    const at = all.findIndex((m) => m.info.id === id && m.info.role === "user");
    if (at < 0) throw new Error("unknown message");
    const diffs = all.slice(at).flatMap((m) => (m.info.role === "user" ? (m.info.summary?.diffs ?? []) : []));
    const filesChanged = [...new Set(diffs.map((d) => d.file))];
    // The revert restores files and conversation together (no variant of either), so only `both`, or `conversation` when no file changed.
    const preview: RewindPreview = { filesChanged, insertions: diffs.reduce((n, d) => n + d.additions, 0), deletions: diffs.reduce((n, d) => n + d.deletions, 0), conversation: true, modes: filesChanged.length ? ["both"] : ["conversation"] };
    return { all, at, preview };
  }
  previewRewind = async (id: string) => (await this.rewindPlan(id)).preview;
  /** OpenCode revert to before the user message `id`; the messages stay stored, the mark hides them until the next prompt removes them. */
  rewind = async (id: string, mode: RewindMode) => {
    if (this.session.currentState() !== "idle") throw new Error("Stop the turn first");
    const { all, at, preview } = await this.rewindPlan(id);
    if (!preview.modes!.includes(mode)) throw new Error(`OpenCode rewinds ${preview.modes![0] === "both" ? "code and conversation together" : "the conversation only"}`);
    const before = this.revertAt;
    this.revertAt = id; // the session.updated of this revert is not an external one
    await this.server.request(`/session/${this.id}/revert`, { method: "POST", directory: this.cwd, body: { messageID: id } }).catch((err) => ((this.revertAt = before), Promise.reject(err)));
    this.session.emit({ type: "rewind", id: randomUUID(), userMessageId: id });
    this.usage = undefined;
    for (const m of all.slice(0, at)) this.noteUsage(m.info);
    void this.emitUsage();
  };
  sync = async () => {};
  close = async () => {
    this.engine.remove(this);
    this.engine.mcp?.drop(this.id);
    if (this.mcpOn && this.server.running()) await this.server.request(`/mcp/${mcpName(this.id)}/disconnect`, { method: "POST", directory: this.cwd }).catch(() => {});
  };
  activity = () => ({ received: 0, at: 0, progress: 0 });
  live = () => this.server.running();
  reloadPlugins = async () => undefined;
  restartQuery() {}
  releaseQuery = () => false;
  externalTurnRunning = () => false;
  untitled = () => false;
  bashRunning = () => false;
  working = () => false;
  takesQueued = () => this.session.currentState() === "idle" && this.session.pendingCount() === 0;
}

class OpenCodeEngineImpl implements Engine {
  readonly name = "opencode" as const;
  readonly capabilities = OPENCODE_CAPABILITIES;
  private readonly sessions = new Set<OpenCodeSession>();
  private unsubscribe: (() => void) | undefined;
  private plan: Promise<Rule[]> | undefined;
  private limits: Promise<Map<string, number>> | undefined;

  constructor(
    readonly server: OpenCodeServer,
    readonly onTitle?: (id: string, title: string) => void,
    readonly mcp?: OpenCodeMcpRoute,
  ) {}

  permissionModes = (o: { allowBypass?: boolean; supportsAuto?: boolean }) => permissionModesFor({ ...o, modes: OPENCODE_MODES });

  open(session: Session, opts: SessionOpts, restored?: Restored) {
    return new OpenCodeSession(this, session, opts, restored?.history as OpenCodeHistory | undefined);
  }

  add(s: OpenCodeSession) {
    this.sessions.add(s);
    this.unsubscribe ??= this.server.events({
      event: (_dir, payload) => {
        const p = payload.properties;
        const sid: string | undefined = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID ?? p.info?.id;
        if (sid) for (const o of this.sessions) if (o.owns(sid)) o.event(payload);
      },
      resync: () => (this.commandLists.clear(), this.sessions.forEach((o) => void o.resync())),
    });
  }
  remove(s: OpenCodeSession) {
    this.sessions.delete(s);
    if (!this.sessions.size) (this.unsubscribe?.(), (this.unsubscribe = undefined));
  }

  /** The `plan` agent's `edit` rules, read once (shortcut: until the daemon restarts; a changed OpenCode config needs one). */
  planEdit(cwd: string): Promise<Rule[]> {
    return (this.plan ??= this.server
      .request<{ name: string; permission: Rule[] }[]>("/agent", { directory: cwd })
      .then((agents) => agents.find((a) => a.name === "plan")?.permission.filter((r) => r.permission === "edit") ?? [])
      .catch((err) => ((this.plan = undefined), Promise.reject(err))));
  }

  /** Context window of `provider/model` from `GET /config/providers`, read once per provider set (`dropLimits` after a login or logout); undefined when unknown. */
  async contextLimit(providerID: string, modelID: string): Promise<number | undefined> {
    this.limits ??= this.server
      .request<{ providers: { id: string; models: Record<string, { limit?: { context?: number } }> }[] }>("/config/providers")
      .then((r) => new Map(r.providers.flatMap((p) => Object.entries(p.models).flatMap(([id, m]) => (m.limit?.context ? [[`${p.id}/${id}`, m.limit.context] as const] : [])))))
      .catch(() => ((this.limits = undefined), new Map<string, number>()));
    return (await this.limits).get(`${providerID}/${modelID}`);
  }
  private commandLists = new Map<string, { at: number; list: Promise<SlashCommand[]> }>();
  /** `GET /command` of a folder (built-ins, project and user commands, MCP prompts, skills), cached 60 s; dropped when the server restarts. */
  commands(cwd: string): Promise<SlashCommand[]> {
    const hit = this.commandLists.get(cwd);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    const list = this.server
      .request<{ name: string; description?: string; hints?: string[] }[]>("/command", { directory: cwd })
      .then((l) => l.map((c) => ({ name: c.name, description: c.description ?? "", argumentHint: (c.hints ?? []).join(" ") })));
    this.commandLists.set(cwd, { at: Date.now(), list });
    list.catch(() => this.commandLists.delete(cwd));
    return list;
  }
  dropLimits = () => (this.limits = undefined);

  /** The rules `POST /session` gets for a new session in `mode`. */
  block = async (mode: PermissionMode, cwd: string): Promise<Rule[]> => modeBlock(mode, [], mode === "plan" ? await this.planEdit(cwd) : []);
}

/** The daemon's `/opencode-mcp` route (server.ts): its URL (undefined while the daemon does not listen), the bearer token of a session (made on first use), dropped at close. */
export type OpenCodeMcpRoute = { url: () => string | undefined; token: (id: string) => string; drop: (id: string) => void };
export type OpenCodeEngine = OpenCodeEngineImpl;
export const createOpenCodeEngine = (server: OpenCodeServer, o: { onTitle?: (id: string, title: string) => void; mcp?: OpenCodeMcpRoute } = {}): OpenCodeEngine => new OpenCodeEngineImpl(server, o.onTitle, o.mcp);
