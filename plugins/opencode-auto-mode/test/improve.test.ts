import { describe, expect, it } from "vitest";
import { buildImproveReport, collectOverrides } from "../improve.ts";
import type { LabelRecord, LogContents } from "../log-store.ts";
import { decision } from "./fixtures.ts";

function logOf(decisions: ReturnType<typeof decision>[], labels: Array<[string, LabelRecord["reply"]]>): LogContents {
  return { decisions, labels: new Map(labels.map(([id, reply]) => [id, { v: 1, kind: "label" as const, at: "t", requestID: id, reply }])) };
}
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;

describe("collectOverrides", () => {
  const log = logOf(
    [
      decision({ requestID: "agree", at: at(1), verdict: "allow" }),
      decision({ requestID: "allowedButRejected", at: at(2), verdict: "allow" }),
      decision({ requestID: "blockedButAllowed", at: at(3), verdict: "block", outcome: "replied" }),
      decision({ requestID: "deferredAllowed", at: at(4), verdict: "block", outcome: "deferred" }),
      decision({ requestID: "noneAllowed", at: at(5), verdict: "none", outcome: "timeout", input: undefined }),
      decision({ requestID: "noneRejected", at: at(6), verdict: "none", outcome: "timeout" }),
      decision({ requestID: "otherProject", at: at(7), verdict: "block", project: "/other" }),
      decision({ requestID: "askAllowed", at: at(9), verdict: "ask", outcome: "deferred" }),
      decision({ requestID: "askRejected", at: at(10), verdict: "ask", outcome: "deferred" }),
      decision({ requestID: "unlabeled", at: at(8), verdict: "block" }),
    ],
    [["agree", "once"], ["allowedButRejected", "reject"], ["blockedButAllowed", "once"], ["deferredAllowed", "always"], ["noneAllowed", "once"], ["noneRejected", "reject"], ["otherProject", "once"], ["askAllowed", "once"], ["askRejected", "reject"]],
  );

  it("keeps human labels that differ from the verdict, newest first, within the project scope", () => {
    const out = collectOverrides(log, { limit: 30, scope: "project", project: "/proj" });
    expect(out.map((o) => [o.record.requestID, o.kind])).toEqual([
      ["askRejected", "human-decided-ask"],
      ["askAllowed", "human-decided-ask"],
      ["noneAllowed", "human-allowed-no-verdict"],
      ["deferredAllowed", "human-allowed-block"],
      ["blockedButAllowed", "human-allowed-block"],
      ["allowedButRejected", "human-rejected-allow"],
    ]);
  });

  it("scope all pulls in other projects; limit applies", () => {
    expect(collectOverrides(log, { limit: 30, scope: "all", project: "/proj" }).map((o) => o.record.requestID)).toContain("otherProject");
    expect(collectOverrides(log, { limit: 1, scope: "all", project: "/proj" })).toHaveLength(1);
  });
});

describe("buildImproveReport", () => {
  const overrides = collectOverrides(
    logOf([decision({ requestID: "x", verdict: "block", reason: "deploys to prod", input: { transcript: "t", action: '{"action":{"permission":"bash","input":"deploy.sh staging"}}' } })], [["x", "once"]]),
    { limit: 30, scope: "all", project: "/proj" },
  );

  it("carries the effective rules, config source, scope, and the compact overrides", () => {
    const report = buildImproveReport({
      overrides,
      scope: "project",
      project: "/proj",
      totals: { decisions: 9, labeled: 4 },
      options: { allow: ["a1"], softDeny: ["s1"], environment: ["e1"], replaceDefaults: false },
      policyPrompt: "# Role\nPOLICY",
      configSources: ["/proj/opencode.json"],
    });
    for (const s of ["- a1", "- s1", "- e1", "replaceDefaults: false", "POLICY", "/proj/opencode.json", "scope: project", "deploys to prod", "deploy.sh staging", "human allowed", "4 labeled of 9"]) {
      expect(report).toContain(s);
    }
  });

  it("says the config source is unknown when it cannot tell, and handles no overrides", () => {
    const report = buildImproveReport({ overrides: [], scope: "all", project: "/proj", totals: { decisions: 0, labeled: 0 }, options: { allow: [], softDeny: [], environment: [], replaceDefaults: false }, policyPrompt: "P", configSources: [] });
    expect(report).toContain("unknown");
    expect(report).toContain("No overrides");
  });
});
