// OpenCode plugin: auto-decides permission "ask" prompts with a classifier model, instead of
// waiting on a human. See README.md for install, options, how it works, and its limits.
import { buildClassifierAgentConfig, CLASSIFIER_AGENT } from "./agent-config.ts";
import { classify } from "./classifier.ts";
import { COMMANDS } from "./commands.ts";
import { createLimits } from "./limits.ts";
import { createLogStore, hashPolicy, resolveDataDir, type ClassifierInput, type DecisionOutcome, type LabelRecord } from "./log-store.ts";
import { logDecision, toast } from "./logging.ts";
import { buildPolicyPrompt } from "./prompt.ts";
import { effectiveDecision } from "./verdict.ts";
import { allowOnce, otherPendingAsks, pendingAsks, rejectWithMessage, type ReplyOutcome } from "./reply.ts";
import { createTools, LOG_PERMISSION, projectKey } from "./tools.ts";
import type { CachedToolCall } from "./transcript.ts";
import { resolveOptions, type Hooks, type PermissionAskedProperties, type Plugin, type PluginOptions } from "./types.ts";

const MAX_CACHED_TOOL_CALLS = 500;
const MAX_REPLIED_IDS = 1000;
const MAX_SEEN_ASKS = 1000;
/** Whole-job budget beyond the classifier timeout, for the calls around it (list, reply, cleanup). */
export const JOB_SLACK_MS = 10_000;
/** Replies of one session closer together than this are one burst: OpenCode publishes a primary reply and its cascade siblings synchronously. */
const CASCADE_WINDOW_MS = 50;
const DEFAULT_BLOCK_MESSAGE = "Blocked by auto mode.";
const UNSURE_BLOCK_MESSAGE = "Blocked by auto mode: could not tell whether this is authorised.";

export const AutoModePlugin: Plugin = async (input, options) => {
  const opts = resolveOptions(options);
  if (!opts.enabled || process.env.OPENCODE_AUTO_MODE === "0") return {};

  const { client } = input;
  const limits = createLimits({ maxConsecutiveBlocks: opts.maxConsecutiveBlocks, maxTotalBlocks: opts.maxTotalBlocks });
  const classifierSessions = new Set<string>();
  const toolInputCache = new Map<string, CachedToolCall>();
  const queues = new Map<string, Promise<void>>(); // per session: asks are classified one at a time, so limits can't be overshot

  function inSession(sessionID: string, job: () => Promise<void>): Promise<void> {
    const run = (queues.get(sessionID) ?? Promise.resolve()).then(job, job);
    queues.set(sessionID, run);
    const cleanup = () => {
      if (queues.get(sessionID) === run) queues.delete(sessionID);
    };
    void run.then(cleanup, cleanup);
    return run;
  }

  const repliedIds = new Set<string>(); // asks already answered by anyone (permission.replied), bounded
  const seenAsks = new Set<string>(); // asks this plugin considered (not filtered out), bounded: only these get human labels
  const lastReplyAt = new Map<string, number>(); // per session: when a permission.replied last arrived, to spot cascade siblings
  const ownReplies = new Set<string>(); // asks this plugin is answering, or answered, itself: not human labels

  const policyPrompt = buildPolicyPrompt(opts);
  const policyHash = hashPolicy(policyPrompt);
  const dataDir = resolveDataDir(opts.logDir);
  const project = projectKey(input.worktree, input.directory);
  const store = opts.log
    ? createLogStore({
        dir: dataDir,
        maxBytes: opts.logMaxBytes,
        onError: (err) => {
          void Promise.resolve(client.app.log({ body: { service: "auto-mode", level: "warn", message: `decision log write failed (reported once): ${String(err)}` } })).catch(() => {});
        },
      })
    : undefined;

  interface Decided {
    verdict: "allow" | "block" | "ask" | "none" | "deferred";
    outcome?: DecisionOutcome;
    reason: string;
    ms: number;
    input?: ClassifierInput;
    model?: string;
    /** false: only the local decision log, not the server log. */
    serverLog?: boolean;
  }

  /** One decision, to the server log and to the local decision log. Never throws. */
  async function emit(info: { id: string; sessionID: string; permission: string; patterns?: string[] }, d: Decided): Promise<void> {
    const serverOutcome = d.outcome === "replied" || d.outcome === "already-answered" || d.outcome === "failed" ? d.outcome : undefined;
    if (d.serverLog !== false) await logDecision(client, { sessionID: info.sessionID, permission: info.permission, verdict: d.verdict, outcome: serverOutcome, reason: d.reason, ms: d.ms });
    if (!store) return;
    await store.append({
      v: 1,
      kind: "decision",
      at: new Date().toISOString(),
      requestID: info.id,
      sessionID: info.sessionID,
      project,
      permission: info.permission,
      patterns: info.patterns ?? [],
      ...(d.model ? { model: d.model } : {}),
      policyHash,
      verdict: d.verdict === "deferred" ? "block" : d.verdict,
      reason: d.reason,
      outcome: d.verdict === "deferred" ? "deferred" : (d.outcome ?? "none"),
      ms: d.ms,
      ...(d.input ? { input: d.input } : {}),
    });
  }

  /** Marks the ask as answered by us while the reply is sent, so its `permission.replied` isn't taken for a human label. */
  async function ourReply(id: string, send: () => Promise<ReplyOutcome>): Promise<ReplyOutcome> {
    ownReplies.add(id);
    const outcome = await send();
    if (outcome !== "replied") ownReplies.delete(id);
    return outcome;
  }

  /** The job under a hard deadline, so one hung call can't wedge the session's queue. */
  async function withDeadline(info: PermissionAskedProperties, job: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs + JOB_SLACK_MS);
    });
    try {
      const won = await Promise.race([job().then(() => "done" as const), deadline]);
      if (won === "timeout") await emit(info, { verdict: "none", outcome: "timeout", reason: "timeout", ms: opts.timeoutMs + JOB_SLACK_MS });
    } finally {
      clearTimeout(timer);
    }
  }

  async function decide(info: PermissionAskedProperties): Promise<void> {
    const skipped = (reason: string) => emit(info, { verdict: "none", outcome: "skipped", reason, ms: 0, serverLog: false });
    if (limits.isStopped(info.sessionID)) return skipped("session hit its block limit");
    if (repliedIds.has(info.id)) return skipped("already answered while queued"); // settled while queued
    const target = { sessionID: info.sessionID, id: info.id };
    const pending = await pendingAsks(client, input.directory);
    if (pending && !pending.some((r) => r.id === info.id)) return skipped("no longer pending"); // a list failure proceeds
    const started = Date.now();
    const { verdict, input: classifierInput, model } = await classify(info, {
      client,
      directory: input.directory,
      model: opts.model,
      transcriptChars: opts.transcriptChars,
      timeoutMs: opts.timeoutMs,
      classifierSessions,
      toolInputCache,
    });
    if (info.tool) toolInputCache.delete(info.tool.callID);
    const done = (d: Omit<Decided, "ms" | "input" | "model">) => emit(info, { ...d, ms: Date.now() - started, input: classifierInput, model });

    if (!verdict || verdict.decision == null) {
      await done({ verdict: "none", reason: "classifier error, timeout or unparseable reply" });
      return; // leave it to the human
    }

    const decision = effectiveDecision(verdict.decision, opts.unsure);
    if (decision === "ask") {
      // Unsure: the human decides. Not a block, so it never counts toward the limits; their answer becomes the label.
      await done({ verdict: "ask", outcome: "deferred", reason: verdict.reason });
      return;
    }

    if (decision === "no") {
      const outcome = await ourReply(info.id, () => allowOnce(client, target));
      if (outcome === "replied") limits.recordAllow(info.sessionID);
      await done({ verdict: "allow", outcome, reason: verdict.reason });
      return;
    }

    // A reject cascades to every sibling ask of the session and, without a message, halts the turn.
    const others = await otherPendingAsks(client, target, input.directory);
    if (others === null || others.length > 0) {
      const why = others === null ? "could not list pending asks" : "other pending asks";
      await done({ verdict: "deferred", reason: `${why}; left to the human (classifier said block: ${verdict.reason})` });
      return;
    }
    const message = verdict.reason || (verdict.decision === "ask" ? UNSURE_BLOCK_MESSAGE : DEFAULT_BLOCK_MESSAGE);
    const outcome = await ourReply(info.id, () => rejectWithMessage(client, target, message));
    await done({ verdict: "block", outcome, reason: verdict.reason });
    if (outcome !== "replied") return;
    await toast(client, `blocked ${info.permission}: ${message}`, "warning");
    if (limits.recordBlock(info.sessionID)) {
      await toast(client, "too many blocks in this session; auto mode has stopped deciding for it", "error");
    }
  }

  const hooks: Hooks = {
    config: async (config) => {
      // The default agent permissions allow everything unknown, so without this rule the tools'
      // ctx.ask(auto_mode_log) would pass silently. A rule the user set themselves wins.
      const perm = config.permission;
      if (perm === undefined || perm === null) config.permission = { [LOG_PERMISSION]: "ask" };
      else if (typeof perm === "string") config.permission = { "*": perm, [LOG_PERMISSION]: "ask" };
      else if (typeof perm === "object" && !(LOG_PERMISSION in perm)) (perm as Record<string, unknown>)[LOG_PERMISSION] = "ask";
      // Agent permissions are merged after the global ones (last match wins), so an agent with "*": "allow" would silently allow it.
      for (const agent of Object.values(config.agent ?? {})) {
        const a = agent as { permission?: unknown } | undefined;
        if (!a || typeof a !== "object" || a.permission === undefined || a.permission === null) continue;
        if (typeof a.permission === "string") a.permission = { "*": a.permission, [LOG_PERMISSION]: "ask" };
        else if (typeof a.permission === "object" && !(LOG_PERMISSION in a.permission)) (a.permission as Record<string, unknown>)[LOG_PERMISSION] = "ask";
      }
      config.agent = config.agent ?? {};
      config.agent[CLASSIFIER_AGENT] = buildClassifierAgentConfig(opts);
      config.command = config.command ?? {};
      for (const [name, command] of Object.entries(COMMANDS)) config.command[name] = { ...command };
    },

    tool: createTools({ client, directory: input.directory, worktree: input.worktree, opts, dataDir, policyPrompt, policyHash, classifierSessions }),

    "chat.params": async (params, output) => {
      if (!classifierSessions.has(params.sessionID)) return;
      output.temperature = 0;
      output.maxOutputTokens = opts.maxOutputTokens;
    },

    "tool.execute.before": async (params, output) => {
      toolInputCache.set(params.callID, { tool: params.tool, input: output.args as Record<string, unknown> });
      if (toolInputCache.size > MAX_CACHED_TOOL_CALLS) {
        const oldest = toolInputCache.keys().next().value;
        if (oldest !== undefined) toolInputCache.delete(oldest);
      }
    },

    "tool.execute.after": async (params) => {
      toolInputCache.delete(params.callID);
    },

    event: async ({ event }) => {
      if (event.type === "permission.replied") {
        // Payload (1.19.5 permission/index.ts): { sessionID, requestID, reply: "once" | "always" | "reject" }
        const props = event.properties as { requestID?: unknown; reply?: unknown; sessionID?: unknown } | undefined;
        const id = props?.requestID;
        if (typeof id === "string") {
          repliedIds.add(id);
          if (repliedIds.size > MAX_REPLIED_IDS) repliedIds.delete(repliedIds.values().next().value as string);
          const reply = props?.reply;
          const session = typeof props?.sessionID === "string" ? props.sessionID : undefined;
          const at = Date.now();
          const cascade = session !== undefined && at - (lastReplyAt.get(session) ?? -Infinity) < CASCADE_WINDOW_MS;
          if (session !== undefined) {
            lastReplyAt.set(session, at);
            if (lastReplyAt.size > MAX_SEEN_ASKS) lastReplyAt.delete(lastReplyAt.keys().next().value as string);
          }
          if (store && seenAsks.has(id) && !ownReplies.has(id) && (reply === "once" || reply === "always" || reply === "reject")) {
            const label: LabelRecord = { v: 1, kind: "label", at: new Date().toISOString(), requestID: id, reply, ...(cascade ? { cascade: true as const } : {}) };
            await store.append(label); // a human's decision: ground truth for eval and improve
          }
        }
        return;
      }
      if (event.type !== "permission.asked") return;
      const info = event.properties as unknown as PermissionAskedProperties;
      if (classifierSessions.has(info.sessionID)) return; // never act on our own classifier
      if (info.permission === LOG_PERMISSION) return; // always the human's: never auto-decided, whatever the options
      if (opts.skipPermissions.includes(info.permission)) return;
      if (opts.onlyPermissions && !opts.onlyPermissions.includes(info.permission)) return;
      seenAsks.add(info.id);
      if (seenAsks.size > MAX_SEEN_ASKS) seenAsks.delete(seenAsks.values().next().value as string);
      try {
        await inSession(info.sessionID, () => withDeadline(info, () => decide(info)));
      } catch (err) {
        await emit(info, { verdict: "none", reason: `unexpected error: ${String(err)}`, ms: 0 });
      }
    },
  };

  return hooks;
};

// V1 plugin module: OpenCode 1.19.5 reads `default` as `{ id, server }` and then ignores the named
// exports. Without it the loader treats EVERY export as a plugin function and rejects the module
// ("Plugin export is not a function") as soon as one of them (like JOB_SLACK_MS) is not one.
export default { id: "auto-mode", server: AutoModePlugin };

export type { PluginOptions };
