// Builds the hidden classifier agent's config entry (registered via the `config` hook).
import { buildPolicyPrompt, type PromptOptions } from "./prompt.ts";
import { CLASSIFIER_AGENT } from "./classifier.ts";

/**
 * The hook adds the agent after config decode, so only `permission` reaches the agent (agent.ts
 * never reads `tools`). `{ "*": "deny" }` becomes a last-wins `*`/`*` deny rule, which
 * Permission.disabled/visibleTools use to hide every tool (built-in, plugin and MCP) from the
 * model, and which denies any call outright. OpenCode still adds its own system prompt parts: the
 * env block and the project's AGENTS.md/CLAUDE.md. Skills are suppressed for an agent without tools,
 * and MCP instructions only survive for servers that list no tools.
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
