// The `fork` tool group of the claude-ui MCP server (docs/spec.md "Fork runs (GH-718)"): no tools, only guidance. The CLI's own
// Agent tool text (with the fork gate on) says how a fork works; this adds when not to fork and the context budget. Claude only:
// OpenCode's `task` tool always starts a fresh subagent. Same wording as docs/site/features/fork-subagents.md.
import type { DaemonToolGroup } from "./daemon-mcp.ts";

export const FORK_GUIDANCE = `Fork subagents: Agent with subagent_type "fork" inherits this conversation, runs on your model, and returns only its result, so its reads, searches and logs stay out of your context.

Fork when the work:
- needs many reads, searches or logs and only the conclusion matters;
- is independent of your next step and can run in parallel;
- needs this conversation's decisions or file knowledge, so a fresh agent would need a long brief;
- would take more than ~5 file reads or return large output.

Do not fork when the task:
- is one small step (one read, one edit);
- feeds a next step that needs the raw output;
- edits files the main thread also edits;
- fits a short, self-contained brief: use a fresh subagent and set \`model\` explicitly (cheaper).`;

export function createForkGroup(enabled: () => boolean): DaemonToolGroup {
  return { id: "fork", enabled, engines: ["claude"], instructions: FORK_GUIDANCE, tools: [], timeoutMs: 0 };
}
