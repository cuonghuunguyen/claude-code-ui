// The steps of an inline task run (docs/spec.md "Inline tasks"), kept like a subagent run of Claude Code: the daemon writes
// `<projects>/<cwd key>/<parent session id>/subagents/agent-inline-<tool_use id>.jsonl` (+ `.meta.json` with `toolUseId`).
// The SDK's getSubagentMessages() reads `toolUseId` of the meta file as `parent_tool_use_id`, so a restore places the steps under the call.
// `claude --resume` lists only main transcripts, never a subagents folder. ADR 0001 holds: it is still a transcript file, not a store of ours.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** The SDK's own rule for an agent id in a file name, tightened: tool_use ids are `toolu_…`. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export type InlineTranscript = {
  /** Queues one streamed SDK message of the run; only assistant steps and tool results are kept. Never throws. */
  append(m: SDKMessage): void;
  /** Resolves when every queued line is on disk. Never rejects. */
  done(): Promise<void>;
};

export type InlineTranscriptTarget = {
  /** `<projects>/<cwd key>/<parent session id>/subagents` */
  dir: string;
  sessionId: string;
  cwd: string;
  toolUseId: string;
  /** Short title of the run (meta `description`). */
  description: string;
};

/** Undefined when the call id is not safe to use in a file name (the run then has no stored steps). */
export function openInlineTranscript(t: InlineTranscriptTarget): InlineTranscript | undefined {
  if (!SAFE_ID.test(t.toolUseId)) return undefined;
  const agentId = `inline-${t.toolUseId}`;
  const file = join(t.dir, `agent-${agentId}.jsonl`);
  let chain: Promise<void> = Promise.resolve();
  let last: string | null = null;
  let failed = false;
  const queue = (job: () => Promise<void>) => {
    chain = chain.then(job).catch((e) => {
      if (!failed) console.error(`inline run ${t.toolUseId}: writing its steps failed:`, e);
      failed = true;
    });
  };
  let started = false;
  return {
    append(sdk) {
      const m = sdk as { type: string; uuid?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } };
      const content = m.message?.content;
      const step = m.type === "assistant" || (m.type === "user" && Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === "tool_result"));
      if (!step || m.parent_tool_use_id || typeof m.uuid !== "string") return;
      // One chain, so the SDK's last-chain read keeps every step (parallel calls of one API message are separate lines).
      const entry = { parentUuid: last, isSidechain: true, agentId, type: m.type, message: m.message, uuid: m.uuid, timestamp: new Date().toISOString(), userType: "external", cwd: t.cwd, sessionId: t.sessionId };
      last = m.uuid;
      const first = !started;
      started = true;
      queue(async () => {
        if (first) {
          await mkdir(t.dir, { recursive: true });
          await writeFile(join(t.dir, `agent-${agentId}.meta.json`), `${JSON.stringify({ agentType: "inline_task", description: t.description, toolUseId: t.toolUseId })}\n`);
        }
        await appendFile(file, `${JSON.stringify(entry)}\n`);
      });
    },
    done: () => chain,
  };
}
