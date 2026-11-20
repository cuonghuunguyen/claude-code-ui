// Fork run on OpenCode 1 (docs/spec.md "Fork runs"): the fork point shared with Aside, and the texts of the run.
// The session side (create, prompt, wait, abort) is OpenCodeSession.forkRun.
import { DAEMON_SERVER } from "./daemon-mcp.ts";
import type { OpenCodeServer } from "./opencode-server.ts";

/** The tool a Fork run is called as (the claude-ui MCP server's `fork`, shown with Claude's name). */
export const FORK_TOOL = `mcp__${DAEMON_SERVER}__fork`;

/** The first words of a fork's prompt: it is the parent's conversation plus this task. */
export const FORK_PREAMBLE = "You are a fork of the conversation above, started to do one task. Do only the task below; do not start other forks or subagents and do not ask the user questions. Your last message is returned to the conversation as the result, so make it the complete answer: short and exact.";

type Stored = { info: { id: string; role: string; time?: { completed?: number } } };

/**
 * OpenCode `POST /session/<owner>/fork` at the right point: before the owner's `revert.messageID` when it has one (a rewind: the cut messages
 * stay stored until the next prompt), else before the first unfinished assistant message of a running turn (the running step, and with it the
 * call that forks), else the whole history. `prefix` = the messages the fork copied. `what` names the caller in the refusal.
 */
export async function forkAt(server: OpenCodeServer, owner: { id: string; cwd: string }, what: string): Promise<{ id: string; prefix: number } | { unavailable: string }> {
  const at = { directory: owner.cwd };
  const stored = await server.request<Stored[]>(`/session/${owner.id}/message`, at);
  const revert = (await server.request<{ revert?: { messageID: string } | null }>(`/session/${owner.id}`, at)).revert?.messageID;
  const cut = revert ? stored.findIndex((m) => m.info.id === revert) : -1;
  const kept = cut < 0 ? stored : stored.slice(0, cut);
  if (!kept.length) return { unavailable: `${what} needs a message in this session first` };
  const messageID = cut < 0 ? stored.find((m) => m.info.role === "assistant" && !m.info.time?.completed)?.info.id : revert;
  const prefix = messageID ? stored.findIndex((m) => m.info.id === messageID) : stored.length;
  const row = await server.request<{ id: string }>(`/session/${owner.id}/fork`, { ...at, method: "POST", body: { messageID } });
  return { id: row.id, prefix };
}
