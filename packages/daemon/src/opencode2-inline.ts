// Inline task on OpenCode 2 (GH-734, docs/spec.md "Inline tasks"): what the daemon reads of the child session's events (usage, turns, last text, files) and the
// rules that give the child only the granted tools. The session side (child create, stop, waiting) is OpenCode2Session.inlineTask.
import { INLINE_OUTPUT_TOKENS, type InlineBuiltin, type InlineSpec } from "./inline-types.ts";
import { failureText } from "./opencode2-parts.ts";
import type { Rule2 } from "./opencode2-engine.ts";

type Json = Record<string, any>;

/** The permission action of each built-in on OpenCode 2 (2.3.0: the `write` tool asks as `edit`, so Write and Edit grant both). */
const ACTION: Record<InlineBuiltin, string> = { Bash: "shell", Read: "read", Write: "edit", Edit: "edit", Grep: "grep", Glob: "glob" };
/** The session metadata key that marks an inline child (the session list hides it). */
export const INLINE_META = "claude-ui.inlineOf";

/**
 * The child's rules: everything denied (OpenCode 2 then offers no tool of a denied action), then, for each granted action, the parent's rules for it in order
 * (`base`: the agent's rules, then the session's), a `*` rule applied to each granted action. Last match wins, so the parent's asks and denials still hold.
 */
export function inlineRules(spec: Pick<InlineSpec, "tools">, base: readonly Rule2[]): Rule2[] {
  const granted = [...new Set(spec.tools.map((t) => ACTION[t]))];
  return [{ action: "*", resource: "*", effect: "deny" }, ...base.flatMap((r) => (r.action === "*" ? granted.map((action) => ({ ...r, action })) : granted.includes(r.action) ? [r] : []))];
}

export type InlineCap = "turns" | "tokens";

/** Reads the events of one child session. */
export class InlineCollector2 {
  private readonly texts = new Map<string, string>();
  private readonly steps: { finish?: string; tokens?: Json; cost?: number }[] = [];
  private readonly files = new Set<string>();
  private readonly tools = new Map<string, string>();
  private model: string | undefined;
  /** Set by the child's `session.execution.succeeded`. */
  idle = false;
  /** Set by the child's `session.execution.interrupted` (not ours: OpenCode's own app, a shutdown). */
  interrupted = false;
  /** Set by a failure of the child (an interrupt is none). */
  error: string | undefined;

  feed(type: string, d: Json) {
    switch (type) {
      case "session.step.started":
        if (d.model?.providerID && d.model?.id) this.model = `${d.model.providerID}/${d.model.id}`;
        return;
      case "session.step.ended":
        return void this.steps.push({ finish: d.finish, tokens: d.tokens, cost: d.cost });
      case "session.text.ended":
        if (d.text) this.texts.set(`${d.assistantMessageID}:${d.ordinal}`, d.text);
        return;
      case "session.tool.input.started":
        return void this.tools.set(d.id, d.name);
      case "session.tool.called": {
        const name = this.tools.get(d.id);
        if ((name === "edit" || name === "write") && typeof d.input?.path === "string") this.files.add(d.input.path);
        return;
      }
      case "session.execution.succeeded":
        return void (this.idle = true);
      case "session.execution.interrupted":
        return void (this.interrupted = true);
      case "session.step.failed":
      case "session.execution.failed":
        if (d.error && d.error.type !== "aborted") this.error ??= failureText(d.error);
        return;
    }
  }

  get turns() {
    return this.steps.length;
  }
  tokens() {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const s of this.steps) {
      t.input += s.tokens?.input ?? 0;
      t.output += (s.tokens?.output ?? 0) + (s.tokens?.reasoning ?? 0);
      t.cacheRead += s.tokens?.cache?.read ?? 0;
      t.cacheWrite += s.tokens?.cache?.write ?? 0;
    }
    return t;
  }
  cost = () => this.steps.reduce((c, s) => c + (s.cost ?? 0), 0);
  filesChanged = () => [...this.files];
  /** The last assistant text (the answer), "" when none came. */
  text = () => [...this.texts.values()].at(-1) ?? "";
  modelName = (fallback: string) => this.model ?? fallback;
  /** A cap the run is over: the step that just ended did not stop the model, and turns or output tokens reached the limit. */
  cap(maxTurns: number): InlineCap | undefined {
    const last = this.steps.at(-1);
    if (!last || last.finish === "stop") return;
    if (this.turns >= maxTurns) return "turns";
    if (this.tokens().output >= INLINE_OUTPUT_TOKENS) return "tokens";
  }
}
