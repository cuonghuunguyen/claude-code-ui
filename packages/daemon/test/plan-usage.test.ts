import { describe, expect, it, vi } from "vitest";
import type { PlanUsage } from "@claude-ui/protocol";
import { createPlanTracker, eventWindows, planUsage } from "../src/plan-usage.ts";
import { fakePlanUsage } from "./fake-query.ts";

const at = (iso: string) => new Date(iso).getTime();
const s = (iso: string) => at(iso) / 1000;
const envTokenUsage = { ...fakePlanUsage, subscription_type: null, rate_limits_available: false, rate_limits: null };
const usageQ = (reply: unknown) => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => reply });
const unified = { five_hour: { utilization: 0.54, resetsAt: s("2026-10-01T11:00:00Z") }, seven_day: { utilization: 0.43, resetsAt: s("2026-10-03T17:00:00Z") } };
const eventInfo = { status: "allowed", rateLimitType: "five_hour", resetsAt: s("2026-10-01T11:00:00Z"), unifiedWindows: unified } as never;

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
    const u = planUsage({ ...fakePlanUsage, rate_limits: { ...fakePlanUsage.rate_limits, limits: null, seven_day_opus: { utilization: 7, resets_at: null } } } as never);
    expect(u!.windows.map((w) => [w.label, w.percent])).toEqual([
      ["Current session", 55],
      ["Current week (all models)", 44],
      ["Current week (Opus)", 7],
    ]);
    const scoped = planUsage({ ...fakePlanUsage, rate_limits: { ...fakePlanUsage.rate_limits, limits: null, model_scoped: [{ display_name: "Fable", utilization: 2, resets_at: null }] } } as never);
    expect(scoped!.windows.at(-1)).toMatchObject({ kind: "weekly_scoped", label: "Current week (Fable)", percent: 2 });
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

  it("a rejected status ends at its reset time, also without a new turn; one without a reset time ends on the next read", async () => {
    vi.useFakeTimers({ now: at("2026-10-01T10:00:00Z") });
    try {
      const seen: (PlanUsage | null)[] = [];
      const t = createPlanTracker({ onChange: (u) => seen.push(u) });
      const q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => fakePlanUsage };
      await t.rateLimit({ status: "rejected", resetsAt: at("2026-10-01T11:00:00Z") / 1000, rateLimitType: "five_hour" }, q as never);
      expect(t.current()).toMatchObject({ status: "rejected" });
      await vi.advanceTimersByTimeAsync(61 * 60_000);
      expect(seen.at(-1)).toMatchObject({ status: "allowed" });
      expect(seen.at(-1)!.statusResetsAt).toBeUndefined();
      await t.refresh(q as never);
      expect(t.current()).toMatchObject({ status: "allowed" });

      await t.rateLimit({ status: "rejected", rateLimitType: "five_hour" }, q as never);
      expect(t.current()).toMatchObject({ status: "rejected" });
      await t.refresh(q as never);
      expect(t.current()).toMatchObject({ status: "allowed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads again at the earliest reset time, also without a turn: a window at 100% drops back after its reset", async () => {
    vi.useFakeTimers({ now: at("2026-10-01T10:00:00Z") });
    try {
      const seen: (PlanUsage | null)[] = [];
      const full = structuredClone(fakePlanUsage);
      full.rate_limits.limits[0]!.percent = 100;
      full.rate_limits.limits[0]!.resets_at = "2026-10-01T11:00:00Z";
      const fresh = structuredClone(fakePlanUsage);
      fresh.rate_limits.limits[0]!.percent = 0;
      const answers = [full, fresh];
      const q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => answers.shift() ?? fresh) };
      const t = createPlanTracker({ onChange: (u) => seen.push(u), read: () => t.refresh(q as never) });
      await t.rateLimit({ status: "rejected", resetsAt: at("2026-10-01T11:00:00Z") / 1000, rateLimitType: "five_hour" }, q as never);
      expect(seen.at(-1)).toMatchObject({ status: "rejected" });
      expect(seen.at(-1)!.windows[0]!.percent).toBe(100);
      await vi.advanceTimersByTimeAsync(61 * 60_000);
      expect(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).toHaveBeenCalledTimes(2);
      expect(seen.at(-1)).toMatchObject({ status: "allowed" });
      expect(seen.at(-1)!.windows[0]!.percent).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reset more than 24.8 days away (above the setTimeout limit) waits in clamped steps: no read loop, read at the reset", async () => {
    vi.useFakeTimers({ now: at("2026-10-01T10:00:00Z") });
    try {
      const seen: (PlanUsage | null)[] = [];
      const read = vi.fn(async () => {});
      const t = createPlanTracker({ onChange: (u) => seen.push(u), read });
      const q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ ...fakePlanUsage, rate_limits: { ...fakePlanUsage.rate_limits, limits: [] } }) };
      const reset = at("2026-10-31T10:00:00Z");
      await t.rateLimit({ status: "rejected", resetsAt: reset / 1000, rateLimitType: "overage" }, q as never);
      const changes = seen.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect({ reads: read.mock.calls.length, changes: seen.length }).toEqual({ reads: 0, changes });
      await vi.advanceTimersByTimeAsync(2 ** 31);
      expect(read).not.toHaveBeenCalled();
      expect(t.current()).toMatchObject({ status: "rejected" });
      await vi.advanceTimersByTimeAsync(reset - Date.now() + 10_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(t.current()).toMatchObject({ status: "allowed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejected status names its window from rateLimitType", async () => {
    const t = createPlanTracker({ onChange: () => {} });
    const q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => fakePlanUsage };
    await t.rateLimit({ status: "rejected", rateLimitType: "seven_day_opus" }, q as never);
    expect(t.current()).toMatchObject({ status: "rejected", statusLimit: "Current week (Opus)" });
  });

  it("coalesces rereads: a burst while one is pending starts one read", async () => {
    let release!: () => void;
    const read = vi.fn(() => new Promise<void>((r) => (release = r)));
    const t = createPlanTracker({ onChange: () => {}, read });
    const a = t.reread();
    t.reread();
    t.reread();
    release();
    await a;
    expect(read).toHaveBeenCalledTimes(1);
    void t.reread();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the last value when plan limits apply but the CLI returned none", async () => {
    const seen: (PlanUsage | null)[] = [];
    const t = createPlanTracker({ onChange: (u) => seen.push(u) });
    await t.refresh({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => fakePlanUsage } as never);
    await t.refresh({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ ...fakePlanUsage, rate_limits: null }) } as never);
    expect(seen).toHaveLength(1);
    expect(t.current()).toMatchObject({ plan: "team" });
  });

  it("a failed read keeps the last value", async () => {
    const seen: unknown[] = [];
    const t = createPlanTracker({ onChange: (u) => seen.push(u) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.refresh({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => Promise.reject(new Error("boom")) } as never);
    expect(seen).toEqual([]);
    expect(t.current()).toBeUndefined();
  });

  it("env token (CLAUDE_CODE_OAUTH_TOKEN): no plan limits from get_usage gives the unavailable state, not null", async () => {
    const seen: (PlanUsage | null)[] = [];
    const t = createPlanTracker({ onChange: (u) => seen.push(u), oauthToken: true });
    await t.refresh(usageQ(envTokenUsage) as never);
    expect(seen).toEqual([{ plan: null, windows: [], status: "allowed", auth: "oauth_token" }]);
  });

  it("without the env token the same reply stays null (API key, Bedrock, Vertex)", async () => {
    const seen: (PlanUsage | null)[] = [];
    const t = createPlanTracker({ onChange: (u) => seen.push(u) });
    await t.refresh(usageQ(envTokenUsage) as never);
    expect(seen).toEqual([null]);
  });

  it("env token: a rate_limit_event's unifiedWindows fill the session and week windows, kept by the next get_usage read", async () => {
    vi.useFakeTimers({ now: at("2026-10-01T10:00:00Z") });
    try {
      const t = createPlanTracker({ onChange: () => {}, oauthToken: true });
      const q = usageQ(envTokenUsage) as never;
      await t.refresh(q);
      await t.rateLimit(eventInfo, q);
      const expected = {
        plan: null,
        auth: "oauth_token",
        status: "allowed",
        windows: [
          { kind: "session", label: "Current session", percent: 54, resetsAt: at("2026-10-01T11:00:00Z"), severity: "normal", active: true },
          { kind: "weekly_all", label: "Current week (all models)", percent: 43, resetsAt: at("2026-10-03T17:00:00Z"), severity: "normal", active: false },
        ],
      };
      expect(t.current()).toEqual(expected);
      await t.refresh(q);
      expect(t.current()).toEqual(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("event windows past their reset read 0% after the reset-time reread", async () => {
    vi.useFakeTimers({ now: at("2026-10-01T10:00:00Z") });
    try {
      const seen: (PlanUsage | null)[] = [];
      const q = usageQ(envTokenUsage) as never;
      const t = createPlanTracker({ onChange: (u) => seen.push(u), oauthToken: true, read: () => t.refresh(q) });
      await t.refresh(q);
      await t.rateLimit(eventInfo, q);
      await vi.advanceTimersByTimeAsync(61 * 60_000);
      expect(seen.at(-1)!.windows[0]).toMatchObject({ kind: "session", percent: 0, resetsAt: null });
      expect(seen.at(-1)!.windows[1]!.percent).toBe(43);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a login session ignores unifiedWindows: get_usage rows win", async () => {
    const t = createPlanTracker({ onChange: () => {} });
    const q = usageQ(fakePlanUsage) as never;
    await t.refresh(q);
    await t.rateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.99, resetsAt: s("2026-10-01T11:00:00Z") } } } as never, q);
    expect(t.current()!.windows[0]!.percent).toBe(55);
    expect(t.current()!.auth).toBeUndefined();
  });

  it("env token with a scope override whose fetch fails (rate_limits null) shows the unavailable state before any value", async () => {
    const seen: (PlanUsage | null)[] = [];
    const t = createPlanTracker({ onChange: (u) => seen.push(u), oauthToken: true });
    await t.refresh(usageQ({ ...fakePlanUsage, subscription_type: null, rate_limits: null }) as never);
    expect(seen).toEqual([{ plan: null, windows: [], status: "allowed", auth: "oauth_token" }]);
  });

  it("eventWindows: percent from the 0-1 fraction (can pass 100), missing windows left out, none -> undefined", () => {
    expect(eventWindows({ five_hour: { utilization: 1.05, resetsAt: s("2026-10-01T11:00:00Z") } }, at("2026-10-01T10:00:00Z"))).toEqual([
      { kind: "session", label: "Current session", percent: 105, resetsAt: at("2026-10-01T11:00:00Z"), severity: "normal", active: true },
    ]);
    expect(eventWindows(undefined)).toBeUndefined();
    expect(eventWindows({})).toBeUndefined();
  });
});
