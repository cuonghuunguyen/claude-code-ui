// Parses the classifier's reply. Expected shape: optional `<thinking>…</thinking>`, then
// `<block>yes|no</block>` and an optional `<reason>…</reason>`. Anything else is unparseable.

export interface Verdict {
  decision: "yes" | "no" | null;
  reason: string;
}

const THINKING_RE = /<thinking>[\s\S]*?<\/thinking>/gi;
const BLOCK_RE = /<block>\s*(yes|no)\s*<\/block>/gi;
const REASON_RE = /<reason>([\s\S]*?)<\/reason>/i;

/** `decision: null` means unparseable (unclosed thinking, no block tag, or conflicting block tags): the caller must do nothing. */
export function parseVerdict(raw: string): Verdict {
  const none: Verdict = { decision: null, reason: "" };
  const stripped = raw.replace(THINKING_RE, "");
  if (/<thinking>/i.test(stripped)) return none; // an unclosed thinking block could hide or fake the answer
  const decisions = [...stripped.matchAll(BLOCK_RE)].map((m) => m[1].toLowerCase());
  if (decisions.length === 0 || new Set(decisions).size > 1) return none;
  const reason = stripped.match(REASON_RE);
  return { decision: decisions[0] as "yes" | "no", reason: reason ? reason[1].trim() : "" };
}
