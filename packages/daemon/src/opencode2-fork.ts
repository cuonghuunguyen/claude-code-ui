// Fork run on OpenCode 2 (docs/spec.md "Fork runs"): the session metadata that marks a fork, and the fork point shared with Aside.
// The session side (fork, prompt, wait, interrupt) is OpenCode2Session.forkRun.
import type { OpenCodeClient } from "@opencode/client";

/** The session metadata key that marks a Fork run's fork (the session list hides it); its value is the parent session's id. */
export const FORK_META = "claude-ui.forkOf";

/**
 * Where a fork of session `id` is cut (`POST /api/session/{id}/fork {before}`): at a rewind (OpenCode's `revert`) its message, else before the unfinished assistant
 * message of a running turn (the running step, and with it the call that forks), else after the whole history. `before` excludes that message. Nothing kept before
 * the cut = undefined (no fork).
 */
export async function forkCut(client: OpenCodeClient, id: string): Promise<{ before?: string } | undefined> {
  const [info, first, newest] = await Promise.all([
    client.session.get({ sessionID: id }),
    client.message.list({ sessionID: id, order: "asc", limit: 1 }),
    client.message.list({ sessionID: id, order: "desc", limit: 20 }),
  ]);
  const oldest = first.data[0];
  if (!oldest) return undefined;
  const running = newest.data.find((m) => m.type === "assistant" && !(m as { time?: { completed?: number } }).time?.completed)?.id;
  const before = info.revert?.messageID ?? running;
  return before === oldest.id ? undefined : { ...(before && { before }) };
}
