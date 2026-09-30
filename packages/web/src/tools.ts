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
