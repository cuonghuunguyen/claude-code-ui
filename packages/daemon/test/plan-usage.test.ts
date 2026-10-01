import { describe, expect, it, vi } from "vitest";
import type { PlanUsage } from "@claude-ui/protocol";
import { createPlanTracker, planUsage } from "../src/plan-usage.ts";
import { fakePlanUsage } from "./fake-query.ts";

const at = (iso: string) => new Date(iso).getTime();

describe("plan usage", () => {
  it("maps the server's usage rows: label from kind and scope, percent, reset time in ms, severity", () => {
    expect(planUsage(fakePlanUsage as never)).toEqual({
      plan: "team",
      status: "allowed",
      windows: [
        { kind: "session", label: "Current session", percent: 55, resetsAt: at("2026-10-01T11:40:00.938490+00:00"), severity: "normal", active: true },
        { kind: "weekly_all", label: "Current week (all models)", percent: 44, resetsAt: at("2026-10-03T17:00:00.938512+00:00"), severity: "normal", active: false },
        { kind: "weekly_scoped", label: "Current week (Fable)", percent: 2, resetsAt: at("2026-10-03T16:59:59.938700+00:00"), severity: "normal", active: false },
      ],
    });
  });

  it("falls back to the typed windows when the response has no rows", () => {
    const u = planUsage({ ...fakePlanUsage, rate_limits: { ...fakePlanUsage.rate_limits, limits: null } } as never);
    expect(u!.windows.map((w) => [w.label, w.percent])).toEqual([
      ["Current session", 55],
      ["Current week (all models)", 44],
    ]);
  });

  it("is null without plan limits (API key, Bedrock, Vertex)", () => {
    expect(planUsage({ ...fakePlanUsage, rate_limits_available: false, rate_limits: null } as never)).toBeNull();
  });

  it("reads with skipBehaviors, applies rate_limit_event status, drops an older answer", async () => {
    const seen: (PlanUsage | null)[] = [];
    const t = createPlanTracker({ onChange: (u) => seen.push(u) });
    let release!: () => void;
    const slow = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(() => new Promise((r) => (release = () => r({ ...fakePlanUsage, subscription_type: "old" })))) };
    const fast = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => fakePlanUsage) };
    const first = t.refresh(slow as never);
    await t.refresh(fast as never);
    release();
    await first;
    expect(fast.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).toHaveBeenCalledWith({ skipBehaviors: true });
    expect(seen.map((u) => u?.plan)).toEqual(["team"]);

    await t.rateLimit({ status: "rejected", resetsAt: 1790854800, rateLimitType: "five_hour" }, fast as never);
    expect(seen.at(-2)).toMatchObject({ status: "rejected", statusResetsAt: 1790854800_000 });
    expect(t.current()).toMatchObject({ plan: "team", status: "rejected" });
    await t.rateLimit({ status: "allowed" }, fast as never);
    expect(t.current()).toMatchObject({ status: "allowed" });
    expect(t.current()!.statusResetsAt).toBeUndefined();
  });

  it("a failed read keeps the last value", async () => {
    const seen: unknown[] = [];
    const t = createPlanTracker({ onChange: (u) => seen.push(u) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.refresh({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => Promise.reject(new Error("boom")) } as never);
    expect(seen).toEqual([]);
    expect(t.current()).toBeUndefined();
  });
});
