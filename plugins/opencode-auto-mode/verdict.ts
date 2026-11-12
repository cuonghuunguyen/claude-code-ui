// Parses the classifier's reply. Expected shape: optional `<thinking>…</thinking>`, then
// `<block>yes|no</block>` and an optional `<reason>…</reason>`. Anything else is unparseable.

export interface Verdict {
  decision: "yes" | "no" | null;
  reason: string;
}

const THINKING_RE = /<thinking>[\s\S]*?<\/thinking>/gi;
const BLOCK_RE = /<block>\s*(yes|no)\s*<\/block>/i;
const REASON_RE = /<reason>([\s\S]*?)<\/reason>/i;

/** `decision: null` means unparseable — the caller must do nothing (leave it to the human). */
export function parseVerdict(raw: string): Verdict {
  const stripped = raw.replace(THINKING_RE, "");
  const block = stripped.match(BLOCK_RE);
  if (!block) return { decision: null, reason: "" };
  const reason = stripped.match(REASON_RE);
  return { decision: block[1].toLowerCase() as "yes" | "no", reason: reason ? reason[1].trim() : "" };
}
