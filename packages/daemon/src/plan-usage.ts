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
// ponytail: a server still on the old window right at its reset is not retried; the next turn or stale connect read fixes it.
/** A read at a reset time waits this long, so the server has rolled the window over. */
export const RESET_GRACE_MS = 10_000;
/** Longest setTimeout delay (2^31-1 ms, 24.8 days); Node runs a longer one after 1 ms. A later reset re-arms on each fire. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
// Window labels of a rate_limit_event's rateLimitType (SDK 0.3.285), for "Limit reached: …".
const LIMIT_LABELS: Record<string, string> = {
  five_hour: LABELS.session!,
  seven_day: LABELS.weekly_all!,
  seven_day_opus: "Current week (Opus)",
  seven_day_sonnet: "Current week (Sonnet)",
};
const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

/** Null when plan limits do not apply (API key, Bedrock, Vertex); undefined when they apply but the CLI could not fetch them. */
export function planUsage(r: SDKControlGetUsageResponse): PlanUsage | null | undefined {
  const limits = r.rate_limits;
  if (!r.rate_limits_available) return null;
  if (!limits) return undefined;
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
  const windows: PlanWindow[] = rows.map((row) => ({ kind: row.kind, label: label(row), percent: Math.round(row.percent), resetsAt: ms(row.resets_at), severity: row.severity, active: row.is_active }));
  return { plan: r.subscription_type, windows, status: "allowed" };
}

/**
 * Latest plan usage of the account. `refresh()` after each turn on the session's query; `rateLimit()` on each
 * `rate_limit_event` (its status shows at once, then a refresh). The status ends at its reset time; one without a
 * reset time ends on the next read after its own. At the earliest reset time (status or window) `read` runs, so an
 * idle page leaves the limit too. An older answer arriving later is dropped.
 */
export function createPlanTracker({ onChange, read = async () => {} }: { onChange: (u: PlanUsage | null) => void; read?: () => Promise<void> }) {
  let usage: PlanUsage | null | undefined;
  let status: Pick<PlanUsage, "status" | "statusResetsAt" | "statusLimit"> = { status: "allowed" };
  let statusRead = 0;
  let expiry: NodeJS.Timeout | undefined;
  let request = 0;
  let readAt = 0;
  let pending: Promise<void> | undefined;
  const current = () => (usage ? { ...usage, ...status } : usage);
  /** One read at a time: a burst of callers shares it. */
  const reread = () => (pending ??= read().catch((err) => console.error("plan usage failed:", err)).finally(() => (pending = undefined)));
  // The CLI sends rate_limit_event and usage only during a turn: nothing else ends a limit while idle.
  function arm() {
    clearTimeout(expiry);
    const now = Date.now();
    const at = Math.min(...[status.statusResetsAt, ...(usage?.windows.map((w) => w.resetsAt) ?? [])].filter((t): t is number => !!t && t > now));
    if (at === Infinity) return;
    const delay = at - now + RESET_GRACE_MS;
    expiry = setTimeout(() => {
      // Not there yet (delay clamped): wait the rest.
      if (delay > MAX_TIMER_MS) return arm();
      if (status.statusResetsAt && status.statusResetsAt <= Date.now()) setStatus({ status: "allowed" });
      if (usage) onChange(current()!);
      arm();
      void reread();
    }, Math.min(delay, MAX_TIMER_MS)).unref();
  }
  function setStatus(s: typeof status) {
    status = s;
    arm();
  }

  async function refresh(q: Query) {
    const n = ++request;
    readAt = Date.now();
    try {
      const r = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      if (n !== request) return;
      const u = planUsage(r);
      if (u === undefined) return;
      usage = u;
      if (n > statusRead && !status.statusResetsAt) setStatus({ status: "allowed" });
      arm();
      onChange(current()!);
    } catch (err) {
      console.error("plan usage failed:", err);
    }
  }

  return {
    /** Undefined until the first answer. */
    current,
    refresh,
    reread,
    /** Ms since the last read started (Infinity before the first). */
    age: () => (readAt ? Date.now() - readAt : Infinity),
    rateLimit(info: SDKRateLimitInfo, q: Query) {
      const limit = info.rateLimitType && (LIMIT_LABELS[info.rateLimitType] ?? info.rateLimitType);
      setStatus(
        info.status === "allowed"
          ? { status: "allowed" }
          : { status: info.status, ...(info.resetsAt ? { statusResetsAt: info.resetsAt * 1000 } : {}), ...(limit ? { statusLimit: limit } : {}) },
      );
      statusRead = request + 1;
      if (usage) onChange(current()!);
      return refresh(q);
    },
  };
}

export type PlanTracker = ReturnType<typeof createPlanTracker>;
