// A live session: the shared event log, state and permission bridge of one conversation. The Engine runtime behind it (claude-engine.ts) owns the agent query and its messages.
import { randomUUID } from "node:crypto";
import { artifactFileOf, type ArtifactFile } from "./artifact-preview.ts";
import {
  MAX_FROM_PARTS,
  omitMedia,
  type Effort,
  type Event,
  type Part,
  type PermissionMode,
  type PermissionDecision,
  type PosPart,
  type Snapshot,
  type TimelinePage,
  type RewindMode,
  type RewindPreview,
  type SessionInfo,
  type SessionState,
} from "@claude-ui/protocol";
import type { PlanTracker } from "./plan-usage.ts";
import type { runBash } from "./bash.ts";
import { PartIndex } from "./part-index.ts";
import type { TranscriptEnd } from "./transcript.ts";
import { tierAsync, type Tier, type TierContext } from "./risk-tier.ts";
import { claudeEngine, ClaudeSession, type Options, type Query, type QueryFn, type SessionMessage, type Transcript } from "./claude-engine.ts";
import type { Engine, EngineSession, Reply, Restored } from "./engine.ts";
import { DeniedRetryError } from "./denied-retry.ts";

// The SDK-facing code lives in claude-engine.ts; these names stay importable from here.
export { withQuery, openQuery, queuedQuery, listModels, transcriptModel, THROWAWAY_TIMEOUT_MS, CLI_TURN_WAIT_MS, EXTERNAL_TURN_QUIET_MS, STALE_TURN_MS, INTERRUPT_GRACE_MS, BASH_BACKGROUND_WAIT_MS, type Transcript } from "./claude-engine.ts";

type Listener = (e: Event) => void;
/** A coordinator settle reads the tier at most this often while the session keeps changing; then it is refused. */
const SETTLE_READS = 5;
type PermissionCard = { input: Record<string, unknown>; title?: string; onAllow?: () => void };
type PermissionPart = Extract<Part, { type: "permission_request" }>;
type QuestionPart = Extract<Part, { type: "question" }>;
type Answer = { decision: "allow" | "allow_always" | "deny"; ruleIndex?: number; message?: string; updatedInput?: Record<string, unknown> };

/** `allowBypass`: daemon config enables bypassPermissions (docs/spec.md "Security"). */
/** `uploadDir`: the folder of this session's fs.uploads by its id (created on call), readable by Claude without a permission request. */
export type SessionSettings = Pick<SessionInfo, "model" | "permissionMode" | "effort"> & { /** Engines with `agents` only. */ agent?: string };
/**
 * `onSettings`: called after model, permission mode or effort changed (the daemon persists them for a restore). `fields`: the
 * settings this change set; none when the first query starts or a /clear heir begins (saved only if the session has no entry).
 * `onCleared`: a /clear handed the live query of `from` (the session that was cleared) to `heir`, a new session (the daemon lists it).
 */
export type SessionOpts = Partial<Omit<SessionSettings, "agent">> & {
  /** The Engine the session runs on; default: the Claude Engine. */
  engine?: Engine;
  allowBypass?: boolean;
  /** Whether a model value (`ModelInfo.value`) supports auto mode (`supportsAutoMode`); none = no model does. */
  supportsAuto?: (model: string) => boolean;
  uploadDir?: (id: string) => string | undefined;
  query?: QueryFn;
  onSettings?: (s: SessionSettings, id: string, fields: (keyof SessionSettings)[]) => void;
  onCleared?: (heir: Session, from: Session) => void;
  /** A CLI process started or was dropped (worker_close, Plugins Restart, idle close, rewind): the session's `live` changed, the daemon re-lists it. */
  onLiveChange?: (id: string) => void;
  /** An Edit or Write of the agent replaced an existing file: `original` is the text it had before (Local history, GH-565). A new file (originalFile null) calls nothing. */
  onFileEdit?: (path: string, original: string) => void;
  /** The turn just ended because the plan usage limit was hit (assistant error rate_limit); `resetsAt` ms from its rejected rate_limit_event. */
  onLimitStop?: (id: string, resetsAt: number | undefined) => void;
  /** Asks the CLI for a predicted next prompt after each turn (Settings › Focus › Next for you); read when the CLI starts. */
  promptSuggestions?: () => boolean;
  /** Claude in Chrome setting (GH-514); read at every query start. Workers never get it. */
  chrome?: () => boolean;
  /** The visualize plugin folder to load into the CLI (GH-690), or undefined while the setting is off; read at every query start. */
  visualizePlugin?: () => string | undefined;
  /** Account plan usage: told of each rate_limit_event, refreshed after each turn. */
  plan?: Pick<PlanTracker, "refresh" | "rateLimit">;
  /** Reads the session's SDK transcript: its main chain and each subagent run's messages (sync()). */
  readTranscript?: (id: string, cwd: string) => Promise<Transcript>;
  /** Whether a terminal CLI process still runs a turn of this session (its own report): the quiet time then ends no external turn. */
  cliTurnRunning?: (id: string) => boolean;
  /** The folders the CLI keeps plan files in for a session in `cwd` (plan-dirs.ts); absent: `.claude/plans`. */
  planDirs?: (cwd: string) => string[];
  /** The transcript's size and last main-chain record, read cheaply for the stale-turn check (GH-239). */
  transcriptEnd?: (id: string, cwd: string) => Promise<TranscriptEnd>;
  /** MCP servers of each new query of session `id` (orchestration.ts: a coordinator's server); read at every query start. */
  mcpServers?: (id: string) => Options["mcpServers"];
  /** Tools removed from session `id`'s CLI (Aside: no edits while read-only, no orchestration tools); read at every query start. */
  disallowedTools?: (id: string) => string[] | undefined;
  /** Agent type the main thread of session `id` runs as (from the worker link); read at every query start. */
  agent?: (id: string) => string | undefined;
  /**
   * Host policy for a tool call (orchestration.ts, by MCP server source): "allow" runs it without a permission request,
   * "no_rules" asks without "don't ask again" suggestions; none = a normal request.
   */
  /** Test seam for bash mode's shell command. */
  runBash?: typeof runBash;
  toolPolicy?: (tool: string, mcpServer?: { name: string; source: string }) => "allow" | "no_rules" | undefined;
  /** Host rewrite of a permission card (orchestration.ts worker_start): the input shown and returned on allow, and its title. */
  /** Test seam for the permission tier (risk-tier.ts tierAsync). */
  tier?: typeof tierAsync;
  /** Whether the session is a worker (linked to a coordinator): its CLI runs with the shell cwd pinned, which lets read-only git be `low` (risk-tier.ts). */
  worker?: (id: string) => boolean;
  /** The message when a tool call is refused before any card (orchestration.ts preflight); the call then runs and the tool returns its own error. */
  preflight?: (id: string, tool: string, input: Record<string, unknown>, mcpServer?: { name: string; source: string }) => string | undefined;
  permissionCard?: (id: string, tool: string, input: Record<string, unknown>, mcpServer?: { name: string; source: string }) => PermissionCard | Promise<PermissionCard | undefined> | undefined;
};

export class Session {
  readonly id: string;
  readonly createdAt = Date.now();
  private state: SessionState = "idle";
  // ponytail: in-memory log grows with the session's distinct parts (a streaming update replaces the previous one, GH-139); trim when memory matters.
  private readonly log: Event[] = [];
  private readonly index = new PartIndex();
  /** Seq of the last emitted event; the log has gaps where a replaceable event was replaced. */
  private lastSeq = 0;
  /** Per part id with a replaceable latest event: that event, or "first" while it is the id's first event (kept: its timeline position). */
  private readonly latest = new Map<string, Event | "first">();
  private readonly listeners = new Set<Listener>();
  /**
   * Pending permission requests and questions by requestId (docs/spec.md "Permission bridge", "Questions"). `reply`: the Engine's
   * half of the answer. `ctx`: the Engine's request flags the permission tier reads (blockedPath, defaultToNo, requiresUserInteraction).
   */
  private readonly pending = new Map<
    string,
    { part: PermissionPart | QuestionPart; reply: (r: Reply) => void; ctx?: Omit<TierContext, "cwd">; onAllow?: () => void; tier?: { epoch: number; value: Promise<Tier> } }
  >();
  /**
   * Bumped by whatever may change files in the cwd: an allowed request, a tool call or bash command that ended. A request's tier
   * read before the last bump is stale and read again (permissionTier).
   */
  private epoch = 0;
  /** When the epoch last moved (performance.now()): a repository scan started before it is not shared (repoSafetyAsync). */
  private epochAt = performance.now();
  /** Coordinator settles of this session, one at a time (coordinatorRespond). */
  private settling: Promise<unknown> = Promise.resolve();
  private continueAt: number | null = null;
  private limitStopped = false;
  /** A prompt suggestion is shown (set by the Engine when it emits one). */
  suggested = false;
  /**
   * Whose upload folder the running CLI was started with (`uploadDir(uploadOwner)`). A /clear heir keeps its parent's until
   * its CLI closes (`dropQuery`: idle close, restart, rewind) and a query of its own starts: the CLI cannot get another directory, so uploads go where it already reads.
   */
  uploadOwner: string;

  /** The Engine runtime of this session (engine use). */
  readonly run: EngineSession;
  private readonly engine: Engine;

  constructor(
    readonly cwd: string,
    private readonly opts: SessionOpts = {},
    /** Without `history`: a new session with a given id (a claimed draft, see uploads.ts). */
    restored?: Restored & { history?: SessionMessage[] },
  ) {
    this.id = restored?.id ?? randomUUID();
    this.uploadOwner = this.id;
    this.engine = opts.engine ?? claudeEngine;
    this.run = this.engine.open(this, opts, restored);
    this.run.begin();
  }

  /**
   * Rebuilds a session from its SDK transcript (`getSessionMessages()`); a prompt resumes it with the same ID. `read`: the uuids of every
   * message read for it, logged or not (`interleaveRuns` prunes orphan runs), so a sync does not bring the left-out ones back.
   */
  static restore(id: string, cwd: string, history: SessionMessage[], opts: SessionOpts = {}, read?: Iterable<string>) {
    return new Session(cwd, opts, { id, history, read });
  }

  /** The new session of a /clear (engine use): same cwd and options, the settings of the cleared one. */
  heir(id: string, settings: Omit<SessionSettings, "agent">) {
    return Session.restore(id, this.cwd, [], { ...this.opts, ...settings });
  }

  info(): SessionInfo {
    const { model, permissionMode, effort, agent } = this.run.settings();
    return {
      id: this.id,
      cwd: this.cwd,
      state: this.state,
      model,
      permissionMode,
      effort,
      ...(agent !== undefined && { agent }),
      permissionModes: this.engine.permissionModes({ allowBypass: this.opts.allowBypass, supportsAuto: this.opts.supportsAuto?.(model) }),
      capabilities: this.engine.capabilities,
      engine: this.engine.name,
    };
  }

  /** Seq of the last logged event. */
  seq() {
    return this.lastSeq;
  }

  /** The paged subscribe snapshot at the current seq (synchronous: subscribe with this seq right after, no event falls between). */
  snapshot(from?: string): { seq: number; snapshot: Snapshot } {
    const page = (from !== undefined && this.index.pageFrom(from, MAX_FROM_PARTS)) || this.index.lastPage();
    const aux = page.older ? this.index.aux(page.older.pos, this.planDirs()) : [];
    return { seq: this.seq(), snapshot: { heads: this.index.heads(), attentionSeq: this.index.attentionSeq, page: { ...page, parts: page.parts.map(omitMedia) }, aux } };
  }

  /** The page before the part `before`; undefined = unknown cursor. */
  page(before: string, until?: string): TimelinePage | undefined {
    const page = this.index.pageBefore(before, until);
    return page && { ...page, parts: page.parts.map(omitMedia) };
  }

  /** Data URL of a base64 payload a snapshot or page left out (`session.media`); undefined when the part or payload is unknown. */
  media(partId: string, index: number): string | undefined {
    const part = this.index.get(partId);
    if (part?.type === "user_text") {
      const image = part.images[index];
      return image?.startsWith("data:") ? image : undefined;
    }
    if (part?.type === "tool_result" && Array.isArray(part.output)) {
      const src = (part.output[index] as { source?: { type?: unknown; media_type?: unknown; data?: unknown } } | undefined)?.source;
      return src?.type === "base64" && typeof src.data === "string" ? `data:${String(src.media_type)};base64,${src.data}` : undefined;
    }
    return undefined;
  }

  /** The file an Artifact publish part of this session names (artifact.preview, GH-175). */
  artifactFile(partId: string): ArtifactFile {
    return artifactFileOf(this.index.get(partId), this.cwd);
  }

  /** Edit/Write parts older than the part `before`; undefined = unknown cursor. */
  edits(before: string): PosPart[] | undefined {
    const pos = this.index.posOf(before);
    return pos === undefined ? undefined : this.index.edits(pos);
  }

  /** Done Artifact publish parts older than the part `before`; undefined = unknown cursor (GH-176). */
  artifacts(before: string): PosPart[] | undefined {
    const pos = this.index.posOf(before);
    return pos === undefined ? undefined : this.index.artifacts(pos);
  }

  /** Replays events with seq > sinceSeq, then follows. Returns an unsubscribe function. */
  subscribe(sinceSeq: number, listener: Listener): () => void {
    this.run.subscribed(sinceSeq);
    for (const e of this.log) if (e.seq > sinceSeq) listener(e);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }


  // The Engine runtime does these (same signatures, same docs: see claude-engine.ts).
  close() {
    return this.run.close();
  }
  activity() {
    return this.run.activity();
  }
  /** Whether the Engine's runtime process runs. */
  live(): boolean {
    return this.run.live();
  }
  /** The running Claude query, for the config dialogs; none for another Engine or before the first prompt. */
  claudeQuery(): Query | undefined {
    return this.run instanceof ClaudeSession ? this.run.liveQuery() : undefined;
  }
  reloadPlugins() {
    return this.run.reloadPlugins();
  }
  restartQuery() {
    return this.run.restartQuery();
  }
  releaseQuery() {
    return this.run.releaseQuery();
  }
  externalTurnRunning() {
    return this.run.externalTurnRunning();
  }
  untitled() {
    return this.run.untitled();
  }
  bashRunning() {
    return this.run.bashRunning();
  }
  bash(command: string) {
    return this.run.bash(command);
  }
  prompt(text: string, images: string[] = []) {
    return this.run.prompt(text, images);
  }
  setModel(model: string) {
    return this.run.setModel(model);
  }
  setPermissionMode(mode: PermissionMode) {
    return this.run.setPermissionMode(mode);
  }
  refreshAgents() {
    return this.run.refreshAgents?.();
  }
  setAgent(agent: string) {
    if (!this.run.setAgent) throw new Error("this session's engine has no agents");
    return this.run.setAgent(agent);
  }
  setEffort(effort: Effort) {
    return this.run.setEffort(effort);
  }
  interrupt() {
    return this.run.interrupt();
  }
  stopSubagent(callId: string) {
    return this.run.stopSubagent(callId);
  }
  /** Allow and retry (GH-711); `unsupported` without the Engine's support (OpenCode). */
  allowDenied(toolUseId: string) {
    if (!this.run.allowDenied) throw new DeniedRetryError("unsupported", "this session's engine has no auto mode");
    return this.run.allowDenied(toolUseId);
  }
  /** Always allow (GH-756); `unsupported` without the Engine's support (OpenCode). */
  alwaysAllowDenied(toolUseId: string, scope: "session" | "local") {
    if (!this.run.alwaysAllowDenied) throw new DeniedRetryError("unsupported", "this session's engine has no auto mode");
    return this.run.alwaysAllowDenied(toolUseId, scope);
  }
  backgroundShell(toolUseId: string) {
    return this.run.backgroundShell(toolUseId);
  }
  stopShell(id: string) {
    return this.run.stopShell(id);
  }
  shellOutput(toolUseId: string) {
    return this.run.shellOutput(toolUseId);
  }
  previewRewind(userMessageId: string): Promise<RewindPreview> {
    return this.run.previewRewind(userMessageId);
  }
  rewind(userMessageId: string, mode: RewindMode) {
    return this.run.rewind(userMessageId, mode);
  }
  sync() {
    return this.run.sync();
  }
  /** The turn that runs is a keep-warm tick (set by the orchestration): its idle carries `keepWarm`, once. */
  keepWarmTurn = false;
  working() {
    return this.run.working();
  }
  takesQueued() {
    return this.run.takesQueued();
  }
  /** The Claude login or account changed: the live CLI is replaced at the end of the running turn. */
  get staleLogin() {
    return this.run.staleLogin;
  }
  set staleLogin(v: boolean) {
    this.run.staleLogin = v;
  }

  /** False once the query ended or failed: nothing reads the input queue any more. */
  isLive() {
    return this.state !== "error" && this.state !== "closed";
  }


  /** Shows (ms) or clears (null) the scheduled continue after a usage limit (auto-continue.ts). */
  setContinueAt(at: number | null) {
    if (at === this.continueAt) return;
    this.continueAt = at;
    this.emit({ type: "auto_continue", id: "auto_continue", at });
  }

  /** Settings › Focus › Next for you was turned off: the shown suggestion goes. */
  clearSuggestion() {
    if (!this.suggested) return;
    this.suggested = false;
    this.emit({ type: "prompt_suggestion", id: "prompt_suggestion", text: null });
  }

  /** The turn ended at the usage limit (`resetsAt` ms when known): the Focus page's limit row, also with auto-continue off. Cleared when the next turn starts. */
  setLimitStop(resetsAt: number | undefined) {
    this.limitStopped = true;
    this.emit({ type: "limit_stop", id: "limit_stop", stopped: true, ...(resetsAt && { resetsAt }) });
  }

  /** The last turn ended at the usage limit and no turn has started since. */
  get limitStop() {
    return this.limitStopped;
  }

  /** Shows the queued messages and why they are paused (prompt-queue.ts). */
  setQueue(items: { id: string; text: string; images: string[]; bash?: true; brief?: string; error?: string }[], held: { reason: "usage_limit" | "not_live"; until?: number } | undefined) {
    const next = { items: items.map((i) => ({ id: i.id, text: i.text, imageCount: i.images.length, ...(i.bash && { bash: true as const }), ...(i.brief && { brief: true as const }), ...(i.error && { error: i.error }) })), ...(held && { held }) };
    if (JSON.stringify(next) === JSON.stringify(this.queueShown)) return;
    this.queueShown = next;
    this.emit({ type: "prompt_queue", id: "prompt_queue", ...next });
  }
  private queueShown: { items: unknown[]; held?: unknown } = { items: [] };

  // Engine use: what the runtime needs of the shared half.
  currentState() {
    return this.state;
  }

  pendingCount() {
    return this.pending.size;
  }

  /** The plan of an ExitPlanMode call, folded from the plan files of this session's folders. */
  planOf(toolUseId: string) {
    return this.index.planOf(toolUseId, this.planDirs());
  }

  /** The runtime asks the user: the request waits in `pending` until respond, answer, coordinatorSettle or cancel settles it through `reply`. */
  request(e: { part: PermissionPart | QuestionPart; ctx?: Omit<TierContext, "cwd">; onAllow?: () => void; reply: (r: Reply) => void }) {
    this.pending.set(e.part.requestId, { part: e.part, reply: e.reply, ctx: e.ctx, onAllow: e.onAllow });
    this.emit(e.part);
    this.setState("needs_input");
    if (e.part.type === "permission_request") this.markLowTier(e.part.requestId);
  }

  /** Stop (Esc): denies pending permission requests and cancels pending questions. */
  interruptPending() {
    for (const [id, { part, reply }] of [...this.pending]) {
      reply({ kind: "interrupt" });
      this.settle(id, part.type === "question" ? {} : { decision: "deny" }, false);
    }
  }

  /** A cancelled permission request gets decision "cancelled"; a cancelled question settles without answers. */
  cancel(requestId: string, message: string) {
    const req = this.pending.get(requestId);
    if (!req) return;
    req.reply({ kind: "cancel", message });
    this.settle(requestId, req.part.type === "permission_request" ? { decision: "cancelled" as PermissionDecision } : {}, false);
  }

  cancelAll(message: string) {
    for (const id of [...this.pending.keys()]) this.cancel(id, message);
  }

  /** The plan folders of this session's CLI. */
  planDirs(): string[] | undefined {
    return this.opts.planDirs?.(this.cwd);
  }

  /** A low tier request is sent again with `tier: "low"` once its tier is read (the Focus page offers Always allow only then); high or unknown stays unmarked. A later read that says otherwise sends it again without the mark. */
  private markLowTier(requestId: string) {
    void this.permissionTier(requestId).then((tier) => {
      const req = this.pending.get(requestId);
      if (req?.part.type !== "permission_request" || (tier === "low") === (req.part.tier === "low")) return;
      const { tier: _, ...rest } = req.part;
      req.part = tier === "low" ? { ...rest, tier } : rest;
      this.emit(req.part);
    });
  }

  /** The pending permission request or question with this ID; undefined once settled or unknown. */
  pendingRequest(requestId: string): PermissionPart | QuestionPart | undefined {
    return this.pending.get(requestId)?.part;
  }

  /** The Engine's request flags of a pending request (blockedPath, decisionReason ...); undefined once settled or unknown. */
  pendingContext(requestId: string): Omit<TierContext, "cwd"> | undefined {
    return this.pending.get(requestId)?.ctx;
  }

  /**
   * The permission tier of a pending permission request (docs/spec.md "Permission tiers"); undefined for a question or unknown ID.
   * Read once per request off the event loop (tierAsync: git runs as a child process) and reused for the permission event, the
   * coordinator's check and the settle-time check, until the session's epoch moves (an allow, a tool that ended): then read again.
   */
  permissionTier(requestId: string): Promise<Tier | undefined> {
    const req = this.pending.get(requestId);
    if (req?.part.type !== "permission_request") return Promise.resolve(undefined);
    if (req.tier?.epoch !== this.epoch) {
      const again = !!req.tier;
      req.tier = { epoch: this.epoch, value: this.readTier(req.part, req.ctx, this.epochAt) };
      // A re-read can change what the Focus page was told.
      if (again) this.markLowTier(requestId);
    }
    return req.tier.value;
  }

  /** One read of a request's tier off the event loop; `since`: share no repository scan that started before it. Any error is high. */
  private readTier(part: PermissionPart, ctx: Omit<TierContext, "cwd"> | undefined, since: number): Promise<Tier> {
    const read = this.opts.tier ?? tierAsync;
    return Promise.resolve()
      .then(() => read(part.tool, part.input, { cwd: this.cwd, bashCwdPinned: this.run.bashCwdPinned(), since, ...ctx }))
      .catch(() => "high" as const);
  }

  /**
   * Answers a pending permission request. False when it is already settled or unknown: the first answer wins. `by`: set only
   * by orchestration; it settles a `low` request only, allow once (no rule, no edit) or deny, with its reason in `message`.
   */
  respond(requestId: string, answer: Answer): boolean {
    const req = this.pending.get(requestId);
    if (req?.part.type !== "permission_request") return false;
    const { decision, ruleIndex, message, updatedInput } = answer;
    const text = message?.trim();
    if (decision === "deny") {
      req.reply({ kind: "deny", ...(text ? { message: text } : {}) });
      return this.settle(requestId, { decision: "deny", ...(text ? { message: text } : {}) }, false);
    }
    req.reply({ kind: "allow", decision, ruleIndex, updatedInput });
    req.onAllow?.();
    return this.settle(requestId, { decision, ...(updatedInput ? { input: updatedInput, editedByUser: true } : {}) }, true);
  }

  /**
   * The security boundary of worker_permission: the tier is checked here, at settle time, whatever the caller checked. False:
   * refused or answered meanwhile, nothing settles. Atomic per request and serial per session: settles of one worker run one at
   * a time, and after the tier is read the request is looked up again and settled in the same synchronous step (no await
   * between). The worker's CLI is blocked on this request, so the worker itself writes nothing while it is decided; another
   * request of the same worker (parallel tool use) is decided only after this one settled, with its tier read again when this
   * allow moved the epoch. The settle reads the tier afresh (no cached read, no scan shared from before it started) and reads
   * again while the epoch moved during the read, at most SETTLE_READS times.
   */
  coordinatorRespond(requestId: string, answer: Answer): Promise<boolean> {
    const run = this.settling.then(async () => {
      // A fresh read, never the cached one: a change from outside this session (a terminal, another session, global config)
      // moves no epoch. Read again while the epoch moved during the read (an allow or a tool end landed meanwhile).
      for (let tries = 0; ; tries++) {
        const req = this.pending.get(requestId);
        if (!req || req.part.type !== "permission_request" || !this.coordinatorAnswerOk(requestId, answer) || tries >= SETTLE_READS) return false;
        const epoch = this.epoch;
        const t = await this.readTier(req.part, req.ctx, performance.now());
        if (this.epoch !== epoch) continue;
        const part = this.pending.get(requestId)?.part;
        if (t !== "low" || part?.type !== "permission_request" || !this.coordinatorAnswerOk(requestId, answer)) return false;
        return this.coordinatorSettle(requestId, part, answer);
      }
    });
    this.settling = run.catch(() => undefined);
    return run;
  }

  private coordinatorAnswerOk(requestId: string, { decision, ruleIndex, message, updatedInput }: Answer): boolean {
    const part = this.pending.get(requestId)?.part;
    return part?.type === "permission_request" && !!message?.trim() && (decision === "allow" || decision === "deny") && ruleIndex === undefined && updatedInput === undefined && !part.escalated;
  }

  private coordinatorSettle(requestId: string, part: PermissionPart, { decision, message }: Answer): boolean {
    const req = this.pending.get(requestId);
    if (!req) return false;
    const reason = message!.trim();
    req.reply({ kind: "coordinator", decision: decision as "allow" | "deny", message: reason });
    return this.settle(requestId, { decision, by: "coordinator" as const, message: reason }, decision === "allow");
  }

  /** Hands a pending request to the user (worker_escalate): re-emitted with `escalated` and `reason`. False when settled, unknown or escalated already. */
  escalate(requestId: string, reason: string): boolean {
    const req = this.pending.get(requestId);
    if (!req || req.part.escalated) return false;
    req.part = { ...req.part, escalated: true, reason };
    this.emit(req.part);
    return true;
  }

  /** Answers a pending question (answers: question text -> answer). False when already settled or unknown: the first answer wins. `by`: set only by orchestration; an escalated question refuses it. */
  answer(requestId: string, answers: Record<string, string>, by?: "coordinator", choices?: Record<string, string[]>): boolean {
    const req = this.pending.get(requestId);
    if (req?.part.type !== "question" || (by && req.part.escalated)) return false;
    req.reply({ kind: "answer", answers, ...(choices && { choices }) });
    return this.settle(requestId, { answers, ...(by ? { by } : {}) }, true);
  }

  /** `allowed`: the answer lets the tool run (a file may change: the tier epoch moves). The Engine's reply was sent before. */
  private settle(requestId: string, done: Partial<PermissionPart> | Partial<QuestionPart>, allowed: boolean) {
    const req = this.pending.get(requestId);
    if (!req) return false;
    this.pending.delete(requestId);
    if (allowed) this.bump();
    this.emit({ ...req.part, ...done, settled: true } as Part);
    if (!this.pending.size && this.state === "needs_input") this.setState("running");
    return true;
  }


  /** Engine use. */
  setState(state: SessionState) {
    this.state = state;
    if (state === "running" && this.limitStopped) {
      this.limitStopped = false;
      this.emit({ type: "limit_stop", id: "limit_stop", stopped: false });
    }
    if (state === "running" && this.suggested) {
      this.suggested = false;
      this.emit({ type: "prompt_suggestion", id: "prompt_suggestion", text: null });
    }
    this.run.beforeStateEvent();
    const keepWarm = state === "idle" && this.keepWarmTurn;
    if (state === "idle") this.keepWarmTurn = false;
    this.emit({ type: "session_state", id: "session_state", state, ...(state === "idle" && this.working() ? { working: true as const } : {}), ...(keepWarm ? { keepWarm: true as const } : {}) });
    if (state === "idle") this.run.idle();
  }

  private bump() {
    this.epoch++;
    this.epochAt = performance.now();
  }

  /** Engine use. */
  emit(part: Part) {
    // A tool call or bash command that ended may have changed files: pending tiers are stale.
    if ((part.type === "tool_call" || part.type === "bash") && part.status !== "running" && part.status !== "pending") this.bump();
    const seq = ++this.lastSeq;
    const pos = this.index.apply({ type: "event", sessionId: this.id, seq, part });
    const e: Event = { type: "event", sessionId: this.id, seq, ...(pos !== undefined && { pos }), part };
    // A streaming text/thinking or running bash part carries the whole state so far: the log keeps the id's first event and its latest (GH-139).
    const prev = this.latest.get(part.id);
    if (prev && prev !== "first") {
      const i = this.log.lastIndexOf(prev);
      if (i >= 0) this.log.splice(i, 1);
    }
    if (replaceable(part)) this.latest.set(part.id, prev ? e : "first");
    else this.latest.delete(part.id);
    this.log.push(e);
    for (const l of this.listeners) l(e);
  }
}

/** A part that carries its whole state so far, so the next event of its id makes it obsolete in the log (GH-139). */
const replaceable = (p: Part) => ((p.type === "assistant_text" || p.type === "thinking") && p.streaming) || (p.type === "bash" && p.status === "running");
