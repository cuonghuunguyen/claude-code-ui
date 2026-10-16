// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { AUTO_CLOSE_EVERY_MS, CLEANUP_RULES, autoCloseDue, autoCloseTargets, cleanupMenu, cleanupTargets, keepReason, loadAutoClose, matchesRule, saveAutoClose, type CleanupContext, type TabFacts } from "./tab-cleanup.ts";
import { NEW_TAB } from "./tabs.ts";

const NOW = 1_000_000_000_000;
const f = (id: string, over: Partial<TabFacts> = {}): TabFacts => ({ id, state: "idle", unread: false, draft: false, listed: true, archived: false, worker: false, transcript: true, busy: false, lastUsed: NOW - 10, ...over });
const ctx = (over: Partial<CleanupContext> = {}): CleanupContext => ({ now: NOW, pinned: new Set(), listLoaded: true, activeId: "act", ...over });

describe("GH-378 tab cleanup rules", () => {
  it("GH-378 idle matches idle, closed and the New session tab; not error, running or needs_input", () => {
    for (const state of ["idle", "closed"] as const) expect(matchesRule("idle", f("a", { state }), ctx())).toBe(true);
    for (const state of ["error", "running", "needs_input"] as const) expect(matchesRule("idle", f("a", { state }), ctx())).toBe(false);
    expect(matchesRule("idle", f(NEW_TAB, { state: undefined }), ctx())).toBe(true);
    expect(matchesRule("idle", f("a", { state: undefined }), ctx())).toBe(false);
  });

  it("GH-378 finished needs idle + transcript + read + nothing queued; never closed, error or the New session tab", () => {
    expect(matchesRule("finished", f("a"), ctx())).toBe(true);
    expect(matchesRule("finished", f("a", { transcript: false }), ctx())).toBe(false);
    expect(matchesRule("finished", f("a", { unread: true }), ctx())).toBe(false);
    expect(matchesRule("finished", f("a", { busy: true }), ctx())).toBe(false);
    expect(matchesRule("finished", f("a", { state: "closed" }), ctx())).toBe(false);
    expect(matchesRule("finished", f("a", { state: "error" }), ctx())).toBe(false);
    expect(matchesRule("finished", f(NEW_TAB), ctx())).toBe(false);
  });

  it("GH-378 archived matches archived, and unlisted only once the list is loaded", () => {
    expect(matchesRule("archived", f("a", { archived: true }), ctx())).toBe(true);
    expect(matchesRule("archived", f("a", { listed: false }), ctx())).toBe(true);
    expect(matchesRule("archived", f("a", { listed: false }), ctx({ listLoaded: false }))).toBe(false);
    expect(matchesRule("archived", f("a", { archived: true }), ctx({ listLoaded: false }))).toBe(true);
    expect(matchesRule("archived", f(NEW_TAB, { listed: true, archived: true }), ctx())).toBe(false);
  });

  it("GH-378 unused 1h/1d/7d compare now - lastUsed with the threshold; no stamp never matches", () => {
    const h = 3_600_000;
    const at = (ms: number) => f("a", { lastUsed: NOW - ms });
    expect(matchesRule("unused1h", at(h), ctx())).toBe(true);
    expect(matchesRule("unused1h", at(h - 1), ctx())).toBe(false);
    expect(matchesRule("unused1d", at(24 * h), ctx())).toBe(true);
    expect(matchesRule("unused1d", at(23 * h), ctx())).toBe(false);
    expect(matchesRule("unused7d", at(7 * 24 * h), ctx())).toBe(true);
    expect(matchesRule("unused7d", at(6 * 24 * h), ctx())).toBe(false);
    expect(matchesRule("unused1h", f("a", { lastUsed: undefined }), ctx())).toBe(false);
  });

  it("GH-378 workers matches tabs with a coordinator", () => {
    expect(matchesRule("workers", f("a", { worker: true }), ctx())).toBe(true);
    expect(matchesRule("workers", f("a"), ctx())).toBe(false);
    expect(matchesRule("workers", f(NEW_TAB, { worker: true }), ctx())).toBe(false);
  });

  it("GH-378 safety: active, pinned, running, busy, needs input, unread and draft tabs are never targets of any rule", () => {
    const everything = { archived: true, worker: true, lastUsed: 0 };
    const kept = [f("act", everything), f("pin", everything), f("run", { ...everything, state: "running" }), f("busy", { ...everything, busy: true }), f("ask", { ...everything, state: "needs_input" }), f("unr", { ...everything, unread: true }), f("dr", { ...everything, draft: true })];
    const c = ctx({ pinned: new Set(["pin"]) });
    for (const rule of CLEANUP_RULES) expect(cleanupTargets(rule, [...kept, f("free", everything)], c)).toEqual(["free"]);
    for (const rule of CLEANUP_RULES) expect(cleanupTargets(rule, kept, c)).toEqual([]);
  });

  it("GH-378 a tab whose view is still loading is never a target of any rule and shows as 'loading' in the kept line", () => {
    const everything = { archived: true, worker: true, lastUsed: 0, loading: true };
    for (const rule of CLEANUP_RULES) expect(cleanupTargets(rule, [f("l", everything)], ctx())).toEqual([]);
    expect(keepReason(f("l", { loading: true }), ctx())).toBe("loading");
    expect(keepReason(f("l", { loading: true, state: "running" }), ctx())).toBe("loading");
    expect(keepReason(f("p", { loading: true }), ctx({ pinned: new Set(["p"]) }))).toBe("pinned");
    expect(cleanupMenu([f("act"), f("l", { loading: true }), f("r", { state: "running" })], ctx()).kept.text).toBe("2 kept: loading/running");
    expect(autoCloseTargets([f("l", { loading: true, lastUsed: 0 })], ctx(), "1h")).toEqual([]);
  });

  it("GH-378 keepReason order: active > pinned > running > needs_input > unread > draft", () => {
    const c = ctx({ pinned: new Set(["p"]) });
    const all = { state: "running" as const, unread: true, draft: true };
    expect(keepReason(f("act", all), c)).toBe("active");
    expect(keepReason(f("p", all), c)).toBe("pinned");
    expect(keepReason(f("a", all), c)).toBe("running");
    expect(keepReason(f("a", { state: "needs_input", unread: true, draft: true }), c)).toBe("needs_input");
    expect(keepReason(f("a", { unread: true, draft: true }), c)).toBe("unread");
    expect(keepReason(f("a", { draft: true }), c)).toBe("draft");
    expect(keepReason(f("a", { busy: true }), c)).toBe("running");
    expect(keepReason(f("a"), c)).toBeUndefined();
  });

  it("GH-378 cleanupTargets keeps strip order and honours scope", () => {
    const facts = [f("a"), f("b", { state: "running" }), f("c"), f("d")];
    expect(cleanupTargets("idle", facts, ctx())).toEqual(["a", "c", "d"]);
    expect(cleanupTargets("idle", facts, ctx(), new Set(["c", "a", "b"]))).toEqual(["a", "c"]);
  });

  it("GH-378 cleanupMenu lists every rule with its count, 0 included, and the kept line without the active tab", () => {
    const facts = [f("act", { unread: true }), f("p"), f("r", { state: "running" }), f("n", { state: "needs_input" }), f("u", { unread: true }), f("d", { draft: true }), f("w", { worker: true }), f("x", { archived: true })];
    const m = cleanupMenu(facts, ctx({ pinned: new Set(["p"]) }));
    expect(m.items.map((i) => i.rule)).toEqual(CLEANUP_RULES);
    expect(m.items.find((i) => i.rule === "idle")!.count).toBe(2);
    expect(m.items.find((i) => i.rule === "unused1d")!.count).toBe(0);
    expect(m.items.find((i) => i.rule === "workers")!.count).toBe(1);
    expect(m.kept).toEqual({ count: 5, text: "5 kept: pinned/running/needs input/unread/draft" });
    expect(cleanupMenu([f("act"), f("a")], ctx()).kept).toEqual({ count: 0, text: "" });
    expect(cleanupMenu(facts, ctx({ pinned: new Set(["p"]) }), new Set(["r", "d"])).kept.text).toBe("2 kept: running/draft");
  });

  it("GH-378 autoCloseTargets: off closes nothing; 1h/1d close idle tabs older than that, safety applied", () => {
    const h = 3_600_000;
    const facts = [f("old", { lastUsed: NOW - 2 * h }), f("new", { lastUsed: NOW - 10 }), f("oldrun", { state: "running", lastUsed: NOW - 2 * h }), f("olddraft", { draft: true, lastUsed: NOW - 2 * h }), f("older", { lastUsed: NOW - 30 * h }), f("nostamp", { lastUsed: undefined }), f("oldwork", { state: "idle", worker: true, lastUsed: NOW - 2 * h })];
    expect(autoCloseTargets(facts, ctx(), "off")).toEqual([]);
    expect(autoCloseTargets(facts, ctx(), "1h")).toEqual(["old", "older", "oldwork"]);
    expect(autoCloseTargets(facts, ctx(), "1d")).toEqual(["older"]);
  });

  it("GH-378 autoCloseDue throttles to 15 minutes", () => {
    expect(autoCloseDue(NOW, undefined)).toBe(true);
    expect(autoCloseDue(NOW, NOW - AUTO_CLOSE_EVERY_MS + 1)).toBe(false);
    expect(autoCloseDue(NOW, NOW - AUTO_CLOSE_EVERY_MS)).toBe(true);
  });
});

describe("GH-378 auto-close setting", () => {
  beforeEach(() => localStorage.clear());
  it("GH-378 loadAutoClose: default off, stored value read, junk → off", () => {
    expect(loadAutoClose()).toBe("off");
    saveAutoClose("1h");
    expect(loadAutoClose()).toBe("1h");
    saveAutoClose("1d");
    expect(loadAutoClose()).toBe("1d");
    localStorage.setItem("claude-ui.tabAutoClose", "weekly");
    expect(loadAutoClose()).toBe("off");
    saveAutoClose("off");
    expect(localStorage.getItem("claude-ui.tabAutoClose")).toBeNull();
  });
});
