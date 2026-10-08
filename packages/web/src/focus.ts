// Focus page model (docs/spec.md "Focus"): every unanswered permission request and question across the listed sessions.
import type { SessionListItem } from "@claude-ui/protocol";
import { relPath } from "./paths.ts";
import { shownState, type PermissionRequest, type QuestionRequest, type SessionView } from "./store.ts";
import { diffStats, toolSummary } from "./tools.ts";

export type Waiting = {
  sessionId: string;
  part: PermissionRequest | QuestionRequest;
  /** When it started waiting (ms): the daemon's `at`, else when this browser first saw it. */
  since: number;
};

/**
 * One entry per unsettled request of every listed, not archived session whose view this browser holds (a session may have
 * several, e.g. parallel subagents), oldest first, then in list order. `firstSeen`: request id -> ms, for a request without `at`.
 */
export function waitingRequests(list: SessionListItem[], views: Record<string, SessionView | undefined>, firstSeen: ReadonlyMap<string, number>, now: number): Waiting[] {
  const out: (Waiting & { order: number })[] = [];
  list.forEach((s, order) => {
    const view = views[s.id];
    if (!view || s.archived) return;
    for (const part of view.parts.values()) {
      if ((part.type === "permission_request" || part.type === "question") && !part.settled) out.push({ sessionId: s.id, part, since: part.at ?? firstSeen.get(part.id) ?? now, order });
    }
  });
  return out.sort((a, b) => a.since - b.since || a.order - b.order).map(({ order: _, ...w }) => w);
}

/** What the sidebar chip, the Focus tab badge, the browser tab title and the status text all show: sessions that wait, not requests. */
export const waitingCount = (waiting: Waiting[]) => new Set(waiting.map((w) => w.sessionId)).size;

/** Sessions that run without waiting for the user, newest activity first, with the tool of their last call. */
export function runningSessions(list: SessionListItem[], views: Record<string, SessionView | undefined>, waiting: Waiting[]) {
  const waits = new Set(waiting.map((w) => w.sessionId));
  return list
    .filter((s) => !s.archived && !waits.has(s.id) && shownState(views[s.id]) === "running")
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((session) => {
      const view = views[session.id]!;
      const last = [...view.order].reverse().map((id) => view.parts.get(id)).find((p) => p?.type === "tool_call");
      return { session, tool: last?.type === "tool_call" ? last.tool : undefined };
    });
}

/** "Bash · npm run test -- auth", "Edit · docs/setup.md +12 −3", "Question · Keep the old route?". */
export function requestSummary(part: PermissionRequest | QuestionRequest, cwd = ""): string {
  if (part.type === "question") return `Question · ${part.questions[0]?.question ?? ""}`;
  const path = (part.input as { file_path?: unknown } | null)?.file_path;
  const detail = typeof path === "string" ? relPath(path, cwd) : toolSummary(part.input);
  const stats = diffStats(part.tool, part.input);
  return [part.tool, [detail, stats && `+${stats.added} −${stats.removed}`].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

/** The one line an answered row shrinks to: "Allowed npm run test -- auth", "Denied …", "Answered: pnpm", "Cancelled". */
export function answeredLabel(part: PermissionRequest | QuestionRequest, cwd = ""): string {
  if (part.type === "question") {
    const answers = Object.values(part.answers ?? {});
    return answers.length ? `Answered: ${answers.join(", ")}` : "Cancelled";
  }
  const what = requestSummary(part, cwd).replace(/^[^·]*· ?/, "") || part.tool;
  switch (part.decision) {
    case "allow":
      return `Allowed ${what}`;
    case "allow_always":
      return `Always allowed ${what}`;
    case "deny":
      return `Denied ${what}`;
    default:
      return "Cancelled";
  }
}

/** The entry after `current`, wrapping; the first (oldest) when none is selected or it is gone. */
export function nextWaiting(waiting: Waiting[], current?: string): Waiting | undefined {
  const at = waiting.findIndex((w) => w.part.id === current);
  return waiting[(at + 1) % waiting.length];
}

/** "12s", "4m 12s", "1h 3m". */
export function waitLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The status text a screen reader hears when the count changes. */
export const waitingStatus = (n: number) => (n === 0 ? "No session needs input" : n === 1 ? "1 session needs input" : `${n} sessions need input`);
