// Tool knowledge for tool cards (docs/spec.md "Session view UX").

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
