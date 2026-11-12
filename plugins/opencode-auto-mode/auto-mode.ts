// OpenCode plugin: auto-decides permission "ask" prompts with a classifier model, instead of
// waiting on a human. See README.md for install, options, how it works, and its limits.
import { buildClassifierAgentConfig, CLASSIFIER_AGENT } from "./agent-config.ts";
import { classify } from "./classifier.ts";
import { createLimits } from "./limits.ts";
import { logDecision, toast } from "./logging.ts";
import { allowOnce, otherPendingAsks, pendingAsks, rejectWithMessage } from "./reply.ts";
import type { CachedToolCall } from "./transcript.ts";
import { resolveOptions, type Hooks, type PermissionAskedProperties, type Plugin, type PluginOptions } from "./types.ts";

const MAX_CACHED_TOOL_CALLS = 500;
const MAX_REPLIED_IDS = 1000;
/** Whole-job budget beyond the classifier timeout, for the calls around it (list, reply, cleanup). */
export const JOB_SLACK_MS = 10_000;
const DEFAULT_BLOCK_MESSAGE = "Blocked by auto mode.";

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

  /** The job under a hard deadline, so one hung call can't wedge the session's queue. */
  async function withDeadline(info: PermissionAskedProperties, job: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs + JOB_SLACK_MS);
    });
    try {
      const won = await Promise.race([job().then(() => "done" as const), deadline]);
      if (won === "timeout") await logDecision(client, { sessionID: info.sessionID, permission: info.permission, verdict: "none", reason: "timeout", ms: opts.timeoutMs + JOB_SLACK_MS });
    } finally {
      clearTimeout(timer);
    }
  }

  async function decide(info: PermissionAskedProperties): Promise<void> {
    if (limits.isStopped(info.sessionID)) return;
    if (repliedIds.has(info.id)) return; // settled while queued
    const target = { sessionID: info.sessionID, id: info.id };
    const base = { sessionID: info.sessionID, permission: info.permission };
    const pending = await pendingAsks(client, input.directory);
    if (pending && !pending.some((r) => r.id === info.id)) return; // no longer pending; a list failure proceeds
    const started = Date.now();
    const verdict = await classify(info, {
      client,
      directory: input.directory,
      model: opts.model,
      transcriptChars: opts.transcriptChars,
      timeoutMs: opts.timeoutMs,
      classifierSessions,
      toolInputCache,
    });
    if (info.tool) toolInputCache.delete(info.tool.callID);
    const since = () => Date.now() - started;

    if (!verdict || verdict.decision == null) {
      await logDecision(client, { ...base, verdict: "none", reason: "classifier error, timeout or unparseable reply", ms: since() });
      return; // leave it to the human
    }

    if (verdict.decision === "no") {
      const outcome = await allowOnce(client, target);
      if (outcome === "replied") limits.recordAllow(info.sessionID);
      await logDecision(client, { ...base, verdict: "allow", outcome, reason: verdict.reason, ms: since() });
      return;
    }

    // A reject cascades to every sibling ask of the session and, without a message, halts the turn.
    const others = await otherPendingAsks(client, target, input.directory);
    if (others === null || others.length > 0) {
      const why = others === null ? "could not list pending asks" : "other pending asks";
      await logDecision(client, { ...base, verdict: "deferred", reason: `${why}; left to the human (classifier said block: ${verdict.reason})`, ms: since() });
      return;
    }
    const message = verdict.reason || DEFAULT_BLOCK_MESSAGE;
    const outcome = await rejectWithMessage(client, target, message);
    await logDecision(client, { ...base, verdict: "block", outcome, reason: verdict.reason, ms: since() });
    if (outcome !== "replied") return;
    await toast(client, `blocked ${info.permission}: ${message}`, "warning");
    if (limits.recordBlock(info.sessionID)) {
      await toast(client, "too many blocks in this session; auto mode has stopped deciding for it", "error");
    }
  }

  const hooks: Hooks = {
    config: async (config) => {
      config.agent = config.agent ?? {};
      config.agent[CLASSIFIER_AGENT] = buildClassifierAgentConfig(opts);
    },

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
        const id = (event.properties as { requestID?: unknown } | undefined)?.requestID;
        if (typeof id === "string") {
          repliedIds.add(id);
          if (repliedIds.size > MAX_REPLIED_IDS) repliedIds.delete(repliedIds.values().next().value as string);
        }
        return;
      }
      if (event.type !== "permission.asked") return;
      const info = event.properties as unknown as PermissionAskedProperties;
      if (classifierSessions.has(info.sessionID)) return; // never act on our own classifier
      if (opts.skipPermissions.includes(info.permission)) return;
      if (opts.onlyPermissions && !opts.onlyPermissions.includes(info.permission)) return;
      try {
        await inSession(info.sessionID, () => withDeadline(info, () => decide(info)));
      } catch (err) {
        await logDecision(client, { sessionID: info.sessionID, permission: info.permission, verdict: "none", reason: `unexpected error: ${String(err)}`, ms: 0 });
      }
    },
  };

  return hooks;
};

export default AutoModePlugin;

export type { PluginOptions };
