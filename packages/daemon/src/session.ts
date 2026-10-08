// A live session: one long-lived streaming-input query() whose SDK messages become logged events.
import { randomUUID } from "node:crypto";
import {
  query as sdkQuery,
  type CanUseTool,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKConversationResetMessage,
  type SDKMessage,
  type SDKUserMessage,
  type SessionMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import {
  bashRecords,
  createAdapter,
  imageBlock,
  MAX_FROM_PARTS,
  permissionModesFor,
  type Effort,
  type Event,
  type Part,
  type PermissionMode,
  type PermissionDecision,
  type PosPart,
  type Snapshot,
  type TimelinePage,
  type Question,
  type RewindMode,
  type RewindPreview,
  type SessionInfo,
  type SessionState,
} from "@claude-ui/protocol";
import type { PlanTracker } from "./plan-usage.ts";
import { runBash, type BashRun } from "./bash.ts";
import { PartIndex } from "./part-index.ts";
import { interleaveRuns } from "./transcript.ts";
import { tier, type Tier, type TierContext } from "./risk-tier.ts";

type Listener = (e: Event) => void;
// Claude Code's wording, so Claude reads the feedback as the user's instruction rather than as tool output.
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
// Never the user's words: coordinator text is not user intent (docs/spec.md "Permission tiers").
const COORDINATOR_DENIED = "The coordinator session denied this tool use; it was not run. Its reason:\n";
type PermissionPart = Extract<Part, { type: "permission_request" }>;
type QuestionPart = Extract<Part, { type: "question" }>;
type Answer = { decision: "allow" | "allow_always" | "deny"; ruleIndex?: number; message?: string; updatedInput?: Record<string, unknown> };

// Claude Code's sources: "local" (.claude/settings.local.json) holds the rules "don't ask again" saves.
const SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

/** `allowBypass`: daemon config enables bypassPermissions (docs/spec.md "Security"). */
/** `uploadDir`: the fs.upload folder, readable by Claude without a permission request. */
export type SessionSettings = Pick<SessionInfo, "model" | "permissionMode" | "effort">;
/**
 * `onSettings`: called after model, permission mode or effort changed (the daemon persists them for a restore). `fields`: the
 * settings this change set; none when the first query starts or a /clear heir begins (saved only if the session has no entry).
 * `onCleared`: a /clear handed the live query to `heir`, a new session (the daemon lists it).
 */
type SessionOpts = Partial<SessionSettings> & {
  allowBypass?: boolean;
  /** Whether a model value (`ModelInfo.value`) supports auto mode (`supportsAutoMode`); none = no model does. */
  supportsAuto?: (model: string) => boolean;
  uploadDir?: string;
  query?: typeof sdkQuery;
  onSettings?: (s: SessionSettings, id: string, fields: (keyof SessionSettings)[]) => void;
  onCleared?: (heir: Session) => void;
  /** The turn just ended because the plan usage limit was hit (assistant error rate_limit); `resetsAt` ms from its rejected rate_limit_event. */
  onLimitStop?: (id: string, resetsAt: number | undefined) => void;
  /** Account plan usage: told of each rate_limit_event, refreshed after each turn. */
  plan?: Pick<PlanTracker, "refresh" | "rateLimit">;
  /** Reads the session's SDK transcript: its main chain and each subagent run's messages (sync()). */
  readTranscript?: (id: string, cwd: string) => Promise<Transcript>;
  /** Whether a terminal CLI process still runs a turn of this session (its own report): the quiet time then ends no external turn. */
  cliTurnRunning?: (id: string) => boolean;
  /** MCP servers of each new query of session `id` (orchestration.ts: a coordinator's server); read at every query start. */
  mcpServers?: (id: string) => Options["mcpServers"];
  /**
   * Host policy for a tool call (orchestration.ts, by MCP server source): "allow" runs it without a permission request,
   * "no_rules" asks without "don't ask again" suggestions; none = a normal request.
   */
  /** Test seam for bash mode's shell command. */
  runBash?: typeof runBash;
  toolPolicy?: (tool: string, mcpServer?: { name: string; source: string }) => "allow" | "no_rules" | undefined;
  /** Host rewrite of a permission card (orchestration.ts worker_start): the input shown and returned on allow, and its title. */
  permissionCard?: (id: string, tool: string, input: Record<string, unknown>, mcpServer?: { name: string; source: string }) => { input: Record<string, unknown>; title?: string; onAllow?: () => void } | undefined;
};

export type Transcript = { main: SessionMessage[]; runs: SessionMessage[][] };

// ExitPlanMode comes without suggestions; Claude Code's "Yes, and auto-accept edits" (verified: the CLI then runs in acceptEdits).
const ACCEPT_EDITS: PermissionUpdate = { type: "setMode", mode: "acceptEdits", destination: "session" };
// Plain allow must name its mode too: without one the CLI restores the mode active before plan mode (acceptEdits after Shift+Tab).
const MANUAL_EDITS: PermissionUpdate = { type: "setMode", mode: "default", destination: "session" };

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
  private input = new InputQueue();
  private query?: Query;
  /** The running drive() loop; it ends after the CLI process exited. */
  private driving?: Promise<void>;
  /** The session the live query's permission requests go to: this one, until a /clear hands the query over. */
  private owner?: { session: Session };
  private model: string;
  private permissionMode: PermissionMode;
  private effort: Effort;
  private adapter: ReturnType<typeof createAdapter>;
  /** Bumped when a conversation rewind drops the query; the old drive loop then stops logging. */
  private generation = 0;
  /**
   * Checkpoints: user prompt UUID -> UUID of the last main-thread assistant message before it, which is the
   * `resumeSessionAt` fork point of a conversation rewind (undefined for the first prompt). Insertion order = prompt order.
   */
  private readonly checkpoints = new Map<string, string | undefined>();
  private lastAssistant?: string;
  /** Fork point for the next start() after a conversation rewind. */
  private resumeAt?: string;
  /** True while rewind() awaits rewindFiles(): a prompt then would run on the query the rewind closes. */
  private rewinding = false;
  /** The bash mode command that runs now (`bash()`). */
  private bashRun?: BashRun;
  /** Session-scoped grants the user gave (destination "session"): re-applied at each query start, the CLI forgets them on exit. */
  private grants: PermissionUpdate[] = [];
  /** Pending permission requests and questions by requestId (docs/spec.md "Permission bridge", "Questions"). */
  /** `ctx`: the SDK's request flags the permission tier reads (blockedPath, defaultToNo, requiresUserInteraction). */
  private readonly pending = new Map<string, { part: PermissionPart | QuestionPart; resolve: (r: PermissionResult) => void; ctx?: Omit<TierContext, "cwd">; onAllow?: () => void }>();
  /** SDK task ID of each running subagent run by its Agent call's toolUseId (task_started, a resume's too; dropped at task_notification). */
  private tasks = new Map<string, string>();
  /** Bumped per refreshUsage(): an older answer that arrives later is dropped. */
  private usageRequest = 0;
  /** False until the first start(): the first query creates the transcript (sessionId), every later one resumes it. */
  private started: boolean;
  /** Born by a /clear hand-over and not prompted yet: its title is "New session" without reading its transcript. */
  private cleared = false;
  /** Converts transcript messages (restore and sync); the live adapter converts the query's stream. */
  private readonly transcript = createAdapter();
  /** UUID of every transcript message the session logged or its own query streamed: the rest are external turns. */
  private readonly known = new Set<string>();
  /** Main-chain message UUIDs the timeline shows, in log order; a rewind cuts it. */
  private readonly timeline: string[] = [];
  /** tool_use IDs of the session's own query: their subagent runs are not external. */
  private readonly ownCalls = new Set<string>();
  /** True from a task_notification to the next result: the CLI runs a turn of its own for it, while the session is idle. */
  private cliTurn = false;
  private cliTurnTimer?: NodeJS.Timeout;
  /** A sync was asked while the session was busy: it runs at the end of the turn. */
  private syncDeferred = false;
  private syncing?: Promise<void>;
  private syncAgain = false;
  /** UUIDs of the prompts and messages of the session's own query: a transcript ending in one is no external turn. */
  private readonly own = new Set<string>();
  /** A terminal CLI turn runs (external_turn part); ends with its turn, or EXTERNAL_TURN_QUIET_MS after the last growth. */
  private externalTurn = false;
  private externalQuiet?: NodeJS.Timeout;
  /** The turn hit the plan usage limit (assistant error rate_limit) and the reset time of its rejected rate_limit_event (ms). */
  private limitHit = false;
  private limitResetsAt?: number;
  private continueAt: number | null = null;
  /** The throwaway commands query was asked (once; a failure asks again at the next subscribe). */
  private commandsAsked = false;
  /** After a failed load no new throwaway starts before this time (ms). */
  private commandsRetryAt = 0;

  constructor(
    readonly cwd: string,
    private readonly opts: SessionOpts = {},
    restored?: { id: string; history: SessionMessage[]; read?: Iterable<string> },
  ) {
    this.id = restored?.id ?? randomUUID();
    this.model = opts.model ?? "default";
    this.permissionMode = opts.permissionMode ?? "default";
    this.effort = opts.effort ?? "default";
    this.adapter = createAdapter({ resumed: !!restored });
    this.started = !!restored;
    // The CLI starts on the first prompt; until then a throwaway query lists the commands for the / menu.
    if (!restored) {
      void this.loadCommands();
      return;
    }
    // ADR 0001: after a daemon restart the SDK transcript is the history; the query resumes on the first prompt. The live query
    // shares the adapter: a task notification after the resume finds a restored run.
    // Every message read is known, also those the restore left out (pruned orphan runs): a sync must not log them after all.
    for (const u of restored.read ?? []) this.known.add(u);
    this.logTranscript(restored.history, this.adapter);
    // No query runs: a call or run without its end in the transcript (the CLI exited mid-run) is no longer running.
    for (const part of this.adapter.endCalls()) this.emit(part);
    this.setState("idle");
    void this.refreshUsage();
  }

  /**
   * Rebuilds a session from its SDK transcript (`getSessionMessages()`); a prompt resumes it with the same ID. `read`: the uuids of every
   * message read for it, logged or not (`interleaveRuns` prunes orphan runs), so a sync does not bring the left-out ones back.
   */
  static restore(id: string, cwd: string, history: SessionMessage[], opts: SessionOpts = {}, read?: Iterable<string>) {
    return new Session(cwd, opts, { id, history, read });
  }

  private start() {
    const owner = (this.owner = { session: this as Session });
    const dirs = [...(this.opts.uploadDir ? [this.opts.uploadDir] : []), ...sessionDirs(this.grants)];
    const rules = sessionRules(this.grants);
    const q = (this.query = (this.opts.query ?? sdkQuery)({
      prompt: this.input,
      options: {
        ...(this.started ? { resume: this.id } : { sessionId: this.id }),
        resumeSessionAt: this.resumeAt,
        // Checkpoints: file backups per user message, and the user message UUIDs echoed back.
        enableFileCheckpointing: true,
        cwd: this.cwd,
        additionalDirectories: dirs.length ? dirs : undefined,
        ...(rules.length && { allowedTools: rules }),
        model: this.model === "default" ? undefined : this.model,
        permissionMode: this.permissionMode,
        allowDangerouslySkipPermissions: !!this.opts.allowBypass,
        effort: this.effort === "default" ? undefined : this.effort,
        includePartialMessages: true,
        settingSources: SETTING_SOURCES,
        // Thinking text is omitted by default; summaries feed the thinking parts.
        extraArgs: { "thinking-display": "summarized", "replay-user-messages": null },
        // Subagent text and thinking too, not only its tool calls: the UI shows the nested transcript.
        forwardSubagentText: true,
        // ADR 0002: subscription login only. An inherited API key would take precedence and bill per token.
        // Todo tools are off by default on current models; TodoWrite (not the Task* tools) sends the whole list.
        // Artifact tools and skills are on in the TUI but off in SDK sessions; CLAUDE_CODE_ARTIFACT (undocumented) turns them on.
        env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_ENABLE_TASKS: "0", CLAUDE_CODE_ARTIFACT: "1", ...withoutApiKeys(process.env) },
        canUseTool: (tool, input, o) => owner.session.canUseTool(tool, input, o),
        mcpServers: this.opts.mcpServers?.(this.id),
      },
    }));
    this.resumeAt = undefined;
    // The first query creates the transcript: saved now, defaults too. A restore without an entry reads the transcript, whose
    // replies record the effort they ran with (the model's default, e.g. medium), not "default".
    if (!this.started) this.settingsChanged([]);
    this.started = true;
    this.driving = this.drive(q);
    // Later changes arrive as system/commands_changed through drive().
    q.supportedCommands().then(
      (list) => this.adapter.commands(list).forEach((p) => this.emit(p)),
      (err) => console.error(`session ${this.id}: supportedCommands failed:`, err),
    );
    return q;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      cwd: this.cwd,
      state: this.state,
      model: this.model,
      permissionMode: this.permissionMode,
      effort: this.effort,
      permissionModes: permissionModesFor({ allowBypass: this.opts.allowBypass, supportsAuto: this.opts.supportsAuto?.(this.model) }),
    };
  }

  /** Seq of the last logged event. */
  seq() {
    return this.lastSeq;
  }

  /** The paged subscribe snapshot at the current seq (synchronous: subscribe with this seq right after, no event falls between). */
  snapshot(from?: string): { seq: number; snapshot: Snapshot } {
    const page = (from !== undefined && this.index.pageFrom(from, MAX_FROM_PARTS)) || this.index.lastPage();
    const aux = page.older ? this.index.aux(page.older.pos) : [];
    return { seq: this.seq(), snapshot: { heads: this.index.heads(), attentionSeq: this.index.attentionSeq, page, aux } };
  }

  /** The page before the part `before`; undefined = unknown cursor. */
  page(before: string, until?: string): TimelinePage | undefined {
    return this.index.pageBefore(before, until);
  }

  /** Edit/Write parts older than the part `before`; undefined = unknown cursor. */
  edits(before: string): PosPart[] | undefined {
    const pos = this.index.posOf(before);
    return pos === undefined ? undefined : this.index.edits(pos);
  }

  /** Replays events with seq > sinceSeq, then follows. Returns an unsubscribe function. */
  subscribe(sinceSeq: number, listener: Listener): () => void {
    // A restored session has no query before its first prompt: its commands load when a tab first opens it (Infinity: the daemon's own observer, no tab).
    if (sinceSeq !== Infinity && !this.query) void this.loadCommands();
    for (const e of this.log) if (e.seq > sinceSeq) listener(e);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Ends the query for good and resolves once its message loop ended (the CLI process exited). The CLI writes
   * session metadata to the transcript on exit, so a transcript delete must wait for this.
   */
  async close() {
    this.bashRun?.kill();
    clearTimeout(this.externalQuiet);
    this.generation++;
    this.query?.close();
    this.query = undefined;
    // ponytail: 5 s cap in case the CLI hangs on exit; a later write then leaves a metadata-only transcript stub.
    await Promise.race([this.driving, new Promise((r) => setTimeout(r, 5000).unref())]);
  }

  /** The running query, for control requests of the config dialogs; none before the first prompt or after it ended. */
  liveQuery(): Query | undefined {
    return this.isLive() ? this.query : undefined;
  }

  /** Plugins dialog: `reloadPlugins()` on the running query (none: undefined); the new command list becomes the commands part. */
  async reloadPlugins(): Promise<number | undefined> {
    const q = this.liveQuery();
    if (!q) return undefined;
    // As the VS Code extension 2.1.283 does: get_settings first makes the CLI re-read the settings files a plugin write just
    // changed; without it the reload can miss a plugin installed a moment ago (seen with CLI 2.1.285). `getSettings` is in
    // sdk.mjs 0.3.285 but not in sdk.d.ts.
    await (q as Query & { getSettings(): Promise<unknown> }).getSettings();
    const r = await q.reloadPlugins();
    this.adapter.commands(r.commands).forEach((p) => this.emit(p));
    return r.error_count;
  }

  /** Plugins dialog "Restart": drops the running query; the next prompt resumes the transcript in a new CLI (same model, mode, effort). */
  restartQuery() {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    if (this.state !== "idle") throw new Error("session is running: interrupt the turn first");
    this.dropQuery();
  }

  /** Idle close (docs/spec.md "Idle close"): drops the live query when nothing runs or waits; the next prompt resumes. False when busy or no query. */
  releaseQuery() {
    if (!this.query || !this.isLive() || this.busy() || this.externalTurn || this.bashRun || this.syncing) return false;
    this.dropQuery();
    return true;
  }

  /** A terminal CLI turn runs in this session: a prompt now would fork the transcript (docs/spec.md "Terminal CLI and web app on one session"). */
  externalTurnRunning() {
    return this.externalTurn;
  }

  /** A /clear heir before its first prompt. */
  untitled() {
    return this.cleared;
  }

  /** False once the query ended or failed: nothing reads the input queue any more. */
  isLive() {
    return this.state !== "error" && this.state !== "closed";
  }

  bashRunning() {
    return !!this.bashRun;
  }

  /**
   * Bash mode: runs `command` in the cwd and logs a `bash` part, then appends the CLI's two records to the transcript with
   * shouldQuery: false (no turn; Claude sees them with the next prompt).
   */
  bash(command: string) {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    if (this.state !== "idle" || this.pending.size || this.rewinding || this.cliTurn || this.externalTurn) throw new Error("session is busy: wait for the turn to end");
    if (this.bashRun) throw new Error("a shell command is already running");
    const id = randomUUID();
    const outId = randomUUID();
    const generation = this.generation;
    const part = (p: Partial<Extract<Part, { type: "bash" }>>) => this.emit({ type: "bash", id, command, stdout: "", stderr: "", status: "running", ...p });
    part({});
    let last = 0;
    let shown = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: [string, string] = ["", ""];
    const flush = () => {
      timer = undefined;
      last = Date.now();
      const key = latest.join("\0");
      if (key === shown) return;
      shown = key;
      part({ stdout: latest[0], stderr: latest[1] });
    };
    const run = (this.bashRun = (this.opts.runBash ?? runBash)(command, this.cwd, (stdout, stderr) => {
      latest = [stdout, stderr];
      // At most every 500 ms, with a trailing update for the last output.
      if (!timer) timer = setTimeout(flush, Math.max(0, 500 - (Date.now() - last)));
    }));
    void run.done.then((r) => {
      clearTimeout(timer);
      this.bashRun = undefined;
      part({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, status: r.stopped ? "stopped" : r.exitCode ? "error" : "done" });
      if (!this.isLive() || generation !== this.generation) return;
      const records = bashRecords(command, r.stdout, r.stderr, r.exitCode);
      const uuids = [id, outId];
      for (const u of uuids) {
        this.known.add(u);
        this.own.add(u);
        this.timeline.push(u);
      }
      // The next prompt's rewind fork point is after the records, else rewinding it would drop them from Claude's view.
      this.lastAssistant = outId;
      if (!this.query) this.start();
      records.forEach((content, i) => this.input.push({ type: "user", uuid: uuids[i], shouldQuery: false, message: { role: "user", content }, parent_tool_use_id: null }));
    });
  }

  /** `images`: data URLs already checked with imageBlock(). */
  prompt(text: string, images: string[] = []) {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    if (this.bashRun) throw new Error("a shell command is running: stop it first");
    if (this.rewinding) throw new Error("session is rewinding");
    this.cleared = false;
    const uuid = randomUUID();
    this.known.add(uuid);
    this.own.add(uuid);
    this.timeline.push(uuid);
    this.checkpoints.set(uuid, this.lastAssistant);
    this.emit({ type: "user_text", id: uuid, text, images });
    this.setState(this.pending.size ? "needs_input" : "running");
    if (!this.query) this.start();
    const content = images.length
      ? [...(text ? [{ type: "text" as const, text }] : []), ...images.map((i) => imageBlock(i)!)]
      : text;
    this.input.push({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null });
  }

  /** Switches the live query's model; "default" resets to the SDK default. A restored session not yet resumed resumes with it. */
  async setModel(model: string) {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    await this.query?.setModel(model);
    this.model = model;
    this.emit({ type: "session_model", id: "session_model", model });
    // Auto needs a model that supports it: back to ask, as the web toast says.
    try {
      if (this.permissionMode === "auto" && !this.opts.supportsAuto?.(model)) {
        await this.query?.setPermissionMode("default");
        this.setMode("default");
      }
    } finally {
      this.settingsChanged(["model"]);
    }
    // The window size can differ per model.
    void this.refreshUsage();
  }

  /** Applies from the next turn on; before the query runs it becomes the start option. */
  async setPermissionMode(mode: PermissionMode) {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    if (!this.info().permissionModes.includes(mode)) throw new Error(`permission mode ${mode} is not enabled`);
    await this.query?.setPermissionMode(mode);
    // The user's pick is saved even when unchanged here: another daemon may have saved a different mode meanwhile.
    if (mode === this.permissionMode) this.settingsChanged(["permissionMode"]);
    else this.setMode(mode);
  }

  /** Applies from the next turn on; "default" goes back to the model's default effort. */
  async setEffort(effort: Effort) {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    await this.query?.applyFlagSettings({ effortLevel: effort === "default" ? null : effort });
    this.effort = effort;
    this.emit({ type: "session_effort", id: "session_effort", effort });
    this.settingsChanged(["effort"]);
  }

  private setMode(mode: PermissionMode) {
    if (mode === this.permissionMode) return;
    this.permissionMode = mode;
    this.emit({ type: "session_permission_mode", id: "session_permission_mode", mode });
    this.settingsChanged(["permissionMode"]);
  }

  private settingsChanged(fields: (keyof SessionSettings)[]) {
    this.opts.onSettings?.({ model: this.model, permissionMode: this.permissionMode, effort: this.effort }, this.id, fields);
  }

  /**
   * Claude Code's Esc: denies pending permission requests and cancels pending questions, then `interrupt()`. The CLI
   * ends the turn with a turn_interrupted marker and an aborted result, which returns the session to idle; the query stays live.
   */
  async interrupt() {
    if (this.bashRun) return this.bashRun.kill();
    if (!this.query || (this.state !== "running" && this.state !== "needs_input")) return;
    for (const [id, { part }] of [...this.pending]) {
      if (part.type === "question") {
        this.cancel(id, REJECTED);
        continue;
      }
      for (const p of this.adapter.deny(part.toolUseId)) this.emit(p);
      this.settle(id, { decision: "deny" }, { behavior: "deny", message: REJECTED, interrupt: true });
    }
    await this.query.interrupt();
  }

  /**
   * Stop agent: stops one subagent run (`stopTask()` of its task); the parent turn goes on with the run's error result.
   * False when no run with that Agent call ID is running in the live query.
   */
  async stopSubagent(subagentId: string): Promise<boolean> {
    const task = this.tasks.get(subagentId);
    if (!task || !this.query) return false;
    await this.query.stopTask(task);
    return true;
  }

  /** Dry run of a code rewind to before this prompt. */
  async previewRewind(userMessageId: string): Promise<RewindPreview> {
    const r = await this.control(userMessageId).rewindFiles(userMessageId, { dryRun: true });
    // canRewind false: no file checkpoint for this message, so nothing to restore.
    const files = r.canRewind ? (r.filesChanged ?? []) : [];
    return {
      filesChanged: files,
      insertions: files.length ? (r.insertions ?? 0) : 0,
      deletions: files.length ? (r.deletions ?? 0) : 0,
      conversation: this.checkpoints.get(userMessageId) !== undefined,
    };
  }

  /** Claude Code `/rewind` to before this prompt: files via `rewindFiles()`, conversation via `resumeSessionAt` on the next prompt. */
  async rewind(userMessageId: string, mode: RewindMode) {
    const q = this.control(userMessageId);
    const forkAt = this.checkpoints.get(userMessageId);
    if (mode !== "code" && forkAt === undefined) throw new Error("cannot rewind the conversation to before the first prompt");
    if (mode !== "conversation") {
      this.rewinding = true;
      try {
        const r = await q.rewindFiles(userMessageId);
        if (!r.canRewind) throw new Error(r.error ?? "cannot rewind files");
      } finally {
        this.rewinding = false;
      }
    }
    if (mode === "code") return;
    // The running CLI holds the full conversation: drop it; the next prompt resumes the transcript truncated at forkAt.
    // resumeDropsTurn is not passed: it refuses any discarded range longer than one turn (verified with SDK 0.3.285).
    this.dropQuery();
    this.resumeAt = this.lastAssistant = forkAt;
    this.cut(userMessageId);
    // The window now holds the conversation up to forkAt only.
    void this.refreshUsage();
  }

  /** Closes the live query for good; the next prompt starts a fresh one that resumes the transcript. */
  private dropQuery() {
    const hadTasks = this.tasks.size > 0;
    this.generation++;
    this.query?.close();
    this.query = undefined;
    // The old drive loop's finally skips this (newer generation): a background run of the closed query stops with it.
    this.tasks.clear();
    for (const part of this.adapter.endCalls()) this.emit(part);
    this.input = new InputQueue();
    if (hadTasks) this.setState(this.state); // clients drop `working`
  }

  /** Drops this prompt and everything after it from the timeline (a `rewind` event). */
  private cut(userMessageId: string) {
    let drop = false;
    for (const id of [...this.checkpoints.keys()]) if ((drop ||= id === userMessageId)) this.checkpoints.delete(id);
    const at = this.timeline.indexOf(userMessageId);
    if (at >= 0) this.timeline.length = at;
    this.emit({ type: "rewind", id: randomUUID(), userMessageId });
  }

  /** Logs transcript messages (main chain, then subagent runs) through the transcript adapter (restore: the live one). */
  private logTranscript(messages: SessionMessage[], adapter = this.transcript) {
    for (const m of messages) {
      this.known.add(m.uuid);
      if (!m.parent_tool_use_id) this.timeline.push(m.uuid);
      for (const part of adapter.convert(m as SDKMessage)) {
        // A subagent run's prompt is no checkpoint.
        if (part.type === "user_text" && !part.parentId) this.checkpoints.set(part.id, this.lastAssistant);
        this.emit(part);
      }
      if (m.type === "assistant" && !m.parent_tool_use_id) this.lastAssistant = m.uuid;
      // Bash mode's output record: the fork point of the next prompt (restore, sync).
      const c = (m.message as { content?: unknown } | undefined)?.content;
      if (m.type === "user" && !m.parent_tool_use_id && typeof c === "string" && c.startsWith("<bash-stdout>")) this.lastAssistant = m.uuid;
    }
  }

  /**
   * A turn runs (also one the CLI starts by itself on a task notification), input is pending or a background task (subagent
   * run, background shell) of the own query runs: an update restart waits for it (docs/spec.md "Updates").
   */
  working() {
    return this.state === "running" || this.state === "needs_input" || this.pending.size > 0 || this.tasks.size > 0 || this.cliTurn || !!this.bashRun;
  }

  /** A turn, a decision or a rewind is under way, or a subagent run of the own query still runs: a sync now would cut into it. */
  private busy() {
    return this.state !== "idle" || this.pending.size > 0 || this.rewinding || this.tasks.size > 0 || this.cliTurn;
  }

  /**
   * Appends external turns (docs/spec.md "Terminal CLI and web app on one session"): transcript messages after the last
   * one the session knows. When the timeline's last message left the main chain (a terminal CLI rewind), a `rewind` event
   * first cuts the timeline back to the common message. Found any: the live query, which misses them, is dropped. A busy
   * session syncs at the end of its turn; calls during a sync run it once more after it.
   */
  sync(): Promise<void> {
    this.syncAgain = !!this.syncing;
    return (this.syncing ??= (async () => {
      do {
        this.syncAgain = false;
        await this.syncOnce();
      } while (this.syncAgain);
    })().finally(() => (this.syncing = undefined)));
  }

  private async syncOnce() {
    if (!this.started || !this.opts.readTranscript || !this.isLive()) return;
    if (this.busy()) return void (this.syncDeferred = true);
    let t: Transcript;
    try {
      t = await this.opts.readTranscript(this.id, this.cwd);
    } catch (err) {
      return void console.error(`session ${this.id}: reading the transcript failed:`, err);
    }
    if (!this.isLive()) return;
    if (this.busy()) return void (this.syncDeferred = true);
    const chain = t.main.filter((m) => !m.parent_tool_use_id);
    // The own CLI's notice of its own background call that it only logs (queueTranscriptOnly, e.g. a run that handed its
    // report back in a message): no stream message, no turn. Own: no external turn, the live query stays.
    const notices = chain.filter((m) => !this.known.has(m.uuid) && this.ownCalls.has(noticeCall(m) ?? ""));
    for (const m of notices) this.own.add(m.uuid);
    this.logTranscript(notices, this.adapter);
    const tail = this.timeline.at(-1);
    // A daemon-run message not in the transcript (yet): the timeline forked from the transcript at the last message both have.
    const forked = tail !== undefined && !chain.some((m) => m.uuid === tail);
    const timeline = new Set(this.timeline);
    const from = forked ? lastIndex(chain, (m) => timeline.has(m.uuid)) : lastIndex(chain, (m) => this.known.has(m.uuid));
    const fresh = chain.slice(from + 1).filter((m) => !this.known.has(m.uuid));
    // A run of an external Agent call; the own query's runs stream to the session (their first prompt does not).
    const runs = t.runs
      .map((run) => (run.some((m) => m.parent_tool_use_id && this.ownCalls.has(m.parent_tool_use_id)) ? [] : run.slice(lastIndex(run, (m) => this.known.has(m.uuid)) + 1).filter((m) => !this.known.has(m.uuid))))
      .filter((run) => run.length);
    // A compaction (terminal CLI /compact or auto-compact) puts its summary before the preserved messages the session knows.
    const summaries = chain.slice(0, from + 1).filter((m) => (m as { isCompactSummary?: boolean }).isCompactSummary && !this.known.has(m.uuid));
    // External messages that open or continue a turn: a CLI turn runs. A read without new ones (a prompt's sync) only ends it.
    const last = chain.at(-1);
    const open = !!last && !this.own.has(last.uuid) && turnOpen(last);
    if (!open || fresh.length || runs.length) this.setExternalTurn(open);
    // Nothing new: e.g. the transcript lags behind the own query's last messages.
    if (!fresh.length && !runs.length && !summaries.length) return;
    if (forked && from >= 0) {
      const common = this.timeline.lastIndexOf(chain[from]!.uuid);
      const prompt = this.timeline.slice(common + 1).find((u) => this.checkpoints.has(u));
      if (prompt) this.cut(prompt);
      this.timeline.length = common + 1;
    }
    this.dropQuery();
    this.resumeAt = undefined;
    this.lastAssistant = chain[lastIndex(chain.slice(0, from + 1), (m) => m.type === "assistant")]?.uuid;
    // Chain order, as a restore shows it: the divider before the messages after it.
    this.logTranscript([...summaries, ...interleaveRuns(fresh, runs)]);
    void this.refreshUsage();
  }

  /** Shows (ms) or clears (null) the scheduled continue after a usage limit (auto-continue.ts). */
  setContinueAt(at: number | null) {
    if (at === this.continueAt) return;
    this.continueAt = at;
    this.emit({ type: "auto_continue", id: "auto_continue", at });
  }

  private setExternalTurn(running: boolean) {
    clearTimeout(this.externalQuiet);
    // A CLI that died mid-turn leaves no end in the transcript; the quiet time ends the turn unless the CLI still reports it.
    if (running) this.externalQuiet = setTimeout(() => this.setExternalTurn(!!this.opts.cliTurnRunning?.(this.id)), EXTERNAL_TURN_QUIET_MS).unref();
    if (running === this.externalTurn) return;
    this.externalTurn = running;
    this.emit({ type: "external_turn", id: "external_turn", running });
  }

  /** The query to send control requests to, started (resumed) without a prompt if none runs. */
  private control(userMessageId: string): Query {
    if (!this.isLive()) throw new Error(`session ${this.id} is not live (${this.state})`);
    if (this.rewinding) throw new Error("session is rewinding");
    if (this.bashRun) throw new Error("a shell command is running: stop it first");
    if (this.state !== "idle") throw new Error("session is running: interrupt the turn first");
    if (!this.checkpoints.has(userMessageId)) throw new Error(`unknown user message ${userMessageId}`);
    return this.query ?? this.start();
  }

  /** Rules already saved never reach this callback. No timeout: the promise waits for respond() or the SDK's abort. */
  private readonly canUseTool: CanUseTool = (tool, input, opts) => {
    const { signal, toolUseID, title: sdkTitle, mcpServer, blockedPath, defaultToNo } = opts;
    let suggestions = opts.suggestions ?? [];
    // Forwarded by sdk.mjs (0.3.285) but not declared in its CanUseTool type.
    const { requiresUserInteraction } = opts as { requiresUserInteraction?: boolean };
    const policy = this.opts.toolPolicy?.(tool, mcpServer);
    if (policy === "allow") return Promise.resolve({ behavior: "allow", updatedInput: input });
    if (policy === "no_rules") suggestions = [];
    const card = this.opts.permissionCard?.(this.id, tool, input, mcpServer);
    const title = card?.title ?? sdkTitle;
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const part: PermissionPart | QuestionPart =
        tool === "AskUserQuestion"
          ? { type: "question", id: requestId, requestId, toolUseId: toolUseID, questions: (input as { questions: Question[] }).questions, settled: false }
          : {
              type: "permission_request",
              id: requestId,
              requestId,
              toolUseId: toolUseID,
              tool,
              input: card?.input ?? input,
              ...(title ? { title } : {}),
              suggestions: tool === "ExitPlanMode" && !suggestions.length ? [ACCEPT_EDITS] : suggestions,
              settled: false,
            };
      this.pending.set(requestId, { part, resolve, ctx: { blockedPath, defaultToNo, requiresUserInteraction }, onAllow: card?.onAllow });
      this.emit(part);
      this.setState("needs_input");
      signal.addEventListener("abort", () => this.cancel(requestId, "Request cancelled"), { once: true });
    });
  };

  /** The pending permission request or question with this ID; undefined once settled or unknown. */
  pendingRequest(requestId: string): PermissionPart | QuestionPart | undefined {
    return this.pending.get(requestId)?.part;
  }

  /** The permission tier of a pending permission request, computed now (docs/spec.md "Permission tiers"); undefined for a question or unknown ID. */
  permissionTier(requestId: string): Tier | undefined {
    const req = this.pending.get(requestId);
    return req?.part.type === "permission_request" ? tier(req.part.tool, req.part.input, { cwd: this.cwd, ...req.ctx }) : undefined;
  }

  /**
   * Answers a pending permission request. False when it is already settled or unknown: the first answer wins. `by`: set only
   * by orchestration; it settles a `low` request only, allow once (no rule, no edit) or deny, with its reason in `message`.
   */
  respond(requestId: string, answer: Answer, by?: "coordinator"): boolean {
    const req = this.pending.get(requestId);
    if (req?.part.type !== "permission_request") return false;
    if (by) return this.coordinatorSettle(requestId, req.part, answer);
    const { decision, ruleIndex, message, updatedInput } = answer;
    const { input, suggestions, toolUseId } = req.part;
    const text = message?.trim();
    if (decision === "deny") {
      for (const part of this.adapter.deny(toolUseId)) this.emit(part);
      // Like Claude Code: "No" with feedback lets Claude continue with it; a bare "No" stops the turn.
      return this.settle(
        requestId,
        { decision: "deny", ...(text ? { message: text } : {}) },
        text ? { behavior: "deny", message: `${REJECTED} To tell you how to proceed, the user said:\n${text}` } : { behavior: "deny", message: REJECTED, interrupt: true },
      );
    }
    const updatedPermissions =
      req.part.tool === "ExitPlanMode"
        ? [decision === "allow_always" ? ACCEPT_EDITS : MANUAL_EDITS]
        : decision === "allow_always"
          ? ruleIndex === undefined
            ? suggestions
            : suggestions.slice(ruleIndex, ruleIndex + 1)
          : undefined;
    if (updatedPermissions) this.grants.push(...updatedPermissions.filter((u) => u.destination === "session"));
    // Edit before accept: the timeline shows what runs, not Claude's proposal.
    if (updatedInput) for (const part of this.adapter.edit(toolUseId, updatedInput)) this.emit(part);
    req.onAllow?.();
    return this.settle(
      requestId,
      { decision, ...(updatedInput ? { input: updatedInput, editedByUser: true } : {}) },
      { behavior: "allow", updatedInput: updatedInput ?? (input as Record<string, unknown>), ...(updatedPermissions ? { updatedPermissions } : {}) },
    );
  }

  /** The security boundary of worker_permission: the tier is checked here, at settle time, whatever the caller checked. */
  private coordinatorSettle(requestId: string, part: PermissionPart, { decision, ruleIndex, message, updatedInput }: Answer): boolean {
    const reason = message?.trim();
    if (!reason || (decision !== "allow" && decision !== "deny") || ruleIndex !== undefined || updatedInput !== undefined || part.escalated) return false;
    if (this.permissionTier(requestId) !== "low") return false;
    for (const p of this.adapter.byCoordinator(part.toolUseId, decision, reason)) this.emit(p);
    const done = { decision, by: "coordinator" as const, message: reason };
    if (decision === "allow") return this.settle(requestId, done, { behavior: "allow", updatedInput: part.input as Record<string, unknown> });
    for (const p of this.adapter.deny(part.toolUseId)) this.emit(p);
    // No interrupt: the worker goes on with the reason, like the user's "No" with feedback.
    return this.settle(requestId, done, { behavior: "deny", message: COORDINATOR_DENIED + reason });
  }

  /** Hands a pending request to the user (worker_escalate): re-emitted with `escalated` and `reason`. False when settled, unknown or escalated already. */
  escalate(requestId: string, reason: string): boolean {
    const req = this.pending.get(requestId);
    if (!req || req.part.escalated) return false;
    req.part = { ...req.part, escalated: true, reason };
    this.emit(req.part);
    return true;
  }

  /** Whether a pending request was escalated to the user: a coordinator must not cancel it (worker_stop). */
  hasEscalated() {
    return [...this.pending.values()].some((r) => r.part.escalated);
  }

  /** Answers a pending question (answers: question text -> answer). False when already settled or unknown: the first answer wins. `by`: set only by orchestration; an escalated question refuses it. */
  answer(requestId: string, answers: Record<string, string>, by?: "coordinator"): boolean {
    const req = this.pending.get(requestId);
    if (req?.part.type !== "question" || (by && req.part.escalated)) return false;
    // The SDK docs: updatedInput must carry the original questions next to the answers.
    return this.settle(requestId, { answers, ...(by ? { by } : {}) }, { behavior: "allow", updatedInput: { questions: req.part.questions, answers } });
  }

  /** A cancelled permission request gets decision "cancelled"; a cancelled question settles without answers. */
  private cancel(requestId: string, message: string) {
    const done = this.pending.get(requestId)?.part.type === "permission_request" ? { decision: "cancelled" as PermissionDecision } : {};
    this.settle(requestId, done, { behavior: "deny", message });
  }

  private settle(requestId: string, done: Partial<PermissionPart> | Partial<QuestionPart>, result: PermissionResult) {
    const req = this.pending.get(requestId);
    if (!req) return false;
    this.pending.delete(requestId);
    this.emit({ ...req.part, ...done, settled: true } as Part);
    if (!this.pending.size && this.state === "needs_input") this.setState("running");
    req.resolve(result);
    return true;
  }

  private async drive(q: Query) {
    // The session the query's messages belong to: a /clear hands the query to a new one.
    let s: Session = this;
    let generation = this.generation;
    // After a conversation_reset the CLI writes a new transcript, named by the session_id of its next messages (not by
    // new_conversation_id; development-docs/GH-52/probe-clear.log, CLI 2.1.285).
    let reset: SDKConversationResetMessage | undefined;
    try {
      for await (const m of q) {
        if (generation !== s.generation) return;
        if (m.type === "conversation_reset") reset = m;
        else if (reset && m.session_id && m.session_id !== s.id) {
          s = s.handOver(m.session_id, reset.user_message_uuid);
          generation = s.generation;
          reset = undefined;
        }
        s.receive(m, q);
      }
      if (generation === s.generation) s.setState("closed");
    } catch (err) {
      if (generation !== s.generation) return;
      console.error(`session ${s.id} failed:`, err);
      s.emit({ type: "raw", id: randomUUID(), message: { error: String(err) } });
      s.setState("error");
    } finally {
      // Nothing waits for these answers any more, and no call of this query runs.
      for (const id of [...s.pending.keys()]) s.cancel(id, "Session ended");
      // A newer generation (conversation rewind) already ended them, and its query may run tasks of its own.
      if (generation === s.generation) {
        s.tasks.clear();
        for (const part of s.adapter.endCalls()) s.emit(part);
      }
    }
  }

  /** One SDK message of this session's live query. */
  private receive(m: SDKMessage, q: Query) {
    if ((m.type === "user" || m.type === "assistant") && m.uuid) {
      this.known.add(m.uuid);
      this.own.add(m.uuid);
      if (!m.parent_tool_use_id && !("isReplay" in m && m.isReplay)) this.timeline.push(m.uuid);
    }
    if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use") this.ownCalls.add(b.id);
    // Echo of a prompt() message (replay-user-messages); its user_text is already logged. The CLI took it now:
    // a steering message pushed as the turn ended starts a turn of its own. Other replays (the model switch echo) start none.
    if (m.type === "user" && "isReplay" in m && m.isReplay) {
      if (this.state === "idle" && m.uuid && this.checkpoints.has(m.uuid)) this.setState("running");
      return;
    }
    if (m.type === "assistant" && !m.parent_tool_use_id) this.lastAssistant = m.uuid;
    // The CLI's own turn (answer to a task notification) starts without a prompt: its first main-chain message (a slow
    // first answer streams before the assistant message) sets running until its result.
    if ((m.type === "assistant" || m.type === "stream_event") && !m.parent_tool_use_id && this.state === "idle") {
      clearTimeout(this.cliTurnTimer);
      this.setState("running");
    }
    // A run SendMessage resumed: its task messages name the SendMessage call; the adapter knows the task's Agent call.
    if (m.type === "system" && m.subtype === "task_started") {
      const id = this.adapter.taskCall(m.task_id) ?? m.tool_use_id;
      if (id) this.tasks.set(id, m.task_id);
    }
    if (m.type === "system" && m.subtype === "task_notification") {
      const id = this.adapter.taskCall(m.task_id) ?? m.tool_use_id;
      if (id) this.tasks.delete(id);
      this.cliTurn = true;
      // Idle: `working` may end now. The CLI's own turn, if any, shows running from its first assistant message.
      if (this.state === "idle") this.setState("idle");
      // ponytail: a stopped or killed task may get no CLI turn, so no result clears cliTurn; give up after 10 s. Upgrade: clear on a CLI signal if one exists.
      clearTimeout(this.cliTurnTimer);
      this.cliTurnTimer = setTimeout(() => {
        if (this.cliTurn && this.state === "idle") {
          this.cliTurn = false;
          this.setState("idle");
        }
      }, CLI_TURN_WAIT_MS).unref();
    }
    // The CLI changes the mode itself too (plan approved, "all edits this session"); init and status carry it.
    if (m.type === "system" && (m.subtype === "init" || m.subtype === "status") && m.permissionMode) this.setMode(m.permissionMode);
    for (const part of this.adapter.convert(m)) this.emit(part);
    if (m.type === "rate_limit_event") void this.opts.plan?.rateLimit(m.rate_limit_info, q);
    if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected" && m.rate_limit_info.resetsAt) this.limitResetsAt = m.rate_limit_info.resetsAt * 1000;
    if (m.type === "assistant" && !m.parent_tool_use_id && m.error === "rate_limit") this.limitHit = true;
    if (m.type === "result") {
      this.cliTurn = false;
      this.setState("idle");
      const hit = this.limitHit, at = this.limitResetsAt;
      this.limitHit = false;
      this.limitResetsAt = undefined;
      if (hit) this.opts.onLimitStop?.(this.id, at);
      void this.opts.plan?.refresh(q);
      if (this.syncDeferred && !this.busy()) {
        this.syncDeferred = false;
        void this.sync();
      }
    }
    if (m.type === "result" || (m.type === "system" && m.subtype === "compact_boundary")) void this.refreshUsage();
  }

  /**
   * /clear (SDK conversation_reset; also plan mode exit with clear context): the CLI goes on in a new transcript `id`. A new
   * session takes over the live query, its state, model, mode and effort; this one keeps its history without the /clear prompt
   * (`clearId`; its transcript does not record it), and its next prompt resumes its own transcript in a CLI of its own.
   */
  private handOver(id: string, clearId: string | undefined): Session {
    const heir = Session.restore(id, this.cwd, [], { ...this.opts, model: this.model, permissionMode: this.permissionMode, effort: this.effort });
    heir.cleared = true;
    // Background calls (shells, subagent runs) still run in the CLI: the heir owns them (shells list, Stop agent, their
    // notification); here they end as a restore of this transcript shows them.
    for (const part of this.adapter.endCalls(true)) this.emit(part);
    for (const call of this.adapter.openCalls()) {
      heir.ownCalls.add(call.id);
      heir.emit(call);
    }
    heir.tasks = this.tasks;
    this.tasks = new Map();
    // The heir runs in the CLI that holds the grants; this session's old transcript resumes in a new CLI with them too.
    heir.grants = [...this.grants];
    // The CLI's cost total and command list carry over; this session starts over like a restored one.
    heir.adapter = this.adapter;
    this.adapter = createAdapter({ resumed: true });
    heir.query = this.query;
    heir.input = this.input;
    heir.driving = this.driving;
    heir.owner = this.owner;
    if (heir.owner) heir.owner.session = heir;
    this.query = this.driving = this.owner = undefined;
    this.input = new InputQueue();
    heir.setState(this.state);
    heir.settingsChanged([]);
    this.opts.onCleared?.(heir);
    if (clearId && this.checkpoints.has(clearId)) this.cut(clearId);
    this.emit({ type: "session_cleared", id: randomUUID(), sessionId: id });
    this.setState("idle");
    return heir;
  }

  /**
   * Logs a context_usage part from `getContextUsage()`. A session without a query (restored, or after a conversation rewind)
   * asks a throwaway query resumed on its transcript, at the rewind's fork point if any; persistSession: false, else the CLI
   * appends a cost-state line on close and the bumped mtime moves the session to the top of the list. "summary": no
   * token-count requests. A queued throwaway is dropped when the session got a real query or a newer request meanwhile.
   * A failed or timed-out read is logged; the meter keeps its last value (none for a restored session).
   */
  private async refreshUsage() {
    const request = ++this.usageRequest;
    const read = async (q: Query) => {
      const u = await q.getContextUsage({ detail: "summary" });
      if (request === this.usageRequest) this.emit({ type: "context_usage", id: "context_usage", usage: contextUsage(u) });
    };
    try {
      if (this.query) return await read(this.query);
      await queued(async () => {
        if (this.query || request !== this.usageRequest) return;
        const model = this.model === "default" ? undefined : this.model;
        // A new session before its first prompt has no transcript: the window of a fresh conversation.
        const at = this.started ? { resume: this.id, resumeSessionAt: this.resumeAt } : {};
        await withQuery(read, this.opts.query, { ...at, persistSession: false, cwd: this.cwd, model });
      });
    } catch (err) {
      console.error(`session ${this.id}: context usage failed:`, err);
    }
  }

  /** Commands and skills of a new or restored session before its first prompt (the CLI's start lists them once it runs). */
  private async loadCommands() {
    if (this.commandsAsked || Date.now() < this.commandsRetryAt) return;
    this.commandsAsked = true;
    try {
      const list = await queued(async () => (this.query ? undefined : withQuery((q) => q.supportedCommands(), this.opts.query, { cwd: this.cwd, persistSession: false })));
      if (list && !this.query) this.adapter.commands(list).forEach((p) => this.emit(p));
    } catch (err) {
      this.commandsAsked = false;
      this.commandsRetryAt = Date.now() + 60_000;
      console.error(`session ${this.id}: supportedCommands failed:`, err);
    }
  }

  private setState(state: SessionState) {
    this.state = state;
    this.emit({ type: "session_state", id: "session_state", state, ...(state === "idle" && this.working() ? { working: true as const } : {}) });
  }

  private emit(part: Part) {
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

// The CLI's echo of a model switch, with the resolved model ID in parentheses.
const SET_MODEL = /^<local-command-stdout>Set model to `.*\(([^()\s]+)\)`<\/local-command-stdout>$/s;

/** Model ID a transcript last ran on (main-thread reply) or switched to (model switch echo); undefined when it has none. */
export function transcriptModel(history: SessionMessage[]): string | undefined {
  let model: string | undefined;
  for (const m of history) {
    const { model: used, content } = m.message as { model?: unknown; content?: unknown };
    // "<synthetic>": a CLI-made reply (API error), no model ran.
    if (m.type === "assistant" && !m.parent_tool_use_id && typeof used === "string" && !used.startsWith("<")) model = used;
    if (m.type === "user" && typeof content === "string") model = SET_MODEL.exec(content)?.[1] ?? model;
  }
  return model;
}
/** How long a task notification waits for the CLI's own turn before the session stops counting one. */
export const CLI_TURN_WAIT_MS = 10_000;


/**
 * A terminal CLI turn without transcript growth for this long counts as ended (a CLI that died mid-turn writes no end), unless
 * a running CLI process reports the session busy or waiting (a long tool, a terminal permission prompt): then it is checked again.
 */
export const EXTERNAL_TURN_QUIET_MS = 120_000;

// User text that ends a turn: a local command's output, an interrupt.
const TURN_END = /^(<local-command-std(out|err)>|<bash-(input|stdout)>|\[Request interrupted by user)/;

/** A part that carries its whole state so far, so the next event of its id makes it obsolete in the log (GH-139). */
const replaceable = (p: Part) => ((p.type === "assistant_text" || p.type === "thinking") && p.streaming) || (p.type === "bash" && p.status === "running");

/** Whether a transcript's last main-chain message leaves a turn open: a prompt, a tool result, a reply calling a tool or cut mid-stream. */
function turnOpen(m: SessionMessage) {
  const { content, stop_reason } = (m.message ?? {}) as { content?: unknown; stop_reason?: unknown };
  if (m.type === "assistant") return stop_reason === "tool_use" || stop_reason == null;
  if (typeof content === "string") return !TURN_END.test(content);
  return !(Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === "text" && TURN_END.test((b as { text?: string }).text ?? "")));
}

/** Call ID (`<tool-use-id>`) of a `<task-notification>` user message; undefined for any other message. */
function noticeCall(m: SessionMessage) {
  const content = (m.message as { content?: unknown } | undefined)?.content;
  if (m.type !== "user" || typeof content !== "string" || !content.startsWith("<task-notification>")) return undefined;
  return /<tool-use-id>(.*?)<\/tool-use-id>/.exec(content)?.[1];
}

/** Index of the last message matching `pred`, -1 when none (Array#findLastIndex is ES2023). */
function lastIndex(ms: SessionMessage[], pred: (m: SessionMessage) => boolean) {
  for (let i = ms.length - 1; i >= 0; i--) if (pred(ms[i]!)) return i;
  return -1;
}

/** Tail of the daemon-wide queue of throwaway queries: one throwaway CLI at a time (a reload subscribes every restored tab at once, FIX-LEAK). */
let throwawayTail: Promise<unknown> = Promise.resolve();

/** Runs `task` in the daemon-wide throwaway queue. */
function queued<T>(task: () => Promise<T>): Promise<T> {
  const run = throwawayTail.then(task);
  throwawayTail = run.catch(() => {});
  return run;
}

const contextUsage = (u: SDKControlGetContextUsageResponse) => ({
  totalTokens: u.totalTokens,
  maxTokens: u.maxTokens,
  percentage: u.percentage,
  categories: u.categories.flatMap(({ name, tokens, kind }) => (kind === "deferred" ? [] : [{ name, tokens, kind }])),
});

/** A throwaway CLI that does not answer within this time is closed (killed) and the request fails. */
export const THROWAWAY_TIMEOUT_MS = 30_000;

/**
 * Control requests outside a live query (supportedModels(), plan usage, context usage, commands) need a query; this one
 * gets no prompt and is closed right after the answer or after THROWAWAY_TIMEOUT_MS. disableAllHooks: viewing a session
 * must not run the user's hooks (SessionStart fires on every CLI start, resume included; verified with SDK 0.3.285).
 */
export async function withQuery<T>(fn: (q: Query) => Promise<T>, query: typeof sdkQuery = sdkQuery, options: Options = {}): Promise<T> {
  const q = openQuery(query, options);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from the CLI within ${THROWAWAY_TIMEOUT_MS} ms`)), THROWAWAY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fn(q), timeout]);
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

/** A query with no prompt, for control requests only (withQuery, config queries); the caller closes it. */
export const openQuery = (query: typeof sdkQuery = sdkQuery, options: Options = {}): Query =>
  query({ prompt: new InputQueue(), options: { settingSources: SETTING_SOURCES, env: withoutApiKeys(process.env), settings: { disableAllHooks: true }, ...options } });

/** withQuery() in the daemon-wide throwaway queue. */
export const queuedQuery = <T,>(fn: (q: Query) => Promise<T>, query: typeof sdkQuery = sdkQuery, options: Options = {}): Promise<T> => queued(() => withQuery(fn, query, options));

export const listModels = (query: typeof sdkQuery = sdkQuery): Promise<ModelInfo[]> => withQuery((q) => q.supportedModels(), query);

export function withoutApiKeys(env: NodeJS.ProcessEnv) {
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  return rest;
}

/** The CLI's rule string of a rule value: `\`, `(` and `)` in the content are escaped with `\` (probed in the CLI 2.1.x binary). */
const ruleString = ({ toolName, ruleContent }: { toolName: string; ruleContent?: string }) =>
  ruleContent ? `${toolName}(${ruleContent.replace(/[\\()]/g, "\\$&")})` : toolName;

const sessionRules = (g: PermissionUpdate[]) => g.flatMap((u) => (u.type === "addRules" && u.behavior === "allow" ? u.rules.map(ruleString) : []));

const sessionDirs = (g: PermissionUpdate[]) => g.flatMap((u) => (u.type === "addDirectories" ? u.directories : []));

/** Async iterable fed by prompt(); stays open for the session lifetime (streaming input mode). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;

  push(m: SDKUserMessage) {
    this.items.push(m);
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}
