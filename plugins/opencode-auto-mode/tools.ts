// The plugin's two tools, behind the /auto-mode-eval and /auto-mode-improve commands.
// OpenCode 1.19.5 takes a plugin tool as `{ description, args, execute(args, ctx) }` where `args`
// is either a Zod raw shape or, when not every entry is a Zod type, a map of JSON Schema property
// schemas (all marked required; no validation). We have no zod in a zero-install file, so we use
// the JSON Schema form, give every arg a neutral "use the default" value, and parse defensively.
import { replay as replayClassifier } from "./classifier.ts";
import { DEFAULT_EVAL_LIMIT, formatEvalReport, inScope, MAX_EVAL_LIMIT, runEval, selectCases, type EvalCase, type Got, type Scope } from "./eval.ts";
import { buildImproveReport, collectOverrides, DEFAULT_IMPROVE_LIMIT, findConfigSources } from "./improve.ts";
import { readLog } from "./log-store.ts";
import type { OpencodeClient, ResolvedAutoModeOptions } from "./types.ts";

export interface ToolRunContext {
  directory?: string;
  worktree?: string;
  abort?: AbortSignal;
}

export interface PluginTool {
  description: string;
  args: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolRunContext): Promise<string>;
}

/** Local stand-in for `@opencode-ai/plugin`'s `tool()`: the definition is returned as is. */
export function tool(def: PluginTool): PluginTool {
  return def;
}

export const EVAL_TOOL = "auto_mode_eval";
export const IMPROVE_TOOL = "auto_mode_improve";

export interface ToolDeps {
  client: OpencodeClient;
  directory: string;
  worktree: string;
  opts: ResolvedAutoModeOptions;
  dataDir: string;
  policyPrompt: string;
  policyHash: string;
  /** Shared with the plugin, so the replay sessions are treated as classifier sessions. */
  classifierSessions: Set<string>;
}

/** The key decisions are logged under: the git worktree, or the directory when there is none ("/"). */
export function projectKey(worktree: string | undefined, directory: string | undefined): string {
  return worktree && worktree !== "/" ? worktree : (directory ?? worktree ?? "");
}

function intArg(v: unknown, fallback: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), max) : fallback;
}

const scopeArg = (v: unknown): Scope => (v === "all" ? "all" : "project");

export function createTools(deps: ToolDeps): Record<string, PluginTool> {
  const projectOf = (ctx: ToolRunContext) => projectKey(ctx.worktree ?? deps.worktree, ctx.directory ?? deps.directory);

  return {
    [EVAL_TOOL]: tool({
      description:
        "Replays logged auto-mode decisions through the classifier with the CURRENT policy and reports agreement with the human's labels (or, for only=all, with the previous verdict). " +
        "COST WARNING: it calls the classifier model once per case (up to `limit`), so it spends tokens. " +
        "Pass the defaults when unsure: limit 0 = 50 (max 500), only \"labeled\", scope \"project\", model \"\" = the configured/recorded model.",
      args: {
        limit: { type: "number", description: "How many most recent cases to replay; 0 for the default of 50 (max 500)." },
        only: { type: "string", enum: ["labeled", "all"], description: "\"labeled\": cases the human decided (truth = their answer). \"all\": every logged case, reference = the previous verdict." },
        scope: { type: "string", enum: ["project", "all"], description: "\"project\": decisions of the current project; \"all\": every project in the log." },
        model: { type: "string", description: "Classifier model as provider/model; empty string for the plugin's configured or recorded model." },
      },
      async execute(args, ctx) {
        const limit = intArg(args.limit, DEFAULT_EVAL_LIMIT, MAX_EVAL_LIMIT);
        const only = args.only === "all" ? "all" : "labeled";
        const scope = scopeArg(args.scope);
        const model = typeof args.model === "string" && args.model.includes("/") ? args.model : undefined;
        const log = readLog(deps.dataDir);
        const cases = selectCases(log, { limit, only, scope, project: projectOf(ctx) });
        const results = await runEval(cases, async (c: EvalCase): Promise<{ got: Got; reason: string }> => {
          if (ctx.abort?.aborted) return { got: "none", reason: "aborted" };
          const out = await replayClassifier(c.record.input!, model ?? deps.opts.model ?? c.record.model, {
            client: deps.client,
            directory: deps.directory,
            timeoutMs: deps.opts.timeoutMs,
            classifierSessions: deps.classifierSessions,
          });
          const v = out.verdict;
          return v?.decision ? { got: v.decision === "yes" ? "block" : "allow", reason: v.reason } : { got: "none", reason: "no verdict (error, timeout or unparseable reply)" };
        });
        return formatEvalReport(results, { only, scope, policyHash: deps.policyHash, model });
      },
    }),

    [IMPROVE_TOOL]: tool({
      description:
        "Reports the current auto-mode rules plus the cases where the human overrode or filled in for the classifier, so rule changes can be proposed. Makes no model call and edits nothing. " +
        "Pass the defaults when unsure: limit 0 = 30, scope \"project\".",
      args: {
        limit: { type: "number", description: "How many most recent overrides to include; 0 for the default of 30." },
        scope: { type: "string", enum: ["project", "all"], description: "\"project\": the current project only; \"all\": every project in the log." },
      },
      async execute(args, ctx) {
        const limit = intArg(args.limit, DEFAULT_IMPROVE_LIMIT, MAX_EVAL_LIMIT);
        const scope = scopeArg(args.scope);
        const project = projectOf(ctx);
        const log = readLog(deps.dataDir);
        const inScopeDecisions = log.decisions.filter((d) => inScope(d, scope, project));
        const labeled = inScopeDecisions.filter((d) => log.labels.has(d.requestID)).length;
        return buildImproveReport({
          overrides: collectOverrides(log, { limit, scope, project }),
          scope,
          project,
          totals: { decisions: inScopeDecisions.length, labeled },
          options: { allow: deps.opts.allow, softDeny: deps.opts.softDeny, environment: deps.opts.environment, replaceDefaults: deps.opts.replaceDefaults },
          policyPrompt: deps.policyPrompt,
          configSources: findConfigSources(deps.directory, deps.worktree),
        });
      },
    }),
  };
}
