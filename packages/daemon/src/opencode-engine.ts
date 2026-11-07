// The OpenCode Engine (ADR 0012, docs/spec.md "OpenCode engine"): sessions run on the daemon's OpenCode server (opencode-server.ts). One event
// stream of the server feeds every open session; prompts, permissions and questions go back as HTTP calls.
import { permissionModesFor, type Effort, type EngineCapabilities, type ModelInfo, type PermissionMode, type PermissionUpdate, type Question } from "@claude-ui/protocol";
import { COORDINATOR_DENIED } from "./claude-engine.ts";
import type { Engine, EngineSession, Reply, Restored } from "./engine.ts";
import { ascending } from "./opencode-id.ts";
import { mapTool, openCodeParts, OpenCodeMapper, type OpenCodeMessage, type OpenCodeTodo } from "./opencode-parts.ts";
import type { OpenCodeServer } from "./opencode-server.ts";
import { mapLimit } from "./session-scan.ts";
import type { Session, SessionOpts, SessionSettings } from "./session.ts";

/** Modes OpenCode sessions switch to; no `auto` or `dontAsk`. */
export const OPENCODE_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const OPENCODE_CAPABILITIES: EngineCapabilities = { permissionModes: OPENCODE_MODES, effort: false, rewind: false, fork: false, steering: false, slashCommands: false, planMeter: false, account: false, contextUsage: false };

export type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" };
const MARK = "claude-ui";
const marker = (pattern: string): Rule => ({ permission: MARK, pattern, action: "allow" });
const star = (permission: string, action: Rule["action"]): Rule => ({ permission, pattern: "*", action });
const ANSWERED = "Answered in OpenCode";

/**
 * The rules a permission mode appends to a session (OpenCode evaluates last match wins; rules cannot be removed through the API, so a mode
 * change appends a whole new block). Marker rules (`claude-ui`) match no tool: they tell a restore which mode is in force and where the
 * "always allow" rules start. `planEdit`: the `plan` agent's own `edit` rules, so earlier edit rules no longer win.
 * shortcut: every mode change appends one block; fine for hundreds of switches.
 */
export function modeBlock(mode: PermissionMode, always: Rule[], planEdit: Rule[]): Rule[] {
  const asks = [star("webfetch", "ask"), star("websearch", "ask")];
  const rules =
    mode === "bypassPermissions" ? ["bash", "edit", "webfetch", "websearch"].map((p) => star(p, "allow"))
    : mode === "acceptEdits" ? [star("bash", "ask"), star("edit", "allow"), ...asks]
    : mode === "plan" ? [star("bash", "ask"), ...asks, ...planEdit]
    : [star("bash", "ask"), star("edit", "ask"), ...asks];
  return [marker(`mode:${mode}`), ...rules, marker("always"), ...always];
}
const lastMarker = (rules: readonly Rule[], test: (pattern: string) => boolean) => rules.map((r) => r.permission === MARK && test(r.pattern)).lastIndexOf(true);
/** The "always allow" rules of a session: the ones after the last `always` marker. */
export const alwaysOf = (rules: readonly Rule[]): Rule[] => {
  const i = lastMarker(rules, (p) => p === "always");
  return i < 0 ? [] : rules.slice(i + 1).filter((r) => r.permission !== MARK);
};
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
export type OpenCodeHistory = { messages: OpenCodeMessage[]; children: Record<string, OpenCodeMessage[]>; busy: boolean; permission: Rule[]; permissions: PermissionAsked[]; questions: QuestionAsked[] };

export async function loadOpenCodeHistory(server: OpenCodeServer, id: string, cwd: string): Promise<OpenCodeHistory> {
  const at = { directory: cwd };
  const [messages, row, status, permissions, questions] = await Promise.all([
    server.request<OpenCodeMessage[]>(`/session/${id}/message`, at),
    server.request<{ permission?: Rule[] }>(`/session/${id}`, at).catch(() => ({}) as { permission?: Rule[] }),
    server.request<Record<string, Status>>("/session/status", at).catch(() => ({}) as Record<string, Status>),
    server.request<PermissionAsked[]>("/permission", at).catch(() => []),
    server.request<QuestionAsked[]>("/question", at).catch(() => []),
  ]);
  const childIds = messages.flatMap((m) => m.parts.map((p) => p.state?.metadata?.sessionId).filter((c): c is string => typeof c === "string"));
  const children = Object.fromEntries(await mapLimit(childIds, 4, async (c) => [c, await server.request<OpenCodeMessage[]>(`/session/${c}/message`, at).catch(() => [])] as const));
  return { messages, children, busy: status[id]?.type === "busy", permission: row.permission ?? [], permissions, questions };
}

/** The models of the connected providers (`GET /config/providers`): Default, then every provider's models under the provider name. */
export async function openCodeModels(server: OpenCodeServer): Promise<ModelInfo[]> {
  const r = await server.request<{ providers: { id: string; name: string; models: Record<string, { name: string }> }[]; default?: Record<string, string> }>("/config/providers");
  const [defProvider, defModel] = Object.entries(r.default ?? {})[0] ?? [];
  const p = r.providers.find((x) => x.id === defProvider);
  const name = p && defModel ? `Default (${p.name} ${p.models[defModel]?.name ?? defModel})` : "Default";
  return [{ value: "default", displayName: name, description: "" }, ...r.providers.flatMap((x) => Object.entries(x.models).map(([id, m]) => ({ value: `${x.id}/${id}`, displayName: m.name, description: "", group: x.name })))];
}

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
  private leavingPlan = false;

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
    for (const part of openCodeParts(h.messages, h.children, this.mapper)) this.session.emit(part);
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
        this.requests(h);
        const state = this.session.currentState();
        if (h.busy && state === "idle") (this.turnAt = Date.now()), this.session.setState("running");
        // A prompt just sent may not be busy in OpenCode yet.
        else if (!h.busy && state === "running" && Date.now() - this.turnAt > 3000) this.finish();
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
    const permission = modeBlock(mode, this.always, mode === "plan" ? await this.engine.planEdit(this.cwd) : []);
    await this.server.request(`/session/${this.id}`, { method: "PATCH", directory: this.cwd, body: { permission } });
    this.written = mode;
  }

  prompt(text: string, images: string[] = []): string {
    if (this.session.currentState() !== "idle") throw new Error("Steering OpenCode sessions comes in a later version");
    const messageID = ascending("msg");
    this.stopped = false;
    this.mapper.own.add(messageID);
    this.session.emit({ type: "user_text", id: messageID, text, images });
    this.beginTurn();
    this.session.setState("running");
    void this.send(messageID, text, images).catch((err) => {
      this.notice("prompt_failed", `Could not send the prompt to OpenCode: ${(err as Error).message}`);
      this.session.setState("idle");
    });
    return messageID;
  }

  private async send(messageID: string, text: string, images: string[]) {
    // Events of the turn must find the stream open; a block of a mode the session was restored with (or the first one) goes in before the turn.
    await this.server.streamReady();
    if (this.written !== this.permissionMode) await this.writeBlock(this.permissionMode);
    if (this.stopped) {
      this.session.emit({ type: "turn_interrupted", id: `interrupted:${ascending("msg")}` });
      return this.session.setState("idle");
    }
    const [providerID, ...rest] = this.model.split("/");
    const parts = [
      ...(text ? [{ id: ascending("prt"), type: "text", text }] : []),
      ...images.map((url) => ({ type: "file", mime: dataUrlMime(url), url, filename: "image" })),
    ];
    await this.server.request(`/session/${this.id}/prompt_async`, {
      method: "POST",
      directory: this.cwd,
      body: { messageID, parts, agent: this.permissionMode === "plan" ? "plan" : "build", ...(this.model !== "default" && rest.length && { model: { providerID, modelID: rest.join("/") } }) },
    });
  }

  private beginTurn() {
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
    this.session.setState("idle");
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
      case "session.updated":
        return root && typeof p.info?.title === "string" ? this.engine.onTitle?.(this.id, p.info.title) : undefined;
    }
  }
  private emitAll(parts: ReturnType<OpenCodeMapper["part"]>) {
    for (const part of parts) this.session.emit(part);
  }

  private askPermission(e: PermissionAsked) {
    if (this.session.pendingRequest(e.id)) return;
    const call = e.tool?.callID ? this.mapper.call(e.tool.callID) : undefined;
    const mapped = call?.type === "tool_call" ? call : undefined;
    // The ask can come before the call has its input (the call is still pending): the permission's own metadata then names it (bash: the command).
    const fallback = mapTool(e.permission, e.metadata);
    const tool = mapped?.tool ?? fallback.tool;
    const edit = e.permission === "edit" && !!e.always?.includes("*");
    const suggestions: PermissionUpdate[] = edit
      ? [{ type: "setMode", mode: "acceptEdits", destination: "session" }]
      : e.always?.length
        ? [{ type: "addRules", rules: e.always.map((ruleContent) => ({ toolName: tool, ruleContent })), behavior: "allow", destination: "session" }]
        : [];
    this.reqs.set(e.id, { kind: "permission", permission: e.permission, always: edit ? undefined : e.always, callId: e.tool?.callID });
    this.session.request({
      part: {
        type: "permission_request",
        id: e.id,
        requestId: e.id,
        toolUseId: e.tool?.callID ?? e.id,
        tool,
        input: mapped && Object.keys(mapped.input as object).length ? mapped.input : { ...(!mapped && { patterns: e.patterns ?? [] }), ...fallback.input },
        ...(!mapped && { title: `OpenCode asks to use ${e.permission}: ${(e.patterns ?? []).join(", ")}` }),
        noEdit: true,
        suggestions,
        settled: false,
        at: Date.now(),
      },
      reply: (r) => this.answerPermission(e.id, r),
    });
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
      // shortcut: a multi-select answer is split at ", " (the wire joins labels with it); a label containing ", " splits wrong. Upgrade when the web sends arrays.
      const answers = req.questions!.map((q) => (r.answers[q.question] === undefined ? [] : q.multiSelect ? r.answers[q.question]!.split(", ") : [r.answers[q.question]!]));
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
  stopSubagent = async () => false;
  backgroundShell = async () => false;
  stopShell = async () => false;
  shellOutput = async () => undefined;
  previewRewind = async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false });
  rewind = async () => {};
  sync = async () => {};
  close = async () => this.engine.remove(this);
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

  constructor(
    readonly server: OpenCodeServer,
    readonly onTitle?: (id: string, title: string) => void,
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
      resync: () => this.sessions.forEach((o) => void o.resync()),
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

  /** The rules `POST /session` gets for a new session in `mode`. */
  block = async (mode: PermissionMode, cwd: string): Promise<Rule[]> => modeBlock(mode, [], mode === "plan" ? await this.planEdit(cwd) : []);
}

export type OpenCodeEngine = OpenCodeEngineImpl;
export const createOpenCodeEngine = (server: OpenCodeServer, o: { onTitle?: (id: string, title: string) => void } = {}): OpenCodeEngine => new OpenCodeEngineImpl(server, o.onTitle);
