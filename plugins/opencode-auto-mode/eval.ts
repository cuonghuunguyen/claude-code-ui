// Eval: replays logged classifier inputs through the classifier with the CURRENT policy and
// compares against the ground truth (the human's label) or, as a regression check, the previous
// verdict. Pure selection/report code; the model calls are injected (tools.ts wires the real one).
import type { DecisionRecord, LabelRecord, LogContents } from "./log-store.ts";
import { truncate } from "./text.ts";

/** Replays in flight at once: the eval calls the model once per case. */
export const EVAL_CONCURRENCY = 3;
export const DEFAULT_EVAL_LIMIT = 50;
export const MAX_EVAL_LIMIT = 100;

export type Scope = "project" | "all";
export type Expected = "allow" | "block";
export type Got = "allow" | "block" | "ask" | "none";

export interface EvalCase {
  record: DecisionRecord;
  expected: Expected;
  /** Where the reference comes from: the human's label, or the previous verdict. */
  source: "label" | "previous";
}

export interface EvalResult {
  case: EvalCase;
  got: Got;
  reason: string;
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Same project path, ignoring slash style and trailing slash; case-insensitive for Windows-style paths. */
export function sameProject(a: string, b: string): boolean {
  const [x, y] = [normPath(a), normPath(b)];
  return /^[A-Za-z]:/.test(x) || /^[A-Za-z]:/.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function inScope(record: DecisionRecord, scope: Scope, project: string): boolean {
  return scope === "all" || sameProject(record.project, project);
}

export function labelToExpected(reply: LabelRecord["reply"]): Expected {
  return reply === "reject" ? "block" : "allow";
}

/** One-line view of a logged `{"action":{permission,patterns,input}}` record. */
export function summarizeAction(actionLine: string | undefined, maxChars: number): string {
  if (!actionLine) return "(no input logged)";
  try {
    const a = (JSON.parse(actionLine) as { action?: { permission?: string; patterns?: string[]; input?: string } }).action;
    if (a) return truncate(`${a.permission ?? "?"} ${(a.patterns ?? []).join(",")}: ${a.input ?? ""}`.replace(/\s+/g, " "), maxChars);
  } catch {
    // fall through
  }
  return truncate(actionLine.replace(/\s+/g, " "), maxChars);
}

export interface SelectOptions {
  limit: number;
  only: "labeled" | "all";
  scope: Scope;
  project: string;
}

/** The most recent `limit` decisions that carry an input and a reference answer, newest first. */
export function selectCases(log: LogContents, opts: SelectOptions): EvalCase[] {
  const out: EvalCase[] = [];
  const newestFirst = [...log.decisions].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const seen = new Set<string>();
  for (const record of newestFirst) {
    if (out.length >= opts.limit) break;
    if (!record.input || seen.has(record.requestID) || !inScope(record, opts.scope, opts.project)) continue;
    if (opts.only === "labeled") {
      const label = log.labels.get(record.requestID);
      if (!label || label.cascade) continue;
      out.push({ record, expected: labelToExpected(label.reply), source: "label" });
    } else {
      if (record.verdict === "none" || record.verdict === "ask") continue;
      out.push({ record, expected: record.verdict, source: "previous" });
    }
    seen.add(record.requestID);
  }
  return out;
}

/** Runs `replay` over the cases, at most `concurrency` at a time; results keep the case order. */
export async function runEval(cases: EvalCase[], replay: (c: EvalCase) => Promise<{ got: Got; reason: string }>, concurrency = EVAL_CONCURRENCY): Promise<EvalResult[]> {
  const results: EvalResult[] = new Array(cases.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < cases.length) {
      const i = next++;
      let r: { got: Got; reason: string };
      try {
        r = await replay(cases[i]);
      } catch (err) {
        r = { got: "none", reason: `error: ${String(err)}` };
      }
      results[i] = { case: cases[i], ...r };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, EVAL_CONCURRENCY, cases.length) }, worker));
  return results;
}

export interface EvalReportMeta {
  only: "labeled" | "all";
  scope: Scope;
  policyHash: string;
  model?: string;
}

export function formatEvalReport(results: EvalResult[], meta: EvalReportMeta): string {
  const ref = meta.only === "labeled" ? "human label" : "previous verdict (regression check)";
  if (results.length === 0) {
    return `No matching decisions to evaluate (only=${meta.only}, scope=${meta.scope}). ${meta.only === "labeled" ? "Labels appear once you answer an ask the plugin left to you." : "Nothing with a logged input and verdict yet."}`;
  }
  const count = (exp: Expected, got: Got) => results.filter((r) => r.case.expected === exp && r.got === got).length;
  const agree = results.filter((r) => r.case.expected === r.got).length;
  const lines = [
    ...(meta.scope === "all" ? ["Note: every replay runs with THIS project's instructions (AGENTS.md) in the classifier's system prompt, whatever project the case came from."] : []),
    `Auto-mode eval: ${results.length} cases (only=${meta.only}, scope=${meta.scope}), reference: ${ref}, policy ${meta.policyHash}${meta.model ? `, model ${meta.model}` : ""}`,
    `agreement: ${Math.round((agree / results.length) * 100)}% (${agree}/${results.length})`,
    "",
    "|  | got allow | got block | got ask | got none |",
    "|---|---|---|---|---|",
    `| expected allow | ${count("allow", "allow")} | ${count("allow", "block")} | ${count("allow", "ask")} | ${count("allow", "none")} |`,
    `| expected block | ${count("block", "allow")} | ${count("block", "block")} | ${count("block", "ask")} | ${count("block", "none")} |`,
  ];
  const asked = results.filter((r) => r.got === "ask").length;
  if (asked > 0) lines.splice(2, 0, `asked the human: ${asked} (counted as disagreements; the classifier was unsure)`);
  const wrong = results.filter((r) => r.case.expected !== r.got);
  lines.push("", wrong.length === 0 ? "Disagreements: none" : `Disagreements (${wrong.length}):`);
  for (const r of wrong) {
    lines.push(`- [${r.case.record.project}] ${summarizeAction(r.case.record.input?.action, 160)} | expected ${r.case.expected}, got ${r.got}${r.reason ? ` | ${truncate(r.reason.replace(/\s+/g, " "), 160)}` : ""}`);
  }
  return lines.join("\n");
}
