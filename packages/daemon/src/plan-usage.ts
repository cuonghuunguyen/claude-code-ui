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
  // A server without rows: the typed windows, graded by nobody. model_scoped replaces the older per-model fields.
  type Window = { utilization: number | null; resets_at: string | null } | null | undefined;
  const scoped: [string, Window][] = limits.model_scoped?.map((m) => [m.display_name, m]) ?? [
    ["Opus", limits.seven_day_opus],
    ["Sonnet", limits.seven_day_sonnet],
  ];
  rows ??= ([["session", null, limits.five_hour], ["weekly_all", null, limits.seven_day], ...scoped.map(([name, w]) => ["weekly_scoped", name, w])] as [string, string | null, Window][]).flatMap(
    ([kind, name, w]) =>
      w?.utilization == null
        ? []
        : [{ kind, percent: w.utilization, resets_at: w.resets_at, severity: "normal", is_active: kind === "session", scope: name ? { model: { display_name: name } } : null }],
  );
  const windows: PlanWindow[] = rows.map((row) => ({ kind: row.kind, label: label(row), percent: row.percent, resetsAt: ms(row.resets_at), severity: row.severity, active: row.is_active }));
  return { plan: r.subscription_type, windows, status: "allowed" };
}

/**
 * Latest plan usage of the account. `refresh()` after each turn on the session's query; `rateLimit()` on each
 * `rate_limit_event` (its status shows at once, then a refresh). The status ends at its reset time; one without a
 * reset time ends on the next read after its own. An older answer arriving later is dropped.
 */
export function createPlanTracker({ onChange }: { onChange: (u: PlanUsage | null) => void }) {
  let usage: PlanUsage | null | undefined;
  let status: Pick<PlanUsage, "status" | "statusResetsAt"> = { status: "allowed" };
  let statusRead = 0;
  let expiry: NodeJS.Timeout | undefined;
  let request = 0;
  let readAt = 0;
  const current = () => (usage ? { ...usage, ...status } : usage);
  function setStatus(s: typeof status) {
    status = s;
    clearTimeout(expiry);
    // The CLI sends rate_limit_event only during a turn: nothing else ends a limit while idle.
    if (s.statusResetsAt) expiry = setTimeout(() => (setStatus({ status: "allowed" }), usage && onChange(current()!)), s.statusResetsAt - Date.now()).unref();
  }

  async function refresh(q: Query) {
    const n = ++request;
    readAt = Date.now();
    try {
      const r = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      if (n !== request) return;
      usage = planUsage(r);
      if (n > statusRead && !status.statusResetsAt) setStatus({ status: "allowed" });
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
      setStatus(info.status === "allowed" ? { status: "allowed" } : { status: info.status, ...(info.resetsAt ? { statusResetsAt: info.resetsAt * 1000 } : {}) });
      statusRead = request + 1;
      if (usage) onChange(current()!);
      return refresh(q);
    },
  };
}

export type PlanTracker = ReturnType<typeof createPlanTracker>;
