// The OpenCode 2 Engine (ADR 0015, docs/spec.md "OpenCode engine"): sessions run on the daemon's OpenCode 2 server through `@opencode/client`. One event stream
// (`GET /api/event`, opencode-server.ts) feeds every open session; prompts, Stop and permission replies go back as client calls.
// Has: create, list, prompt, stream, stop, permissions, models, the read-only rules of an Aside, rewind, /undo /redo /compact, bash mode, questions, agents, OpenCode's
// slash commands, inline tasks and the daemon's MCP servers (orchestration, claude-ui). No Fork runs yet.
import { randomUUID } from "node:crypto";
import type { OpenCodeClient } from "@opencode/client";
import { permissionModesFor, type Effort, type EffortLevel, type EngineCapabilities, type ModelInfo, type PermissionMode, type PermissionUpdate, type Question, type RewindMode, type RewindPreview, type SlashCommand } from "@claude-ui/protocol";
import { ASIDE_NO_EDIT } from "./aside.ts";
import { DAEMON_SERVER, ToolError } from "./daemon-mcp.ts";
import { DeniedRetryError } from "./denied-retry.ts";
import type { Engine, EngineSession, Reply, Restored } from "./engine.ts";
import { INLINE_TIMEOUT_MS, type ForkResult, type InlineHooks, type InlineResult, type InlineSpec } from "./inline-types.ts";
import { ascending } from "./opencode-id.ts";
import { INLINE_SYSTEM, clip } from "./opencode-inline.ts";
import { DONT_ASK, LOCAL_COMMANDS, OPENCODE_CAPABILITIES, OPENCODE_PERMISSION_MODES, splitLabels, withVisualize, type OpenCodeMcpRoute } from "./opencode-engine.ts";
import { findCall, mcpKeys, mcpName, mcpTimeoutMs, showDaemonCard, WORKER_START, type McpServerKey } from "./opencode-shared.ts";
import { INLINE_META, InlineCollector2, inlineRules, storedEnd, type StoredEnd } from "./opencode2-inline.ts";
import { contentBefore, type PatchPart, type SnapshotSource } from "./opencode-snapshot.ts";
import { visualizeSystem } from "./visualize.ts";
import { OpenCode2Mapper, bashPart, failureText, mapTool2, type Failure, type OpenCode2Message, type Shell2 } from "./opencode2-parts.ts";
import type { OpenCodeServer } from "./opencode-server.ts";
import type { Session, SessionOpts, SessionSettings } from "./session.ts";

/** What the OpenCode 2 adapter has: as OpenCode 1's (`/compact`, `/undo`, `/redo` are the daemon's commands, the others OpenCode's; `fork`: the Aside). */
export const OPENCODE2_CAPABILITIES: EngineCapabilities = {
  ...OPENCODE_CAPABILITIES,
  // The config dialogs (GH-864): OpenCode 2 signs an MCP server in through its integrations, not through a route of the server, and reports a plugin's load result
  // (a row shows its error), which OpenCode 1 does not (`pluginStatus` is no gap here).
  config: (({ pluginStatus: _status, ...gaps }) => ({
    ...OPENCODE_CAPABILITIES.config!,
    gaps: { ...gaps, mcpAuth: "OpenCode 2 signs MCP servers in through its integrations. Sign in with OpenCode's own app.", pluginUpdate: "claude-ui does not update OpenCode 2 plugins. Update them in OpenCode's own app." },
  }))(OPENCODE_CAPABILITIES.config!.gaps),
};

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
  // Don't ask: the `default` asks plus a marker that matches no tool; the engine answers every ask with a reject (a deny rule would hide the tool and beat the project's saved approvals).
  if (mode === "dontAsk") return [MARK_DONT_ASK, ...modeRules("default")];
  return [rule("shell", "ask"), rule("edit", mode === "acceptEdits" ? "allow" : "ask"), rule("webfetch", "ask"), rule("websearch", "ask")];
}
/** Marks Don't ask in the session's rules (`modeOfRules` tells it from `default`); its action matches no tool. */
const MARK_DONT_ASK: Rule2 = { action: "claude-ui-mode", resource: "dontAsk", effect: "deny" };
/** Last, so it wins (OpenCode 2 applies the last matching rule): a read-only Aside changes no file. `edit` is also the action of the `write` tool (checked on 2.3.0). */
const READ_ONLY: Rule2 = rule("edit", "deny");
/** The session's own daemon MCP servers in OpenCode, when attached: `orchestration` = its orchestration server's name, `daemon` = its claude-ui server's tool rules. */
export type McpRules = { orchestration?: string; daemon?: Rule2[] };
/** Whether a rule is one of the daemon MCP servers' (every session's servers are attached to the folder; a session's rules hide the others'). */
const isDaemonMcp = (r: Rule2) => r.action.startsWith(`${DAEMON_SERVER}-`) || r.action.startsWith("orchestration-");
/**
 * The daemon MCP servers' rules (as OpenCode 1's mode block, opencode-engine.ts modeBlock): every session's claude-ui and orchestration tools hidden but the own ones;
 * the own claude-ui tools as `daemon` says, the own orchestration tools allowed, `worker_start` asking (the user's gate on new workers) except in bypass.
 */
export const mcpRules = (mode: PermissionMode, mcp: McpRules = {}): Rule2[] => [
  rule(`${DAEMON_SERVER}-*`, "deny"),
  ...(mcp.daemon ?? []),
  rule("orchestration-*", "deny"),
  ...(mcp.orchestration ? [rule(`${mcp.orchestration}_*`, "allow"), ...(mode === "bypassPermissions" ? [] : [rule(`${mcp.orchestration}_worker_start`, mode === "dontAsk" ? "deny" : "ask")])] : []),
];
/**
 * The session's rules: its mode's, the agent's denials after them (OpenCode 2 applies the session's rules after the agent's, so without them a mode's `edit ask` would
 * beat plan's `edit deny`), the daemon MCP servers' rules, and the read-only denial of an Aside. `config` has no rules of its own: the agent's apply as they are
 * (the MCP servers' too: OpenCode would allow an MCP tool by default).
 */
export const rulesOf = (mode: PermissionMode, readOnly: boolean, denials: readonly Rule2[] = [], mcp?: McpRules): Rule2[] => [...(mode === "config" ? [] : [...modeRules(mode), ...denials]), ...mcpRules(mode, mcp), ...(readOnly ? [READ_ONLY] : [])];
/** The mode whose rules a session has (its rules start with them; `config`: none or only the read-only denial, besides the MCP servers' rules), undefined for rules of another origin. */
export const modeOfRules = (rules: readonly Rule2[] | undefined): PermissionMode | undefined => {
  if ((rules ?? []).some((x) => x.action === MARK_DONT_ASK.action && x.resource === MARK_DONT_ASK.resource)) return "dontAsk";
  const r = JSON.stringify((rules ?? []).filter((x) => !isDaemonMcp(x)));
  const starts = (m: PermissionMode) => r.startsWith(JSON.stringify(modeRules(m)).slice(0, -1));
  return (["bypassPermissions", "acceptEdits", "default"] as const).find(starts) ?? ([JSON.stringify([]), JSON.stringify([READ_ONLY])].includes(r) ? "config" : undefined);
};

/** An entry of `GET /api/agent`: `id` is what a session switches to. */
export type Agent2 = { id: string; name?: string; description?: string; mode?: string; hidden?: boolean; permissions?: Rule2[] };
/** The agents a user chooses from (OpenCode's own filter): primary or all, not hidden. */
export const primaryAgents2 = (list: readonly Agent2[]) => list.filter((a) => !a.hidden && a.mode !== "subagent");
/** An agent's denials: from its first deny of an action on, every rule of that action (so the exceptions after it hold: plan's plan-file `edit` allow). */
export const denialsOf2 = (rules: readonly Rule2[]): Rule2[] => {
  const first = new Map<string, number>();
  rules.forEach((r, i) => r.effect === "deny" && !first.has(r.action) && first.set(r.action, i));
  return rules.filter((r, i) => i >= (first.get(r.action) ?? Infinity));
};
const LOCAL_NAMES = LOCAL_COMMANDS.map((c) => c.name);
/** How often, and how many times, an agent list is read again while OpenCode has not loaded the folder (2.3.0 lists no agent then). */
const AGENT_POLL_MS = 250;
const SETTLE_MS = 500;
/** The longest wait for a folder to list again after a location reload. */
const RELOAD_SETTLE_MS = 5_000;
const AGENT_POLLS = 120;
/** How long an agent list is kept; a cold folder's first list (read without an event stream) only briefly: OpenCode lists the folder's own agents after its built-ins. */
const AGENTS_MS = 60_000;
const COLD_AGENTS_MS = 5_000;
/** The longest a `/name` typed before OpenCode's command list came waits for it. */
const COMMANDS_WAIT_MS = 5_000;
/** The instruction entry that carries an inline task's system text. */
const INLINE_ENTRY = "claude-ui-inline";
/** The instruction entry that carries the visualize skill's text while the setting is on (docs/spec.md "Inline visualizations"). */
const VISUALIZE_ENTRY = "claude-ui-visualize";

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

/** What `begin()` and `resync()` read of a session: its stored messages (before a revert's cut), whether a turn runs, the permission requests and question forms of its folder. */
export type OpenCode2History = {
  messages: OpenCode2Message[];
  busy: boolean;
  permissions: Json[];
  /** The question forms OpenCode waits for (of the session and its subagents). */
  forms?: Json[];
  /** The session's own permission rules in OpenCode. */
  rules?: Rule2[];
  /** The message OpenCode's staged revert cuts at: it and everything after are hidden (OpenCode still lists them until a prompt commits the revert). */
  revert?: string;
  /** The agent OpenCode runs the session as (`session.switchAgent`); none: OpenCode's default agent. */
  agent?: string;
};
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
  const [all, info, active, requests, forms] = await Promise.all([
    loadMessages(client, id),
    client.session.get({ sessionID: id }),
    client.session.active().catch(() => ({}) as Record<string, unknown>),
    client.permission.request.list({ location: { directory: cwd } }).then((r) => r.data as unknown as Json[], () => [] as Json[]),
    client.form.list({ location: { directory: cwd } }).then((r) => r.data as unknown as Json[], () => [] as Json[]),
  ]);
  // The requests of this session and of its subagents' sessions.
  const ours = async (list: Json[]) => (await Promise.all(list.map(async (r) => ((await isOurs(r.sessionID)) ? [r] : [])))).flat();
  const revert = info.revert?.messageID;
  const cut = revert ? all.findIndex((m) => m.id === revert) : -1;
  return { messages: cut < 0 ? all : all.slice(0, cut), busy: id in active, permissions: await ours(requests), forms: await ours(forms), rules: (info.permissions ?? []) as Rule2[], ...(revert && { revert }), ...(info.agent && { agent: info.agent }) };
}

type TurnEnd = { done: Promise<void>; resolve: () => void };
/** The longest a prompt sent after Stop waits for the stopped turn to end. */
const TURN_END_WAIT_MS = 10_000;
/** The longest a Stop waits for a prompt that is on its way to OpenCode before it asks OpenCode to stop. */
const POSTING_WAIT_MS = 3000;
const ANSWERED = "Answered in OpenCode";
/** How often a running bash mode command's output is read (OpenCode 2 sends no output events). */
/** The most of a background shell's output the Shells list gets. */
const SHELL_TAIL = 30_000;
const SHELL_POLL_MS = 500;
/** A user message that shows in the timeline (text or an image). */
const shownUser = (m: OpenCode2Message) => m.type === "user" && (!!m.text || !!m.files?.some((f) => f.mime?.startsWith("image/") && f.data));
type Req = { kind: "permission"; callId?: string; sessionID: string; /** The mapper of the call: an inline run's own. */ mapper: OpenCode2Mapper; /** An inline run's call: its denied card shows under it. */ parentId?: string } | { kind: "question"; sessionID: string; form: Json; questions: Question[]; /** The shown fields, one per question. */ fields: Json[] };
/** A running inline task: its child session's events feed `notify`; `callId` = the call its steps show under. */
type InlineRun = { callId?: string; mapper: OpenCode2Mapper; notify: (type: string, d: Json) => void; /** Its prompt reached OpenCode: a check that finds it not running ends it. */ posted?: boolean; /** Ends the run as OpenCode stored its end (an end event lost with a stream drop). */ settle: (end: StoredEnd) => void };
/** The text of the last assistant message of a stored child session (the fallback when its events were missed). */
const lastAssistantText2 = (messages: readonly OpenCode2Message[]) => {
  for (const m of [...messages].reverse()) {
    const t = m.type === "assistant" ? (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("") : "";
    if (t) return t;
  }
  return "";
};

class OpenCode2Session implements EngineSession {
  private model: string;
  private permissionMode: PermissionMode;
  private effort: Effort;
  staleLogin = false;
  private readonly mapper = new OpenCode2Mapper();
  /** The rules OpenCode has for this session, as JSON. */
  private written: string;
  /** The model or effort changed here since it was last sent to OpenCode (or the session was made with one). */
  private modelDirty: boolean;
  /** The pending permission requests and questions by id: the session each belongs to (a subagent's session answers under its own id). */
  private readonly reqs = new Map<string, Req>();
  /** Forms OpenCode asks that claude-ui cannot show: their notice was shown. */
  private readonly unshown = new Set<string>();
  /** The message OpenCode's staged revert cuts the conversation at, undefined when none (a prompt commits it: OpenCode removes the cut messages then). */
  private revertAt: string | undefined;
  /**
   * A revert clear was asked or seen and no step ran since. OpenCode 2.3.0 follows a clear with an empty execution (`execution.started`/`succeeded`, no step),
   * which is no turn: `run` = its start was skipped (its end is skipped too); `prompted` = a prompt or command of ours was posted since (its turn's start is
   * not skipped); `prompt` = that prompt's message id and `delivered` = OpenCode delivered it (`session.inbox.delivered`): an execution end before that is the
   * clear's. The first step ends it. A resync while it is set starts no turn (OpenCode lists the session active during the empty execution).
   */
  private clear: { run: boolean; prompted: boolean; prompt?: string; delivered: boolean } | undefined;
  private markClear() {
    this.clear = { run: false, prompted: false, delivered: false };
  }
  /** A prompt (`id`) or command of ours goes to OpenCode: it commits a staged revert, and the clear's empty execution is not its turn. */
  private posted(id?: string) {
    this.revertAt = undefined;
    if (this.clear) Object.assign(this.clear, { prompted: true, prompt: id, delivered: false });
  }
  /** The bash mode command running as this session's turn: OpenCode's shell id once `session.shell.started` named it, Stop pressed before that, the output read so far. */
  /** Shell ids of our commands moved to the background: their request still ends them (`shell: background` kept). */
  private readonly backgrounded = new Set<string>();
  private shellRun: { command: string; shellId?: string; stop?: boolean; stdout: string; timer?: NodeJS.Timeout; /** Moved to the background: the session is free, the command runs on. */ background?: boolean } | undefined;
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
  /** The agent chosen here (`setAgent`, the plan mode alias, or followed from OpenCode's own app); else the worker link's agent, else OpenCode's default. */
  private chosen: string | undefined;
  /** The agent OpenCode has for the session (`switchAgent`); undefined: OpenCode's default agent. */
  private agentInOpenCode: string | undefined;
  /** Names of OpenCode's commands last listed: `/name` of one of them runs it. */
  private commandNames = new Set<string>();
  /** OpenCode listed its commands once; `commandsReady` settles when the first read ended (listed or failed). */
  private commandsLoaded = false;
  private commandsReady: Promise<void> = Promise.resolve();
  /** OpenCode started an execution for the running turn (`session.execution.started`). */
  private turnExecuted = false;
  /** Running inline tasks by child session id. */
  private readonly inlineRuns = new Map<string, InlineRun>();
  /** The `inline_task` calls an inline run already took. */
  private readonly inlineClaimed = new Set<string>();
  /** Stop per running inline call id (the card's Stop agent): ends the run as stopped. */
  private readonly inlineStops = new Map<string, () => void>();
  private retrying: { attempt: number; message: string; next?: number } | undefined;
  /** The model of the running step (`session.step.started`). */
  private stepModel: { id: string; providerID: string } | undefined;
  /** The daemon MCP servers attached to OpenCode for this session (orchestration on and no unkept Aside; a claude-ui tool group enabled). */
  private mcpOn = new Set<McpServerKey>();
  private attaching: Promise<void> | undefined;
  /** The servers this session object added: a server OpenCode lists as connected before that may carry a bearer an earlier close dropped. */
  private readonly added = new Set<McpServerKey>();

  constructor(
    private readonly engine: OpenCode2EngineImpl,
    private readonly session: Session,
    private readonly opts: SessionOpts,
    private readonly history?: OpenCode2History,
  ) {
    this.model = opts.model ?? "default";
    const marked = history && modeOfRules(history.rules);
    const mode = opts.permissionMode ?? marked ?? "config";
    // Plan is OpenCode's plan agent: a saved, restored or requested plan mode opens as agent `plan` with the default mode.
    this.permissionMode = mode === "plan" || (mode === "bypassPermissions" && !opts.allowBypass) ? "default" : mode;
    const created = history ? undefined : engine.createdAs(session.id);
    this.agentInOpenCode = history ? history.agent : created?.agent;
    this.chosen = mode === "plan" ? "plan" : history?.agent;
    this.effort = opts.effort ?? "default";
    // A new session got its rules with `POST /api/session`; a restored one has what OpenCode kept (a fork: its owner's).
    this.written = JSON.stringify(history ? (history.rules ?? []) : (created?.rules ?? modeRules(this.permissionMode)));
    this.modelDirty = this.model !== "default" || this.effort !== "default";
  }

  private get server() {
    return this.engine.server;
  }
  get id() {
    return this.session.id;
  }
  get cwd() {
    return this.session.cwd;
  }

  begin() {
    this.engine.add(this);
    void this.attach();
    this.revertAt = this.history?.revert;
    // The slash menu of an open session: the daemon's own commands at once, OpenCode's once it listed them.
    this.session.emit({ type: "commands", id: "commands", commands: LOCAL_COMMANDS });
    this.commandsReady = this.emitCommands();
    void this.refreshAgents();
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
    void this.reconcileShells();
  }

  /** A background shell of the model that OpenCode no longer lists as running ended while the daemon was away (its end notice, if any, is already read): the card stops. */
  private async reconcileShells() {
    const open = this.mapper.openShells();
    if (!open.length) return;
    const running = await this.server
      .client()
      .then((c) => c.shell.list({ location: { directory: this.cwd } }))
      .then((r) => new Set(r.data.map((x) => x.id)))
      .catch(() => undefined);
    if (!running) return;
    for (const [, sh] of open) if (!running.has(sh)) this.shellExited({ id: sh, status: "killed" });
  }
  /** The tree before each running step (`session.step.started` `snapshot`), by assistant message id. `session.step.ended` carries the tree after it. */
  private readonly stepTrees = new Map<string, string>();
  private stepStart(sessionID: string, d: Json) {
    if (typeof d.snapshot !== "string" || !this.opts.onFileEdit) return;
    if (this.stepTrees.size >= 200) this.stepTrees.clear();
    this.stepTrees.set(`${sessionID}:${d.assistantMessageID}`, d.snapshot);
  }
  /**
   * A step of the agent (this session's, or an inline run's) changed files: the content they had before the step goes to Local history (opencode-snapshot.ts).
   * `files` are relative to the project folder. Async, never blocks the event pump.
   */
  private stepPatch(sessionID: string, d: Json) {
    const key = `${sessionID}:${d.assistantMessageID}`;
    const hash = this.stepTrees.get(key);
    this.stepTrees.delete(key);
    const onEdit = this.opts.onFileEdit;
    const files: unknown = d.files;
    if (!onEdit || !hash || !Array.isArray(files) || !files.length) return;
    const part: PatchPart = { id: key, hash, files: files.filter((f): f is string => typeof f === "string") };
    void contentBefore(this.engine.snapshots, this.cwd, sessionID, part).then((list) => list.forEach(([path, before]) => onEdit(path, before)), () => {});
  }
  /** `shell.exited` of any shell: the card of the call that started it ends. */
  shellExited(d: Json) {
    this.emitAll(this.mapper.shellExited(d.id, d.status, typeof d.exit === "number" ? d.exit : undefined));
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

  /** Asks again what OpenCode still waits for (permission requests and questions of this session); settles what it no longer lists. */
  private requests(h: OpenCode2History) {
    const live = new Set<string>();
    for (const p of h.permissions) {
      live.add(p.id);
      // An inline run's ask keeps its own call data (its denied card shows under the inline task).
      const run = this.inlineRuns.get(p.sessionID);
      if (run) this.askPermission(p, run.mapper, run.callId);
      else this.askPermission(p);
    }
    for (const f of h.forms ?? []) (live.add(f.id), this.askForm(f));
    for (const id of [...this.reqs.keys()]) if (!live.has(id) && this.session.pendingRequest(id)) this.session.cancel(id, ANSWERED);
  }

  /** After a reconnect: an inline run OpenCode no longer runs lost its end event; it ends as OpenCode stored it (its newest `idle` row; its text from the stored messages). */
  private async checkInlines(client: OpenCodeClient) {
    const posted = [...this.inlineRuns].filter(([, r]) => r.posted);
    if (!posted.length) return;
    const active = await client.session.active().catch(() => undefined);
    if (!active) return;
    for (const [id, r] of posted) {
      if (id in active) continue;
      const newest = await client.message.list({ sessionID: id, order: "desc", limit: 5 }).then((p) => p.data as unknown as Json[], () => []);
      r.settle(storedEnd(newest));
    }
  }

  resync(): Promise<void> {
    void this.server.client().then((c) => this.checkInlines(c), () => undefined);
    const posts = this.posts;
    return (this.resyncing ??= this.server
      .client()
      .then((c) => loadOpenCode2History(c, this.id, this.cwd, (sid) => this.engine.isOurs(this.id, sid)))
      .then((h) => {
        // A revert missed as an event (stream drop): the cut is shown; a clear brings the cut messages back with the history below.
        if (h.revert !== this.revertAt && (this.revertAt = h.revert)) (this.mapper.forgetFrom(h.revert), this.session.emit({ type: "rewind", id: randomUUID(), userMessageId: h.revert }));
        this.apply(h);
        this.requests(h);
        const state = this.session.currentState();
        // OpenCode lists the session as active during a clear's empty execution: that is no turn.
        if (h.busy && state === "idle" && !this.clear) (this.beginTurn(), this.openTurnEnd(), this.session.setState("running"));
        // A prompt that is still being prepared is not in OpenCode yet: only a turn that reached it can have ended there. A bash mode command is no OpenCode turn.
        // A prompt behind a clear's empty execution may not run yet.
        else if (!h.busy && state === "running" && !this.shellRun && !this.clear && this.turnPosted && this.posting.size === 0 && this.posts === posts) this.turnStop < this.stops ? this.endStopped() : this.finish();
      })
      .catch(() => {})
      .finally(() => (this.resyncing = undefined)));
  }

  /** The `commands` part: the daemon's commands, then OpenCode's (built-ins, project and user commands). */
  emitCommands = async () => {
    const raw = await this.engine.serverCommands(this.cwd).catch(() => undefined);
    if (!raw) return;
    // /visualize is the daemon's: never a server command (unless OpenCode lists one of that name).
    this.commandNames = new Set(raw.map((c) => c.name).filter((n) => !LOCAL_NAMES.includes(n)));
    this.commandsLoaded = true;
    this.session.emit({ type: "commands", id: "commands", commands: withVisualize(raw, !!this.engine.visualizeOn?.()) });
  };
  /** The `agents` part, the default agent first; `failed: true` when OpenCode did not answer (the web offers a retry, which calls this again). */
  refreshAgents = async () => {
    const list = await this.engine.primaryFirst(this.cwd).catch(() => undefined);
    if (!list) return void this.session.emit({ type: "agents", id: "agents", agents: [], failed: true });
    this.session.emit({ type: "agents", id: "agents", agents: list.map(({ id, description }) => ({ name: id, ...(description && { description }) })) });
  };

  settings(): SessionSettings {
    return { model: this.model, permissionMode: this.permissionMode, effort: this.effort, agent: this.agentNow() };
  }
  /** The agent prompts run as. `opts.agent` (the worker link) is read lazily: orchestration writes it after the session is created. */
  private agentName = async () => this.chosen ?? this.opts.agent?.(this.id) ?? (await this.engine.defaultAgent(this.cwd));
  /** `agentName` without waiting: the default agent as last read (`build` before the first read). */
  private agentNow = () => this.chosen ?? this.opts.agent?.(this.id) ?? this.engine.defaultAgentKnown(this.cwd);
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
    if (mode === "plan") return this.setAgent("plan");
    if (!this.session.info().permissionModes.includes(mode)) throw new Error(`permission mode ${mode} is not enabled`);
    await this.writeRules(mode);
    this.permissionMode = mode;
    this.session.emit({ type: "session_permission_mode", id: "session_permission_mode", mode });
    this.changed("permissionMode");
  }
  /** OpenCode runs the next turns as `agent` (a primary agent of OpenCode here); the rules get its denials. */
  async setAgent(agent: string) {
    const list = primaryAgents2(await this.engine.agents(this.cwd));
    if (!list.some((a) => a.id === agent)) throw new Error(`unknown agent ${agent}. OpenCode agents here: ${list.map((a) => a.id).join(", ")}`);
    await this.writeRules(this.permissionMode, agent);
    await this.switchAgent(await this.server.client(), agent);
    this.chosen = agent;
    this.session.emit({ type: "session_agent", id: "session_agent", agent });
    this.changed("agent", "permissionMode"); // a saved legacy `plan` mode must not win over the agent at the next restore
  }
  /** `POST …/agent` unless OpenCode runs the session as `agent` already. */
  private async switchAgent(client: OpenCodeClient, agent: string) {
    if (agent === (this.agentInOpenCode ?? (await this.engine.defaultAgent(this.cwd)))) return;
    const before = this.agentInOpenCode;
    this.agentInOpenCode = agent; // its `session.agent.selected` is no switch from elsewhere
    await client.session.switchAgent({ sessionID: this.id, agent }).catch((err) => ((this.agentInOpenCode = before), Promise.reject(err)));
  }
  /** The agent of the next turn: the session's, or OpenCode's default when the config no longer has it (a notice; the chosen agent stays, it may come back). */
  private async turnAgent() {
    const agent = await this.agentName();
    if (primaryAgents2(await this.engine.agents(this.cwd)).some((a) => a.id === agent)) return agent;
    const fallback = await this.engine.defaultAgent(this.cwd);
    this.notice("agent_missing", `OpenCode has no agent ${agent} here any more; this prompt runs as ${fallback}`);
    return fallback;
  }
  /** An agent chosen in OpenCode's own app (`session.agent.selected`): followed when it is a primary agent here. */
  private async followAgent(agent: unknown) {
    if (typeof agent !== "string" || agent === this.agentInOpenCode) return;
    this.agentInOpenCode = agent;
    const list = await this.engine.agents(this.cwd).catch(() => []);
    if (!primaryAgents2(list).some((a) => a.id === agent) || agent === this.agentNow()) return;
    this.chosen = agent;
    this.session.emit({ type: "session_agent", id: "session_agent", agent });
    this.changed("agent");
  }
  allowDenied(_toolUseId: string): string | undefined {
    throw new DeniedRetryError("unsupported", "this session's engine has no auto mode");
  }
  alwaysAllowDenied(_toolUseId: string, _scope: "session" | "local"): Promise<string | undefined> {
    throw new DeniedRetryError("unsupported", "this session's engine has no auto mode");
  }

  /** Replaces the session's rules in OpenCode with the ones of `mode` and `agent` (default: the session's). */
  private async writeRules(mode: PermissionMode, agent?: string) {
    const client = await this.server.client();
    const permissions = await this.rules(mode, agent);
    await client.session.update({ sessionID: this.id, permissions });
    this.written = JSON.stringify(permissions);
  }
  /** The rules of `mode` for this session as `agent`: with the agent's denials, read-only while it is an Aside that may not edit (aside.ts). */
  private async rules(mode: PermissionMode, agent?: string) {
    agent ??= await this.agentName();
    const own = (await this.engine.agents(this.cwd)).find((a) => a.id === agent)?.permissions ?? [];
    return rulesOf(mode, this.readOnly(), denialsOf2(own), this.ownMcp(mode));
  }
  /**
   * This session's attached MCP servers as rules: the claude-ui tools that ask follow the mode (`config` too: OpenCode would allow an MCP tool by default). The
   * `fork` tool is hidden: OpenCode 2 has no Fork runs in claude-ui yet (forkRun).
   */
  private ownMcp(mode: PermissionMode): McpRules {
    const name = mcpName(this.id, DAEMON_SERVER);
    const daemon = this.mcpOn.has(DAEMON_SERVER) ? this.opts.daemonMcp?.openCodeRules(name, mode === "bypassPermissions" ? "allow" : mode === "dontAsk" ? "deny" : "ask") : undefined;
    return { ...(this.mcpOn.has("orchestration") && { orchestration: mcpName(this.id) }), ...(daemon && { daemon: [...daemon.map((r) => rule(r.permission, r.action)), rule(`${name}_fork`, "deny")] }) };
  }

  /**
   * Attaches this session's daemon MCP servers to OpenCode (`PUT /api/experimental/mcp/{name}` in its folder) unless they are connected: at begin and before each turn,
   * so an OpenCode restart (which drops them) is repaired by the next prompt. Code Mode off: the model calls the tools by their own names (`<name>_<tool>`), which the
   * rules and the cards know. `mcpServers` binds the tools to this session, as at a Claude query start. A failure is a notice; the prompt still goes.
   */
  private attach(): Promise<void> {
    let attaching: McpServerKey = "orchestration";
    return (this.attaching ??= (async () => {
      const route = this.engine.mcp;
      const url = route?.url();
      const keys = url ? mcpKeys(this.opts, this.id) : [];
      this.mcpOn = new Set(keys);
      if (!keys.length) return;
      const client = await this.server.client();
      const location = { directory: this.cwd };
      const listed = (await client.mcp.list({ location })).data;
      for (const key of keys) {
        attaching = key;
        const name = mcpName(this.id, key);
        if (this.added.has(key) && listed.some((m) => m.name === name && m.status.status === "connected")) continue;
        const config = { type: "remote" as const, url: url!, headers: { authorization: `Bearer ${route!.token(this.id, key)}` }, oauth: false as const, codemode: false, timeout: { execution: mcpTimeoutMs(key, this.opts) } };
        await client.experimental.mcp.add({ server: name, location, config });
        this.added.add(key);
      }
    })()
      .catch((err) => this.notice(`mcp_failed:${ascending("msg")}`, `Could not attach the ${attaching} tools to OpenCode: ${(err as Error).message}`))
      .finally(() => (this.attaching = undefined)));
  }
  private readOnly = () => !!this.opts.disallowedTools?.(this.id)?.some((t) => ASIDE_NO_EDIT.includes(t));

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

  /** An early `/name` waits for OpenCode's command list and its request: a prompt typed meanwhile waits for it (OpenCode gets them in the typed order). */
  private commandGate: Promise<void> | undefined;

  prompt(text: string, images: string[] = []): string | undefined {
    if (this.commandGate) {
      this.localRun = undefined;
      void this.commandGate.then(() => this.prompt(text, images));
      return undefined;
    }
    const local = !images.length && /^\/(compact|undo|redo)$/.exec(text.trim())?.[1];
    if (local) {
      // Only /undo is awaited by its reply (the undone prompt goes back to the box); /compact and /redo run on their own.
      const run = this.runLocal(local as "compact" | "undo" | "redo");
      this.localRun = local === "undo" ? run : undefined;
      return undefined;
    }
    // `/name args` of an OpenCode command, while no turn runs (else it is a plain prompt that joins the turn).
    const cmd = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const idle = () => this.session.currentState() === "idle";
    // Like a local command it has no message of ours (no draft; the web drops its pending bubble): the prompt OpenCode makes of it shows.
    if (cmd && this.commandNames.has(cmd[1]!) && idle()) return void ((this.localRun = undefined), void this.runCommand(cmd[1]!, cmd[2] ?? "", images));
    // Typed before OpenCode listed its commands: wait for the list (at most 5 s), then run it as a command, or send it as a prompt (shown then).
    if (cmd && !this.commandsLoaded && idle()) {
      this.localRun = undefined;
      const gate: Promise<void> = Promise.race([this.commandsReady, new Promise((r) => setTimeout(r, COMMANDS_WAIT_MS))])
        .then(() => (this.commandNames.has(cmd[1]!) && idle() ? this.runCommand(cmd[1]!, cmd[2] ?? "", images) : void this.sendPlain(text, images)))
        .finally(() => this.commandGate === gate && (this.commandGate = undefined));
      this.commandGate = gate;
      return undefined;
    }
    return this.sendPlain(text, images);
  }

  /** A prompt of ours: its `user_text` at once, then sent (a new turn when idle, else joining the running one). */
  private sendPlain(text: string, images: string[]): string {
    // Stop was pressed and the stopped turn still runs: a joining prompt would be lost with it, so it starts the next turn when this one has ended.
    const afterStop = this.turnStop < this.stops && this.session.currentState() !== "idle";
    const messageID = ascending("msg");
    // OpenCode commits a staged revert at the next prompt: the cut messages are gone.
    this.posted(messageID);
    this.mapper.own.add(messageID);
    this.session.emit({ type: "user_text", id: messageID, text, images });
    const steer = this.session.currentState() !== "idle";
    const stops = this.stops;
    const start = () => {
      // A Stop while this prompt waited for the stopped turn drops it (as a prompt being prepared).
      if (this.stops !== stops) return;
      if (!steer || afterStop) (this.beginTurn(), (this.turnPosted = false), this.session.setState("running"));
      void this.send(messageID, text, images, this.visualizeDirective(text)).catch((err) => {
        this.notice(`prompt_failed:${messageID}`, `Could not send the prompt to OpenCode: ${(err as Error).message}`);
        if (!steer || afterStop) this.toIdle();
      });
    };
    if (!afterStop) start();
    else void Promise.race([this.turnEnd?.done, new Promise((r) => setTimeout(r, TURN_END_WAIT_MS))]).then(start);
    return messageID;
  }

  private localRun?: Promise<{ text: string; images: string[] } | undefined>;
  /** The run of the `/undo` just taken by prompt(): its undone prompt (no draft when nothing was undone). */
  localDraft = () => this.localRun ?? Promise.resolve(undefined);

  /** `/compact`, `/undo` and `/redo` (nothing is echoed): only while idle. `/undo` returns the prompt it took back. */
  private async runLocal(cmd: "compact" | "undo" | "redo"): Promise<{ text: string; images: string[] } | undefined> {
    const say = (text: string) => this.notice(`local:${ascending("msg")}`, text);
    if (this.session.currentState() !== "idle" || this.session.pendingCount()) return void say("Stop the turn first");
    try {
      if (cmd === "compact") return void (await this.compact());
      const client = await this.server.client();
      if (cmd === "undo") {
        const target = (await this.shown(client)).filter(shownUser).at(-1);
        if (!target) return void say("Nothing to undo");
        await this.rewind(target.id, (await this.previewRewind(target.id)).modes![0]!);
        return { text: target.text ?? "", images: (target.files ?? []).filter((f) => f.mime?.startsWith("image/") && f.data).map((f) => `data:${f.mime};base64,${f.data}`) };
      }
      const all = await loadMessages(client, this.id);
      const at = this.revertAt ? all.findIndex((m) => m.id === this.revertAt) : -1;
      if (at < 0) return void say("Nothing to redo");
      const next = all.slice(at + 1).find(shownUser);
      const before = this.revertAt;
      // The newest undone prompt is redone: OpenCode clears the revert (files back as before it); else the revert point moves to the next undone prompt.
      this.revertAt = next?.id;
      if (!next) this.markClear();
      await (next ? client.session.revert.stage({ sessionID: this.id, messageID: next.id, files: true }) : client.session.revert.clear({ sessionID: this.id })).catch((err) => ((this.revertAt = before), Promise.reject(err)));
      await this.resync(); // the messages between the old and the new revert point come back
    } catch (err) {
      say(`/${cmd} failed: ${(err as Error).message}`);
    }
  }

  /** `/compact`: OpenCode summarizes the conversation as a turn (`session.compaction.*`, then the execution's end). */
  private async compact() {
    this.engine.record(this.id);
    this.beginTurn();
    this.session.setState("running");
    const client = await this.server.client();
    // The compaction's events must find the stream open (as a prompt's).
    await this.server.streamReady();
    await client.session.compact({ sessionID: this.id }).catch((err) => {
      this.toIdle();
      return Promise.reject(err);
    });
  }

  /** The stored messages that show: those before a staged revert's cut. */
  private async shown(client: OpenCodeClient) {
    const all = await loadMessages(client, this.id);
    const cut = this.revertAt ? all.findIndex((m) => m.id === this.revertAt) : -1;
    return cut < 0 ? all : all.slice(0, cut);
  }

  /** What a rewind to before the user message `id` covers: the files its turn and every later shown turn changed (`GET …/diff`, `to` excluded). */
  previewRewind = async (id: string): Promise<RewindPreview> => {
    const client = await this.server.client();
    const users = (await this.shown(client)).filter((m) => m.type === "user");
    if (!users.some((u) => u.id === id)) throw new Error("unknown message");
    const last = users.at(-1)!;
    // Without `to` a diff covers one turn (up to the next user message, which after a cut is the cut's): from `id` to the last turn, then the last turn.
    const diffs = [...(last.id === id ? [] : await client.session.diff({ sessionID: this.id, from: id, to: last.id })), ...(await client.session.diff({ sessionID: this.id, from: last.id }))];
    const files = [...new Set(diffs.map((d) => d.file))];
    // A revert restores the conversation, with the files (`files: true`) or without them; never the files alone.
    return { filesChanged: files, insertions: diffs.reduce((n, d) => n + d.additions, 0), deletions: diffs.reduce((n, d) => n + d.deletions, 0), conversation: true, modes: files.length ? ["both", "conversation"] : ["conversation"] };
  };

  /** OpenCode's revert to before the user message `id` (`…/revert/stage`): the messages stay stored, hidden until the next prompt commits the revert. */
  rewind = async (id: string, mode: RewindMode) => {
    if (this.session.currentState() !== "idle") throw new Error("Stop the turn first");
    const preview = await this.previewRewind(id);
    if (!preview.modes!.includes(mode)) throw new Error(preview.modes!.length > 1 ? "OpenCode rewinds the conversation, with or without the code" : "OpenCode rewinds the conversation only: no file changed");
    const client = await this.server.client();
    const before = this.revertAt;
    this.revertAt = id; // the `session.revert.staged` of this revert is not an external one
    await client.session.revert.stage({ sessionID: this.id, messageID: id, files: mode === "both" }).catch((err) => ((this.revertAt = before), Promise.reject(err)));
    this.mapper.forgetFrom(id);
    this.session.emit({ type: "rewind", id: randomUUID(), userMessageId: id });
    // The context in use is the last step's before the cut.
    const kept = await this.shown(client).catch(() => []);
    this.usage = undefined;
    for (const m of kept) this.noteUsage(m);
    void this.emitUsage();
  };

  /**
   * Gets OpenCode ready for a turn of this session: the stream open, the session's agent (`switchAgent`), its rules and model. False when a Stop came meanwhile.
   * The record comes before anything of the turn reaches OpenCode 2: a failed save fails the prompt, never leaves a version 2 turn with no record.
   */
  private async prepare(client: OpenCodeClient, live: () => boolean) {
    this.engine.record(this.id);
    await Promise.all([this.server.streamReady(), this.attach()]);
    if (!live()) return false;
    const agent = await this.turnAgent();
    const rules = await this.rules(this.permissionMode, agent);
    if (!live()) return false;
    if (this.written !== JSON.stringify(rules)) await this.writeRules(this.permissionMode, agent);
    await this.switchAgent(client, agent);
    if (!live()) return false;
    await this.applyModel(client);
    await this.syncVisualize(client);
    return live();
  }

  /**
   * An OpenCode command (`POST …/command`): OpenCode expands it into the prompt it stores (shown by its `session.inbox.enqueued`) and runs the turn, whose
   * `session.execution.started` starts it here; a command that runs no turn (`/goal pause`) starts none. A failure (an unknown argument) is a notice.
   */
  private runCommand(name: string, args: string, images: string[]): Promise<void> {
    const stops = this.stops;
    // Running from the start (Stop works, no second command goes): a Stop while it is prepared ends it here, as a prompt's.
    this.beginTurn();
    this.turnPosted = false;
    this.session.setState("running");
    const key = this.turnKey;
    const waiting = () => this.turnKey === key && !this.turnExecuted && this.session.currentState() !== "idle";
    return (async () => {
      const client = await this.server.client();
      if (!(await this.prepare(client, () => this.stops === stops))) return;
      this.posted();
      this.turnPosted = true;
      const files = images.map((uri) => ({ uri, source: { type: "inline" as const }, name: "image" }));
      this.posts++;
      const post = client.session.command({ sessionID: this.id, name, text: args, ...(files.length && { files }) });
      this.posting.add(post);
      try {
        await post;
      } finally {
        this.posting.delete(post);
      }
      // OpenCode took it and runs no turn for it (`/goal pause`): the session is not active there.
      if (!waiting()) return;
      const active = await client.session.active().catch(() => undefined);
      if (active && !(this.id in active) && waiting()) this.toIdle();
    })().catch((err) => {
      this.notice(`command_failed:${ascending("msg")}`, `/${name} failed: ${(err as Error).message}`);
      if (this.turnKey === key) this.toIdle();
    });
  }

  /** The hidden directive of `/visualize [what]` while the setting is on and OpenCode has no `visualize` command of its own; the typed text stays the prompt. */
  private visualizeDirective(text: string): string | undefined {
    if (!visualizeSystem(this.opts.visualizePlugin?.(), "opencode") || this.commandNames.has("visualize")) return undefined;
    const viz = /^\/visualize(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!viz) return undefined;
    return viz[1]?.trim() ? `Answer this with a visualize fence: ${viz[1].trim()}` : "Draw your last answer, or the current topic, as a visualize fence.";
  }

  /** The visualize text as an instruction entry of the session: put when it changed since the last put, removed once when the setting went off (a run that did not put it lists the entries to know an earlier run's). */
  private visualized: string | null | undefined;
  private async syncVisualize(client: OpenCodeClient) {
    const system = visualizeSystem(this.opts.visualizePlugin?.(), "opencode") ?? null;
    if (system === this.visualized) return;
    try {
      if (system !== null) await client.experimental.session.instructions.entry.put({ sessionID: this.id, key: VISUALIZE_ENTRY, value: system });
      else if (this.visualized || (await client.experimental.session.instructions.entry.list({ sessionID: this.id })).some((e) => e.key === VISUALIZE_ENTRY)) await client.experimental.session.instructions.entry.remove({ sessionID: this.id, key: VISUALIZE_ENTRY });
      this.visualized = system;
    } catch (err) {
      // A failed sync is tried again at the next prompt; the prompt itself goes on.
      console.error("OpenCode 2 visualize instruction failed:", (err as Error).message);
    }
  }

  private async send(messageID: string, text: string, images: string[], directive?: string) {
    const stops = this.stops;
    // A Stop while the prompt is prepared ends the wait: nothing was posted, interrupt() ended the turn.
    const live = () => this.stops === stops;
    const client = await this.server.client();
    if (!(await this.prepare(client, live))) return;
    this.turnPosted = true;
    const files = images.map((uri) => ({ uri, source: { type: "inline" as const }, name: "image" }));
    // A hidden message for the model right before the prompt: `resume: false` starts no turn of its own, the prompt's turn reads it.
    if (directive) await client.session.synthetic({ sessionID: this.id, text: directive, delivery: "steer", resume: false });
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
    this.turnExecuted = false;
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
    this.clear = undefined;
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
    if (this.shellRun) return this.killShell();
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
        // OpenCode 2.3.0 follows a revert clear with an empty execution: no turn.
        if (this.clear && !this.clear.prompted) return void (this.clear.run = true);
        if (this.session.currentState() === "idle") (this.beginTurn(), this.session.setState("running"));
        this.turnExecuted = true;
        return;
      case "session.execution.succeeded":
        // The clear's empty execution ended: its start was skipped, or a prompt of ours waits behind it (not delivered yet).
        if (this.clear && (this.clear.run || (this.clear.prompted && !this.clear.delivered))) return void (this.clear = undefined);
        return this.finish();
      case "session.inbox.delivered":
        // Our prompt reached a run: that run is its turn.
        if (this.clear?.prompt && d.inboxID === this.clear.prompt) Object.assign(this.clear, { delivered: true, run: false });
        return;
      case "session.execution.failed":
        if (this.clear?.run) return void (this.clear = undefined);
        this.failed = true;
        this.showError(d.error);
        return this.finish();
      case "session.execution.interrupted":
        if (this.clear?.run) return void (this.clear = undefined);
        return this.session.currentState() === "idle" ? undefined : this.interrupted();
      case "session.step.started": {
        // A step after a skipped start is a real run (the clear's empty execution has none): a turn of OpenCode's own app, shown as one.
        const own = this.clear?.run && this.session.currentState() === "idle";
        this.clear = undefined;
        if (own) (this.beginTurn(), this.session.setState("running"), (this.turnExecuted = true));
        this.stepStart(this.id, d);
        this.turnAssistant = d.assistantMessageID;
        this.stepModel = d.model;
        return this.setRetry(undefined);
      }
      case "session.step.ended":
        this.stepPatch(this.id, d);
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
      case "session.revert.staged": {
        // Reverted elsewhere (OpenCode's own app): cut like our own rewind.
        const at: string | undefined = d.revert?.messageID;
        if (!at || at === this.revertAt) return;
        this.revertAt = at;
        this.mapper.forgetFrom(at);
        this.session.emit({ type: "rewind", id: randomUUID(), userMessageId: at });
        // A cut moved to a later message brings back the messages between: read them again.
        return void (this.resyncing?.then(() => this.resync()) ?? this.resync());
      }
      case "session.revert.cleared":
        // The cut messages come back; a read already in flight may predate the clear.
        this.revertAt = undefined;
        this.markClear();
        return void (this.resyncing?.then(() => this.resync()) ?? this.resync());
      case "session.revert.committed":
        this.revertAt = undefined;
        return;
      case "session.compaction.failed":
        this.failed = true;
        return this.emitAll(this.mapper.event(type, d));
      case "session.shell.started":
        return this.shellStarted(d.shell as Shell2);
      case "session.shell.ended":
        return this.shellEnded(d.shell as Shell2);
      case "form.created":
        return this.askForm(d.form);
      case "form.replied":
      case "form.cancelled":
        return this.session.pendingRequest(d.id) ? this.session.cancel(d.id, ANSWERED) : undefined;
      case "session.renamed":
        return typeof d.title === "string" ? this.engine.onTitle?.(this.id, d.title) : undefined;
      case "session.agent.selected":
        return void this.followAgent(d.agent);
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

  private askPermission(e: Json, mapper = this.mapper, parentId?: string) {
    if (this.session.pendingRequest(e.id) || this.reqs.has(e.id)) return;
    const callId: string | undefined = e.source?.type === "tool" ? e.source.id : undefined;
    // Don't ask: whatever asks is refused at once, no card and no needs-input (the session's and its subagents' asks).
    if (this.permissionMode === "dontAsk") {
      const card = callId && mapper.deny(callId);
      if (card) this.session.emit({ ...card, ...(parentId && { parentId }) });
      void this.server
        .client()
        .then((c) => c.permission.reply({ sessionID: e.sessionID, requestID: e.id, decision: "reject", message: DONT_ASK }))
        .catch((err) => this.notice(`answer_failed:${ascending("msg")}`, `Could not answer OpenCode: ${(err as Error).message}`));
      return;
    }
    const call = callId ? mapper.call(callId) : undefined;
    const mapped = call?.type === "tool_call" ? call : undefined;
    const resources: string[] = e.resources ?? [];
    // The ask can come before the call has its input: the permission's own data then names the command (shell: the resource; a daemon MCP tool: its input).
    const fallback = mapTool2(e.action, e.action === "shell" ? { command: resources[0] ?? "" } : isDaemonMcp(rule(e.action, "ask")) && e.metadata?.input && typeof e.metadata.input === "object" ? e.metadata.input : {});
    const tool = mapped?.tool ?? fallback.tool;
    const input: Record<string, unknown> = mapped && Object.keys(mapped.input as object).length ? (mapped.input as Record<string, unknown>) : { ...(!mapped && { patterns: resources }), ...fallback.input };
    // OpenCode saves the "always" patterns itself (per project). worker_start: none, the card is the user's only gate on new workers (as for Claude).
    const suggestions: PermissionUpdate[] = e.save?.length && tool !== WORKER_START ? [{ type: "addRules", rules: (e.save as string[]).map((ruleContent) => ({ toolName: tool, ruleContent })), behavior: "allow", destination: "session" }] : [];
    this.reqs.set(e.id, { kind: "permission", callId, sessionID: e.sessionID, mapper, ...(parentId && { parentId }) });
    const part = { type: "permission_request" as const, id: e.id, requestId: e.id, toolUseId: callId ?? e.id, tool, input, ...(!mapped && { title: `OpenCode asks to use ${e.action}: ${resources.join(", ")}` }), noEdit: true as const, suggestions, settled: false, at: Date.now() };
    const reply = (r: Reply) => this.answer(e.id, r);
    // The claude-ui tools that ask (terminal_run) and worker_start get their own cards.
    const daemonCard = showDaemonCard({
      opts: this.opts,
      id: this.id,
      tool,
      input,
      pending: () => this.reqs.has(e.id),
      show: (title, onAllow) => this.session.request({ part: { ...part, ...(title !== undefined && { title }) }, onAllow, reply }),
      allowOnce: () => this.answer(e.id, { kind: "allow", decision: "allow" }),
    });
    if (!daemonCard) this.session.request({ part, reply });
  }

  private answer(id: string, r: Reply) {
    const req = this.reqs.get(id);
    this.reqs.delete(id);
    if (req?.kind !== "permission") return;
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
        const card = req.callId && req.mapper.deny(req.callId);
        if (card) this.session.emit({ ...card, ...(req.parentId && { parentId: req.parentId }) });
        return send("reject", r.kind === "deny" ? r.message : undefined);
      }
      case "cancel":
        if (r.message !== ANSWERED) send("reject");
    }
  }

  /**
   * Inline task (GH-734): a session of its own runs the prompt with only the granted tools (its rules: inlineRules), the system text as an instruction entry, on the
   * input's model, else setting `openCodeModel`, else this session's. A root session, not a child: OpenCode 2 sends a child's report to its parent's inbox and starts a
   * turn there. The session list hides it (`INLINE_META`); it is deleted at the end. Its steps show under the running `inline_task` call; its permission asks in this
   * session. Ends at its execution's end, an error, a cap (turns, output tokens, time) or `hooks.signal`.
   */
  inlineTask = async (spec: InlineSpec, hooks: InlineHooks): Promise<InlineResult> => {
    const t0 = Date.now();
    const fallback = this.model;
    const result = (r: Partial<InlineResult> & Pick<InlineResult, "status">, col?: InlineCollector2): InlineResult => ({
      text: "",
      model: col?.modelName(fallback) ?? fallback,
      turns: col?.turns ?? 0,
      tokens: col?.tokens() ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(col && col.cost() > 0 && { costUsd: col.cost() }),
      filesChanged: col?.filesChanged() ?? [],
      durationMs: Date.now() - t0,
      ...r,
    });
    let childId: string | undefined;
    let col: InlineCollector2 | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let callId: string | undefined;
    let client: OpenCodeClient | undefined;
    try {
      callId = await findCall(() => this.mapper.runningCall(`mcp__${DAEMON_SERVER}__inline_task`, hooks.input, this.inlineClaimed));
      if (callId) this.inlineClaimed.add(callId);
      client = await this.server.client();
      const agent = await this.agentName();
      const own = (await this.engine.agents(this.cwd)).find((a) => a.id === agent)?.permissions ?? [];
      // The agent's rules, then this session's (its mode, the agent's denials, an Aside's read-only rule): applied to the granted tools only.
      const permissions = inlineRules(spec, [...own, ...(await this.rules(this.permissionMode, agent))]);
      const model = refOf(spec.model || hooks.settings?.openCodeModel || this.model);
      const row = await client.session.create({ location: { directory: this.cwd }, title: `Inline: ${spec.title}`.slice(0, 80), agent, ...(model && { model }), permissions, metadata: { [INLINE_META]: this.id } });
      const id = (childId = row.id);
      const collector = (col = new InlineCollector2());
      const mapper = new OpenCode2Mapper();
      const outcome = new Promise<{ status: InlineResult["status"]; limit?: InlineResult["limit"]; error?: string }>((resolve) => {
        this.inlineRuns.set(id, {
          ...(callId && { callId }),
          mapper,
          notify: (type, d) => {
            collector.feed(type, d);
            const cap = collector.cap(spec.maxTurns);
            if (cap) resolve({ status: "limit", limit: cap });
            else if (collector.error) resolve({ status: "error", error: collector.error });
            else if (collector.idle) resolve({ status: "done" });
            else if (collector.interrupted) resolve({ status: "stopped" });
          },
          settle: resolve,
        });
        this.engine.adoptInline(id, this);
        timer = setTimeout(() => resolve({ status: "limit", limit: "time" }), INLINE_TIMEOUT_MS);
        onAbort = () => resolve({ status: "stopped" });
        if (callId) this.inlineStops.set(callId, onAbort);
        if (hooks.signal.aborted) onAbort();
        else hooks.signal.addEventListener("abort", onAbort, { once: true });
      });
      await client.experimental.session.instructions.entry.put({ sessionID: id, key: INLINE_ENTRY, value: INLINE_SYSTEM });
      await this.server.streamReady();
      // A Stop that came while the session was made sends no prompt.
      if (!hooks.signal.aborted && !(callId && !this.inlineStops.has(callId))) {
        await client.session.prompt({ sessionID: id, text: spec.text });
        const run = this.inlineRuns.get(id);
        if (run) run.posted = true;
      }
      const end = await outcome;
      if (end.status !== "done" && end.status !== "error") await client.session.interrupt({ sessionID: id }).catch(() => undefined);
      let text = collector.text();
      if (!text && end.status === "done") text = lastAssistantText2(await loadMessages(client, id).catch(() => []));
      return result({ ...end, ...clip(text) }, collector);
    } catch (err) {
      return result({ status: "error", error: (err as Error).message, ...(col && clip(col.text())) }, col);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) hooks.signal.removeEventListener("abort", onAbort);
      if (childId) {
        const gone = childId;
        this.inlineRuns.delete(gone);
        this.engine.releaseInline(gone);
        // Its asks wait for no one any more.
        for (const [rid, r] of this.reqs) if (r.sessionID === gone && this.session.pendingRequest(rid)) this.session.cancel(rid, "The inline task ended");
        void client?.session.remove({ sessionID: gone }).catch(() => undefined);
      }
      if (callId) this.inlineStops.delete(callId);
      // A claim stays while its call still runs (a second run must not take it); finished calls are dropped.
      for (const id of this.inlineClaimed) if (!this.mapper.isRunning(id)) this.inlineClaimed.delete(id);
    }
  };

  /** One event of an inline run's session: its result, its permission asks (answered under its id), its steps under the call. */
  inlineEvent(childId: string, type: string, d: Json) {
    const run = this.inlineRuns.get(childId);
    if (!run) return;
    run.notify(type, d);
    if (type === "session.step.started") this.stepStart(childId, d);
    else if (type === "session.step.ended") this.stepPatch(childId, d);
    if (type === "permission.asked") return this.askPermission(d, run.mapper, run.callId);
    if (type === "permission.replied") return this.session.pendingRequest(d.requestID) ? this.session.cancel(d.requestID, ANSWERED) : undefined;
    if (run.callId) for (const part of run.mapper.event(type, d)) this.session.emit({ ...part, parentId: run.callId });
  }

  /**
   * A form of OpenCode 2 (`form.created`) as a question part under its call (docs/spec.md "OpenCode 2 adapter", Questions): `metadata.kind` `question` is the
   * `question` tool, another kind has no call (the part's `toolUseId` is the form's id). A form with no shown field: a notice.
   */
  private askForm(form: Json) {
    if (this.session.pendingRequest(form.id) || this.reqs.has(form.id)) return;
    const all: Json[] = form.fields ?? [];
    const shown = all.filter((f) => !f.hidden);
    if (!shown.length) {
      if (!this.unshown.has(form.id)) this.notice(`form:${form.id}`, `OpenCode asks for input claude-ui cannot show yet (${form.title ?? "a form"}). Answer it in OpenCode.`);
      return void this.unshown.add(form.id);
    }
    const titleOf = (key: string) => all.find((f) => f.key === key)?.title ?? key;
    const seen = new Map<string, number>();
    const questions: Question[] = shown.map((f, i) => {
      const base = f.description ?? f.title ?? f.key;
      // Questions are answered by their text: an equal text gets a number.
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const when = (f.when as Json[] | undefined)?.map((w) => `${titleOf(w.key)} ${w.op === "neq" ? "is not" : "is"} ${w.value}`).join(" and ");
      const header = `${i === 0 && form.metadata?.kind !== "question" ? (form.title ?? "") : (f.title ?? "")}${when ? ` (if ${when})` : ""}`;
      const options: Question["options"] =
        f.type === "boolean" ? [{ label: "Yes", description: "" }, { label: "No", description: "" }] : f.type === "external" ? [{ label: "Done", description: f.url ?? "" }] : (f.options ?? []).map((o: Json) => ({ label: o.label, description: o.description ?? "" }));
      return { question: n > 1 ? `${base} (${n})` : base, header, options, multiSelect: f.type === "multiselect" };
    });
    this.reqs.set(form.id, { kind: "question", sessionID: form.sessionID, form, questions, fields: shown });
    this.session.request({ part: { type: "question", id: form.id, requestId: form.id, toolUseId: form.metadata?.tool?.id ?? form.id, questions, settled: false, at: Date.now() }, reply: (r) => this.answerQuestion(form.id, r) });
  }

  /**
   * The reply of a form: each shown field's answer as OpenCode expects it (an option by its value, a boolean, a number), the defaults of hidden fields, and no answer
   * for a field whose `when` does not hold. A string OpenCode would refuse is `{error}`.
   */
  private formAnswer(req: Extract<Req, { kind: "question" }>, r: Extract<Reply, { kind: "answer" }>): { answer: Record<string, string | number | boolean | string[]> } | { error: string } {
    const answer: Record<string, string | number | boolean | string[]> = {};
    for (const [i, f] of req.fields.entries()) {
      const q = req.questions[i]!;
      const text = r.answers[q.question]?.trim();
      if (text === undefined) continue;
      const labels = r.choices?.[q.question] ?? (q.multiSelect ? splitLabels(text, q.options.map((o) => o.label)) : [text]);
      const value = (label: string) => (f.options as Json[] | undefined)?.find((o) => o.label === label)?.value ?? label;
      if (f.type === "multiselect") answer[f.key] = labels.map(value);
      else if (f.type === "boolean") {
        const yes = /^(yes|true|y)$/i.test(text);
        if (!yes && !/^(no|false|n)$/i.test(text)) return { error: `${f.title ?? f.key} needs Yes or No` };
        answer[f.key] = yes;
      } else if (f.type === "number" || f.type === "integer") {
        const n = text === "" ? NaN : Number(text);
        const bound = (b: unknown) => (typeof b === "number" ? b : undefined);
        if (!Number.isFinite(n) || (f.type === "integer" && !Number.isInteger(n))) return { error: `${f.title ?? f.key} needs ${f.type === "integer" ? "a whole" : "a"} number` };
        if ((bound(f.minimum) ?? -Infinity) > n || (bound(f.maximum) ?? Infinity) < n) return { error: `${f.title ?? f.key} must be ${bound(f.minimum) !== undefined && bound(f.maximum) !== undefined ? `between ${f.minimum} and ${f.maximum}` : bound(f.minimum) !== undefined ? `at least ${f.minimum}` : `at most ${f.maximum}`}` };
        answer[f.key] = n;
      } else if (f.type === "external") answer[f.key] = true;
      else answer[f.key] = value(labels[0] ?? text);
    }
    // Hidden fields answer with their default, when they have one.
    for (const f of (req.form.fields ?? []) as Json[]) if (f.hidden && f.default !== undefined) answer[f.key] = f.default;
    // A field whose condition does not hold is not active: OpenCode refuses an answer for it.
    const active = (f: Json) => ((f.when as Json[] | undefined) ?? []).every((w) => (answer[w.key] === w.value) === (w.op !== "neq"));
    let again = true;
    while (again) {
      again = false;
      for (const f of (req.form.fields ?? []) as Json[]) if (f.key in answer && !active(f)) (delete answer[f.key], (again = true));
    }
    return { answer };
  }

  /** The answer of a question (a multi-select field as the list of chosen labels); anything else cancels the form, which ends OpenCode's turn. */
  private answerQuestion(id: string, r: Reply) {
    const req = this.reqs.get(id);
    this.reqs.delete(id);
    if (req?.kind !== "question") return;
    const call = (f: (c: OpenCodeClient) => Promise<unknown>) =>
      void this.server
        .client()
        .then(f)
        .catch((err) => this.notice(`answer_failed:${ascending("msg")}`, `Could not answer OpenCode: ${(err as Error).message}`));
    if (r.kind === "answer") {
      const a = this.formAnswer(req, r);
      // A value OpenCode would refuse is not sent: the question comes back with the reason.
      if ("error" in a) {
        this.notice(`form_invalid:${ascending("msg")}`, `${a.error}. Answer again.`);
        return void setTimeout(() => this.reqs.has(id) || this.askForm(req.form), 0);
      }
      return call((c) => c.session.form.reply({ sessionID: req.sessionID, formID: id, answer: a.answer }));
    }
    if (r.kind !== "cancel" || r.message !== ANSWERED) call((c) => c.session.form.cancel({ sessionID: req.sessionID, formID: id }));
  }

  /**
   * Bash mode (`!`): OpenCode runs `command` in the folder without a model call (`POST …/shell`, answered when the command ends). The session is running while it
   * runs; no `turn_result`. Output: read every 500 ms (OpenCode sends no output events), the stored shell message at the end. Stop = `DELETE /api/shell/{id}`.
   */
  bash(command: string): void {
    if (!this.session.isLive()) throw new Error(`session ${this.id} is not live (${this.session.currentState()})`);
    if (this.session.currentState() !== "idle" || this.session.pendingCount()) throw new Error("session is busy: wait for the turn to end");
    // The command runs in the version 2 session: recorded first, as a prompt.
    this.engine.record(this.id);
    const messageID = ascending("msg");
    const run: NonNullable<OpenCode2Session["shellRun"]> = { command, stdout: "" };
    this.shellRun = run;
    this.session.setState("running");
    void (async () => {
      const client = await this.server.client();
      await this.server.streamReady();
      await client.session.shell({ sessionID: this.id, id: messageID, command });
      // The stored shell message has the whole output and the exit code.
      const m = (await client.session.message.get({ sessionID: this.id, messageID }).catch(() => undefined)) as OpenCode2Message | undefined;
      if (m?.type === "shell" && m.shellID) this.session.emit({ ...bashPart({ id: m.shellID, command, status: m.status ?? "exited", exit: m.exit }, m.output?.output ?? run.stdout), ...(run.background && { shell: "background" as const }) });
    })()
      .catch((err) => this.notice(`shell_failed:${messageID}`, `Could not run the command in OpenCode: ${(err as Error).message}`))
      .finally(() => {
        clearInterval(run.timer);
        if (run.shellId) this.backgrounded.delete(run.shellId);
        if (this.shellRun !== run) return;
        this.shellRun = undefined;
        this.toIdle();
      });
  }

  private shellStarted(sh: Shell2) {
    this.session.emit(bashPart(sh, ""));
    const run = this.shellRun;
    if (!run || run.shellId) return;
    run.shellId = sh.id;
    if (run.stop) return void this.killShell();
    run.timer = setInterval(() => {
      void this.server
        .client()
        .then((c) => c.shell.output({ id: sh.id, location: { directory: this.cwd } }))
        .then((o) => {
          const out = (o as unknown as { data?: { output?: string } }).data?.output ?? "";
          if (this.shellRun === run && out !== run.stdout) (run.stdout = out, this.session.emit(bashPart(sh, out)));
        })
        .catch(() => {});
    }, SHELL_POLL_MS);
  }

  /** A command ended: ours shows its stored message when its request answers; one run elsewhere (OpenCode's own app) shows its output now. */
  private shellEnded(sh: Shell2) {
    if (this.shellRun?.shellId === sh.id || this.backgrounded.has(sh.id)) return;
    void this.server
      .client()
      .then((c) => c.shell.output({ id: sh.id, location: { directory: this.cwd } }))
      .then((o) => (o as unknown as { data?: { output?: string } }).data?.output ?? "", () => "")
      .then((out) => this.session.emit(bashPart(sh, out)));
  }

  /** Stop of a bash mode command: OpenCode kills it (its request then answers); before OpenCode named the shell, the kill waits for `session.shell.started`. */
  private async killShell() {
    const run = this.shellRun!;
    run.stop = true;
    if (!run.shellId) return;
    const client = await this.server.client();
    await client.shell.remove({ id: run.shellId, location: { directory: this.cwd } }).catch((err) => this.notice(`stop_failed:${ascending("msg")}`, `Could not stop the command in OpenCode: ${(err as Error).message}`));
  }
  subscribed() {}
  beforeStateEvent() {}
  idle() {}
  bashCwdPinned = () => false;
  /** The daemon's `fork` tool: OpenCode 2 has no Fork runs in claude-ui yet; the model gets this as the tool's error. */
  forkRun = async (): Promise<ForkResult> => {
    throw new ToolError("OpenCode 2 sessions cannot run forks in claude-ui yet. Use the subagent tool, or inline_task for a mechanical task.");
  };
  /** Stop agent of a running inline task's card: the run ends as stopped (its session is interrupted). */
  stopSubagent = async (callId: string) => {
    const stop = this.inlineStops.get(callId);
    if (!stop) return false;
    this.inlineStops.delete(callId);
    stop();
    return true;
  };
  /** Run in background: the session is free at once; OpenCode runs the command on (its request answers at the end, the card then shows the result). */
  backgroundShell = async (id: string) => {
    const run = this.shellRun;
    if (!run?.shellId || run.shellId !== id) return false;
    run.background = true;
    this.backgrounded.add(id);
    clearInterval(run.timer);
    this.shellRun = undefined;
    this.session.emit({ ...bashPart({ id, command: run.command, status: "running" }, run.stdout), shell: "background" });
    this.toIdle();
    return true;
  };
  /** The shell a card of the Shells list stands for: a background call of the model, or a bash mode command moved to the background (its part id is the shell id). */
  private shellFor = (id: string) => this.mapper.shellOf(id) ?? (this.backgrounded.has(id) ? id : undefined);
  /** Kill: OpenCode removes the shell (its end then shows on the card). False for an unknown or ended shell. */
  stopShell = async (id: string) => {
    const sh = this.shellFor(id);
    if (!sh || this.mapper.shellEnd(sh)) return false;
    const client = await this.server.client();
    await client.shell.remove({ id: sh, location: { directory: this.cwd } });
    return true;
  };
  /** Output tails shown in the Shells list: the last read while the shell ran, for a killed one (OpenCode forgets its output). */
  private readonly shellTails = new Map<string, string>();
  /** The tail of a background shell's output: read from OpenCode while it runs, the end notice's text after. */
  shellOutput = async (id: string) => {
    const sh = this.shellFor(id);
    if (!sh) return undefined;
    const end = this.mapper.shellEnd(sh);
    let out = end?.output ?? (end ? this.shellTails.get(sh) : undefined);
    let truncated = false;
    if (out === undefined && end) return undefined;
    if (out === undefined) {
      const client = await this.server.client();
      const r = await client.shell.output({ id: sh, location: { directory: this.cwd } });
      out = r.data.output;
      truncated = r.data.truncated;
      this.shellTails.set(sh, out);
    }
    return out.length > SHELL_TAIL ? { output: out.slice(-SHELL_TAIL), truncated: true } : { output: out, truncated };
  };
  sync = async () => {};
  close = async () => {
    clearInterval(this.shellRun?.timer);
    this.engine.remove(this);
    // The session's MCP servers leave its folder in OpenCode (until a later open attaches them again); their bearer tokens are dropped.
    this.engine.mcp?.drop(this.id);
    const names = [...this.mcpOn].map((k) => mcpName(this.id, k));
    if (names.length && this.server.running())
      void this.server
        .client()
        .then((c) => Promise.all(names.map((server) => c.experimental.mcp.remove({ server, location: { directory: this.cwd } }).catch(() => undefined))))
        .catch(() => undefined);
  };
  activity = () => ({ received: 0, at: 0, progress: 0 });
  live = () => this.server.running();
  reloadPlugins = async () => undefined;
  restartQuery() {}
  releaseQuery = () => false;
  externalTurnRunning = () => false;
  untitled = () => false;
  bashRunning = () => !!this.shellRun;
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
    /** The daemon's `/opencode-mcp` route: the URL and bearer tokens of a session's MCP servers. */
    readonly mcp?: OpenCodeMcpRoute,
    /** The Inline visualizations setting. */
    readonly visualizeOn?: () => boolean,
  ) {}

  /** OpenCode's snapshot store (same layout as OpenCode 1): the data folder; `projectID` of the session row and the project's `canonical` folder as the worktree (cached; a failed read is not). */
  readonly snapshots: SnapshotSource = (() => {
    const projects = new Map<string, Promise<{ projectID: string; worktree: string }>>();
    return {
      data: () => this.server.dataDir(),
      project: (cwd, sessionId) => {
        const key = `${sessionId}\0${cwd}`;
        let hit = projects.get(key);
        if (!hit) {
          hit = (async () => {
            const client = await this.server.client();
            const row = await client.session.get({ sessionID: sessionId });
            const project = (await client.project.list()).find((p) => p.id === row.projectID);
            if (!project?.canonical) throw new Error("no project folder");
            return { projectID: row.projectID, worktree: project.canonical };
          })();
          projects.set(key, hit);
          hit.catch(() => projects.delete(key));
        }
        return hit.then((v) => v, () => undefined);
      },
    };
  })();

  permissionModes = (o: { allowBypass?: boolean; supportsAuto?: boolean }) => permissionModesFor({ ...o, modes: OPENCODE_PERMISSION_MODES });

  open(session: Session, opts: SessionOpts, restored?: Restored) {
    return new OpenCode2Session(this, session, opts, restored?.history as OpenCode2History | undefined);
  }

  add(s: OpenCode2Session) {
    this.sessions.set(s.id, s);
    this.owners.clear();
    const first = !this.unsubscribe;
    this.unsubscribe ??= this.server.events(
      {
        event: (dir, payload) => {
          // OpenCode loaded or changed a folder's agents or commands (its first load included): read them again.
          if (payload.type === "agent.updated" || payload.type === "command.updated") return this.listsChanged(dir);
          // A shell's end names no session: the session whose call started it shows it.
          if (payload.type === "shell.exited") return this.sessions.forEach((o) => o.shellExited(payload.properties));
          // A form names its session inside the form.
          const sid: unknown = payload.properties.sessionID ?? payload.properties.form?.sessionID;
          if (typeof sid !== "string") return;
          const own = this.sessions.get(sid);
          if (own) return own.event(payload.type, payload.properties);
          const inline = this.inlineOwners.get(sid);
          if (inline) return inline.inlineEvent(sid, payload.type, payload.properties);
          // A subagent's session: only its permission requests and questions are shown (the user must be able to answer them, or the turn waits for ever).
          if (payload.type === "permission.asked" || payload.type === "form.created")
            void this.ownerOf(sid).then((owner) => owner && this.sessions.get(owner)?.event(payload.type, payload.properties));
          else if (payload.type === "permission.replied" || payload.type === "form.replied" || payload.type === "form.cancelled")
            for (const o of this.sessions.values()) o.event(payload.type, payload.properties);
        },
        resync: () => (this.modelLists.clear(), this.listsChanged(undefined), this.sessions.forEach((o) => void o.resync())),
      },
      2,
    );
    // OpenCode lists a folder's built-in agents and commands before its own ones, then says `agent.updated`: an event sent before this stream opened is lost, so the
    // lists read before (a session create or the chooser) are read again once it is open.
    if (first) void this.server.streamReady().then(() => this.listsChanged(undefined));
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
  isOurs = async (own: string, sid: string) => sid === own || this.inlineOwners.get(sid)?.id === own || (await this.ownerOf(sid)) === own;

  /** Inline runs' sessions and the session each belongs to: their events go to it. */
  private readonly inlineOwners = new Map<string, OpenCode2Session>();
  adoptInline = (id: string, owner: OpenCode2Session) => void this.inlineOwners.set(id, owner);
  releaseInline = (id: string) => void this.inlineOwners.delete(id);

  /** The agent lists and commands of `dir` (none: of every folder) are read again; its open sessions show the new ones. */
  private listsChanged(dir: string | undefined) {
    // OpenCode names the folder by its real path: a folder opened through a link matches none, then every folder is read again.
    if (dir && ![...this.agentLists.keys(), ...this.commandLists.keys(), ...[...this.sessions.values()].map((s) => s.cwd)].includes(dir)) dir = undefined;
    for (const map of [this.agentLists, this.commandLists, this.defaults]) for (const k of [...map.keys()]) if (!dir || k === dir) map.delete(k);
    for (const s of this.sessions.values()) if (!dir || s.cwd === dir) (void s.refreshAgents(), void s.emitCommands());
  }
  /** Forgets the cached agents and default agent of `cwd`: the next read asks OpenCode (a config change made them stale before OpenCode's own event). */
  forgetAgents(cwd: string) {
    this.agentLists.delete(cwd);
    this.defaults.delete(cwd);
  }
  /**
   * Reloads OpenCode's locations so a changed config file is read (`POST /api/location/reload`: 2.3.0 never re-reads a file by itself). The reload rebuilds every loaded
   * location and ends running tools and asks, so it runs only when no session is running anywhere: false = not done (busy, or the server did not answer), the caller keeps
   * the change pending (folder-reload.ts). The lists of the folders are read again; the daemon's MCP servers the reload drops are attached again by the next prompt.
   */
  async reloadLocations(cwds: string[] = []): Promise<boolean> {
    try {
      const client = await this.server.client();
      if (Object.keys((await client.session.active()) ?? {}).length) return false;
      await client.location.reload();
      // 2.3.0 answers empty lists for 1-3 s after a reload: the dialogs are told only once the folders list again (at most RELOAD_SETTLE_MS).
      const until = Date.now() + RELOAD_SETTLE_MS;
      for (const cwd of cwds) {
        const location = { location: { directory: cwd } };
        while (Date.now() < until) {
          const [a, p] = await Promise.all([client.agent.list(location), client.plugin.list(location)]);
          if ((a.data as unknown[]).length && (p.data as unknown[]).length) break;
          await new Promise((r) => setTimeout(r, AGENT_POLL_MS));
        }
      }
    } catch {
      return false;
    }
    this.modelLists.clear();
    this.listsChanged(undefined);
    return true;
  }
  private agentLists = new Map<string, { at: number; ttl: number; list: Promise<Agent2[]> }>();
  /**
   * `GET /api/agent` of a folder (project agents differ per folder), cached 60 s (a cold folder's first list 5 s) and until OpenCode says they changed. A folder OpenCode has not loaded yet lists
   * no agent (2.3.0): read again until it lists some. A failure drops the entry, so the next call (session open, the chooser's retry) asks again.
   */
  agents(cwd: string): Promise<Agent2[]> {
    const hit = this.agentLists.get(cwd);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.list;
    const entry = { at: Date.now(), ttl: AGENTS_MS } as { at: number; ttl: number; list: Promise<Agent2[]> };
    const list = (entry.list = (async () => {
      const c = await this.server.client();
      for (let i = 0; ; i++) {
        const l = (await c.agent.list({ location: { directory: cwd } })).data as unknown as Agent2[];
        // A folder that was cold lists its built-ins first (2.3.0 lists its own agents ~0.2 s later); without an event stream no `agent.updated` says they came.
        if (l.length) {
          entry.at = Date.now();
          const cold = i > 0 && !this.unsubscribe;
          entry.ttl = cold ? COLD_AGENTS_MS : AGENTS_MS;
          if (cold) this.rereadAgents(cwd, entry);
          return l;
        }
        if (i >= AGENT_POLLS) throw new Error("OpenCode lists no agent for this folder");
        await new Promise((r) => setTimeout(r, AGENT_POLL_MS));
      }
    })());
    this.agentLists.set(cwd, entry);
    list.catch(() => this.agentLists.get(cwd)?.list === list && this.agentLists.delete(cwd));
    return list;
  }
  /** A cold folder's first list has its built-ins only (no event stream says the rest came): one read ~SETTLE_MS later replaces the cache and is pushed to the folder's sessions; the caller did not wait. */
  private rereadAgents(cwd: string, entry: { at: number; ttl: number; list: Promise<Agent2[]> }) {
    setTimeout(async () => {
      if (this.agentLists.get(cwd) !== entry) return;
      try {
        const l = (await (await this.server.client()).agent.list({ location: { directory: cwd } })).data as unknown as Agent2[];
        if (!l.length || this.agentLists.get(cwd) !== entry) return;
        this.agentLists.set(cwd, { at: Date.now(), ttl: AGENTS_MS, list: Promise.resolve(l) });
        this.defaults.delete(cwd); // the default agent may be one of the own agents the first list lacked
        for (const s of this.sessions.values()) if (s.cwd === cwd) void s.refreshAgents();
      } catch {
        // The cached first list stays until its short TTL ends.
      }
    }, SETTLE_MS).unref();
  }
  private defaults = new Map<string, { at: number; name: Promise<string> }>();
  /** The last known default agent per folder: the synchronous reads (session info) use it until the first `defaultAgent` answers. */
  private defaultKnown = new Map<string, string>();
  defaultAgentKnown = (cwd: string) => this.defaultKnown.get(cwd) ?? "build";
  /**
   * The agent OpenCode runs a session as when none is chosen: the config's `default_agent` (its highest-priority document that sets one, `GET /api/config`) when it
   * is a visible primary agent, else `build`, else the first primary agent, else `build`. Cached with the agent list; a failed read falls back without a notice.
   */
  defaultAgent(cwd: string): Promise<string> {
    const hit = this.defaults.get(cwd);
    if (hit && Date.now() - hit.at < 60_000) return hit.name;
    const name = (async () => {
      let failed = false;
      const primary = primaryAgents2(await this.agents(cwd).catch(() => ((failed = true), [])));
      const docs = await this.server
        .client()
        .then((c) => c.config.get({ location: { directory: cwd } }))
        .catch(() => [] as unknown[]);
      const configured = (docs as { info?: { default_agent?: string } }[]).map((d) => d.info?.default_agent).filter(Boolean).at(-1);
      const pick = primary.find((a) => a.id === configured)?.id ?? primary.find((a) => a.id === "build")?.id ?? primary[0]?.id ?? "build";
      if (failed) this.defaults.delete(cwd);
      else this.defaultKnown.set(cwd, pick);
      return pick;
    })();
    this.defaults.set(cwd, { at: Date.now(), name });
    return name;
  }
  /** The primary agents of a folder, the default agent first (the chooser preselects the first). */
  async primaryFirst(cwd: string): Promise<Agent2[]> {
    const [list, first] = [primaryAgents2(await this.agents(cwd)), await this.defaultAgent(cwd)];
    return [...list.filter((a) => a.id === first), ...list.filter((a) => a.id !== first)];
  }
  private commandLists = new Map<string, { at: number; list: Promise<SlashCommand[]> }>();
  /**
   * The slash menu of a folder: the daemon's `/compact`, `/undo`, `/redo`, then `GET /api/command` (built-ins, project and user commands), cached as the agents.
   * Read after the agents: a folder OpenCode has not loaded yet lists only the built-in commands.
   */
  commands(cwd: string): Promise<SlashCommand[]> {
    return this.serverCommands(cwd).then((l) => withVisualize(l, !!this.visualizeOn?.()));
  }
  /** `commands` without the daemon's `/visualize` (it follows the setting per call, this list is cached). */
  serverCommands(cwd: string): Promise<SlashCommand[]> {
    const hit = this.commandLists.get(cwd);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    const list = (async () => {
      await this.agents(cwd).catch(() => undefined);
      const c = await this.server.client();
      const raw = (await c.command.list({ location: { directory: cwd } })).data as unknown as { name: string; description?: string }[];
      return [...LOCAL_COMMANDS, ...raw.filter((x) => !LOCAL_NAMES.includes(x.name)).map((x) => ({ name: x.name, description: x.description ?? "", argumentHint: "" }))];
    })();
    this.commandLists.set(cwd, { at: Date.now(), list });
    list.catch(() => this.commandLists.get(cwd)?.list === list && this.commandLists.delete(cwd));
    return list;
  }
  /** The rules and agent of a new session in `mode` (`plan` = agent plan in the default mode): the mode's rules with the agent's denials. Rejects when the agents cannot be read. */
  async createRules(mode: PermissionMode, cwd: string): Promise<{ rules: Rule2[]; agent?: string }> {
    const list = await this.agents(cwd);
    const agent = mode === "plan" ? "plan" : await this.defaultAgent(cwd);
    const rules = rulesOf(mode === "plan" ? "default" : mode, false, denialsOf2(list.find((a) => a.id === agent)?.permissions ?? []));
    return { rules, ...(mode === "plan" && { agent }) };
  }
  /** What each new session was created with, until its OpenCode2Session takes it. */
  private readonly created = new Map<string, { rules: Rule2[]; agent?: string }>();
  noteCreated = (id: string, c: { rules: Rule2[]; agent?: string }) => void this.created.set(id, c);
  createdAs = (id: string) => {
    const c = this.created.get(id);
    this.created.delete(id);
    return c;
  };

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
export const createOpenCode2Engine = (server: OpenCodeServer, o: { onTitle?: (id: string, title: string) => void; record?: (id: string) => void; mcp?: OpenCodeMcpRoute; visualizeOn?: () => boolean } = {}): OpenCode2Engine => new OpenCode2EngineImpl(server, o.onTitle, o.record, o.mcp, o.visualizeOn);
