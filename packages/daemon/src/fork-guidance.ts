// The `fork` tool groups of the claude-ui MCP server (docs/spec.md "Fork runs"). Claude: no tools, only guidance. The CLI's own
// Agent tool text (with the fork gate on) says how a fork works; this adds when not to fork and the context budget. OpenCode:
// the `fork` tool (its `task` tool always starts a fresh subagent). Same wording as docs/site/features/fork-subagents.md.
import { z } from "zod";
import { ToolError, type DaemonToolCtx, type DaemonToolGroup } from "./daemon-mcp.ts";
import { INLINE_TIMEOUT_MS, type ForkResult, type ForkSpec } from "./inline-types.ts";

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
- needs an unbiased view (review): a fork inherits your assumptions;
- needs a specialized agent type or a worktree;
- needs little of a large conversation (a fork copies all of it);
- fits a short, self-contained brief: use a fresh subagent and set \`model\` explicitly (cheaper).`;

export const FORK_GUIDANCE_OPENCODE = `Fork subagents: the fork tool starts a fork of this conversation. The fork inherits the conversation so far and returns only its final message, so its reads, searches and logs stay out of your context. The call waits until the fork ends.

Fork when the work:
- needs many reads, searches or logs and only the conclusion matters;
- needs this conversation's decisions or file knowledge, so a fresh subagent would need a long brief;
- would take more than ~5 file reads or return large output.

Do not fork when the task:
- is one small step (one read, one edit);
- feeds a next step that needs the raw output;
- edits files you also edit;
- needs an unbiased view (review): a fork inherits your assumptions;
- needs little of a large conversation (a fork copies all of it);
- fits a short, self-contained brief: use the task tool (cheaper).`;

const PROMPT_MAX = 20_000;

/** The `fork` tool of OpenCode sessions (docs/spec.md "Fork runs"): `run` runs it in the session's engine (`EngineSession.forkRun`). */
export type ForkRunner = (sessionId: string, spec: ForkSpec, signal: AbortSignal | undefined, input: Record<string, unknown>) => Promise<ForkResult>;

const forkTool = (run: ForkRunner): DaemonToolGroup["tools"][number] => ({
  name: "fork",
  description:
    "Fork this conversation: a copy of you with the whole conversation so far does one task and returns only its final message. Use it when the task needs this conversation's context and its steps would fill yours. The call waits for the fork to finish: {status, text}.",
  shape: {
    description: z.string().min(1).max(100).describe("Three to five words naming the task."),
    prompt: z.string().min(1).max(PROMPT_MAX).describe("The task for the fork and the format of its reply. The fork has the conversation, so no need to repeat it."),
  },
  permission: "allow",
  async run({ sessionId, signal }: DaemonToolCtx, a: ForkSpec) {
    const r = await run(sessionId, a, signal, { description: a.description, prompt: a.prompt });
    if (r.status === "error" && !r.text) throw new ToolError(r.error ?? "The fork failed.");
    return { status: r.status, ...(r.limit && { limit: r.limit }), ...(r.error && { error: r.error }), text: r.text, ...(r.truncated && { truncated: true }), filesChanged: r.filesChanged };
  },
});

/** The guidance group of Claude (no tools) and the one of OpenCode (the `fork` tool); both follow `fork.enabled`. */
export function createForkGroups(enabled: () => boolean, run: ForkRunner): DaemonToolGroup[] {
  return [createForkGroup(enabled), { id: "fork-opencode", enabled, engines: ["opencode"], instructions: FORK_GUIDANCE_OPENCODE, tools: [forkTool(run)], timeoutMs: INLINE_TIMEOUT_MS + 60_000 }];
}

export function createForkGroup(enabled: () => boolean): DaemonToolGroup {
  return { id: "fork", enabled, engines: ["claude"], instructions: FORK_GUIDANCE, tools: [], timeoutMs: 0 };
}
