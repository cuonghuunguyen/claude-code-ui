// Files changed in a session, for the changes tab (docs/spec.md "Layout"): built from its successful Edit/Write calls.
import type { Part } from "@claude-ui/protocol";
import { parseDiffFromFile } from "@pierre/diffs";
import type { SessionView, ToolCall } from "./store.ts";
import { diffStats } from "./tools.ts";

const EDIT_TOOLS = new Set(["Edit", "Write"]);

/** `original`: the file before the session's first change of it, when the daemon sent it (live queries only). */
export type FileChange = { path: string; original?: string | null; calls: ToolCall[]; results: (Part | undefined)[] };

/** Changed files in order of their first change, subagents included. */
export function sessionChanges(s: SessionView): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const id of s.order) {
    const p = s.parts.get(id)!;
    if (p.type !== "tool_call" || !EDIT_TOOLS.has(p.tool) || p.status !== "done") continue;
    const path = (p.input as { file_path?: unknown }).file_path;
    if (typeof path !== "string") continue;
    const result = s.parts.get(`${p.toolUseId}:result`);
    const c = byPath.get(path) ?? { path, calls: [], results: [] };
    if (!byPath.has(path)) byPath.set(path, c);
    // Only the first call's original is the file before the session: the daemon sends one per path per query, so after a restart a later call's
    // original already holds the earlier edits.
    if (!c.calls.length && result?.type === "tool_result" && "original" in result) c.original = result.original;
    c.calls.push(p);
    c.results.push(result);
  }
  return [...byPath.values()];
}

/** Whether `part` occurs exactly once in `text`, overlapping matches counted. */
const once = (text: string, part: string) => {
  const i = text.indexOf(part);
  return i >= 0 && text.indexOf(part, i + 1) < 0;
};

/**
 * The file before the session's changes: the daemon's original, else the calls undone backwards from `after` (the disk).
 * Undefined when that is ambiguous: a replace_all Edit (its new text may also have been there before), an Edit whose new text is empty or not
 * found exactly once, a Write that is not the creation of the file by the first call.
 * ponytail: a restored transcript has no originals, so such files show the per-call diffs instead.
 */
export function baseline(after: string, c: FileChange): string | undefined {
  if (c.original !== undefined) return c.original ?? "";
  let text = after;
  for (let i = c.calls.length - 1; i >= 0; i--) {
    const call = c.calls[i]!;
    const input = call.input as { old_string?: unknown; new_string?: unknown; replace_all?: unknown };
    if (call.tool === "Write") {
      const out = c.results[i]?.type === "tool_result" ? (c.results[i] as { output: unknown }).output : undefined;
      // Only a created file has a known before: nothing.
      return i === 0 && typeof out === "string" && /created successfully/i.test(out) ? "" : undefined;
    }
    const { old_string: from, new_string: to } = input;
    if (typeof from !== "string" || typeof to !== "string" || !to || input.replace_all === true || !once(text, to)) return undefined;
    text = text.replace(to, () => from);
  }
  return text;
}

export type Stats = { added: number; removed: number };

export function fileStats(before: string, after: string, name: string): Stats {
  const { hunks } = parseDiffFromFile({ name, contents: before }, { name, contents: after });
  return { added: hunks.reduce((n, h) => n + h.additionLines, 0), removed: hunks.reduce((n, h) => n + h.deletionLines, 0) };
}

/** Sum of the per-call diffs: the stats of a file without a baseline. */
export function callStats(c: FileChange): Stats {
  return c.calls.reduce(
    (t, call) => {
      const s = diffStats(call.tool, call.input);
      return s ? { added: t.added + s.added, removed: t.removed + s.removed } : t;
    },
    { added: 0, removed: 0 },
  );
}
