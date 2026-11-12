// Builds the hidden classifier agent's config entry (registered via the `config` hook).
import { buildPolicyPrompt, type PromptOptions } from "./prompt.ts";
import { CLASSIFIER_AGENT } from "./classifier.ts";

/**
 * The hook adds the agent after config decode, so only `permission` reaches the agent (agent.ts
 * never reads `tools`). `{ "*": "deny" }` becomes a last-wins `*`/`*` deny rule, which
 * Permission.disabled/visibleTools use to hide every tool (built-in, plugin and MCP) from the
 * model, and which denies any call outright. OpenCode still adds its own system prompt parts
 * (env block, AGENTS.md/CLAUDE.md, skills/MCP instructions) on top of ours.
 */
export function buildClassifierAgentConfig(opts: PromptOptions): Record<string, unknown> {
  return {
    mode: "subagent",
    hidden: true,
    temperature: 0,
    permission: { "*": "deny" },
    prompt: buildPolicyPrompt(opts),
  };
}

export { CLASSIFIER_AGENT };
