// The OpenCode Engine (ADR 0012, docs/spec.md "OpenCode engine"): sessions run on the daemon's OpenCode server (opencode-server.ts). One event
// stream of the server feeds every open session; prompts, permissions and questions go back as HTTP calls.
import { randomUUID } from "node:crypto";
import { permissionModesFor, type Effort, type EffortLevel, type EngineCapabilities, type ModelInfo, type PermissionMode, type PermissionUpdate, type Question, type RewindMode, type RewindPreview, type SlashCommand } from "@claude-ui/protocol";
import { ASIDE_NO_EDIT, ASIDE_NO_WORKERS } from "./aside.ts";
import { COORDINATOR_DENIED } from "./claude-engine.ts";
import type { Engine, EngineSession, Reply, Restored } from "./engine.ts";
import { MAX_WAIT_MS } from "./orchestration.ts";
import { DAEMON_SERVER } from "./daemon-mcp.ts";
import { errorKey, errorText, firstLine } from "./opencode-errors.ts";
import { ascending } from "./opencode-id.ts";
import { INLINE_SYSTEM, InlineCollector, clip, inlineTools, lastAssistantText } from "./opencode-inline.ts";
import { INLINE_TIMEOUT_MS, type InlineHooks, type InlineResult, type InlineSpec } from "./inline-types.ts";
import { mapTool, openCodeParts, OpenCodeMapper, type OpenCodeMessage, type OpenCodeTodo } from "./opencode-parts.ts";
import { OpenCodeHttpError, type OpenCodeServer } from "./opencode-server.ts";
import { StopControl } from "./opencode-stop.ts";
import { mapLimit } from "./session-scan.ts";
import { visualizeSystem } from "./visualize.ts";
import type { Session, SessionOpts, SessionSettings } from "./session.ts";

/** Modes OpenCode sessions accept; no `auto` or `dontAsk`. `plan` is the `plan` agent (GH-684): accepted as input, never offered. */
export const OPENCODE_MODES: PermissionMode[] = ["config", "default", "acceptEdits", "plan", "bypassPermissions"];
/** Modes offered: config first (the default, GH-705); plan is the plan agent (GH-684). */
export const OPENCODE_PERMISSION_MODES: PermissionMode[] = ["config", "default", "acceptEdits", "bypassPermissions"];
export const OPENCODE_CAPABILITIES: EngineCapabilities = { permissionModes: OPENCODE_PERMISSION_MODES, agents: true, effort: true, rewind: true, fork: true, steering: true, slashCommands: true, planMeter: false, account: false, contextUsage: true, shell: true };

export type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" };
/** An entry of `GET /agent`. */
export type OpenCodeAgent = { name: string; description?: string; mode?: string; hidden?: boolean | null; permission: Rule[] };
/** The agents a user chooses from (OpenCode's own filter): primary or all, not hidden. */
export const primaryAgents = (list: OpenCodeAgent[]) => list.filter((a) => !a.hidden && a.mode !== "subagent");
/**
 * The rules of `permission` that must win over the permission mode: for each key, its deny rules and the rules that follow its first deny (the
 * exceptions to it: plan's plan-file `edit` allow). An agent's allow rules before that (`bash * allow`) are not appended: they would turn
 * Ask before edits into allow, while the deny still wins.
 */
export const denialsOf = (permission: readonly Rule[]): Rule[] => {
  const first = new Map<string, number>();
  permission.forEach((r, i) => r.action === "deny" && !first.has(r.permission) && first.set(r.permission, i));
  return permission.filter((r, i) => i >= (first.get(r.permission) ?? Infinity));
};
const MARK = "claude-ui";
const marker = (pattern: string): Rule => ({ permission: MARK, pattern, action: "allow" });
const star = (permission: string, action: Rule["action"]): Rule => ({ permission, pattern: "*", action });
const ANSWERED = "Answered in OpenCode";
/**
 * OpenCode answers 499 to every read of lazy state whose first load a client cut off: MCP (GH-682) and providers (GH-679). 1.19.5 keeps the interruption
 * until the folder's instance is disposed (providers: for the whole server, until a restart); every turn in a broken MCP folder then aborts before the
 * model call, with no `session.error`. So the rule of the daemon: a request that waits for such a load (`GET /mcp`, `POST /mcp`, `GET /command`, the
 * disconnect, `GET /config/providers`) is never aborted (`timeoutMs: 0`). A caller that must not wait long races it against a timer and leaves the
 * request running; it never passes a signal that fires.
 */
export const brokenState = (err: unknown) => err instanceof OpenCodeHttpError && err.status === 499;
/** A provider read still answered 499 after the folder's instance was disposed: OpenCode's provider state is broken server-wide (only a restart clears it). */
export class ProviderStateBroken extends Error {
  constructor() {
    super("OpenCode's provider state is broken for the whole server");
  }
}
const SELF_ABORT = "OpenCode ended this turn on its own before the model answered (MessageAbortedError); claude-ui did not stop it.";
const MCP_RELOADED = "OpenCode's MCP servers for this folder had failed to load, so claude-ui reloaded the folder in OpenCode. Send the prompt again.";
const MCP_HEALTHY = "OpenCode's MCP servers for this folder work again. Send the prompt again.";
const MCP_BROKEN_BUSY = "OpenCode's MCP servers for this folder failed to load; claude-ui reloads the folder when the turn running in it ends. Send the prompt again then.";
/** The daemon's MCP servers a session attaches to OpenCode: orchestration, and `claude-ui` (daemon-mcp.ts). */
export type McpServerKey = "orchestration" | typeof DAEMON_SERVER;
const MCP_KEYS: McpServerKey[] = ["orchestration", DAEMON_SERVER];
const sameKeys = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((k) => b.has(k));
/** The name of a session's MCP server in OpenCode; its tool keys are `<name>_<tool>` (fit OpenCode's tool name limit). */
export const mcpName = (id: string, server: McpServerKey = "orchestration") => `${server}-${id.slice(-10)}`;
const WORKER_START = "mcp__orchestration__worker_start";
const ORCHESTRATION = { name: "orchestration", source: "sdk" };

/**
 * The rules a permission mode appends to a session (OpenCode evaluates last match wins; rules cannot be removed through the API, so a mode
 * change appends a whole new block). Marker rules (`claude-ui`) match no tool: they tell a restore which mode is in force and where the
 * "always allow" rules start. `agentRules`: the current agent's denials (`denialsOf`), appended after the mode's rules: OpenCode evaluates the
 * session's rules after the agent's, so without them a custom agent's `edit: deny` (or plan's) would lose to the mode.
 * `config` has no tool rules of its own: OpenCode's config and the agent decide (GH-705).
 * shortcut: every mode change appends one block; fine for hundreds of switches.
 */
export function modeBlock(mode: PermissionMode, always: Rule[], agentRules: Rule[], { readOnly = false, mcp, daemon, agent, config }: { /** The session's own claude-ui server's rules (`DaemonMcp.openCodeRules`), when attached. */ daemon?: Rule[]; /** `config` mode: the agent's whole ruleset, re-applied to undo an earlier block's tool rules; absent on create. */ config?: Rule[]; readOnly?: boolean; /** The session's own orchestration MCP server name, when attached. */ mcp?: string; /** The agent the block was written for. */ agent?: string } = {}): Rule[] {
  const asks = [star("webfetch", "ask"), star("websearch", "ask")];
  const rules =
    mode === "config" ? (config ?? [])
    : mode === "bypassPermissions" ? ["bash", "edit", "webfetch", "websearch", "external_directory", "doom_loop"].map((p) => star(p, "allow"))
    : mode === "acceptEdits" ? [star("bash", "ask"), star("edit", "allow"), ...asks]
    : [star("bash", "ask"), star("edit", "ask"), ...asks];
  // Orchestration MCP servers are attached per folder: hide every session's tools but the own ones; worker_start asks (the user's gate on new workers).
  // The claude-ui servers are per session too: every session's tools are hidden but the own ones.
  const orchestration = [star(`${DAEMON_SERVER}-*`, "deny"), ...(daemon ?? []), star("orchestration-*", "deny"), ...(mcp ? [star(`${mcp}_*`, "allow"), ...(mode === "bypassPermissions" ? [] : [star(`${mcp}_worker_start`, "ask")])] : [])];
  // A read-only Aside: the last matching rule hides edit, write and apply_patch, whatever the mode allows.
  return [marker(`mode:${mode}`), ...(agent ? [marker(`agent:${agent}`)] : []), ...rules, ...agentRules, ...orchestration, ...(readOnly ? [star("edit", "deny")] : []), marker("always"), ...always, ...denialTail(always, agentRules, readOnly)];
}
/** The agent's and the Aside's denials again after the always rules (last match wins), so an always-allow rule never beats them (GH-705). */
export const denialTail = (always: readonly Rule[], agentRules: Rule[], readOnly: boolean): Rule[] => {
  const denials = [...agentRules, ...(readOnly ? [star("edit", "deny")] : [])];
  return always.length && denials.length ? [marker("denials"), ...denials] : [];
};
const lastMarker = (rules: readonly Rule[], test: (pattern: string) => boolean) => rules.map((r) => r.permission === MARK && test(r.pattern)).lastIndexOf(true);
/** The "always allow" rules of a session: the ones after the last `always` marker, up to the next marker (`denials`). */
export const alwaysOf = (rules: readonly Rule[]): Rule[] => {
  const i = lastMarker(rules, (p) => p === "always");
  if (i < 0) return [];
  const rest = rules.slice(i + 1);
  const end = rest.findIndex((r) => r.permission === MARK);
  return end < 0 ? rest : rest.slice(0, end);
};
/** The rules of the last block (all rules when there is none). */
const lastBlock = (rules: readonly Rule[]) => rules.slice(Math.max(lastMarker(rules, (p) => p.startsWith("mode:")), 0));
/** The agent of the last block, undefined for a session without one (or a block from before agents). */
export const agentOf = (rules: readonly Rule[]): string | undefined => {
  const block = lastBlock(rules);
  const i = lastMarker(block, (p) => p.startsWith("agent:"));
  return i < 0 ? undefined : block[i]!.pattern.slice(6);
};
/** The mode of the last block, undefined for a session without one. */
export const modeOf = (rules: readonly Rule[]): PermissionMode | undefined => {
  const i = lastMarker(rules, (p) => p.startsWith("mode:"));
  return i < 0 ? undefined : (rules[i]!.pattern.slice(5) as PermissionMode);
};

type PermissionAsked = { id: string; sessionID: string; permission: string; patterns?: string[]; metadata?: Record<string, unknown>; always?: string[]; tool?: { callID?: string } };
type QuestionAsked = { id: string; sessionID: string; questions: { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean }[]; tool?: { callID?: string } };
type Status = { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; /** `retry`: when the next attempt starts (epoch ms of OpenCode's clock). */ next?: number };
/** What the `model_retry` part carries. */
type Retry = { attempt: number; message: string; next?: number };
type Payload = { type: string; properties: Record<string, any> };

/** What `begin()` and `resync()` read of a session: stored messages (and those of its subagents), busy state, pending requests of the folder. */
export type OpenCodeHistory = { messages: OpenCodeMessage[]; children: Record<string, OpenCodeMessage[]>; busy: boolean; /** OpenCode is waiting to retry the model call (its status `retry`: counts as busy). */ retry?: Retry; /** The message OpenCode's `revert` cuts the conversation at (it and everything after are hidden). */ revert?: string; permission: Rule[]; permissions: PermissionAsked[]; questions: QuestionAsked[] };

/** The `model_retry` state of a `retry` status: the first line of the reason (OpenCode may append more). */
const retryOf = (s: Status): Retry => ({ attempt: s.attempt ?? 1, message: firstLine(s.message ?? ""), ...(typeof s.next === "number" && { next: s.next }) });

export async function loadOpenCodeHistory(server: OpenCodeServer, id: string, cwd: string): Promise<OpenCodeHistory> {
  // No timeout: reopening a session after a restart reads a cold folder, whose first answer takes more than 3 s; giving up would lose the session.
  const at = { directory: cwd, timeoutMs: 0 };
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
  const st = status[id];
  return { messages, children, busy: st?.type === "busy" || st?.type === "retry", ...(st?.type === "retry" && { retry: retryOf(st) }), revert, permission: row.permission ?? [], permissions, questions };
}

/** `GET /config/providers`: the connected providers with their models (`variants`: the model's reasoning variants by name) and the default model per provider. */
type ProviderList = { providers: { id: string; name: string; models: Record<string, { name: string; limit?: { context?: number }; variants?: Record<string, unknown> }> }[]; default?: Record<string, string> };
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
/** The effort levels of a model: its variant names that are effort levels (`none`, `minimal` are not), in effort order. */
const levelsOf = (m?: { variants?: Record<string, unknown> }) => EFFORT_ORDER.filter((l) => l in (m?.variants ?? {}));
const defaultOf = (r: ProviderList) => {
  const [provider, model] = Object.entries(r.default ?? {})[0] ?? [];
  const p = r.providers.find((x) => x.id === provider);
  return p && model ? { p, id: model, m: p.models[model] } : undefined;
};
/** Default, then every provider's models under the provider name; a model with reasoning variants offers them as effort levels. */
export function modelsFrom(r: ProviderList): ModelInfo[] {
  const effort = (m?: { variants?: Record<string, unknown> }) => {
    const levels = levelsOf(m);
    return levels.length ? { supportsEffort: true, supportedEffortLevels: levels } : {};
  };
  const def = defaultOf(r);
  const name = def ? `Default (${def.p.name} ${def.m?.name ?? def.id})` : "Default";
  return [{ value: "default", displayName: name, description: "", ...effort(def?.m) }, ...r.providers.flatMap((x) => Object.entries(x.models).map(([id, m]) => ({ value: `${x.id}/${id}`, displayName: m.name, description: "", group: x.name, ...effort(m) })))];
}
/** The models of the connected providers of `cwd`'s OpenCode instance (`GET /config/providers`; none: the server's own folder). Never cut off; rejects when it fails. */
export const openCodeModels = (engine: OpenCodeEngine, cwd?: string): Promise<ModelInfo[]> => engine.providerList(cwd, { strict: true }).then(modelsFrom);

/**
 * A multi-select answer is the chosen labels joined with ", ": cut it at the option labels (longest first), so a label holding ", " stays whole; the rest is the user's own text.
 * shortcut: only for answers without `choices` (a coordinator's `worker_answer`); the web sends `choices`. Free text that starts with a label and ", ", or equals a label, is still read as that label.
 */
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

type TurnEnd = { done: Promise<void>; resolve: () => void };
/** The longest a prompt sent after Stop waits for the aborted turn to end. */
const TURN_END_WAIT_MS = 10_000;
/** How long a prompt request that answered after a Stop is watched for the turn it may start in OpenCode. */
const STALE_WATCH_MS = 1000;
/** How long the Stop waits for OpenCode's answer to the abort before it reads the turn's end anyway (the request keeps running). */
const ABORT_WAIT_MS = 3000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Commands the daemon itself runs for an OpenCode session (OpenCode's web app has them as session commands, not server commands). */
const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Summarize the conversation to free context", argumentHint: "" },
  { name: "undo", description: "Undo the last message and its file changes", argumentHint: "" },
  { name: "redo", description: "Redo the last undone message", argumentHint: "" },
];
const LOCAL_NAMES = LOCAL_COMMANDS.map((c) => c.name);
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
  /** The agent chosen with `setAgent`, the plan alias, or followed from OpenCode's own UI; else the worker link's agent, else build. */
  private chosen: string | undefined;
  /** The agent of the last block written (the block holds its denials). */
  private writtenAgent: string | undefined;
  /** A followed agent switch is being written (one block per switch, however many `message.updated` events). */
  private following = false;
  /** A bash mode command (`POST /shell`, no model call) is running as the turn: its end sends no `turn_result`. */
  private shellRun = false;
  /** Settles when the running turn goes idle. */
  private turnEnd: TurnEnd | undefined;
  /** Tokens and model of the last completed assistant message of this session (its context window use). */
  /** The message OpenCode's revert cuts the conversation at, undefined when none (a prompt clears it: OpenCode removes the cut messages then). */
  private revertAt: string | undefined;
  /** Names of the commands last listed: `/name` of one of them runs it. */
  private commandNames = new Set<string>();
  private usage: { tokens: NonNullable<OpenCodeMessage["info"]["tokens"]>; providerID: string; modelID: string } | undefined;
  /** The MCP servers attached to OpenCode: orchestration (on, no unkept Aside) and claude-ui (a tool group enabled); `writtenMcp`: those the last block written has rules for. */
  private mcpOn = new Set<McpServerKey>();
  private writtenMcp: Set<McpServerKey>;
  private attaching: Promise<void> | undefined;
  /** The assistant message OpenCode aborted on its own in this turn (no Stop, no `session.error`). */
  private selfAbort: string | undefined;
  /** The user messages of the running turn (its prompt, steering ones): only an answer to one of them can be a self-abort of this turn. */
  private turnUsers = new Set<string>();
  /** Where each send() is (preparing, posting, posted, dropped): what a Stop does to it (opencode-stop.ts). */
  private readonly stops = new StopControl();
  /** The Stop mark of the running turn (`stops.count` when it began): a turn begun after the last Stop has the current count. */
  private turnStop = 0;
  /** Something of the running turn may have reached OpenCode (a request posted, or the turn found busy there). */
  private turnPosted = true;
  /** Settles when the prompt requests an earlier Stop left on their way can no longer start a turn in OpenCode: a new prompt waits for it. */
  private stale: Promise<void> | undefined;
  /**
   * Set from a Stop that left prompt requests on their way until they can no longer start a turn in OpenCode. While the stopped turn no
   * longer shows here (`hiding()`), OpenCode's events of the session belong to a stopped prompt that reached it late: they are not shown,
   * `busy` and `idle` report them to cleanStale().
   */
  private quiet: { busy: () => void; idle: () => void } | undefined;
  /** The model call is being retried (a `model_retry` part is set), undefined when not. */
  private retrying: Retry | undefined;
  /** The last retry attempt of the turn: a failing turn says OpenCode gave up after that many retries. */
  private lastAttempt = 0;
  /** Counts the `session.status` events seen: a read of the status that a live one overtook is not applied. */
  private statusEvents = 0;
  /** An id of the running turn, kept after it ended: an error after idle belongs to it (and a notice of the turn has an id of its own). */
  private turnKey = ascending("msg");
  /** The last assistant message of the running turn (its id is the id of the turn's error notice, as at a restore) and its model. */
  private turnAssistant: { id: string; model?: string } | undefined;
  /** The errors the turn showed (`errorKey`): OpenCode 1.19.5 sends a model-not-found error twice. */
  private errorKeys = new Set<string>();
  /** Running inline tasks (GH-734) by child session id: `ui` = the child's parts show under the parent's call. */
  private readonly inlines = new Map<string, { notify: (e: Payload) => void; ui: boolean }>();
  /** The `inline_task` calls an inline run already took. */
  private readonly inlineClaimed = new Set<string>();
  /** Stop per running inline call id (the card's Stop agent): ends the run as stopped. */
  private readonly inlineStops = new Map<string, () => void>();

  constructor(
    private readonly engine: OpenCodeEngineImpl,
    private readonly session: Session,
    private readonly opts: SessionOpts,
    private readonly history?: OpenCodeHistory,
  ) {
    this.model = opts.model ?? "default";
    // A restored session without a saved mode has the one of its last block in OpenCode (bypass only when the daemon allows it); without a block it ran under OpenCode's config (GH-705).
    const marked = history && modeOf(history.permission);
    const mode = opts.permissionMode ?? (!marked ? "config" : OPENCODE_MODES.includes(marked) && (marked !== "bypassPermissions" || opts.allowBypass) ? marked : "default");
    // Plan is the plan agent (GH-684): a saved, restored or requested plan mode opens as agent `plan` with the default permission mode.
    this.permissionMode = mode === "plan" ? "default" : mode;
    if (mode === "plan") this.chosen = "plan";
    this.effort = opts.effort ?? "default";
    // A new session got its block with `POST /session` (the plan agent for a plan start, else build); a legacy plan block has no agent marker.
    this.written = history ? modeOf(history.permission) : this.permissionMode;
    this.writtenAgent = history ? agentOf(history.permission) : (this.chosen ?? "build");
    this.always = history ? alwaysOf(history.permission) : [];
    this.revertAt = history?.revert;
    this.writtenMcp = new Set(
      history
        ? MCP_KEYS.filter((k) => lastBlock(history.permission).some((r) => (k === "orchestration" ? r.permission === `${mcpName(session.id)}_*` && r.action === "allow" : r.permission.startsWith(`${mcpName(session.id, k)}_`))))
        : [],
    );
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
  owns = (sessionId: string) => sessionId === this.id || this.mapper.isChild(sessionId) || this.inlines.has(sessionId);

  begin() {
    this.engine.add(this);
    void this.emitCommands();
    void this.emitAgents();
    void this.attach();
    if (!this.history) return;
    this.apply(this.history);
    this.session.setState(this.history.busy ? "running" : "idle");
    if (this.history.busy) (this.turnAt = Date.now(), this.turnKey = ascending("msg"), this.openTurnEnd(), this.noteLastUser(this.history.messages));
    this.setRetry(this.history.retry);
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
    // /compact, /undo and /redo are ours: with arguments they are a plain prompt, never a server command.
    this.commandNames = new Set(commands.map((c) => c.name).filter((n) => !LOCAL_NAMES.includes(n)));
    this.session.emit({ type: "commands", id: "commands", commands });
  }

  /** The `agents` part; `failed: true` when OpenCode did not answer (the web offers a retry, which calls this again). Never waits for the caller. */
  refreshAgents = async () => {
    const list = await this.engine.agents(this.cwd).catch(() => undefined);
    if (!list) return void this.session.emit({ type: "agents", id: "agents", agents: [], failed: true });
    this.session.emit({ type: "agents", id: "agents", agents: primaryAgents(list).map(({ name, description }) => ({ name, ...(description && { description }) })) });
  };
  private emitAgents = () => this.refreshAgents();

  private noteUsage(info: OpenCodeMessage["info"]) {
    if (info.role === "assistant" && info.time?.completed && info.tokens && info.providerID && info.modelID) this.usage = { tokens: info.tokens, providerID: info.providerID, modelID: info.modelID };
  }

  /** The `context_usage` part from the last completed assistant message; none while the window of its model is unknown. */
  private async emitUsage() {
    const u = this.usage;
    const max = u && (await this.engine.contextLimit(u.providerID, u.modelID, this.cwd));
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
    const seen = this.statusEvents;
    return (this.resyncing ??= loadOpenCodeHistory(this.server, this.id, this.cwd)
      .then((h) => {
        this.apply(h);
        // A status event that came while the read ran is newer than the read.
        if (seen === this.statusEvents) this.setRetry(h.retry);
        void this.emitCommands();
        void this.emitAgents();
        this.requests(h);
        const state = this.session.currentState();
        if (h.busy && state === "idle" && !this.hiding()) (this.beginTurn(), this.noteLastUser(h.messages), this.session.setState("running"));
        // A prompt just sent may not be busy in OpenCode yet.
        else if (!h.busy && state === "running" && Date.now() - this.sentAt > 3000) this.finish();
      })
      .catch(() => {})
      .finally(() => (this.resyncing = undefined)));
  }

  settings(): SessionSettings {
    return { model: this.model, permissionMode: this.permissionMode, effort: this.effort, agent: this.agentName() };
  }
  private changed(...fields: (keyof SessionSettings)[]) {
    this.opts.onSettings?.(this.settings(), this.id, fields);
  }
  private notice(id: string, text: string) {
    this.session.emit({ type: "notice", id: `${this.id}:${id}`, level: "warning", text });
  }
  /** A warning of its own: a notice id is reused only to update the same warning, so each occurrence has one (a second one must not rewrite the first in an older turn). */
  private occurrence(kind: string, text: string, key = ascending("msg")) {
    this.notice(`${kind}:${key}`, text);
  }

  /** Sets the retry state of the model call (the `model_retry` head part); only a change is emitted. */
  private setRetry(r: Retry | undefined) {
    const was = this.retrying;
    if (!r && !was) return;
    if (r && was && r.attempt === was.attempt && r.message === was.message && r.next === was.next) return;
    this.retrying = r;
    if (r) this.lastAttempt = r.attempt;
    this.session.emit({ type: "model_retry", id: "model_retry", retry: r ?? null });
  }

  async setModel(model: string) {
    this.model = model;
    this.session.emit({ type: "session_model", id: "session_model", model });
    this.changed("model");
  }
  async setPermissionMode(mode: PermissionMode) {
    if (mode === "plan") return this.setAgent("plan");
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

  /** Applies from the next prompt: the block gets the agent's denials; `agent` must be a primary agent of OpenCode here. */
  async setAgent(agent: string) {
    const list = primaryAgents(await this.engine.agents(this.cwd));
    if (!list.some((a) => a.name === agent)) throw new Error(`unknown agent ${agent}. OpenCode agents here: ${list.map((a) => a.name).join(", ")}`);
    await this.writeBlock(this.permissionMode, agent);
    this.chosen = agent;
    this.session.emit({ type: "session_agent", id: "session_agent", agent });
    this.changed("agent", "permissionMode"); // a saved legacy `plan` mode must not win over the agent at the next restore
  }

  private async agentPermission(agent: string) {
    return (await this.engine.agents(this.cwd)).find((a) => a.name === agent)?.permission ?? [];
  }
  private readOnly = () => !!this.opts.disallowedTools?.(this.id)?.some((t) => ASIDE_NO_EDIT.includes(t));

  /** The agent prompts run as. `opts.agent` (the worker link) is read lazily: orchestration writes it after the session is created. */
  private agentName = () => this.chosen ?? this.opts.agent?.(this.id) ?? "build";

  /** Writes a block for `mode` and `agent` (the agent's denials come from `GET /agent`). */
  private async writeBlock(mode: PermissionMode, agent = this.agentName()) {
    const mcp = new Set(this.mcpOn);
    const own = await this.agentPermission(agent);
    // The claude-ui tools that ask follow the mode's bash action (`config` too: OpenCode would allow an MCP tool by default).
    const daemon = mcp.has(DAEMON_SERVER) ? this.opts.daemonMcp?.openCodeRules(mcpName(this.id, DAEMON_SERVER), mode === "bypassPermissions" ? "allow" : "ask") : undefined;
    // shortcut: a config block copies the agent's rules as GET /agent gave them (cached 60 s), so later opencode.json edits reach this session after the next block write; upgrade: track whether the session ruleset has anything to undo.
    const permission = modeBlock(mode, this.always, denialsOf(own), { agent, readOnly: this.readOnly(), ...(mcp.has("orchestration") && { mcp: mcpName(this.id) }), ...(daemon && { daemon }), ...(mode === "config" && { config: own }) });
    await this.server.request(`/session/${this.id}`, { method: "PATCH", directory: this.cwd, body: { permission } });
    this.written = mode;
    this.writtenAgent = agent;
    this.writtenMcp = mcp;
  }

  /**
   * Attaches this session's orchestration MCP server to OpenCode (its folder's instance) unless it is connected: at begin and before each
   * prompt, so a restart or dispose of OpenCode (which drops it) is repaired by the next prompt. Only while orchestration is on and the
   * session is no unkept Aside; `mcpServers` binds the tools to this session, as at a Claude query start.
   */
  private attach(): Promise<void> {
    let attaching: McpServerKey = "orchestration";
    return (this.attaching ??= (async () => {
      const route = this.engine.mcp;
      const url = route?.url();
      // `mcpServers` binds the tools to this session; its keys say which servers apply. An unkept Aside gets no orchestration.
      const noWorkers = !!this.opts.disallowedTools?.(this.id)?.some((t) => ASIDE_NO_WORKERS.includes(t));
      const keys = url ? Object.keys(this.opts.mcpServers?.(this.id, "opencode") ?? {}).filter((k): k is McpServerKey => (MCP_KEYS as string[]).includes(k) && !(k === "orchestration" && noWorkers)) : [];
      this.mcpOn = new Set(keys);
      if (!keys.length) return;
      // These wait for OpenCode's MCP load of the folder: never cut off (see brokenState); a folder whose load was cut off earlier is reloaded.
      const read = () => this.server.request<Record<string, { status: string }>>("/mcp", { directory: this.cwd, timeoutMs: 0 });
      const status = await read().catch(async (err) => (brokenState(err) && (await this.engine.repairFolder(this.cwd)) ? read() : Promise.reject(err)));
      for (const key of keys) {
        attaching = key;
        const name = mcpName(this.id, key);
        if (status[name]?.status === "connected") continue;
        const timeout = key === "orchestration" ? MAX_WAIT_MS + 60_000 : (this.opts.daemonMcp?.timeoutMs() ?? 120_000);
        const config = { type: "remote", url, headers: { authorization: `Bearer ${route!.token(this.id, key)}` }, oauth: false, timeout };
        await this.server.request("/mcp", { method: "POST", directory: this.cwd, timeoutMs: 0, body: { name, config } });
      }
    })()
      .catch((err) => this.occurrence("mcp_failed", `Could not attach the ${attaching} tools to OpenCode: ${(err as Error).message}`))
      .finally(() => (this.attaching = undefined)));
  }

  prompt(text: string, images: string[] = []): string | undefined {
    const local = !images.length && /^\/(compact|undo|redo)$/.exec(text.trim())?.[1];
    if (local) {
      void this.runLocal(local as "compact" | "undo" | "redo");
      return undefined;
    }
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

  /** `/compact`, `/undo` and `/redo` (nothing is echoed): only while idle; a running turn is not steered with them. */
  private async runLocal(cmd: "compact" | "undo" | "redo") {
    const say = (text: string) => this.notice(`local:${ascending("msg")}`, text);
    if (this.session.currentState() !== "idle" || this.session.pendingCount()) return say("Stop the turn first");
    try {
      if (cmd === "compact") return await this.compact(say);
      // User messages that show in the timeline (not a shell run's or a compaction's).
      const all = await this.server.request<OpenCodeMessage[]>(`/session/${this.id}/message`, { directory: this.cwd });
      const shown = (m: OpenCodeMessage) => m.info.role === "user" && m.parts.some((p) => (p.type === "text" && !p.synthetic && !p.ignored) || (p.type === "file" && p.mime?.startsWith("image/")));
      const at = this.revertAt ? all.findIndex((m) => m.info.id === this.revertAt) : -1;
      if (cmd === "undo") {
        const target = all.slice(0, at < 0 ? all.length : at).filter(shown).at(-1);
        if (!target) return say("Nothing to undo");
        return await this.rewind(target.info.id, (await this.previewRewind(target.info.id)).modes![0]!);
      }
      if (at < 0) return say("Nothing to redo");
      const next = all.slice(at + 1).find(shown);
      // The newest undone message is redone: the revert point goes away; else it moves to the next undone one.
      if (!next) return void (await this.server.request(`/session/${this.id}/unrevert`, { method: "POST", directory: this.cwd }));
      const before = this.revertAt;
      this.revertAt = next.info.id; // the session.updated of this revert is not an external one
      await this.server.request(`/session/${this.id}/revert`, { method: "POST", directory: this.cwd, body: { messageID: next.info.id } }).catch((err) => ((this.revertAt = before), Promise.reject(err)));
      await this.resync(); // the messages between the old and the new revert point come back
    } catch (err) {
      say(`/${cmd} failed: ${(err as Error).message}`);
    }
  }

  /** `/compact`: OpenCode summarizes the conversation (a turn: the compaction marker, the summary as an assistant message). */
  private async compact(say: (text: string) => void) {
    const [providerID, ...rest] = this.model.split("/");
    const picked = this.model !== "default" && rest.length ? { providerID: providerID!, modelID: rest.join("/") } : (this.usage ?? (await this.engine.defaultModel(this.cwd)));
    if (!picked) return say("Choose a model first");
    this.revertAt = undefined; // the summary removes the cut messages
    this.stopped = false;
    this.sentAt = Infinity;
    this.beginTurn();
    this.session.setState("running");
    if (!(await this.afterStale())) return;
    this.server
      .request(`/session/${this.id}/summarize`, { method: "POST", directory: this.cwd, timeoutMs: 0, body: { providerID: picked.providerID, modelID: picked.modelID } })
      .then(
        () => (this.sentAt = Date.now()),
        (err) => {
          this.sentAt = Date.now();
          say(`/compact failed: ${(err as Error).message}`);
          this.toIdle();
        },
      );
  }

  /**
   * A turn begun here by a request of its own (bash mode, /compact) waits, as send() does, for the prompt requests an earlier Stop left on
   * their way: while they may start a turn in OpenCode, its events are hidden (quiet). False when a Stop came meanwhile (nothing is posted).
   */
  private async afterStale(): Promise<boolean> {
    const mark = this.stops.count;
    this.turnPosted = false;
    await this.stale;
    if (this.stops.count !== mark) return false;
    this.turnPosted = true;
    return true;
  }

  /** Sends a prompt: it joins the running turn (steering: the model sees it at the next step; the turn still ends at one session.idle) or starts one. */
  private start(messageID: string, text: string, images: string[]) {
    const steer = this.session.currentState() !== "idle";
    this.stopped = false;
    if (!steer) {
      this.sentAt = Infinity;
      this.beginTurn();
      this.turnPosted = false;
      this.session.setState("running");
    }
    this.turnUsers.add(messageID);
    const cmd = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    void this.send(messageID, text, images, !steer && cmd && this.commandNames.has(cmd[1]!) ? { name: cmd[1]!, args: cmd[2] ?? "" } : undefined).catch((err) => {
      this.occurrence("prompt_failed", `Could not send the prompt to OpenCode: ${(err as Error).message}`, messageID);
      if (!steer) this.toIdle();
    });
  }

  private async send(messageID: string, text: string, images: string[], command?: { name: string; args: string }) {
    const run = this.stops.begin();
    // Whatever the outcome (POST failure, Stop, command), the turn-end check of a resync may run 3 s later.
    try {
      // Preparing: OpenCode does not know the prompt; a Stop ends each of these waits at once and the prompt is never sent (interrupt() ends the turn).
      // Events of the turn must find the stream open; the attach waits for OpenCode's MCP load (30-300 s) and is never cancelled (see brokenState);
      // prompts an earlier Stop left on their way must not start a turn this prompt would join.
      if (!(await run.prepare(Promise.all([this.server.streamReady(), this.attach(), this.stale])))) return;
      // A block of a mode or agent the session was restored with (or the first one) goes in before the turn.
      let agent = this.agentName();
      if ((this.written !== this.permissionMode || this.writtenAgent !== agent || !sameKeys(this.writtenMcp, this.mcpOn)) && !(await run.prepare(this.writeBlock(this.permissionMode)))) return;
      // An agent the config no longer has: this prompt runs as build (the chosen agent stays, it may come back). The list is cached per folder.
      const known = this.engine.agents(this.cwd);
      if (!(await run.prepare(known))) return;
      if (!primaryAgents(await known).some((a) => a.name === agent)) {
        this.notice("agent_missing", `OpenCode has no agent ${agent} here any more; this prompt runs as build`);
        agent = "build";
      }
      const levels = this.effort !== "default" ? this.engine.effortLevels(this.model, this.cwd) : Promise.resolve([] as EffortLevel[]);
      if (!(await run.prepare(levels))) return;
      // A model switch can leave an effort the new model lacks: then no variant (the web offers only listed levels).
      const variant = this.effort !== "default" && (await levels).includes(this.effort as EffortLevel) ? { variant: this.effort } : {};
      const [providerID, ...rest] = this.model.split("/");
      this.turnPosted = true;
      const stops = this.stops.count;
      // A failure after a Stop is no failed prompt: the Stop ended the turn.
      const unlessStopped = (err: unknown) => (this.stops.count !== stops ? undefined : Promise.reject(err));
      if (command) {
        // The turn runs inside this request: no timeout.
        await run
          .post(
            this.server.request(`/session/${this.id}/command`, {
              method: "POST",
              directory: this.cwd,
              timeoutMs: 0,
              body: { messageID, command: command.name, arguments: command.args, agent, ...variant, ...(this.model !== "default" && { model: this.model }), parts: images.map((url) => ({ type: "file", mime: dataUrlMime(url), url, filename: "image" })) },
            }),
          )
          .catch(unlessStopped);
        return;
      }
      const parts = [
        ...(text ? [{ id: ascending("prt"), type: "text", text }] : []),
        ...images.map((url) => ({ type: "file", mime: dataUrlMime(url), url, filename: "image" })),
      ];
      // No caller timeout: a slow answer (a cold folder) is not a failed prompt; the turn runs whatever the answer's delay.
      // A Stop meanwhile leaves this wait as it is: OpenCode may run the turn already (interrupt() tells by its status).
      const system = visualizeSystem(this.opts.visualizePlugin?.()); // per prompt: the setting applies from the next one
      await run
        .post(
          this.server.request(`/session/${this.id}/prompt_async`, {
            method: "POST",
            directory: this.cwd,
            timeoutMs: 0,
            body: { messageID, parts, agent, ...(system && { system }), ...variant, ...(this.model !== "default" && rest.length && { model: { providerID, modelID: rest.join("/") } }) },
          }),
        )
        .catch(unlessStopped);
    } finally {
      run.end();
      this.sentAt = Date.now();
    }
  }

  /** A turn is running (started here, found busy at a restore or resync): `turnEnd` settles when it goes idle. */
  private openTurnEnd() {
    if (this.turnEnd) return;
    const end = {} as TurnEnd;
    end.done = new Promise<void>((r) => (end.resolve = r));
    this.turnEnd = end;
  }

  private beginTurn() {
    this.turnEnd = undefined;
    this.openTurnEnd();
    this.turnStop = this.stops.count;
    this.turnPosted = true;
    this.turnAt = Date.now();
    this.aborted = false;
    this.failed = false;
    this.selfAbort = undefined;
    this.turnKey = ascending("msg");
    this.turnAssistant = undefined;
    this.errorKeys = new Set();
    this.lastAttempt = 0;
    this.turnUsers = new Set();
    this.mapper.resetTurn();
  }

  /** An assistant message answers a user message of the running turn (a message without a parent cannot be placed: taken as this turn's). */
  private ofTurn(info: OpenCodeMessage["info"]) {
    return !info.parentID || this.turnUsers.has(info.parentID);
  }

  /** A turn found running (restore, resync): its user message is the last one stored. */
  private noteLastUser(messages: OpenCodeMessage[]) {
    const user = [...messages].reverse().find((m) => m.info.role === "user");
    if (user) this.turnUsers.add(user.info.id);
  }

  /** The turn ended (session idle): its result, then idle. */
  private finish() {
    if (this.session.currentState() === "idle") return;
    const { usage, cost } = this.mapper.turn();
    const shell = this.shellRun;
    this.shellRun = false;
    // A Stop hit this turn and OpenCode ended it without an abort error (it sends none while it waits to retry): the Stop's one marker, no result.
    if (this.turnStop < this.stops.count && !this.aborted) (this.aborted = true, this.session.emit({ type: "turn_interrupted", id: `interrupted:${ascending("msg")}` }));
    if (!this.aborted && !shell) this.session.emit({ type: "turn_result", id: `turn:${ascending("msg")}`, durationMs: Date.now() - this.turnAt, ...(cost > 0 && { costUsd: cost }), usage, isError: this.failed });
    this.toIdle();
    void this.emitUsage();
    if (this.selfAbort) void this.explainAbort(this.selfAbort);
    void this.engine.folderIdle(this.cwd);
  }

  /** After a turn OpenCode aborted on its own: a broken MCP state of the folder (499) is repaired and the notice says so. */
  private async explainAbort(messageID: string) {
    const broken = await this.server.request("/mcp", { directory: this.cwd, timeoutMs: 0 }).then(() => false, brokenState);
    if (!broken) return;
    const fixed = await this.engine.repairFolder(this.cwd);
    this.notice(`aborted:${messageID}`, `${SELF_ABORT} ${fixed ? MCP_RELOADED : MCP_BROKEN_BUSY}`);
    // A turn still runs in the folder: the folder is reloaded when a turn of ours there ends (finish()), and the notice then says so.
    if (!fixed) this.engine.reloadWhenIdle(this.cwd, (how) => this.notice(`aborted:${messageID}`, `${SELF_ABORT} ${how === "reloaded" ? MCP_RELOADED : MCP_HEALTHY}`));
  }

  /** The turn is over: idle, and a prompt waiting for the end of an aborted turn goes on. */
  private toIdle() {
    this.setRetry(undefined);
    this.session.setState("idle");
    this.turnEnd?.resolve();
    this.turnEnd = undefined;
  }

  /**
   * Stop. Each send() of the turn is handled by its phase (opencode-stop.ts); the turn then ends where it really ends:
   * - nothing of the turn reached OpenCode (every send was preparing): it ends here at once, one interrupted marker;
   * - else OpenCode's abort ends it: a running turn with its events (session.error, session.idle -> finish()); OpenCode's status idle after
   *   the abort means it ran nothing (the abort of an idle session sends no event): it ends here;
   * - a prompt request still on its way can reach OpenCode after the abort and start a turn there: `stale` (cleanStale()) aborts that one
   *   without showing it, and a prompt sent after Stop waits for it (never joins it).
   * Until the turn ended, a prompt sent after Stop waits for it (prompt(): `afterStop`).
   */
  /**
   * Inline task (GH-734): a child session of this one runs the prompt on a small model with only the granted tools. Its parts show under the running
   * `inline_task` call; permission asks go to this session's UI (`owns`). Ends at the child's idle, error, a cap (turns, output tokens, time) or `hooks.signal`.
   */
  inlineTask = async (spec: InlineSpec, hooks: InlineHooks): Promise<InlineResult> => {
    const t0 = Date.now();
    const fallback = this.model !== "default" ? this.model : "default";
    const result = (r: Partial<InlineResult> & Pick<InlineResult, "status">, col?: InlineCollector): InlineResult => ({
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
    let col: InlineCollector | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let callId: string | undefined;
    let messageID: string | undefined;
    try {
      callId = await this.findInlineCall(hooks);
      if (callId) this.inlineClaimed.add(callId);
      const model = await this.inlineModel(spec, hooks);
      const agent = this.agentName();
      const own = await this.agentPermission(agent).catch(() => [] as Rule[]);
      // The parent's mode, agent denials and "always" rules; no claude-ui or orchestration tools (modeBlock hides both without own rules): no recursion.
      const permission = modeBlock(this.permissionMode, this.always, denialsOf(own), { agent, readOnly: this.readOnly(), ...(this.permissionMode === "config" && { config: own }) });
      const row = await this.server.request<{ id: string }>("/session", { method: "POST", directory: this.cwd, timeoutMs: 0, body: { parentID: this.id, title: `Inline: ${spec.title}`.slice(0, 80), permission } });
      childId = row.id;
      const collector = (col = new InlineCollector(childId));
      if (callId) this.mapper.adopt(childId, callId);
      const outcome = new Promise<{ status: InlineResult["status"]; limit?: InlineResult["limit"]; error?: string }>((resolve) => {
        const end = (o: Parameters<typeof resolve>[0]) => resolve(o);
        this.inlines.set(childId!, {
          ui: !!callId,
          notify: (e) => {
            collector.feed(e);
            const cap = collector.cap(spec.maxTurns);
            if (cap) end({ status: "limit", limit: cap });
            else if (collector.error) end({ status: "error", error: collector.error });
            else if (collector.idle) end({ status: "done" });
          },
        });
        timer = setTimeout(() => end({ status: "limit", limit: "time" }), INLINE_TIMEOUT_MS);
        onAbort = () => end({ status: "stopped" });
        if (callId) this.inlineStops.set(callId, onAbort);
        if (hooks.signal.aborted) onAbort();
        else hooks.signal.addEventListener("abort", onAbort, { once: true });
      });
      messageID = ascending("msg");
      this.mapper.own.add(messageID);
      await this.server.streamReady();
      await this.server.request(`/session/${childId}/prompt_async`, {
        method: "POST",
        directory: this.cwd,
        timeoutMs: 0,
        body: { messageID, ...(model && { model }), system: INLINE_SYSTEM, tools: inlineTools(spec), parts: [{ id: ascending("prt"), type: "text", text: spec.text }] },
      });
      const end = await outcome;
      if (end.status !== "done" && end.status !== "error") await this.server.request(`/session/${childId}/abort`, { method: "POST", directory: this.cwd }).catch(() => undefined);
      let text = collector.text();
      if (!text && end.status === "done") text = lastAssistantText(await this.server.request<OpenCodeMessage[]>(`/session/${childId}/message`, { directory: this.cwd }).catch(() => []));
      return result({ ...end, ...clip(text) }, collector);
    } catch (err) {
      return result({ status: "error", error: (err as Error).message, ...(col && clip(col.text())) }, col);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) hooks.signal.removeEventListener("abort", onAbort);
      if (childId) {
        this.inlines.delete(childId);
        this.mapper.release(childId);
      }
      if (callId) this.inlineStops.delete(callId);
      // A claim stays while its call still runs (a second run must not take it); finished calls are dropped.
      for (const id of this.inlineClaimed) if (!this.mapper.isRunning(id)) this.inlineClaimed.delete(id);
      if (messageID) this.mapper.own.delete(messageID);
    }
  };

  /** The running `inline_task` call this run belongs to: the newest one with an equal input that no run took. Its event may come after the tool request, so it is awaited a moment. */
  private async findInlineCall(hooks: InlineHooks) {
    for (let i = 0; i < 20; i++) {
      const id = this.mapper.runningCall(`mcp__${DAEMON_SERVER}__inline_task`, hooks.input, this.inlineClaimed);
      if (id || i === 19) return id;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Model of the child: the input, else setting `openCodeModel`, else OpenCode's `small_model`, else the parent's (none: OpenCode's default). */
  private async inlineModel(spec: InlineSpec, hooks: InlineHooks) {
    let value = spec.model || hooks.openCodeModel || undefined;
    value ??= (await this.server.request<{ small_model?: string }>("/config", { directory: this.cwd }).catch(() => undefined))?.small_model || undefined;
    value ??= this.model !== "default" ? this.model : undefined;
    const [providerID, ...rest] = (value ?? "").split("/");
    return value && rest.length ? { providerID: providerID!, modelID: rest.join("/") } : undefined;
  }

  async interrupt() {
    if (this.session.currentState() === "idle") return;
    this.stopped = true;
    this.setRetry(undefined); // OpenCode waits no more for the retry once the abort reaches it; the line goes at once
    const ways = this.stops.stop();
    this.session.interruptPending();
    if (!this.turnPosted) this.endStopped();
    // No caller timeout: a slow answer (a cold or loaded OpenCode) is no failed Stop; the reply does not wait for it. Only a real failure is shown.
    const abort = this.abort();
    if (ways.length) {
      const prev = this.stale;
      const mine: Promise<void> = Promise.all([prev, this.cleanStale(ways, abort)]).then(() => {
        if (this.stale === mine) this.stale = undefined;
      });
      this.stale = mine;
    }
    // The turn's end is read at the abort's answer, or after ABORT_WAIT_MS if it is late (and again at its late answer).
    void Promise.race([abort, sleep(ABORT_WAIT_MS).then(() => true)]).then(async (ok) => {
      if (ok && this.stoppedShows() && (await this.idleInOpenCode())) this.endStopped();
      if (ok) void abort.then(async (late) => late && this.stoppedShows() && (await this.idleInOpenCode()) && this.endStopped());
    });
  }

  /** `POST /abort`, no caller timeout; true when OpenCode answered, false (and a notice) when it failed. */
  private abort(): Promise<boolean> {
    return this.server.request(`/session/${this.id}/abort`, { method: "POST", directory: this.cwd, timeoutMs: 0 }).then(
      () => true,
      (err) => (this.notice(`stop_failed:${ascending("msg")}`, `Could not stop the turn in OpenCode: ${(err as Error).message}`), false),
    );
  }

  /** The turn a Stop hit still runs here. */
  private stoppedShows() {
    return this.session.currentState() !== "idle" && this.turnStop < this.stops.count;
  }

  /** OpenCode's events of the session are a stopped prompt's (quiet), not a turn shown here. */
  private hiding() {
    return !!this.quiet && !this.stoppedShows();
  }

  private openQuiet() {
    let busy!: () => void;
    let idle!: () => void;
    const started = new Promise<boolean>((r) => (busy = () => r(true)));
    const ended = new Promise<void>((r) => (idle = r));
    const q = { busy, idle, started, ended };
    this.quiet = q;
    return q;
  }

  /** The stopped turn ends here: one interrupted marker, no result, idle. Not a turn begun after the Stop (a prompt sent after it). */
  private endStopped() {
    if (this.session.currentState() === "idle" || this.turnStop >= this.stops.count) return;
    if (!this.aborted) this.session.emit({ type: "turn_interrupted", id: `interrupted:${ascending("msg")}` });
    this.aborted = true;
    this.finish();
  }

  /** OpenCode runs nothing for this session; false when it runs something or its status cannot be read. */
  private async idleInOpenCode() {
    const status = await this.server.request<Record<string, Status>>("/session/status", { directory: this.cwd }).catch(() => undefined);
    return !!status && (status[this.id]?.type ?? "idle") === "idle";
  }

  /**
   * Prompt requests a Stop left on their way: once they settled (and the abort answered, at most ABORT_WAIT_MS), a turn one of them started in
   * OpenCode is aborted. While the stopped turn still shows, that is its end (its events, or the status read); else it is aborted unseen.
   */
  private async cleanStale(ways: Promise<void>[], abort: Promise<boolean>) {
    // Opened at the Stop (interrupt() calls this before any await): from then on, events of a stopped prompt that reaches OpenCode late are
    // hidden once the stopped turn no longer shows here.
    const q = (this.quiet ?? this.openQuiet()) as ReturnType<OpenCodeSession["openQuiet"]>;
    try {
      await Promise.all([Promise.race([abort, sleep(ABORT_WAIT_MS)]), ...ways]);
      if (this.stoppedShows()) {
        // A stopped prompt that reached OpenCode after the first abort runs there: abort again (no event when nothing runs).
        await Promise.race([this.abort(), sleep(ABORT_WAIT_MS)]);
        if (this.stoppedShows() && (await this.idleInOpenCode())) this.endStopped();
        return;
      }
      void this.idleInOpenCode().then((none) => none || q.busy());
      // OpenCode stores the prompt and starts its loop a moment after it answered the request: watched that long.
      if (!(await Promise.race([q.started, sleep(STALE_WATCH_MS).then(() => false)]))) return;
      await Promise.race([this.abort(), sleep(ABORT_WAIT_MS)]);
      await Promise.race([q.ended, sleep(TURN_END_WAIT_MS)]);
    } finally {
      if (this.quiet === q) this.quiet = undefined;
    }
  }

  private async followAgent(agent: unknown) {
    if (typeof agent !== "string") return;
    const list = await this.engine.agents(this.cwd).catch(() => []);
    if (primaryAgents(list).some((a) => a.name === agent) && agent !== this.agentName()) await this.setAgent(agent).catch(() => {});
  }

  /** One event of the server for this session or one of its subagent sessions. */
  event(payload: Payload) {
    const p = payload.properties;
    const sid = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID ?? p.info?.id;
    const root = sid === this.id;
    const inline = sid && sid !== this.id ? this.inlines.get(sid) : undefined;
    if (inline) {
      inline.notify(payload);
      // A run without a call to hang under shows nothing; its permission asks still reach the user.
      if (!inline.ui && ["message.updated", "message.part.updated", "message.part.delta", "todo.updated"].includes(payload.type)) return;
    }
    switch (payload.type) {
      case "message.updated": {
        const info = p.info;
        // plan_exit "Yes" (agent build), or another agent chosen in OpenCode's own UI: follow it. Hidden agents (compaction, title) never match.
        if (root && info.role === "user" && !this.mapper.own.has(info.id) && info.agent !== this.agentName() && !this.following) {
          this.following = true;
          void this.followAgent(info.agent).finally(() => (this.following = false));
        }
        if (root && this.hiding()) return;
        if (root) this.noteUsage(info);
        if (root && info.role === "assistant" && !this.quiet && this.session.currentState() !== "idle" && this.ofTurn(info)) this.turnAssistant = { id: info.id, ...(info.providerID && info.modelID && { model: `${info.providerID}/${info.modelID}` }) };
        // A prompt of this turn sent elsewhere (OpenCode's own UI, a compaction); ours are noted when sent (a late update of a stopped one is not this turn's).
        if (root && info.role === "user" && !this.mapper.own.has(info.id) && this.session.currentState() !== "idle") this.turnUsers.add(info.id);
        // OpenCode aborted the turn on its own (no session.error, not our Stop): say so instead of ending silently.
        if (root && info.role === "assistant" && info.error?.name === "MessageAbortedError" && info.time?.completed && !this.aborted && !this.stopped && this.session.currentState() !== "idle" && this.selfAbort !== info.id && this.ofTurn(info)) {
          this.selfAbort = info.id;
          this.failed = true;
          this.notice(`aborted:${info.id}`, SELF_ABORT);
        }
        return this.emitAll(this.mapper.message(info));
      }
      case "message.part.updated":
        return root && this.hiding() ? undefined : this.emitAll(this.mapper.part(p.part));
      case "message.part.delta":
        return p.field === "text" && !(root && this.hiding()) ? this.emitAll(this.mapper.delta(p.partID, p.delta)) : undefined;
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
        if (s.type === "busy" && this.hiding()) return this.quiet!.busy();
        if (this.hiding()) return;
        this.statusEvents++;
        // The reason of the wait shows until the next attempt (busy) or the end (idle) replaces it.
        this.setRetry(s.type === "retry" ? retryOf(s) : undefined);
        if (s.type === "busy" && this.session.currentState() === "idle") (this.beginTurn(), this.session.setState("running"));
        return;
      }
      case "session.idle":
        if (root && this.hiding()) return this.quiet!.idle();
        return root ? this.finish() : undefined;
      case "session.error": {
        if (!root) return;
        if (p.error?.name === "MessageAbortedError") {
          // One marker per turn (interrupt() may have ended it already); none for a stopped prompt that reached OpenCode late.
          if (this.hiding() || this.session.currentState() === "idle" || this.aborted) return;
          this.aborted = true;
          return this.session.emit({ type: "turn_interrupted", id: `interrupted:${ascending("msg")}` });
        }
        this.failed = true;
        // One warning per turn, in its own place: the id is the turn's assistant message (the history shows the same one after a restore), else the turn's.
        const key = errorKey(p.error);
        if (this.errorKeys.has(key)) return;
        this.errorKeys.add(key);
        const model = this.model !== "default" ? this.model : this.turnAssistant?.model;
        return this.session.emit({ type: "notice", id: `error:${this.turnAssistant?.id ?? this.turnKey}`, level: "warning", text: errorText(p.error, { ...(model && { model }), ...(this.lastAttempt > 0 && { attempts: this.lastAttempt }) }) });
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
    // In config, "all edits" is a saved edit rule: acceptEdits would add asks the OpenCode config does not have (GH-705).
    const edit = e.permission === "edit" && !!e.always?.includes("*") && this.permissionMode !== "config";
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
    // The claude-ui tools that ask (terminal_run): the card title names the terminal and the command; "always" suggestions stay.
    if (tool.startsWith(`mcp__${DAEMON_SERVER}__`)) {
      void Promise.resolve(this.opts.permissionCard?.(this.id, tool, input, { name: DAEMON_SERVER, source: "sdk" }))
        .catch(() => undefined)
        .then((card) => this.reqs.has(e.id) && this.session.request({ part: { ...part, ...(card && { title: card.title }) }, reply }));
      return;
    }
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
    void this.server.request(path, { method: "POST", directory: this.cwd, body }).catch((err) => this.occurrence("answer_failed", `Could not answer OpenCode: ${(err as Error).message}`));
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
        // Edit outside config: "always" would only live in the server's memory; "all edits" is the acceptEdits mode, saved with the session.
        this.post(path, { reply: "once" });
        return void this.setPermissionMode("acceptEdits").catch((err) => this.occurrence("mode_failed", `Could not switch the mode: ${(err as Error).message}`));
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
      const answers = req.questions!.map((q) => (r.answers[q.question] === undefined ? [] : (r.choices?.[q.question] ?? (q.multiSelect ? splitLabels(r.answers[q.question]!, q.options.map((o) => o.label)) : [r.answers[q.question]!]))));
      return this.post(`/question/${id}/reply`, { answers });
    }
    if (r.kind !== "cancel" || r.message !== ANSWERED) this.post(`/question/${id}/reject`, {});
  }

  /** "Always allow" of a permission other than edit: the patterns join the session ruleset (and survive restarts). */
  private persist(permission: string, patterns: string[]) {
    const rules = patterns.map((pattern): Rule => ({ permission, pattern, action: "allow" }));
    this.always.push(...rules);
    // A fresh always section with every rule, then the denials again: the new rule must not beat them (GH-705).
    const write = async () => {
      const always = [...this.always];
      const permission = [marker("always"), ...always, ...denialTail(always, denialsOf(await this.agentPermission(this.agentName())), this.readOnly())];
      await this.server.request(`/session/${this.id}`, { method: "PATCH", directory: this.cwd, body: { permission } });
    };
    void write().catch((err) => this.occurrence("persist_failed", `Could not save the rule: ${(err as Error).message}`));
  }

  /**
   * Bash mode (`!`): OpenCode runs `command` in the folder without a model call (`POST /shell`; the request answers when it ends). Its events
   * come as the Bash card (the mapper's `bash` tool), the turn is the command run, no `turn_result`. Stop = abort.
   */
  bash(command: string) {
    if (!this.session.isLive()) throw new Error(`session ${this.id} is not live (${this.session.currentState()})`);
    if (this.session.currentState() !== "idle" || this.session.pendingCount()) throw new Error("session is busy: wait for the turn to end");
    if (this.shellRun) throw new Error("a shell command is already running");
    const messageID = ascending("msg");
    this.mapper.own.add(messageID);
    this.shellRun = true;
    this.stopped = false;
    this.sentAt = Infinity;
    this.beginTurn();
    this.turnUsers.add(messageID);
    this.session.setState("running");
    const model = this.model.split("/");
    const done = () => (this.sentAt = Date.now());
    void this.afterStale().then((go) => {
      if (!go) return void done();
      this.server
        .request(`/session/${this.id}/shell`, { method: "POST", directory: this.cwd, timeoutMs: 0, body: { messageID, command, agent: this.agentName(), ...(this.model !== "default" && model.length > 1 && { model: { providerID: model[0], modelID: model.slice(1).join("/") } }) } })
        .then(done, (err) => {
          done();
          this.occurrence("shell_failed", `Could not run the command in OpenCode: ${(err as Error).message}`);
          this.shellRun = false;
          this.toIdle();
        });
    });
  }
  subscribed() {}
  beforeStateEvent() {}
  idle() {}
  bashCwdPinned = () => false;
  /** Stop agent: aborts the child session of the task call. */
  stopSubagent = async (callId: string) => {
    const inline = this.inlineStops.get(callId);
    if (inline) return inline(), true; // the run aborts its child and ends as stopped
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
    const stored = await this.server.request<OpenCodeMessage[]>(`/session/${this.id}/message`, { directory: this.cwd });
    // Messages cut by an earlier revert are hidden: their changes are already undone and count once.
    const cut = this.revertAt ? stored.findIndex((m) => m.info.id === this.revertAt) : -1;
    const all = cut < 0 ? stored : stored.slice(0, cut);
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
    // The disconnect reads the folder's MCP state too: never cut off, and close does not wait for it.
    if (this.server.running()) for (const key of this.mcpOn) void this.server.request(`/mcp/${mcpName(this.id, key)}/disconnect`, { method: "POST", directory: this.cwd, timeoutMs: 0 }).catch(() => {});
  };
  activity = () => ({ received: 0, at: 0, progress: 0 });
  live = () => this.server.running();
  reloadPlugins = async () => undefined;
  restartQuery() {}
  releaseQuery = () => false;
  externalTurnRunning = () => false;
  untitled = () => false;
  bashRunning = () => this.shellRun;
  working = () => false;
  takesQueued = () => this.session.currentState() === "idle" && this.session.pendingCount() === 0;
}

class OpenCodeEngineImpl implements Engine {
  readonly name = "opencode" as const;
  readonly capabilities = OPENCODE_CAPABILITIES;
  private readonly sessions = new Set<OpenCodeSession>();
  private unsubscribe: (() => void) | undefined;
  private readonly providerLists = new Map<string, Promise<ProviderList>>();

  constructor(
    readonly server: OpenCodeServer,
    readonly onTitle?: (id: string, title: string) => void,
    readonly mcp?: OpenCodeMcpRoute,
  ) {}

  permissionModes = (o: { allowBypass?: boolean; supportsAuto?: boolean }) => permissionModesFor({ ...o, modes: OPENCODE_PERMISSION_MODES });

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
      resync: () => (this.commandLists.clear(), this.agentLists.clear(), this.sessions.forEach((o) => void o.resync())),
    });
  }
  remove(s: OpenCodeSession) {
    this.sessions.delete(s);
    if (!this.sessions.size) (this.unsubscribe?.(), (this.unsubscribe = undefined));
  }

  private agentLists = new Map<string, { at: number; list: Promise<OpenCodeAgent[]> }>();
  /** `GET /agent` of a folder (project agents differ per folder), cached 60 s; dropped when the server restarts. */
  agents(cwd: string): Promise<OpenCodeAgent[]> {
    const hit = this.agentLists.get(cwd);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    // Waits for OpenCode's load of the folder (first answers take 2-5 s): never cut off (see brokenMcp); a callback that must not wait is not given one.
    // A failure drops the entry, so the next call (session open, resync, the chooser's retry) asks again.
    const list = this.server.request<OpenCodeAgent[]>("/agent", { directory: cwd, timeoutMs: 0 });
    this.agentLists.set(cwd, { at: Date.now(), list });
    list.catch(() => this.agentLists.delete(cwd));
    return list;
  }

  /**
   * `GET /config/providers` of `cwd`'s instance (none: the server's own folder), read once per provider set (`dropLimits` after a login or logout).
   * Never cut off (see brokenState). A 499 disposes the folder's instance when no turn runs there and reads again.
   * `strict`: a failure rejects (models.list); else it gives an empty list and is read again next time.
   */
  providerList(cwd?: string, { strict = false } = {}): Promise<ProviderList> {
    const key = cwd ?? "";
    let hit = this.providerLists.get(key);
    if (!hit) {
      const read = () => this.server.request<ProviderList>("/config/providers", { ...(cwd && { directory: cwd }), timeoutMs: 0 });
      // Repaired and still 499: the break is not the folder's (ProviderStateBroken). A refused repair (busy, status read failed) says nothing about the server: the 499 stays as it is.
      const again = () => read().catch((e) => Promise.reject(brokenState(e) ? new ProviderStateBroken() : e));
      const mine: Promise<ProviderList> = (hit = read().catch(async (err) => (brokenState(err) && (await this.repairFolder(cwd)) ? again() : Promise.reject(err))));
      this.providerLists.set(key, mine);
      mine.catch(() => this.providerLists.get(key) === mine && this.providerLists.delete(key));
    }
    return strict ? hit : hit.catch(() => ({ providers: [] }));
  }
  /** Context window of `provider/model`; undefined when unknown. */
  async contextLimit(providerID: string, modelID: string, cwd?: string): Promise<number | undefined> {
    return (await this.providerList(cwd)).providers.find((p) => p.id === providerID)?.models[modelID]?.limit?.context;
  }
  /** The model OpenCode runs by default (`default` of `GET /config/providers`). */
  async defaultModel(cwd?: string): Promise<{ providerID: string; modelID: string } | undefined> {
    const d = defaultOf(await this.providerList(cwd));
    return d && { providerID: d.p.id, modelID: d.id };
  }
  /** The effort levels of a session model (`default` = the default model of OpenCode); none when it has no reasoning variants. */
  async effortLevels(model: string, cwd?: string): Promise<EffortLevel[]> {
    const r = await this.providerList(cwd);
    const [provider, ...rest] = model.split("/");
    return levelsOf(model === "default" ? defaultOf(r)?.m : r.providers.find((p) => p.id === provider)?.models[rest.join("/")]);
  }
  private readonly repairs = new Map<string, Promise<boolean>>();
  /** Folders found broken while a turn ran in them (not disposed then): what to tell the sessions once they are reloaded. */
  private readonly pendingReload = new Map<string, ((how: "reloaded" | "healthy") => void)[]>();
  reloadWhenIdle(cwd: string, done: (how: "reloaded" | "healthy") => void) {
    this.pendingReload.set(cwd, [...(this.pendingReload.get(cwd) ?? []), done]);
  }
  private flushReload(cwd: string, how: "reloaded" | "healthy") {
    const waiting = this.pendingReload.get(cwd);
    this.pendingReload.delete(cwd);
    waiting?.forEach((f) => f(how));
  }
  /** A turn of a session of the folder ended: a folder marked broken is reloaded now when it is still broken and nothing runs in it any more. */
  async folderIdle(cwd: string) {
    if (!this.pendingReload.has(cwd)) return;
    const broken = await this.server.request("/mcp", { directory: cwd, timeoutMs: 0 }).then(() => false, brokenState);
    // Healthy again (another path reloaded it, or OpenCode did): the notices say that. Else dispose now; busy: the next turn end tries again.
    if (!broken) this.flushReload(cwd, "healthy");
    else await this.repairFolder(cwd); // a successful repair flushes the notices
  }
  /** Disposes the folder's OpenCode instance (none: the server's own) so its MCP and provider state loads again (see brokenState); not while a session of the folder runs a turn in OpenCode (dispose cancels it). True when disposed. One at a time per folder. */
  repairFolder(cwd?: string): Promise<boolean> {
    const key = cwd ?? "";
    const running = this.repairs.get(key);
    if (running) return running;
    const directory = cwd && { directory: cwd };
    const run = (async () => {
      const status = await this.server.request<Record<string, { type: string }>>("/session/status", { ...directory });
      if (Object.values(status).some((s) => s.type !== "idle")) return false;
      await this.server.request("/instance/dispose", { method: "POST", ...directory, timeoutMs: 0 });
      this.commandLists.delete(key);
      this.providerLists.delete(key);
      // Whoever disposed it (another session's open or attach included): the sessions that wait for the reload hear of it.
      this.flushReload(key, "reloaded");
      return true;
    })()
      .catch(() => false)
      .finally(() => this.repairs.delete(key));
    this.repairs.set(key, run);
    return run;
  }
  private commandLists = new Map<string, { at: number; list: Promise<SlashCommand[]> }>();
  /** `GET /command` of a folder (built-ins, project and user commands, MCP prompts, skills), cached 60 s; dropped when the server restarts. */
  commands(cwd: string): Promise<SlashCommand[]> {
    const hit = this.commandLists.get(cwd);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    // Waits for OpenCode's MCP load of the folder: never cut off (see brokenState); a broken folder is reloaded and read once more.
    const read = () => this.server.request<{ name: string; description?: string; hints?: string[] }[]>("/command", { directory: cwd, timeoutMs: 0 });
    const list = read()
      .catch(async (err) => (brokenState(err) && (await this.repairFolder(cwd)) ? read() : Promise.reject(err)))
      .then((l) => [...LOCAL_COMMANDS, ...l.filter((c) => !LOCAL_NAMES.includes(c.name)).map((c) => ({ name: c.name, description: c.description ?? "", argumentHint: (c.hints ?? []).join(" ") }))]);
    this.commandLists.set(cwd, { at: Date.now(), list });
    list.catch(() => this.commandLists.delete(cwd));
    return list;
  }
  dropLimits = () => this.providerLists.clear();

  /** The rules `POST /session` gets for a new session in `mode` (`plan` = agent plan, mode default), else as agent `agent`. */
  block = async (mode: PermissionMode, cwd: string, agent = "build"): Promise<Rule[]> => {
    const as = mode === "plan" ? "plan" : agent;
    const known = await this.agents(cwd);
    return modeBlock(mode === "plan" ? "default" : mode, [], denialsOf(known.find((a) => a.name === as)?.permission ?? []), { agent: as });
  };
}

/** The daemon's `/opencode-mcp` route (server.ts): its URL (undefined while the daemon does not listen), the bearer token of a session (made on first use), dropped at close. */
export type OpenCodeMcpRoute = { url: () => string | undefined; token: (id: string, server: McpServerKey) => string; drop: (id: string) => void };
export type OpenCodeEngine = OpenCodeEngineImpl;
export const createOpenCodeEngine = (server: OpenCodeServer, o: { onTitle?: (id: string, title: string) => void; mcp?: OpenCodeMcpRoute } = {}): OpenCodeEngine => new OpenCodeEngineImpl(server, o.onTitle, o.mcp);
