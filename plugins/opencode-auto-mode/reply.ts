// Replies to a pending permission request. Prefers the V2 route (carries a `message` the model
// sees as feedback) via the V1 client's raw request method, which already has the server's auth
// headers; falls back to the V1 route when that is not reachable. A 404 means someone else (the
// claude-ui card, the TUI) already answered — that's fine, swallow it.
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
      body: { reply, message },
    });
    if (res.response?.status === 404) return "already-answered";
    if (res.error) return undefined;
    return "replied";
  } catch {
    return undefined;
  }
}

async function replyViaV1(client: OpencodeClient, target: ReplyTarget, reply: "once" | "reject"): Promise<ReplyOutcome> {
  try {
    const res = await client.postSessionIdPermissionsPermissionId({
      path: { id: target.sessionID, permissionID: target.id },
      body: { response: reply },
    });
    if (res.response?.status === 404) return "already-answered";
    if (res.error) return "failed";
    return "replied";
  } catch {
    return "failed";
  }
}

/** Never "always": auto mode only ever answers once, or rejects. */
export async function replyToPermission(client: OpencodeClient, target: ReplyTarget, reply: "once" | "reject", message?: string): Promise<ReplyOutcome> {
  const v2 = await replyViaV2(client, target, reply, message);
  if (v2) return v2;
  return replyViaV1(client, target, reply);
}
