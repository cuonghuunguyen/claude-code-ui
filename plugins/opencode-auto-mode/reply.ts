// Talks to the permission API. Prefers the V2 reply route (`POST /permission/{requestID}/reply`,
// which carries a `message` the model sees as feedback) via the V1 client's raw request method,
// which already has the server's auth headers.
// Reject semantics (permission/index.ts): a reject WITH a message is a CorrectedError (the turn
// continues with the feedback); one without, and every sibling ask of the session the cascade
// rejects, is a RejectedError (the turn halts). So a reject always carries a message, is V2-only
// (the V1 route has no message), and the caller must not reject while sibling asks are pending.
// A 404 means someone else (the claude-ui card, the TUI) already answered: swallowed.
import type { OpencodeClient } from "./types.ts";

export interface ReplyTarget {
  sessionID: string;
  id: string;
}

export type ReplyOutcome = "replied" | "already-answered" | "failed";

async function replyViaV2(client: OpencodeClient, target: ReplyTarget, reply: "once" | "reject", message: string | undefined): Promise<ReplyOutcome | undefined> {
  const raw = client._client;
  if (!raw) return undefined;
  try {
    const res = await raw.post({
      url: "/permission/{requestID}/reply",
      path: { requestID: target.id },
      body: message === undefined ? { reply } : { reply, message },
    });
    if (res.response?.status === 404) return "already-answered";
    if (res.error) return undefined;
    return "replied";
  } catch {
    return undefined;
  }
}

async function replyViaV1(client: OpencodeClient, target: ReplyTarget): Promise<ReplyOutcome> {
  try {
    const res = await client.postSessionIdPermissionsPermissionId({
      path: { id: target.sessionID, permissionID: target.id },
      body: { response: "once" },
    });
    if (res.response?.status === 404) return "already-answered";
    if (res.error) return "failed";
    return "replied";
  } catch {
    return "failed";
  }
}

/** Allow once (V2, falling back to V1). Never "always". */
export async function allowOnce(client: OpencodeClient, target: ReplyTarget): Promise<ReplyOutcome> {
  return (await replyViaV2(client, target, "once", undefined)) ?? replyViaV1(client, target);
}

/** Reject with feedback for the model. V2 only: no fallback, a failure is left to the human. */
export async function rejectWithMessage(client: OpencodeClient, target: ReplyTarget, message: string): Promise<ReplyOutcome> {
  return (await replyViaV2(client, target, "reject", message)) ?? "failed";
}

/** Ids of the session's other pending asks, or null when they can't be listed. */
export async function otherPendingAsks(client: OpencodeClient, target: ReplyTarget, directory: string): Promise<string[] | null> {
  try {
    const res = await client._client?.get({ url: "/permission", query: { directory } });
    if (!res || res.error || !Array.isArray(res.data)) return null;
    return (res.data as Array<{ id?: string; sessionID?: string }>)
      .filter((r) => r.sessionID === target.sessionID && r.id !== target.id)
      .map((r) => String(r.id));
  } catch {
    return null;
  }
}
