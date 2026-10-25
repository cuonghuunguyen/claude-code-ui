import type { Part } from "./parts.ts";

type Call = Extract<Part, { type: "tool_call" }>;

/** Claude Code's default plan files (`<config dir>/plans/*.md`) when the session's plan folders are not known. */
const DEFAULT_PLAN_FILE = /[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/;

const slashes = (p: string) => p.replace(/\\/g, "/");
const dirOf = (p: string) => slashes(p).replace(/\/[^/]*$/, "");

/**
 * A file the CLI keeps a plan in: a `.md` file directly in one of the session's plan folders (`dirs`: the user config's `plans` folder and the
 * `plansDirectory` setting, as the daemon resolves them), else, without `dirs`, in a `.claude/plans` folder.
 */
export function isPlanPath(path: string, dirs?: readonly string[]): boolean {
  if (!path.endsWith(".md")) return false;
  if (!dirs?.length) return DEFAULT_PLAN_FILE.test(path);
  const d = dirOf(path);
  return dirs.some((x) => slashes(x).replace(/\/+$/, "") === d);
}

const filePath = (p: Call) => (typeof (p.input as { file_path?: unknown } | null)?.file_path === "string" ? (p.input as { file_path: string }).file_path : undefined);

/** A finished `Write` of a plan file with its text. */
export function isPlanFileWrite(p: Part, dirs?: readonly string[]): p is Call {
  if (p.type !== "tool_call" || p.tool !== "Write" || p.status !== "done") return false;
  const path = filePath(p);
  const content = (p.input as { content?: unknown } | null)?.content;
  return !!path && isPlanPath(path, dirs) && typeof content === "string" && !!content;
}

/** A finished `Edit` or `MultiEdit` of `path`. */
export const isEditOf = (p: Part, path: string): p is Call => p.type === "tool_call" && (p.tool === "Edit" || p.tool === "MultiEdit") && p.status === "done" && filePath(p) === path;

type Replace = { old_string?: unknown; new_string?: unknown; replace_all?: unknown };
function apply(text: string, e: Replace): string {
  if (typeof e.old_string !== "string" || typeof e.new_string !== "string" || !e.old_string) return text;
  if (e.replace_all === true) return text.split(e.old_string).join(e.new_string);
  const i = text.indexOf(e.old_string);
  return i < 0 ? text : text.slice(0, i) + e.new_string + text.slice(i + e.old_string.length);
}

/** `text` after the Edit or MultiEdit `call` (an edit whose text is not found changes nothing). */
function applyCall(text: string, call: Call): string {
  const input = call.input as { edits?: unknown } & Replace;
  return call.tool === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as Replace[]).reduce(apply, text) : apply(text, input);
}

/**
 * The plan text of the ExitPlanMode call at `parts[at]`: its own `input.plan`, else the plan file the model kept it in (Claude Code 2.1.294 calls
 * ExitPlanMode with an empty input): the newest finished plan-file `Write` before the call, with every later `Edit` / `MultiEdit` of that file applied in order
 * (the CLI has the model revise the plan with Edit). Undefined when the part is no ExitPlanMode call or no source carries the plan.
 */
export function planOfCall(parts: readonly Part[], at: number, dirs?: readonly string[]): string | undefined {
  const call = parts[at];
  if (call?.type !== "tool_call" || call.tool !== "ExitPlanMode") return undefined;
  const own = (call.input as { plan?: unknown } | null)?.plan;
  if (typeof own === "string" && own) return own;
  for (let i = at - 1; i >= 0; i--) {
    const w = parts[i]!;
    if (!isPlanFileWrite(w, dirs)) continue;
    const path = filePath(w)!;
    let text = (w.input as { content: string }).content;
    for (let j = i + 1; j < at; j++) {
      const e = parts[j]!;
      if (isEditOf(e, path)) text = applyCall(text, e);
    }
    return text;
  }
  return undefined;
}
