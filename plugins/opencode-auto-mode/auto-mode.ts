// OpenCode plugin: auto-decides permission "ask" prompts with a classifier model, instead of
// waiting on a human. See README.md for install, options, how it works, and its limits.
import { buildClassifierAgentConfig, CLASSIFIER_AGENT } from "./agent-config.ts";
import { classify, DEFAULT_MAX_OUTPUT_TOKENS } from "./classifier.ts";
import { readProjectDoc } from "./docs.ts";
import { createLimits } from "./limits.ts";
import { logDecision, toast } from "./logging.ts";
import { replyToPermission } from "./reply.ts";
import type { CachedToolCall } from "./transcript.ts";
import { resolveOptions, type Hooks, type PermissionAskedProperties, type Plugin, type PluginOptions } from "./types.ts";

export const AutoModePlugin: Plugin = async (input, options) => {
  const opts = resolveOptions(options);
  if (!opts.enabled || process.env.OPENCODE_AUTO_MODE === "0") return {};

  const { client } = input;
  const limits = createLimits({ maxConsecutiveBlocks: opts.maxConsecutiveBlocks, maxTotalBlocks: opts.maxTotalBlocks });
  const classifierSessions = new Set<string>();
  const toolInputCache = new Map<string, CachedToolCall>();

  const hooks: Hooks = {
    config: async (config) => {
      const agentsMd = opts.includeAgentsMd ? await readProjectDoc(input.worktree, input.directory, "AGENTS.md") : undefined;
      const claudeMd = opts.includeAgentsMd ? await readProjectDoc(input.worktree, input.directory, "CLAUDE.md") : undefined;
      config.agent = config.agent ?? {};
      config.agent[CLASSIFIER_AGENT] = buildClassifierAgentConfig(opts, { agentsMd, claudeMd });
    },

    "chat.params": async (params, output) => {
      if (!classifierSessions.has(params.sessionID)) return;
      output.temperature = 0;
      output.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
    },

    "tool.execute.before": async (params, output) => {
      toolInputCache.set(params.callID, { tool: params.tool, input: output.args as Record<string, unknown> });
    },

    event: async ({ event }) => {
      if (event.type !== "permission.asked") return;
      const info = event.properties as unknown as PermissionAskedProperties;
      if (classifierSessions.has(info.sessionID)) return; // never act on our own classifier
      if (opts.skipPermissions.includes(info.permission)) return;
      if (opts.onlyPermissions && !opts.onlyPermissions.includes(info.permission)) return;
      if (limits.isStopped(info.sessionID)) return;

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
      const ms = Date.now() - started;

      if (!verdict || verdict.decision == null) {
        await logDecision(client, { sessionID: info.sessionID, permission: info.permission, verdict: "none", reason: "", ms });
        return; // classifier error, timeout, or unparseable reply: leave it to the human
      }

      if (verdict.decision === "yes") {
        const justStopped = limits.recordBlock(info.sessionID);
        await replyToPermission(client, { sessionID: info.sessionID, id: info.id }, "reject", verdict.reason);
        await logDecision(client, { sessionID: info.sessionID, permission: info.permission, verdict: "block", reason: verdict.reason, ms });
        await toast(client, `blocked ${info.permission}${verdict.reason ? `: ${verdict.reason}` : ""}`, "warning");
        if (justStopped) await toast(client, "too many blocks in this session; auto mode has stopped deciding for it", "error");
        return;
      }

      limits.recordAllow(info.sessionID);
      await replyToPermission(client, { sessionID: info.sessionID, id: info.id }, "once");
      await logDecision(client, { sessionID: info.sessionID, permission: info.permission, verdict: "allow", reason: verdict.reason, ms });
    },
  };

  return hooks;
};

export default AutoModePlugin;

// Re-exported so opencode.json's `["file:///…/auto-mode.ts", {…}]` options type-checks for consumers.
export type { PluginOptions };
