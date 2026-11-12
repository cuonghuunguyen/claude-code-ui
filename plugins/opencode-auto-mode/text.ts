// Small string helpers shared by transcript.ts and verdict.ts.

/** `v` as a display string; objects are JSON-encoded, nullish becomes "". */
export function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function truncate(s: string, maxChars: number): string {
  return s.length > maxChars ? s.slice(0, maxChars) + "…(truncated)" : s;
}

/** Compact `k=v k2=v2 …` rendering of an object, for unknown/MCP tool inputs. */
export function compactKV(obj: Record<string, unknown> | undefined, maxChars: number): string {
  if (!obj) return "";
  const text = Object.entries(obj)
    .map(([k, v]) => `${k}=${str(v)}`)
    .join(" ");
  return truncate(text, maxChars);
}
