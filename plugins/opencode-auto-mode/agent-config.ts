// Builds the hidden classifier agent's config entry (registered via the `config` hook).
import { buildPolicyPrompt, type PromptDocs, type PromptOptions } from "./prompt.ts";
import { CLASSIFIER_AGENT } from "./classifier.ts";

/**
 * Tool ids built into opencode 1.19.5 (packages/opencode/src/tool/*.ts `Tool.define`). The
 * agent `tools` map only matches these exact ids — there is no wildcard — so a plugin-registered
 * or MCP tool is not covered here. The `permission: deny-all` below is the real backstop for the
 * risky categories (edit, bash, webfetch, doom_loop, external_directory); this list additionally
 * turns off tools that aren't permission-gated at all (read, grep, task, …), since the classifier
 * never needs to call a tool — it only needs to read the prompt and reply with text.
 */
const KNOWN_TOOL_IDS = [
  "bash",
  "edit",
  "write",
  "apply_patch",
  "patch",
  "read",
  "grep",
  "glob",
  "list",
  "webfetch",
  "websearch",
  "codesearch",
  "task",
  "todowrite",
  "skill",
  "question",
  "lsp",
  "plan_exit",
  "invalid",
];

export function classifierTools(): Record<string, boolean> {
  return Object.fromEntries(KNOWN_TOOL_IDS.map((id) => [id, false]));
}

export function buildClassifierAgentConfig(opts: PromptOptions, docs: PromptDocs): Record<string, unknown> {
  return {
    mode: "subagent",
    hidden: true,
    temperature: 0,
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "deny",
      doom_loop: "deny",
      external_directory: "deny",
    },
    tools: classifierTools(),
    prompt: buildPolicyPrompt(opts, docs),
  };
}

export { CLASSIFIER_AGENT };
