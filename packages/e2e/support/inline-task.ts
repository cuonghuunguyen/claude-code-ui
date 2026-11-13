// GH-734 helpers for the inline task scenarios. No Playwright import.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The symbol the code location task searches for; defined once, used in five files. */
export const SYMBOL = "zebraQuota42";

/** Files of the inline task fixtures: a symbol in five files, a 5000-line log with one ERROR, a node test file with two failures, a local page. */
export function fixtureFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "src/quota.ts": `export const ${SYMBOL} = 7;\n`,
    "src/a.ts": `import { ${SYMBOL} } from "./quota";\nexport const a = ${SYMBOL} + 1;\n`,
    "src/b.ts": `import { ${SYMBOL} } from "./quota";\nexport const b = ${SYMBOL} * 2;\n`,
    "src/c.ts": `import { ${SYMBOL} } from "./quota";\nexport const c = ${SYMBOL} - 3;\n`,
    "src/d.ts": `import { ${SYMBOL} } from "./quota";\nexport const d = ${SYMBOL} ** 2;\n`,
    "page.html": "<!doctype html><title>inline fixture</title><h1 id=\"hello\">Hello inline</h1>\n",
  };
  const log: string[] = [];
  for (let i = 1; i <= 5000; i++) {
    const s = String(i % 60).padStart(2, "0");
    log.push(i === 3141 ? `2026-03-14T09:26:53Z ERROR payment gateway refused card (code E-7731)` : `2026-03-14T09:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${s}Z INFO request ${i} ok`);
  }
  files["build.log"] = log.join("\n") + "\n";
  const tests = ['import test from "node:test";', 'import assert from "node:assert";'];
  for (let i = 1; i <= 20; i++) tests.push(`test("case ${i}", () => { assert.strictEqual(${i === 6 || i === 13 ? "1, 2" : "1, 1"}); });`);
  files["tests/sample.test.mjs"] = tests.join("\n") + "\n";
  return files;
}

/** `<inline tokens>` as the result JSON holds them. */
export type InlineResult = { status: string; limit?: string; text?: string; model?: string; turns?: number; tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }; costUsd?: number; filesChanged?: string[] };

/** Every inline_task result JSON in the Claude Code transcripts of the project folder named `projectName` (transcript folder name ends with it). */
export function inlineResults(projectName: string, home = homedir()): InlineResult[] {
  const root = join(home, ".claude", "projects");
  if (!existsSync(root)) return [];
  const out: InlineResult[] = [];
  for (const dir of readdirSync(root).filter((d) => d.endsWith(`-${projectName}`) || d.endsWith(projectName))) {
    for (const f of readdirSync(join(root, dir)).filter((x) => x.endsWith(".jsonl"))) {
      const ids = new Set<string>();
      const lines = readFileSync(join(root, dir, f), "utf8").split("\n").filter(Boolean);
      const rows = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      for (const r of rows) for (const c of r.message?.content ?? []) if (c?.type === "tool_use" && /inline_task$/.test(c.name ?? "")) ids.add(c.id);
      for (const r of rows) {
        for (const c of Array.isArray(r.message?.content) ? r.message.content : []) {
          if (c?.type !== "tool_result" || !ids.has(c.tool_use_id)) continue;
          const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((p: { text?: string }) => p.text ?? "").join("");
          try { out.push(JSON.parse(text)); } catch {}
        }
      }
    }
  }
  return out;
}

export const tokenSum = (t?: { input: number; output: number; cacheRead: number; cacheWrite: number }) => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0);

/** Haiku 4.5 list prices in USD per million tokens, used to price parent and subagent calls the CLI does not price one by one. */
const PRICE = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

/** One model call of a transcript: its tokens and the size of its context (input + cache write + cache read). */
export type Call = { id: string; input: number; cacheWrite: number; cacheRead: number; output: number; context: number; total: number };

const callOf = (id: string, u: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number }): Call => {
  const input = u.input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0, output = u.output_tokens ?? 0;
  return { id, input, cacheWrite, cacheRead, output, context: input + cacheWrite + cacheRead, total: input + cacheWrite + cacheRead + output };
};
export const priceOf = (calls: Call[]) => calls.reduce((n, c) => n + (c.input * PRICE.input + c.cacheWrite * PRICE.cacheWrite + c.cacheRead * PRICE.cacheRead + c.output * PRICE.output) / 1e6, 0);
export const callsTotal = (calls: Call[]) => calls.reduce((n, c) => n + c.total, 0);

function jsonl(file: string): Record<string, any>[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
/** The model calls of one transcript file, in order: a message id is one call (its content blocks repeat the usage; the last line has the final output count). */
function callsOf(file: string, sidechain: boolean): Call[] {
  const byId = new Map<string, Call>();
  for (const r of jsonl(file)) {
    if (r.type !== "assistant" || !r.message?.id || !!r.isSidechain !== sidechain || !r.message.usage) continue;
    byId.set(r.message.id, callOf(r.message.id, r.message.usage));
  }
  return [...byId.values()];
}

const sessionFiles = (projectName: string, home = homedir()) => {
  const root = join(home, ".claude", "projects");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) => d.endsWith(`-${projectName}`)).flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".jsonl")).map((f) => join(root, d, f)));
};

/** Model calls of the main agent of the project's session. */
export const parentCalls = (projectName: string): Call[] => sessionFiles(projectName).flatMap((f) => callsOf(f, false));

/** Model calls of the subagents (Agent tool) of the project's session: `<session>/subagents/*.jsonl`. */
export function subagentCalls(projectName: string): Call[] {
  return sessionFiles(projectName).flatMap((f) => {
    const dir = f.replace(/\.jsonl$/, "") + "/subagents";
    return existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".jsonl")).flatMap((x) => callsOf(join(dir, x), true)) : [];
  });
}

export type CostEntry = {
  engine: "inline" | "subagent";
  parentCalls: number;
  parentTokens: number;
  /** Tokens of the inline run (its result JSON) or of the subagent (its transcript). */
  workerTokens: number;
  totalTokens: number;
  /** Parent priced at Haiku 4.5 list prices + the inline run's own costUsd (CLI) or the subagent priced at list prices. */
  costUsd: number;
  /** Context size of the parent's last call minus that of its last call before the task. */
  parentContextDelta: number;
  model: string;
  date: string;
};
export type CostFile = Record<string, Partial<Record<"inline" | "subagent", CostEntry>>>;

export function readCosts(dir: string): CostFile {
  try { return JSON.parse(readFileSync(join(dir, "inline-cost.json"), "utf8")); } catch { return {}; }
}
export function writeCost(dir: string, scenario: string, entry: CostEntry): void {
  mkdirSync(dir, { recursive: true });
  const all = readCosts(dir);
  (all[scenario] ??= {})[entry.engine] = entry;
  writeFileSync(join(dir, "inline-cost.json"), JSON.stringify(all, null, 2));
}
