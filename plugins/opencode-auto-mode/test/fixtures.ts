import type { DecisionRecord } from "../log-store.ts";

export function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    v: 1,
    kind: "decision",
    at: "2026-01-01T00:00:00.000Z",
    requestID: "per1",
    sessionID: "ses1",
    project: "/proj",
    permission: "bash",
    patterns: ["*"],
    model: "p/m",
    policyHash: "abc",
    verdict: "allow",
    reason: "ok",
    outcome: "replied",
    ms: 5,
    input: { transcript: '{"user":"x"}', action: '{"action":{}}' },
    ...over,
  };
}
