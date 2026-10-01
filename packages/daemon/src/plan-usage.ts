// Plan usage (Claude Code `/usage`): the only place that calls the experimental SDK usage API, so a rename touches this file.
import type { Query, SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { PlanUsage, PlanWindow } from "@claude-ui/protocol";

/** A server usage row; untyped in the SDK 0.3.285 get_usage reply but sent (typed on `SDKUsageReport`). */
type Row = {
  kind: string;
  percent: number;
  resets_at: string | null;
  severity: string;
  is_active: boolean;
  scope?: { model?: { display_name: string } | null; surface?: { display_name: string } | null } | null;
};

// Claude Code `/usage` wording. Classify on kind, never on a label.
const LABELS: Record<string, string> = { session: "Current session", weekly_all: "Current week (all models)" };
const label = (r: Row) => {
  const scope = r.scope?.model?.display_name ?? r.scope?.surface?.display_name;
  return LABELS[r.kind] ?? (scope ? `Current week (${scope})` : r.kind);
};
const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

/** Null when plan limits do not apply (API key, Bedrock, Vertex) or the CLI could not fetch them. */
export function planUsage(r: SDKControlGetUsageResponse): PlanUsage | null {
  const limits = r.rate_limits;
  if (!r.rate_limits_available || !limits) return null;
  let rows = (limits as { limits?: Row[] | null }).limits;
  // A server without rows: the typed windows, graded by nobody.
  rows ??= (
    [
      ["session", limits.five_hour],
      ["weekly_all", limits.seven_day],
    ] as const
  ).flatMap(([kind, w]) => (w?.utilization == null ? [] : [{ kind, percent: w.utilization, resets_at: w.resets_at, severity: "normal", is_active: kind === "session" }]));
  const windows: PlanWindow[] = rows.map((row) => ({ kind: row.kind, label: label(row), percent: row.percent, resetsAt: ms(row.resets_at), severity: row.severity, active: row.is_active }));
  return { plan: r.subscription_type, windows, status: "allowed" };
}

/**
 * Latest plan usage of the account. `refresh()` after each turn on the session's query; `rateLimit()` on each
 * `rate_limit_event` (its status shows at once, then a refresh). An older answer arriving later is dropped.
 */
export function createPlanTracker({ onChange }: { onChange: (u: PlanUsage | null) => void }) {
  let usage: PlanUsage | null | undefined;
  let status: Pick<PlanUsage, "status" | "statusResetsAt"> = { status: "allowed" };
  let request = 0;
  let readAt = 0;
  const current = () => (usage ? { ...usage, ...status } : usage);

  async function refresh(q: Query) {
    const n = ++request;
    readAt = Date.now();
    try {
      const r = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      if (n !== request) return;
      usage = planUsage(r);
      onChange(current()!);
    } catch (err) {
      console.error("plan usage failed:", err);
    }
  }

  return {
    /** Undefined until the first answer. */
    current,
    refresh,
    /** Ms since the last read started (Infinity before the first). */
    age: () => (readAt ? Date.now() - readAt : Infinity),
    rateLimit(info: SDKRateLimitInfo, q: Query) {
      status = info.status === "allowed" ? { status: "allowed" } : { status: info.status, ...(info.resetsAt ? { statusResetsAt: info.resetsAt * 1000 } : {}) };
      if (usage) onChange(current()!);
      return refresh(q);
    },
  };
}

export type PlanTracker = ReturnType<typeof createPlanTracker>;
