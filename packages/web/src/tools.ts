// Tool knowledge for tool cards (docs/spec.md "Session view UX").
import { parseDiffFromFile } from "@pierre/diffs";

/** Read/search tools; consecutive calls merge into one context group. */
export const CONTEXT_TOOLS = new Set(["Read", "Grep", "Glob"]);

// Input fields that best describe a call, most telling first.
const SUMMARY_KEYS = ["file_path", "notebook_path", "pattern", "command", "path", "url", "query", "description", "prompt"];

/** One-line summary of a tool input for the card header. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  const key = SUMMARY_KEYS.find((k) => typeof fields[k] === "string");
  const value = key ? fields[key] : Object.values(fields).find((v) => typeof v === "string");
  return typeof value === "string" ? (value.split("\n")[0] ?? "") : "";
}

/** Line range of a Read call, from the numbered result lines if any, else from offset/limit. */
export function readRange(input: unknown, output?: unknown): string {
  const nums = typeof output === "string" ? [...output.matchAll(/^\s*(\d+)[\t→]/gm)].map((m) => Number(m[1])) : [];
  if (nums.length > 0) return `lines ${nums[0]}–${nums.at(-1)}`;
  const { offset, limit } = (input ?? {}) as { offset?: unknown; limit?: unknown };
  const start = typeof offset === "number" ? offset : 1;
  if (typeof limit === "number") return `lines ${start}–${start + limit - 1}`;
  return typeof offset === "number" ? `from line ${start}` : "";
}

type FileContents = { name: string; contents: string };

/** Old and new file for an Edit/Write diff, built from the tool input alone; undefined until the input is complete. */
export function editFiles(tool: string, input: unknown): { oldFile: FileContents; newFile: FileContents } | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const name = str(i.file_path);
  // Edit strings are fragments, not whole files: end them with a newline, else the diff marks "No newline at end of file".
  const line = (v: unknown) => (typeof v === "string" && v && !v.endsWith("\n") ? `${v}\n` : str(v));
  const [before, after] = tool === "Edit" ? [line(i.old_string), line(i.new_string)] : tool === "Write" ? ["", str(i.content)] : [];
  if (name === undefined || before === undefined || after === undefined) return undefined;
  return { oldFile: { name, contents: before }, newFile: { name, contents: after } };
}

/** Added and removed line counts of an Edit/Write call, for the collapsed card header; undefined until the input is complete. */
export function diffStats(tool: string, input: unknown): { added: number; removed: number } | undefined {
  const files = editFiles(tool, input);
  if (!files) return undefined;
  const { hunks } = parseDiffFromFile(files.oldFile, files.newFile);
  return { added: hunks.reduce((n, h) => n + h.additionLines, 0), removed: hunks.reduce((n, h) => n + h.deletionLines, 0) };
}
