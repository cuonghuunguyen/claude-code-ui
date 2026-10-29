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

const isWriteOf = (p: Part, path: string): p is Call => p.type === "tool_call" && p.tool === "Write" && p.status === "done" && filePath(p) === path && typeof (p.input as { content?: unknown } | null)?.content === "string";

/**
 * The plan text of the ExitPlanMode call at `parts[at]`, as the CLI reads it from its plan file when the call runs: the newest finished `Write` of the plan file
 * before the call (the call's `input.planFilePath`, else any plan file), with every later finished `Edit` / `MultiEdit` of that file applied in order (the CLI has
 * the model revise the plan with Edit). Without that Write: the call's own `input.plan` (Claude Code 2.1.294 calls ExitPlanMode with an empty input, and fills
 * `plan` from the file when it emits the message, so before an Edit of the same message ran), with the Edits of the call's message applied. Undefined when the
 * part is no ExitPlanMode call or no source carries the plan.
 */
export function planOfCall(parts: readonly Part[], at: number, dirs?: readonly string[]): string | undefined {
  const call = parts[at];
  if (call?.type !== "tool_call" || call.tool !== "ExitPlanMode") return undefined;
  const input = call.input as { plan?: unknown; planFilePath?: unknown } | null;
  const given = typeof input?.planFilePath === "string" && input.planFilePath ? input.planFilePath : undefined;
  const edited = (text: string, path: string, from: number) => {
    for (let j = from; j < at; j++) {
      const e = parts[j]!;
      if (isEditOf(e, path)) text = applyCall(text, e);
    }
    return text;
  };
  for (let i = at - 1; i >= 0; i--) {
    const w = parts[i]!;
    if (!(given ? isWriteOf(w, given) : isPlanFileWrite(w, dirs))) continue;
    const write = w as Call;
    return edited((write.input as { content: string }).content, filePath(write)!, i + 1);
  }
  const own = input?.plan;
  if (typeof own !== "string" || !own) return undefined;
  if (!given) return own;
  // The call's message: the tool calls right before it (their results come after the message).
  let from = at;
  while (from > 0 && parts[from - 1]!.type === "tool_call") from--;
  return edited(own, given, from);
}

/** A done Artifact publish (GH-176): action absent or "publish", not an asset upload. Daemon and Artifacts pane share it. */
export function isArtifactPublish(p: Part): p is Call {
  if (p.type !== "tool_call" || p.tool !== "Artifact" || p.status !== "done") return false;
  const i = (p.input ?? {}) as { action?: unknown; asset?: unknown };
  return (i.action === undefined || i.action === "publish") && i.asset !== true;
}
