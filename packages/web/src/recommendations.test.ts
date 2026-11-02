// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAP_MS, KEY, PER_DAY, RULES, gate, localDay, markShown, nextStreak, offer, parseRec, promptBusy, resetPageForTests, scrolledFar, seen, setRecommendationHost, setRecommendationsOn, streak, count, bump, type RecState } from "./recommendations.ts";

const fresh = (): RecState => ({ v: 1, shown: [], dayCount: 0, counts: {} });
const shown = vi.fn();
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as RecState;
const ctx = { pageShown: false, blocked: false, toast: false, skipToast: false };
const T0 = new Date(2026, 5, 1, 10, 0, 0).getTime();
const toast = (id = "toast") => {
  const r = document.createElement("div");
  r.setAttribute("data-testid", "toast-region");
  r.innerHTML = `<div data-testid="${id}"></div>`;
  document.body.append(r);
  return r;
};
const ok = (now = T0) => offer("compactTabs", { compact: false, overflow: true, projects: 3 }, () => {}, now);

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  resetPageForTests();
  shown.mockReset();
  setRecommendationHost({ blocked: () => false, show: shown });
});
afterEach(() => {
  setRecommendationHost(undefined);
  vi.restoreAllMocks();
});

const pushOk = { needed: true, pushOn: false, supported: true, secure: true, permission: "default" as NotificationPermission, local: true, desktopOn: false };
const ROWS: { id: keyof typeof RULES; yes: object; no: object[] }[] = [
  { id: "jira", yes: { ready: false }, no: [{ ready: true }] },
  { id: "compactTabs", yes: { compact: false, overflow: true, projects: 3 }, no: [{ compact: true, overflow: true, projects: 3 }, { compact: false, overflow: false, projects: 3 }, { compact: false, overflow: true, projects: 2 }] },
  { id: "cleanupTabs", yes: { count: 15 }, no: [{ count: 14 }] },
  { id: "autoClose", yes: { autoClose: "off", n: 2 }, no: [{ autoClose: "1d", n: 2 }, { autoClose: "1h", n: 2 }, { autoClose: "off", n: 1 }] },
  { id: "diffMode", yes: { mode: "branch", def: "session", streak: 3 }, no: [{ mode: "branch", def: "branch", streak: 3 }, { mode: "branch", def: "session", streak: 2 }] },
  { id: "searchSessions", yes: { far: true, empty: true }, no: [{ far: false, empty: true }, { far: true, empty: false }] },
  { id: "artifactsPane", yes: { artifacts: 3, paneSeen: false }, no: [{ artifacts: 2, paneSeen: false }, { artifacts: 3, paneSeen: true }] },
  { id: "contextBreakdown", yes: { visible: true, percent: 51 }, no: [{ visible: false, percent: 80 }, { visible: true, percent: 50 }] },
  { id: "push", yes: pushOk, no: [{ ...pushOk, needed: false }, { ...pushOk, pushOn: true }, { ...pushOk, supported: false }, { ...pushOk, secure: false }, { ...pushOk, permission: "denied" }, { ...pushOk, desktopOn: true }] },
  { id: "keepAwake", yes: { slept: true, supported: true, on: false }, no: [{ slept: false, supported: true, on: false }, { slept: true, supported: false, on: false }, { slept: true, supported: true, on: true }] },
  { id: "middleClick", yes: { fine: true, n: 2 }, no: [{ fine: false, n: 2 }, { fine: true, n: 1 }] },
  { id: "phoneSwipe", yes: { phone: true, n: 3 }, no: [{ phone: false, n: 3 }, { phone: true, n: 2 }] },
];

describe("rules", () => {
  it.each(ROWS)("each rule: $id when() is true only for its condition", ({ id, yes, no }) => {
    const r = RULES[id] as { when: (f: object) => boolean; text: (f: object) => string };
    expect(r.when(yes)).toBe(true);
    for (const f of no) expect(r.when(f)).toBe(false);
    expect(r.text({ ...yes, count: 15, mode: "branch" })).not.toMatch(/^rec\./);
  });

  it("a setting rule at its recommended value never shows", () => {
    expect(offer("compactTabs", { compact: true, overflow: true, projects: 5 })).toBe(false);
    expect(offer("autoClose", { autoClose: "1d", n: 9 })).toBe(false);
    expect(offer("diffMode", { mode: "branch", def: "branch", streak: 9 })).toBe(false);
    expect(offer("push", { ...pushOk, pushOn: true })).toBe(false);
    expect(offer("keepAwake", { slept: true, supported: true, on: true })).toBe(false);
    expect(shown).not.toHaveBeenCalled();
  });
});

describe("offer", () => {
  it("marks shown when it appears and never shows again", () => {
    expect(ok()).toBe(true);
    expect(shown).toHaveBeenCalledWith(expect.any(String), { label: "Turn on", run: expect.any(Function) });
    expect(stored().shown).toEqual(["compactTabs"]);
    resetPageForTests();
    expect(ok(T0 + 3 * 24 * 3600_000)).toBe(false);
  });

  it("not marked when the condition is false or a gate blocks", () => {
    expect(offer("compactTabs", { compact: true, overflow: true, projects: 3 })).toBe(false);
    expect(stored().shown ?? []).toEqual([]);
    setRecommendationHost({ blocked: () => true, show: shown });
    expect(ok()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it.each(["toast", "update-toast", "stale-toast"])("skips while another toast shows (%s) and shows at the next trigger", (id) => {
    const r = toast(id);
    expect(ok()).toBe(false);
    r.remove();
    expect(ok()).toBe(true);
  });

  it("autoClose stacks next to a toast", () => {
    toast();
    expect(offer("autoClose", { autoClose: "off", n: 2 })).toBe(true);
    expect(shown).toHaveBeenCalledOnce();
  });

  it("inline rule ignores toasts and needs no host", () => {
    toast();
    setRecommendationHost(undefined);
    expect(offer("jira", { ready: false })).toBe(true);
    expect(shown).not.toHaveBeenCalled();
  });

  it("a toast rule needs a host", () => {
    setRecommendationHost(undefined);
    expect(ok()).toBe(false);
  });

  it("one per page load", () => {
    expect(ok()).toBe(true);
    expect(offer("cleanupTabs", { count: 20 }, () => {}, T0 + 3600_000)).toBe(false);
    resetPageForTests();
    expect(offer("cleanupTabs", { count: 20 }, () => {}, T0 + 3600_000)).toBe(true);
  });

  it("five per local day, the sixth waits for the next day", () => {
    const ids = ["compactTabs", "cleanupTabs", "autoClose", "artifactsPane", "contextBreakdown", "keepAwake"] as const;
    let s = fresh();
    for (let i = 0; i < PER_DAY; i++) s = markShown(s, ids[i]!, T0 + i * GAP_MS);
    expect(gate(s, ids[5], T0 + 6 * GAP_MS, ctx)).toBe("day");
    expect(gate(s, ids[5], T0 + 24 * 3600_000, ctx)).toBeUndefined();
  });

  it("30 minutes between two", () => {
    const s = markShown(fresh(), "cleanupTabs", T0);
    expect(gate(s, "autoClose", T0 + GAP_MS - 1, ctx)).toBe("gap");
    expect(gate(s, "autoClose", T0 + GAP_MS, ctx)).toBeUndefined();
  });

  it("gate order", () => {
    expect(gate({ ...fresh(), off: true }, "jira", T0, ctx)).toBe("off");
    expect(gate(markShown(fresh(), "jira", T0), "jira", T0, { ...ctx, blocked: true })).toBe("shown");
    expect(gate(fresh(), "jira", T0, { ...ctx, blocked: true, toast: true })).toBe("blocked");
    expect(gate(fresh(), "jira", T0, { ...ctx, toast: true })).toBe("toast");
    expect(gate(fresh(), "jira", T0, { ...ctx, toast: true, skipToast: true, pageShown: true })).toBe("page");
  });

  it("blocked while the host says blocked", () => {
    setRecommendationHost({ blocked: () => true, show: shown });
    expect(ok()).toBe(false);
    expect(offer("jira", { ready: false })).toBe(false);
  });

  it("promptBusy: focused prompt textarea with text", () => {
    document.body.innerHTML = `<div data-testid="prompt-box"><textarea id="p"></textarea></div><textarea id="o"></textarea>`;
    const p = document.getElementById("p") as HTMLTextAreaElement;
    p.focus();
    expect(promptBusy()).toBe(false);
    p.value = "hi";
    expect(promptBusy()).toBe(true);
    const o = document.getElementById("o") as HTMLTextAreaElement;
    o.value = "x";
    o.focus();
    expect(promptBusy()).toBe(false);
  });

  it("master switch off: nothing shows; counters still count", () => {
    setRecommendationsOn(false);
    expect(ok()).toBe(false);
    expect(count("openInTab")).toBe(1);
    expect(stored().off).toBe(true);
    setRecommendationsOn(true);
    expect(stored().off).toBeUndefined();
    expect(count("openInTab")).toBe(2);
    expect(ok()).toBe(true);
  });

  it("blocked storage: once per page load", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(ok()).toBe(true);
    expect(ok(T0 + 3 * 24 * 3600_000)).toBe(false);
    expect(count("x")).toBeGreaterThan(0);
  });
});

describe("storage", () => {
  it("blocked write only (getItem works): counters keep counting in memory", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(count("x")).toBe(1);
    expect(count("x")).toBe(2);
    expect(seen("x")).toBe(2);
  });
});

describe("helpers", () => {
  it("parseRec drops garbage", () => {
    expect(parseRec(null)).toEqual(fresh());
    expect(parseRec("{bad")).toEqual(fresh());
    expect(parseRec('{"v":2}')).toEqual(fresh());
    const s = parseRec('{"v":1,"shown":["jira","nope",3],"dayCount":2,"day":"2026-6-1","lastAt":5,"counts":{"a":2,"b":1.5,"c":"x"},"streak":{"mode":"branch","n":2}}');
    expect(s.shown).toEqual(["jira"]);
    expect(s.counts).toEqual({ a: 2 });
    expect(s.streak).toEqual({ mode: "branch", n: 2 });
    expect(s.dayCount).toBe(2);
  });
  it("localDay uses local time", () => expect(localDay(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-1-5"));
  it("bump caps at 99", () => expect(bump({ ...fresh(), counts: { a: 99 } }, "a").counts.a).toBe(99));
  it("streak resets on another mode", () => {
    expect(nextStreak(fresh(), "branch").streak).toEqual({ mode: "branch", n: 1 });
    expect(nextStreak(nextStreak(fresh(), "branch"), "branch").streak?.n).toBe(2);
    expect(nextStreak(nextStreak(fresh(), "branch"), "session").streak).toEqual({ mode: "session", n: 1 });
    expect([streak("branch"), streak("branch"), streak("session"), streak("branch")]).toEqual([1, 2, 1, 1]);
  });
  it("scrolledFar", () => {
    const s = [{ t: 0, top: 0 }, { t: 1000, top: 400 }, { t: 2000, top: 0 }, { t: 3000, top: 400 }];
    expect(scrolledFar(s, 3000, 400)).toBe(true);
    expect(scrolledFar(s, 3000, 500)).toBe(false);
    expect(scrolledFar(s, 20_000, 400)).toBe(false);
    expect(scrolledFar(s, 3000, 0)).toBe(false);
  });
});
