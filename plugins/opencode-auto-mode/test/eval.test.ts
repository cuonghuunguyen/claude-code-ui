import { describe, expect, it } from "vitest";
import { EVAL_CONCURRENCY, formatEvalReport, runEval, selectCases, sameProject } from "../eval.ts";
import type { LabelRecord, LogContents } from "../log-store.ts";
import { decision } from "./fixtures.ts";

function logOf(decisions: ReturnType<typeof decision>[], labels: Array<[string, LabelRecord["reply"]]> = []): LogContents {
  return {
    decisions,
    labels: new Map(labels.map(([id, reply]) => [id, { v: 1, kind: "label" as const, at: "t", requestID: id, reply }])),
  };
}
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;

describe("sameProject", () => {
  it("ignores slash style, trailing slash and (on Windows paths) case", () => {
    expect(sameProject("C:\\Proj\\a\\", "c:/proj/a")).toBe(true);
    expect(sameProject("/a/b", "/a/c")).toBe(false);
  });
});

describe("selectCases", () => {
  const log = logOf(
    [
      decision({ requestID: "a", at: at(1), verdict: "allow" }),
      decision({ requestID: "b", at: at(2), verdict: "block", outcome: "deferred" }),
      decision({ requestID: "c", at: at(3), verdict: "none", outcome: "timeout" }),
      decision({ requestID: "d", at: at(4), verdict: "allow", input: undefined }),
      decision({ requestID: "e", at: at(5), verdict: "allow", project: "/other" }),
      decision({ requestID: "f", at: at(6), verdict: "block" }),
    ],
    [["a", "reject"], ["b", "once"], ["c", "always"], ["d", "once"], ["e", "once"]],
  );
  const base = { limit: 50, only: "labeled" as const, scope: "project" as const, project: "/proj" };

  it("labeled: only decisions with a label and an input; label maps once/always -> allow, reject -> block", () => {
    const cases = selectCases(log, base);
    expect(cases.map((c) => [c.record.requestID, c.expected, c.source])).toEqual([
      ["c", "allow", "label"],
      ["b", "allow", "label"],
      ["a", "block", "label"],
    ]);
  });

  it("scope all includes other projects", () => {
    expect(selectCases(log, { ...base, scope: "all" }).map((c) => c.record.requestID)).toEqual(["e", "c", "b", "a"]);
  });

  it("all: the previous allow/block verdict is the reference (regression check); no-verdict records are skipped; newest first, limited", () => {
    const cases = selectCases(log, { ...base, only: "all", limit: 2 });
    expect(cases.map((c) => [c.record.requestID, c.expected, c.source])).toEqual([
      ["f", "block", "previous"],
      ["b", "block", "previous"],
    ]);
  });
});

describe("runEval", () => {
  const cases = (n: number) =>
    selectCases(
      logOf(Array.from({ length: n }, (_, i) => decision({ requestID: `r${i}`, at: at(i) })), Array.from({ length: n }, (_, i) => [`r${i}`, "once"] as [string, "once"])),
      { limit: 500, only: "labeled", scope: "all", project: "/proj" },
    );

  it("never runs more than the concurrency cap in parallel", async () => {
    let inFlight = 0;
    let max = 0;
    const results = await runEval(cases(10), async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { got: "allow" as const, reason: "" };
    });
    expect(results).toHaveLength(10);
    expect(max).toBeLessThanOrEqual(EVAL_CONCURRENCY);
    expect(max).toBeGreaterThan(1);
    expect(EVAL_CONCURRENCY).toBeLessThanOrEqual(3);
  });
});

describe("formatEvalReport", () => {
  it("counts, agreement, confusion matrix and the disagreement list", () => {
    const mk = (id: string, expected: "allow" | "block", got: "allow" | "block" | "ask" | "none", reason = "r") => ({
      case: { record: decision({ requestID: id, input: { transcript: "t", action: `{"action":{"permission":"bash","input":"${"x".repeat(400)}"}}` } }), expected, source: "label" as const },
      got,
      reason,
    });
    const report = formatEvalReport([mk("1", "allow", "allow"), mk("2", "allow", "block", "too risky"), mk("3", "block", "block"), mk("4", "block", "none")], { only: "labeled", scope: "project", policyHash: "h1" });
    expect(report).toContain("4 cases");
    expect(report).toContain("agreement: 50% (2/4)");
    expect(report).toMatch(/expected allow\s*\|\s*1\s*\|\s*1\s*\|\s*0/);
    expect(report).toMatch(/expected blocks*|s*0s*|s*1s*|s*0s*|s*1/);
    expect(report).toContain("too risky");
    expect(report).toContain("policy h1");
    expect(report).not.toContain("x".repeat(300)); // action summary truncated
    expect(report.match(/^- /gm)).toHaveLength(2); // two disagreements listed
  });

  it("shows ask separately: a got-ask column and count, and it counts as a disagreement", () => {
    const mk = (id: string, expected: "allow" | "block", got: "allow" | "block" | "ask" | "none") => ({
      case: { record: decision({ requestID: id }), expected, source: "label" as const },
      got,
      reason: "unsure",
    });
    const report = formatEvalReport([mk("1", "allow", "allow"), mk("2", "allow", "ask"), mk("3", "block", "ask"), mk("4", "block", "block")], { only: "labeled", scope: "project", policyHash: "h1" });
    expect(report).toContain("agreement: 50% (2/4)");
    expect(report).toContain("got ask");
    expect(report).toMatch(/expected allow\s*\|\s*1\s*\|\s*0\s*\|\s*1\s*\|\s*0/);
    expect(report).toMatch(/expected block\s*\|\s*0\s*\|\s*1\s*\|\s*1\s*\|\s*0/);
    expect(report).toContain("asked the human: 2");
    expect(report).toContain("got ask");
  });

  it("previous-verdict mode skips records whose verdict was ask", () => {
    const log = logOf([decision({ requestID: "q", verdict: "ask", outcome: "deferred" }), decision({ requestID: "r", at: at(2), verdict: "allow" })]);
    expect(selectCases(log, { limit: 50, only: "all", scope: "all", project: "/proj" }).map((c) => c.record.requestID)).toEqual(["r"]);
  });

  it("says so when there is nothing to evaluate", () => {
    expect(formatEvalReport([], { only: "labeled", scope: "project", policyHash: "h" })).toContain("No matching");
  });
});
