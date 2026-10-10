// Focus page model (docs/spec.md "Focus"): every unanswered permission request and question across the listed sessions.
import type { Part, SessionListItem, TodoItem } from "@claude-ui/protocol";
import { lastLine } from "./notify.ts";
import { relPath } from "./paths.ts";
import { clockText } from "./plan-meter.tsx";
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
 * several, e.g. parallel subagents), in the displayed order (kind: escalated, permission, question; then oldest first, then list order). Next waiting,
 * the selection after an answer and the Focus page's rows all follow it. `firstSeen`: request id -> ms, for a request without `at`.
 */
/** Position of a request's kind in KIND_ORDER: the one ordering of requests (escalated, permission, question). */
const requestRank = (part: PermissionRequest | QuestionRequest) => KIND_ORDER.indexOf(part.escalated ? "escalated" : part.type === "question" ? "question" : "permission");

export function waitingRequests(list: SessionListItem[], views: Record<string, SessionView | undefined>, firstSeen: ReadonlyMap<string, number>, now: number): Waiting[] {
  const out: (Waiting & { order: number })[] = [];
  list.forEach((s, order) => {
    const view = views[s.id];
    if (!view || s.archived) return;
    for (const part of view.parts.values()) {
      if ((part.type === "permission_request" || part.type === "question") && !part.settled) out.push({ sessionId: s.id, part, since: part.at ?? firstSeen.get(part.id) ?? now, order });
    }
  });
  return out.sort((a, b) => requestRank(a.part) - requestRank(b.part) || a.since - b.since || a.order - b.order).map(({ order: _, ...w }) => w);
}

/** What the sidebar chip, the Focus tab badge, the browser tab title and the status text all show: sessions that wait, not requests. */
export const waitingCount = (waiting: Waiting[]) => new Set(waiting.map((w) => w.sessionId)).size;

const callDetail = (input: unknown, cwd: string) => {
  const path = (input as { file_path?: unknown } | null)?.file_path;
  return typeof path === "string" ? relPath(path, cwd) : toolSummary(input);
};

/** "Bash · npm run test -- auth", "Read · docs/setup.md": the tool and what it works on. */
export const callSummary = (tool: string, input: unknown, cwd = "") => [tool, callDetail(input, cwd)].filter(Boolean).join(" · ");

/** "Bash · npm run test -- auth", "Edit · docs/setup.md +12 −3", "Question · Keep the old route?". */
export function requestSummary(part: PermissionRequest | QuestionRequest, cwd = ""): string {
  if (part.type === "question") return `Question · ${part.questions[0]?.question ?? ""}`;
  const detail = callDetail(part.input, cwd);
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

// ---- GH-270: what needs a look, per session ----

export type AttentionKind = "escalated" | "permission" | "question" | "error" | "limit" | "stuck" | "finished";
/** Fixed priority order of the Focus lists. */
export const KIND_ORDER: readonly AttentionKind[] = ["escalated", "permission", "question", "error", "limit", "stuck", "finished"];
/** Kinds that block the session until the user acts: the only ones the badge counts. */
export const BLOCKING: ReadonlySet<AttentionKind> = new Set<AttentionKind>(["escalated", "permission", "question"]);
export const KIND_LABEL: Record<AttentionKind, string> = { escalated: "Escalated", permission: "Permission", question: "Question", error: "Error", limit: "Usage limit", stuck: "Quiet", finished: "Finished" };

export type AttentionRow = {
  /** The request's part id for request kinds, else `${kind}:${sessionId}`. */
  id: string;
  kind: AttentionKind;
  sessionId: string;
  /** ms: request `since`; error, limit, finished: list lastActivity; stuck: last activity. */
  since: number;
  /** Line 2, verb-first. */
  reason: string;
  /** Line 3, optional: the coordinator's reason (escalated) or the task summary (finished). */
  detail?: string;
  request?: PermissionRequest | QuestionRequest;
  action: "answer" | "cancel_continue" | "open";
};

export type FocusInput = {
  list: SessionListItem[];
  views: Record<string, SessionView | undefined>;
  waiting: Waiting[];
  unread: ReadonlySet<string>;
  /** Last activity of a session (ms): max(last live event, list lastActivity). */
  activity: (sessionId: string) => number;
  now: number;
  clock?: (ms: number) => string;
};

export type WorkingRow = { session: SessionListItem; now: string; progress?: string; quietMs: number };

/** A running session is quiet (stuck) after this long without an event. */
export const STUCK_MS = 5 * 60_000;
/** A working row shows its quiet time instead of its age above this. */
export const QUIET_SHOWN_MS = 2 * 60_000;
export const FINISHED_MAX_AGE_MS = 24 * 60 * 60_000;
export const SECTION_MAX = 5;

const lastOf = <T,>(items: T[], pred: (x: T) => boolean): T | undefined => items.filter(pred).at(-1);

const topLevel = (view: SessionView): Part[] => view.order.flatMap((id) => {
  const p = view.parts.get(id);
  return p && !p.parentId ? [p] : [];
});

const busy = (view: SessionView) =>
  [...view.parts.values()].some((p) => (p.type === "tool_call" && (p.status === "running" || p.status === "pending")) || ((p.type === "subagent" || p.type === "bash") && p.status === "running"));

function errorText(view: SessionView): string {
  const parts = topLevel(view);
  const from = parts.map((p) => p.type === "user_text").lastIndexOf(true) + 1;
  for (const p of parts.slice(from).reverse()) {
    const error = p.type === "raw" ? (p.message as { error?: unknown } | null)?.error : undefined;
    if (error) return String(error).replace(/^Error:\s*/i, "");
  }
  return "the turn ended with an error";
}

/** The todo list a row shows: the live list while the turn runs, the last one once idle (the store clears `todos` on idle, also with a background task still running). */
export const rowTodos = (v: SessionView): TodoItem[] => (v.state === "idle" ? v.lastTodos : v.todos);

/** "k of n": the task at work (completed ones plus the in-progress one) of all; undefined for an empty list. */
export const taskProgress = (items: TodoItem[]) => (items.length ? `${items.filter((t) => t.status === "completed").length + (items.some((t) => t.status === "in_progress") ? 1 : 0)} of ${items.length}` : undefined);

/** "4 of 4 · Done: <last completed item>"; undefined for an empty list or none completed. */
export function doneSummary(items: TodoItem[]): string | undefined {
  const last = lastOf(items, (t) => t.status === "completed");
  return last ? `${taskProgress(items)} · Done: ${last.content}` : undefined;
}

/** "quiet 6m", "quiet 1h 3m". */
export function quietLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `quiet ${m}m` : `quiet ${Math.floor(m / 60)}h ${m % 60}m`;
}

/** What a running session does now: the in-progress task, the running call, else Compacting, Thinking or Writing. */
export function nowLine(view: SessionView, cwd = ""): string {
  const task = rowTodos(view).find((t) => t.status === "in_progress");
  if (task) return task.activeForm ?? task.content;
  const parts = topLevel(view);
  const running = lastOf(parts, (p) => p.type === "tool_call" && p.status === "running");
  if (running?.type === "tool_call") return callSummary(running.tool, running.input, cwd);
  const last = parts.at(-1);
  if (last?.type === "compaction" && !last.summary) return "Compacting";
  if (last?.type === "thinking" && last.streaming) return "Thinking";
  return "Writing";
}

const rowOfRequest = (w: Waiting, cwd: string): AttentionRow => {
  const { part } = w;
  const ask = part.type === "question" ? `Answer: ${part.questions[0]?.question ?? ""}` : undefined;
  const escalated = !!part.escalated;
  const kind: AttentionKind = escalated ? "escalated" : part.type === "question" ? "question" : "permission";
  const reason = ask ?? (escalated ? `Decide: ${requestSummary(part, cwd)}` : `Allow or deny ${requestSummary(part, cwd)}`);
  return { id: part.id, kind, sessionId: w.sessionId, since: w.since, reason, detail: escalated && part.reason ? `Coordinator: ${part.reason}` : undefined, request: part, action: "answer" };
};

/** Every row of the Needs you and Finished lists, in display order: request rows, then at most one row per session without a request. */
export function attentionRows(i: FocusInput): AttentionRow[] {
  const clock = i.clock ?? clockText;
  const cwdOf = new Map(i.list.map((s) => [s.id, s.cwd]));
  const rows: AttentionRow[] = i.waiting.map((w) => rowOfRequest(w, cwdOf.get(w.sessionId) ?? ""));
  const waits = new Set(i.waiting.map((w) => w.sessionId));
  for (const s of i.list) {
    const view = i.views[s.id];
    if (!view || s.archived || waits.has(s.id)) continue;
    const row = (kind: AttentionKind, since: number, reason: string, action: AttentionRow["action"], detail?: string): AttentionRow => ({ id: `${kind}:${s.id}`, kind, sessionId: s.id, since, reason, detail, action });
    if (view.state === "error" && i.unread.has(s.id)) rows.push(row("error", s.lastActivity, `Check the error: ${errorText(view)}`, "open"));
    else if (view.continueAt !== undefined) rows.push(row("limit", s.lastActivity, `Wait for the usage limit to reset: continues at ${clock(view.continueAt)}`, "cancel_continue"));
    else if ((view.state === "running" || view.externalTurn) && !busy(view) && i.now - i.activity(s.id) >= STUCK_MS) {
      const at = i.activity(s.id);
      const lastCall = lastOf(topLevel(view), (p) => p.type === "tool_call");
      rows.push(row("stuck", at, `Check it: ${quietLabel(i.now - at)}${lastCall?.type === "tool_call" ? ` since ${callSummary(lastCall.tool, lastCall.input, s.cwd)}` : ""}`, "open"));
    } else if (view.state === "idle" && !view.working && !view.externalTurn && i.unread.has(s.id) && i.now - s.lastActivity <= FINISHED_MAX_AGE_MS) {
      const text = lastOf(topLevel(view), (p) => p.type === "assistant_text");
      const line = text?.type === "assistant_text" ? lastLine(text.text) : undefined;
      rows.push(row("finished", s.lastActivity, line ? `Review: ${line}` : "Review the result", "open", doneSummary(view.lastTodos)));
    }
  }
  const order = new Map(rows.map((r, n) => [r, n]));
  const rank = (x: AttentionRow) => KIND_ORDER.indexOf(x.kind);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.action === "answer" ? a.since - b.since : b.since - a.since) || order.get(a)! - order.get(b)!);
}

/** Running sessions that have no attention row (they wait or are quiet there), newest activity first. */
export function workingRows(i: FocusInput, rows: AttentionRow[]): WorkingRow[] {
  const taken = new Set(rows.map((x) => x.sessionId));
  return i.list
    .filter((s) => !s.archived && !taken.has(s.id) && shownState(i.views[s.id]) === "running")
    .sort((a, b) => i.activity(b.id) - i.activity(a.id))
    .map((session) => {
      const view = i.views[session.id]!;
      return { session, now: nowLine(view, session.cwd), progress: taskProgress(rowTodos(view)), quietMs: i.now - i.activity(session.id) };
    });
}

/** At most `max` rows, with how many more there are; all of them when expanded. */
export function capRows<T>(rows: T[], expanded: boolean, max = SECTION_MAX): { shown: T[]; more: number } {
  return expanded || rows.length <= max ? { shown: rows, more: 0 } : { shown: rows.slice(0, max), more: rows.length - max };
}

/** Sessions with a blocking row: what the badge counts. */
export const blockingCount = (rows: AttentionRow[]) => new Set(rows.filter((x) => BLOCKING.has(x.kind)).map((x) => x.sessionId)).size;

/** "3 need you · 1 to review · 2 working"; zero parts left out. */
export function focusSubtitle(rows: AttentionRow[], working: number): string {
  const b = blockingCount(rows);
  const review = new Set(rows.filter((x) => !BLOCKING.has(x.kind)).map((x) => x.sessionId)).size;
  const parts = [b && `${b} ${b === 1 ? "needs" : "need"} you`, review && `${review} to review`, working && `${working} working`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing needs you";
}
