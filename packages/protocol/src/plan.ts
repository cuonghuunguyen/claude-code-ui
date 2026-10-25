import type { Part } from "./parts.ts";

/** Claude Code's plan files: plan mode writes the plan there, and recent CLIs (2.1.294) then call ExitPlanMode with an empty input. */
export const PLAN_FILE = /[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/;

/** A `Write` call to a plan file with its text. */
export function isPlanFileWrite(p: Part): p is Extract<Part, { type: "tool_call" }> {
  if (p.type !== "tool_call" || p.tool !== "Write") return false;
  const i = p.input as { file_path?: unknown; content?: unknown } | null;
  return typeof i?.file_path === "string" && PLAN_FILE.test(i.file_path) && typeof i.content === "string" && !!i.content;
}

/**
 * The plan text of the ExitPlanMode call at `parts[at]`: its own `input.plan`, else the content of the newest plan-file `Write` before it.
 * Undefined when the part is no ExitPlanMode call or no source carries the plan (a plan file changed only by Edit).
 */
export function planOfCall(parts: readonly Part[], at: number): string | undefined {
  const call = parts[at];
  if (call?.type !== "tool_call" || call.tool !== "ExitPlanMode") return undefined;
  const own = (call.input as { plan?: unknown } | null)?.plan;
  if (typeof own === "string" && own) return own;
  for (let i = at - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (isPlanFileWrite(p)) return (p.input as { content: string }).content;
  }
  return undefined;
}
