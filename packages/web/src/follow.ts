import type { SessionListItem } from "@claude-ui/protocol";

/**
 * Whether a tab follows a listed session in the background (a view, events, unread marker). A closed session, or a restored one that is idle and
 * not live (no CLI runs, nothing new arrives), is not followed: it has no view, and its unread state comes from the list's `lastActivity`.
 */
export function followed(s: Pick<SessionListItem, "state" | "live">): boolean {
  return s.state !== "closed" && (s.live !== false || s.state === "running" || s.state === "needs_input" || s.state === "error");
}
