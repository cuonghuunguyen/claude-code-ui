// The OpenCode 2 Engine (ADR 0015, docs/spec.md "OpenCode engine"): sessions run on the daemon's OpenCode 2 server through `@opencode/client`. One event stream
// (`GET /api/event`, opencode-server.ts) feeds every open session; prompts, Stop and permission replies go back as client calls.
// Slice 2 of the OpenCode 2 support: create, list, prompt, stream, stop, permissions, models. Agents, slash commands, rewind, bash mode, questions, rename,
// archive, delete, Aside and MCP are later slices: their calls answer that OpenCode 2 does not have them in claude-ui yet.
import type { OpenCodeClient } from "@opencode/client";
import { permissionModesFor, type Effort, type EffortLevel, type EngineCapabilities, type ModelInfo, type PermissionMode, type PermissionUpdate } from "@claude-ui/protocol";
import { DeniedRetryError } from "./denied-retry.ts";
import type { Engine, EngineSession, Reply, Restored } from "./engine.ts";
import { ascending } from "./opencode-id.ts";
import { OPENCODE_CAPABILITIES, OPENCODE_PERMISSION_MODES } from "./opencode-engine.ts";
import { OpenCode2Mapper, failureText, mapTool2, type Failure, type OpenCode2Message } from "./opencode2-parts.ts";
import type { OpenCodeServer } from "./opencode-server.ts";
import type { Session, SessionOpts, SessionSettings } from "./session.ts";

/** What this version of the OpenCode 2 adapter has: no agents, commands, rewind, fork or bash mode yet. */
export const OPENCODE2_CAPABILITIES: EngineCapabilities = { ...OPENCODE_CAPABILITIES, agents: false, rewind: false, fork: false, slashCommands: false, shell: false };

/** A permission rule of OpenCode 2. */
export type Rule2 = { action: string; resource: string; effect: "allow" | "deny" | "ask" };
const rule = (action: string, effect: Rule2["effect"]): Rule2 => ({ action, resource: "*", effect });
/**
 * The session rules of a permission mode. They replace the session's rules (`PATCH /api/session/{id}`); the agent's own rules apply under them. `config` has none:
 * OpenCode's config and the agent decide. "Always allow" is saved by OpenCode itself (per project, `POST …/reply` with `always`), so a mode change never loses it.
 */
export function modeRules(mode: PermissionMode): Rule2[] {
  if (mode === "config") return [];
  if (mode === "bypassPermissions") return [rule("*", "allow")];
  return [rule("shell", "ask"), rule("edit", mode === "acceptEdits" ? "allow" : "ask"), rule("webfetch", "ask"), rule("websearch", "ask")];
}
/** The mode whose rules a session has, undefined for rules of another origin. */
export const modeOfRules = (rules: readonly Rule2[] | undefined): PermissionMode | undefined =>
  (["config", "default", "acceptEdits", "bypassPermissions"] as const).find((m) => JSON.stringify(modeRules(m)) === JSON.stringify(rules ?? []));

/** The unsupported-feature error of this slice: the text names the feature. */
export const notYet = (what: string) => new Error(`OpenCode 2 does not support ${what} in claude-ui yet.`);

type Json = Record<string, any>;
/** A model of `GET /api/model` and its default. */
type ModelRow = { id: string; providerID: string; name: string; enabled?: boolean; variants?: { id: string }[]; limit?: { context?: number } };
type Models = { list: ModelRow[]; def: ModelRow | undefined };
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const levelsOf = (m?: ModelRow) => EFFORT_ORDER.filter((l) => m?.variants?.some((v) => v.id === l));
const effortInfo = (m?: ModelRow) => {
  const levels = levelsOf(m);
  return levels.length ? { supportsEffort: true, supportedEffortLevels: levels } : {};
};
/** `provider/model` as OpenCode 2's model reference; "default" has none. */
const refOf = (model: string) => {
  const [providerID, ...rest] = model.split("/");
  return model !== "default" && rest.length ? { providerID: providerID!, id: rest.join("/") } : undefined;
};
/** Default, then every connected provider's models under the provider id; a model with reasoning variants offers them as effort levels. */
export const modelsFrom = ({ list, def }: Models): ModelInfo[] => [
  { value: "default", displayName: def ? `Default (${def.providerID} ${def.name})` : "Default", description: "", ...effortInfo(def) },
  ...list.filter((m) => m.enabled !== false).map((m) => ({ value: `${m.providerID}/${m.id}`, displayName: m.name, description: "", group: m.providerID, ...effortInfo(m) })),
];

/** What `begin()` and `resync()` read of a session: its stored messages, whether a turn runs, the permission requests of its folder. */
export type OpenCode2History = { messages: OpenCode2Message[]; busy: boolean; permissions: Json[]; /** The session's own permission rules in OpenCode. */ rules?: Rule2[] };
const PAGE = 100;

/** The stored messages of a session, oldest first (all pages). */
export async function loadMessages(client: OpenCodeClient, sessionID: string): Promise<OpenCode2Message[]> {
  const all: OpenCode2Message[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.message.list({ sessionID, order: "asc", limit: PAGE, ...(cursor && { cursor }) });
    all.push(...(page.data as unknown as OpenCode2Message[]));
    cursor = page.data.length >= PAGE ? (page.cursor.next ?? undefined) : undefined;
    if (!cursor) return all;
  }
}

export async function loadOpenCode2History(client: OpenCodeClient, id: string, cwd: string, isOurs: (sessionID: string) => Promise<boolean> = async (sid) => sid === id): Promise<OpenCode2History> {
  const [messages, info, active, requests] = await Promise.all([
    loadMessages(client, id),
    client.session.get({ sessionID: id }),
    client.session.active().catch(() => ({}) as Record<string, unknown>),
    client.permission.request.list({ location: { directory: cwd } }).then((r) => r.data as unknown as Json[], () => [] as Json[]),
  ]);
  // The requests of this session and of its subagents' sessions.
  const mine = await Promise.all(requests.map(async (r) => ((await isOurs(r.sessionID)) ? [r] : [])));
  return { messages, busy: id in active, permissions: mine.flat(), rules: (info.permissions ?? []) as Rule2[] };
}

type TurnEnd = { done: Promise<void>; resolve: () => void };
/** The longest a prompt sent after Stop waits for the stopped turn to end. */
const TURN_END_WAIT_MS = 10_000;
/** The longest a Stop waits for a prompt that is on its way to OpenCode before it asks OpenCode to stop. */
const POSTING_WAIT_MS = 3000;
const ANSWERED = "Answered in OpenCode";

class OpenCode2Session implements EngineSession {
  private model: string;
  private permissionMode: PermissionMode;
  private effort: Effort;
  staleLogin = false;
  private readonly mapper = new OpenCode2Mapper();
  /** The mode whose rules OpenCode has for this session (undefined: not known to match any). */
  private written: PermissionMode | undefined;
  /** The model or effort changed here since it was last sent to OpenCode (or the session was made with one). */
  private modelDirty: boolean;
  /** The pending permission requests by id: the session each belongs to (a subagent's session answers under its own id). */
  private readonly reqs = new Map<string, { callId?: string; sessionID: string }>();
  private turnAt = 0;
  private aborted = false;
  private failed = false;
  private resyncing: Promise<void> | undefined;
  /** Counts Stops: a prompt that was preparing when one came is not sent; a turn begun after the last one has the current count. */
  private stops = 0;
  private turnStop = 0;
  /** A prompt of the running turn reached OpenCode (posted, or the turn was found running there). False while it is only being prepared. */
  private turnPosted = true;
  /** The `session.prompt` calls on their way: a Stop waits for them, so it reaches OpenCode after them. */
  private posting = new Set<Promise<unknown>>();
  /** Prompt requests sent so far: a resync whose reads began before one of them has not seen its turn. */
  private posts = 0;
  private turnEnd: TurnEnd | undefined;
  private turnKey = ascending("msg");
  /** The last assistant message of the running turn: the id of its failure notice, as at a restore. */
  private turnAssistant: string | undefined;
  private errorKeys = new Set<string>();
  /** Model and tokens of the last step: the context window in use. */
  private usage: { tokens: Json; providerID: string; id: string } | undefined;
  private retrying: { attempt: number; message: string; next?: number } | undefined;
  /** The model of the running step (`session.step.started`). */
  private stepModel: { id: string; providerID: string } | undefined;

  constructor(
    private readonly engine: OpenCode2EngineImpl,
    private readonly session: Session,
    private readonly opts: SessionOpts,
    private readonly history?: OpenCode2History,
  ) {
    this.model = opts.model ?? "default";
    const marked = history && modeOfRules(history.rules);
    const mode = opts.permissionMode ?? marked ?? "config";
    // Plan is OpenCode's plan agent (a later slice): a saved plan mode opens as the default mode.
    this.permissionMode = mode === "plan" || (mode === "bypassPermissions" && !opts.allowBypass) ? "default" : mode;
    this.effort = opts.effort ?? "default";
    // A new session got its rules with `POST /api/session`; a restored one has what OpenCode kept.
    this.written = history ? marked : this.permissionMode;
    this.modelDirty = this.model !== "default" || this.effort !== "default";
  }

  private get server() {
    return this.engine.server;
  }
  get id() {
    return this.session.id;
  }
  private get cwd() {
    return this.session.cwd;
  }

  begin() {
    this.engine.add(this);
    if (!this.history) return;
    this.apply(this.history);
    this.session.setState(this.history.busy ? "running" : "idle");
    if (this.history.busy) (this.beginTurn(), this.openTurnEnd());
    this.requests(this.history);
    // Events between the history read and the stream connecting are lost: read again once it is open.
    void this.server.streamReady().then(() => this.resync());
  }

  /** Emits stored history (also after a stream reconnect: part ids are stable, a re-emit replaces). */
  private apply(h: OpenCode2History) {
    for (const part of this.mapper.history(h.messages)) this.session.emit(part);
    for (const m of h.messages) this.noteUsage(m);
    void this.emitUsage();
  }

  private noteUsage(m: { type?: string; tokens?: Json; model?: { id: string; providerID: string } }) {
    if (m.type === "assistant" && m.tokens && m.model) this.usage = { tokens: m.tokens, providerID: m.model.providerID, id: m.model.id };
  }

  /** The `context_usage` part from the last step; none while the window of its model is unknown. */
  private async emitUsage() {
    const u = this.usage;
    const max = u && (await this.engine.contextLimit(u.providerID, u.id, this.cwd).catch(() => undefined));
    if (!u || !max) return;
    const t = u.tokens;
    const used = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    this.session.emit({ type: "context_usage", id: "context_usage", usage: { totalTokens: used, maxTokens: max, percentage: Math.round((used / max) * 100), categories: [{ name: "Used", tokens: used, kind: "used" }, { name: "Free", tokens: Math.max(max - used, 0), kind: "free" }] } });
  }

  /** Asks again what OpenCode still waits for (permission requests of this session); settles what it no longer lists. */
  private requests(h: OpenCode2History) {
    const live = new Set<string>();
    for (const p of h.permissions) (live.add(p.id), this.askPermission(p));
    for (const id of [...this.reqs.keys()]) if (!live.has(id) && this.session.pendingRequest(id)) this.session.cancel(id, ANSWERED);
  }

  resync(): Promise<void> {
    const posts = this.posts;
    return (this.resyncing ??= this.server
      .client()
      .then((c) => loadOpenCode2History(c, this.id, this.cwd, (sid) => this.engine.isOurs(this.id, sid)))
      .then((h) => {
        this.apply(h);
        this.requests(h);
        const state = this.session.currentState();
        if (h.busy && state === "idle") (this.beginTurn(), this.openTurnEnd(), this.session.setState("running"));
        // A prompt that is still being prepared is not in OpenCode yet: only a turn that reached it can have ended there.
        else if (!h.busy && state === "running" && this.turnPosted && this.posting.size === 0 && this.posts === posts) this.turnStop < this.stops ? this.endStopped() : this.finish();
      })
      .catch(() => {})
      .finally(() => (this.resyncing = undefined)));
  }

  settings(): SessionSettings {
    return { model: this.model, permissionMode: this.permissionMode, effort: this.effort, agent: "build" };
  }
  private changed(...fields: (keyof SessionSettings)[]) {
    this.opts.onSettings?.(this.settings(), this.id, fields);
  }
  private notice(id: string, text: string) {
    this.session.emit({ type: "notice", id: `${this.id}:${id}`, level: "warning", text });
  }

  private setRetry(r: OpenCode2Session["retrying"]) {
    const was = this.retrying;
    if (!r && !was) return;
    if (r && was && r.attempt === was.attempt && r.message === was.message && r.next === was.next) return;
    this.retrying = r;
    this.session.emit({ type: "model_retry", id: "model_retry", retry: r ?? null });
  }

  async setModel(model: string) {
    this.model = model;
    this.modelDirty = true;
    this.session.emit({ type: "session_model", id: "session_model", model });
    this.changed("model");
  }
  async setEffort(effort: Effort) {
    this.effort = effort;
    this.modelDirty = true;
    this.session.emit({ type: "session_effort", id: "session_effort", effort });
    this.changed("effort");
  }
  async setPermissionMode(mode: PermissionMode) {
    if (!this.session.info().permissionModes.includes(mode)) throw new Error(`permission mode ${mode} is not enabled`);
    await this.writeRules(mode);
    this.permissionMode = mode;
    this.session.emit({ type: "session_permission_mode", id: "session_permission_mode", mode });
    this.changed("permissionMode");
  }
  async setAgent(_agent: string): Promise<void> {
    throw notYet("agents");
  }
  refreshAgents = async () => {};
  allowDenied(_toolUseId: string): string | undefined {
    throw new DeniedRetryError("unsupported", "this session's engine has no auto mode");
  }
  alwaysAllowDenied(_toolUseId: string, _scope: "session" | "local"): Promise<string | undefined> {
    throw new DeniedRetryError("unsupported", "this session's engine has no auto mode");
  }

  /** Replaces the session's rules in OpenCode with the ones of `mode`. */
  private async writeRules(mode: PermissionMode) {
    const client = await this.server.client();
    await client.session.update({ sessionID: this.id, permissions: modeRules(mode) });
    this.written = mode;
  }

  /** Makes OpenCode run the next prompt on the session's model and effort (`POST …/model`); only when one of them changed here. */
  private async applyModel(client: OpenCodeClient) {
    if (!this.modelDirty) return;
    // "default" after an explicit model has no reference of its own: OpenCode's default model is set.
    let ref = refOf(this.model) ?? (await this.engine.defaultModel(this.cwd));
    if (!ref) return void (this.modelDirty = false);
    const levels = this.effort !== "default" ? await this.engine.effortLevels(`${ref.providerID}/${ref.id}`, this.cwd) : [];
    // A model switch can leave an effort the new model lacks: then no variant (the web offers only listed levels).
    ref = { ...ref, ...(this.effort !== "default" && levels.includes(this.effort as EffortLevel) && { variant: this.effort }) } as typeof ref;
    await client.session.switchModel({ sessionID: this.id, model: ref });
    this.modelDirty = false;
  }

  prompt(text: string, images: string[] = []): string | undefined {
    // Stop was pressed and the stopped turn still runs: a joining prompt would be lost with it, so it starts the next turn when this one has ended.
    const afterStop = this.turnStop < this.stops && this.session.currentState() !== "idle";
    const messageID = ascending("msg");
    this.mapper.own.add(messageID);
    this.session.emit({ type: "user_text", id: messageID, text, images });
    const steer = this.session.currentState() !== "idle";
    const stops = this.stops;
    const start = () => {
      // A Stop while this prompt waited for the stopped turn drops it (as a prompt being prepared).
      if (this.stops !== stops) return;
      if (!steer || afterStop) (this.beginTurn(), (this.turnPosted = false), this.session.setState("running"));
      void this.send(messageID, text, images).catch((err) => {
        this.notice(`prompt_failed:${messageID}`, `Could not send the prompt to OpenCode: ${(err as Error).message}`);
        if (!steer || afterStop) this.toIdle();
      });
    };
    if (!afterStop) start();
    else void Promise.race([this.turnEnd?.done, new Promise((r) => setTimeout(r, TURN_END_WAIT_MS))]).then(start);
    return messageID;
  }

  private async send(messageID: string, text: string, images: string[]) {
    const stops = this.stops;
    // A Stop while the prompt is prepared ends the wait: nothing was posted, interrupt() ended the turn.
    const live = () => this.stops === stops;
    // The record comes before anything of this turn reaches OpenCode 2: a failed save fails the prompt, never leaves a version 2 turn with no record.
    this.engine.record(this.id);
    await this.server.streamReady();
    if (!live()) return;
    const client = await this.server.client();
    if (this.written !== this.permissionMode) await this.writeRules(this.permissionMode);
    if (!live()) return;
    await this.applyModel(client);
    if (!live()) return;
    this.turnPosted = true;
    const files = images.map((uri) => ({ uri, source: { type: "inline" as const }, name: "image" }));
    this.posts++;
    const post = client.session.prompt({ sessionID: this.id, id: messageID, text, ...(files.length && { files }) });
    this.posting.add(post);
    try {
      await post;
    } finally {
      this.posting.delete(post);
    }
  }

  private openTurnEnd() {
    if (this.turnEnd) return;
    const end = {} as TurnEnd;
    end.done = new Promise<void>((r) => (end.resolve = r));
    this.turnEnd = end;
  }

  private beginTurn() {
    this.turnEnd = undefined;
    this.openTurnEnd();
    this.turnStop = this.stops;
    this.turnPosted = true;
    this.turnAt = Date.now();
    this.aborted = false;
    this.failed = false;
    this.turnKey = ascending("msg");
    this.turnAssistant = undefined;
    this.errorKeys = new Set();
    this.mapper.resetTurn();
  }

  /** The turn ended (execution succeeded or failed, or the Stop's end): its result, then idle. */
  private finish() {
    if (this.session.currentState() === "idle") return;
    const { usage, cost } = this.mapper.turn();
    if (!this.aborted) this.session.emit({ type: "turn_result", id: `turn:${ascending("msg")}`, durationMs: Date.now() - this.turnAt, ...(cost > 0 && { costUsd: cost }), usage, isError: this.failed });
    this.toIdle();
    void this.emitUsage();
  }

  private toIdle() {
    this.setRetry(undefined);
    this.session.setState("idle");
    this.turnEnd?.resolve();
    this.turnEnd = undefined;
  }

  /** The Stop's end of the turn: one interrupted marker, no result, idle. Not a turn begun after the Stop. */
  private endStopped() {
    if (this.session.currentState() === "idle" || this.turnStop >= this.stops) return;
    if (!this.aborted) this.session.emit({ type: "turn_interrupted", id: `interrupted:${ascending("msg")}` });
    this.aborted = true;
    this.finish();
  }

  /**
   * Stop. A prompt that is still being prepared never reaches OpenCode (`send` sees the count change): the turn ends here at once. Else the Stop waits for the
   * prompts on their way (so it reaches OpenCode after them) and asks OpenCode to interrupt; the turn then ends with its `session.execution.interrupted`.
   * OpenCode answering that nothing runs (the prompt failed, or the turn ended meanwhile) ends it here.
   */
  async interrupt() {
    if (this.session.currentState() === "idle") return;
    this.stops++;
    this.setRetry(undefined);
    this.session.interruptPending();
    if (!this.turnPosted) return this.endStopped();
    if (this.posting.size) await Promise.race([Promise.allSettled([...this.posting]), new Promise((r) => setTimeout(r, POSTING_WAIT_MS))]);
    const client = await this.server.client();
    const r = await client.session.interrupt({ sessionID: this.id }).catch((err) => {
      this.notice(`stop_failed:${ascending("msg")}`, `Could not stop the turn in OpenCode: ${(err as Error).message}`);
      return undefined;
    });
    // Accepted: the turn ends with its `session.execution.interrupted`; should the event be lost (a stream drop), the resync after the reconnect ends it.
    if (r?.interrupted === false) return this.endStopped();
  }

  /** One event of the server for this session. */
  event(type: string, d: Json) {
    switch (type) {
      case "session.execution.started":
        if (this.session.currentState() === "idle") (this.beginTurn(), this.session.setState("running"));
        return;
      case "session.execution.succeeded":
        return this.finish();
      case "session.execution.failed":
        this.failed = true;
        this.showError(d.error);
        return this.finish();
      case "session.execution.interrupted":
        return this.session.currentState() === "idle" ? undefined : this.interrupted();
      case "session.step.started":
        this.turnAssistant = d.assistantMessageID;
        this.stepModel = d.model;
        return this.setRetry(undefined);
      case "session.step.ended":
        this.mapper.step(d.assistantMessageID, d.tokens, d.cost);
        if (d.tokens && this.stepModel) this.usage = { tokens: d.tokens, providerID: this.stepModel.providerID, id: this.stepModel.id };
        return;
      case "session.step.failed":
        // Interrupted steps are the Stop's: `execution.interrupted` shows it.
        if (d.error?.type === "aborted") return;
        this.failed = true;
        return this.showError(d.error);
      case "session.retry.scheduled":
        return this.setRetry({ attempt: d.attempt ?? 1, message: failureText(d.error), ...(typeof d.at === "number" && { next: d.at }) });
      case "session.inbox.enqueued":
        return this.emitAll(this.mapper.inbox(d));
      case "permission.asked":
        return this.askPermission(d);
      case "permission.replied":
        // Settled in OpenCode's own UI: our reply was settled before this event.
        return this.session.pendingRequest(d.requestID) ? this.session.cancel(d.requestID, ANSWERED) : undefined;
      case "session.renamed":
        return typeof d.title === "string" ? this.engine.onTitle?.(this.id, d.title) : undefined;
      default:
        return this.emitAll(this.mapper.event(type, d));
    }
  }

  private interrupted() {
    if (!this.aborted) this.session.emit({ type: "turn_interrupted", id: `interrupted:${ascending("msg")}` });
    this.aborted = true;
    this.finish();
  }

  /** One warning per failure of the turn, in its own place: the id is the turn's assistant message (the history shows the same one after a restore), else the turn's. */
  private showError(error: Failure | undefined) {
    const text = failureText(error);
    if (this.errorKeys.has(text)) return;
    this.errorKeys.add(text);
    this.session.emit({ type: "notice", id: `error:${this.turnAssistant ?? this.turnKey}`, level: "warning", text });
  }
  private emitAll(parts: ReturnType<OpenCode2Mapper["event"]>) {
    for (const part of parts) this.session.emit(part);
  }

  private askPermission(e: Json) {
    if (this.session.pendingRequest(e.id) || this.reqs.has(e.id)) return;
    const callId: string | undefined = e.source?.type === "tool" ? e.source.id : undefined;
    const call = callId ? this.mapper.call(callId) : undefined;
    const mapped = call?.type === "tool_call" ? call : undefined;
    const resources: string[] = e.resources ?? [];
    // The ask can come before the call has its input: the permission's own data then names the command (shell: the resource).
    const fallback = mapTool2(e.action, e.action === "shell" ? { command: resources[0] ?? "" } : {});
    const tool = mapped?.tool ?? fallback.tool;
    const input: Record<string, unknown> = mapped && Object.keys(mapped.input as object).length ? (mapped.input as Record<string, unknown>) : { ...(!mapped && { patterns: resources }), ...fallback.input };
    // OpenCode saves the "always" patterns itself (per project).
    const suggestions: PermissionUpdate[] = e.save?.length ? [{ type: "addRules", rules: (e.save as string[]).map((ruleContent) => ({ toolName: tool, ruleContent })), behavior: "allow", destination: "session" }] : [];
    this.reqs.set(e.id, { callId, sessionID: e.sessionID });
    this.session.request({
      part: { type: "permission_request", id: e.id, requestId: e.id, toolUseId: callId ?? e.id, tool, input, ...(!mapped && { title: `OpenCode asks to use ${e.action}: ${resources.join(", ")}` }), noEdit: true as const, suggestions, settled: false, at: Date.now() },
      reply: (r) => this.answer(e.id, r),
    });
  }

  private answer(id: string, r: Reply) {
    const req = this.reqs.get(id);
    this.reqs.delete(id);
    if (!req) return;
    const send = (decision: "once" | "always" | "reject", message?: string) =>
      void this.server
        .client()
        .then((c) => c.permission.reply({ sessionID: req.sessionID, requestID: id, decision, ...(message && { message }) }))
        .catch((err) => this.notice(`answer_failed:${ascending("msg")}`, `Could not answer OpenCode: ${(err as Error).message}`));
    switch (r.kind) {
      case "allow":
        return send(r.decision === "allow" ? "once" : "always");
      case "deny":
      case "interrupt": {
        const card = req.callId && this.mapper.deny(req.callId);
        if (card) this.session.emit(card);
        return send("reject", r.kind === "deny" ? r.message : undefined);
      }
      case "cancel":
        if (r.message !== ANSWERED) send("reject");
    }
  }

  async inlineTask(): Promise<never> {
    throw notYet("inline tasks");
  }
  bash(_command: string): void {
    throw notYet("bash mode");
  }
  previewRewind = async (): Promise<never> => {
    throw notYet("rewind");
  };
  rewind = async (): Promise<never> => {
    throw notYet("rewind");
  };
  subscribed() {}
  beforeStateEvent() {}
  idle() {}
  bashCwdPinned = () => false;
  stopSubagent = async () => false;
  backgroundShell = async () => false;
  stopShell = async () => false;
  shellOutput = async () => undefined;
  sync = async () => {};
  close = async () => {
    this.engine.remove(this);
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

class OpenCode2EngineImpl implements Engine {
  readonly name = "opencode" as const;
  readonly capabilities = OPENCODE2_CAPABILITIES;
  private readonly sessions = new Map<string, OpenCode2Session>();
  private unsubscribe: (() => void) | undefined;
  private readonly modelLists = new Map<string, Promise<Models>>();

  constructor(
    readonly server: OpenCodeServer,
    readonly onTitle?: (id: string, title: string) => void,
    /** Writes the adapter record of a session (ADR 0015); throws when it cannot be saved. */
    readonly record: (id: string) => void = () => {},
  ) {}

  permissionModes = (o: { allowBypass?: boolean; supportsAuto?: boolean }) => permissionModesFor({ ...o, modes: OPENCODE_PERMISSION_MODES });

  open(session: Session, opts: SessionOpts, restored?: Restored) {
    return new OpenCode2Session(this, session, opts, restored?.history as OpenCode2History | undefined);
  }

  add(s: OpenCode2Session) {
    this.sessions.set(s.id, s);
    this.owners.clear();
    this.unsubscribe ??= this.server.events(
      {
        event: (_dir, payload) => {
          const sid: unknown = payload.properties.sessionID;
          if (typeof sid !== "string") return;
          const own = this.sessions.get(sid);
          if (own) return own.event(payload.type, payload.properties);
          // A subagent's session: only its permission requests are shown (the user must be able to answer them, or the turn waits for ever).
          if (payload.type === "permission.asked")
            void this.ownerOf(sid).then((owner) => owner && this.sessions.get(owner)?.event(payload.type, payload.properties));
          else if (payload.type === "permission.replied")
            for (const o of this.sessions.values()) o.event(payload.type, payload.properties);
        },
        resync: () => (this.modelLists.clear(), this.sessions.forEach((o) => void o.resync())),
      },
      2,
    );
  }
  remove(s: OpenCode2Session) {
    this.sessions.delete(s.id);
    if (!this.sessions.size) (this.unsubscribe?.(), (this.unsubscribe = undefined));
  }

  /** The session of ours a session belongs to (itself, or the root of its parent chain), undefined when none is ours. Read once per session id. */
  private readonly owners = new Map<string, Promise<string | undefined>>();
  ownerOf = (sid: string): Promise<string | undefined> => this.find(sid).catch(() => undefined);
  /** Rejects when a read failed (nothing is kept for it: the next request asks again); an answer, "not ours" included, is kept until a session is added. */
  private find(sid: string): Promise<string | undefined> {
    if (this.sessions.has(sid)) return Promise.resolve(sid);
    let hit = this.owners.get(sid);
    if (!hit) {
      const mine: Promise<string | undefined> = (hit = this.server
        .client()
        .then((c) => c.session.get({ sessionID: sid }))
        .then((row) => (row.parentID ? this.find(row.parentID) : undefined)));
      this.owners.set(sid, mine);
      mine.catch(() => this.owners.get(sid) === mine && this.owners.delete(sid));
    }
    return hit;
  }
  isOurs = async (own: string, sid: string) => sid === own || (await this.ownerOf(sid)) === own;

  /** `GET /api/model` and `GET /api/model/default` of a folder (providers and the default can differ per folder), read once per provider set. Rejects when it fails. */
  models(cwd?: string): Promise<Models> {
    const key = cwd ?? "";
    let hit = this.modelLists.get(key);
    if (!hit) {
      const location = { location: { ...(cwd && { directory: cwd }) } };
      const read = (async () => {
        const c = await this.server.client();
        const [list, def] = await Promise.all([c.model.list({ ...location, types: ["chat"] }), c.model.default(location)]);
        return { list: list.data as unknown as ModelRow[], def: (def.data ?? undefined) as unknown as ModelRow | undefined };
      })();
      this.modelLists.set(key, (hit = read));
      read.catch(() => this.modelLists.get(key) === read && this.modelLists.delete(key));
    }
    return hit;
  }
  modelInfos = async (cwd?: string) => modelsFrom(await this.models(cwd));
  async contextLimit(providerID: string, id: string, cwd?: string): Promise<number | undefined> {
    const { list, def } = await this.models(cwd);
    return [...list, ...(def ? [def] : [])].find((m) => m.providerID === providerID && m.id === id)?.limit?.context;
  }
  async defaultModel(cwd?: string): Promise<{ providerID: string; id: string } | undefined> {
    const { def } = await this.models(cwd).catch(() => ({ def: undefined }));
    return def && { providerID: def.providerID, id: def.id };
  }
  /** The effort levels of `provider/model`: its variants that are effort levels, in effort order. */
  async effortLevels(model: string, cwd?: string): Promise<EffortLevel[]> {
    const { list, def } = await this.models(cwd).catch(() => ({ list: [] as ModelRow[], def: undefined }));
    return levelsOf([...list, ...(def ? [def] : [])].find((m) => `${m.providerID}/${m.id}` === model));
  }
  dropLimits = () => this.modelLists.clear();
}

export type OpenCode2Engine = OpenCode2EngineImpl;
export const createOpenCode2Engine = (server: OpenCodeServer, o: { onTitle?: (id: string, title: string) => void; record?: (id: string) => void } = {}): OpenCode2Engine => new OpenCode2EngineImpl(server, o.onTitle, o.record);
