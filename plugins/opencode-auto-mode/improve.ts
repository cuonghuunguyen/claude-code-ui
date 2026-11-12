// Improve: no model call. Collects where the human disagreed with auto mode and lays it out,
// next to the effective rules, for the session model to turn into rule suggestions.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inScope, summarizeAction, type Scope } from "./eval.ts";
import type { DecisionRecord, LogContents } from "./log-store.ts";
import { truncate } from "./text.ts";

export const DEFAULT_IMPROVE_LIMIT = 30;

export type OverrideKind = "human-allowed-block" | "human-rejected-allow" | "human-allowed-no-verdict" | "human-decided-ask";

export interface Override {
  record: DecisionRecord;
  kind: OverrideKind;
  reply: "once" | "always" | "reject";
}

export interface OverrideOptions {
  limit: number;
  scope: Scope;
  project: string;
}

/** Labeled decisions where the human went against (or filled in for) the classifier, newest first. */
export function collectOverrides(log: LogContents, opts: OverrideOptions): Override[] {
  const out: Override[] = [];
  const newestFirst = [...log.decisions].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const record of newestFirst) {
    if (out.length >= opts.limit) break;
    const label = log.labels.get(record.requestID);
    if (!label || !inScope(record, opts.scope, opts.project)) continue;
    const allowed = label.reply !== "reject";
    let kind: OverrideKind | undefined;
    if (record.verdict === "block" && allowed) kind = "human-allowed-block";
    else if (record.verdict === "allow" && !allowed) kind = "human-rejected-allow";
    else if (record.verdict === "none" && allowed) kind = "human-allowed-no-verdict";
    else if (record.verdict === "ask") kind = "human-decided-ask";
    if (kind) out.push({ record, kind, reply: label.reply });
  }
  return out;
}

const KIND_TEXT: Record<OverrideKind, string> = {
  "human-allowed-block": "classifier said block (or deferred a block), human allowed",
  "human-rejected-allow": "classifier said allow, human rejected",
  "human-allowed-no-verdict": "classifier gave no verdict, human allowed",
  "human-decided-ask": "classifier was unsure and asked the human, who decided",
};

export interface ImproveReportInput {
  overrides: Override[];
  scope: Scope;
  project: string;
  totals: { decisions: number; labeled: number };
  options: { allow: string[]; softDeny: string[]; environment: string[]; replaceDefaults: boolean; unsure?: "ask" | "block" };
  policyPrompt: string;
  configSources: string[];
}

export function formatImproveReport(r: ImproveReportInput): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `\n  - ${i}`).join("") : " (none)");
  const lines = [
    `Auto-mode improve report (scope: ${r.scope}, current project: ${r.project})`,
    `Log in scope: ${r.totals.decisions} decisions, ${r.totals.labeled} labeled of ${r.totals.decisions}.`,
    `Plugin options currently come from: ${r.configSources.length ? r.configSources.join(", ") : "unknown (not found in the usual config files)"}`,
    "",
    "## Effective rules (configured additions; the shipped defaults are inside the policy prompt below)",
    `replaceDefaults: ${r.options.replaceDefaults}`,
    `unsure: ${r.options.unsure ?? "ask"}`,
    `allow:${list(r.options.allow)}`,
    `softDeny:${list(r.options.softDeny)}`,
    `environment:${list(r.options.environment)}`,
    "",
    "## Current policy prompt",
    r.policyPrompt,
    "",
    `## Human overrides (${r.overrides.length}, newest first)`,
  ];
  if (r.overrides.length === 0) lines.push("No overrides in scope: the human has not contradicted auto mode (or nothing is labeled yet).");
  r.overrides.forEach((o, i) => {
    lines.push(
      `${i + 1}. ${KIND_TEXT[o.kind]} (human replied ${o.reply})`,
      `   project: ${o.record.project}`,
      `   action: ${summarizeAction(o.record.input?.action ?? `{"action":{"permission":"${o.record.permission}","patterns":${JSON.stringify(o.record.patterns)}}}`, 300)}`,
      `   classifier reason: ${truncate(o.record.reason.replace(/\s+/g, " "), 200) || "(none)"}`,
    );
  });
  return lines.join("\n");
}

/** Alias kept next to its input type. */
export const buildImproveReport = formatImproveReport;

/** Config files that mention this plugin, as far as we can tell; empty = unknown. */
export function findConfigSources(directory: string, worktree: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): string[] {
  const names = ["opencode.json", "opencode.jsonc"];
  const candidates: string[] = [];
  if (env.OPENCODE_CONFIG) candidates.push(env.OPENCODE_CONFIG);
  const globalDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  for (const n of names) candidates.push(join(globalDir, n));
  for (const base of new Set([worktree, directory])) {
    for (const n of names) candidates.push(join(base, n), join(base, ".opencode", n));
  }
  const found: string[] = [];
  for (const file of candidates) {
    try {
      if (existsSync(file) && /auto-mode/.test(readFileSync(file, "utf8"))) found.push(file);
    } catch {
      // unreadable: skip
    }
  }
  return found;
}
