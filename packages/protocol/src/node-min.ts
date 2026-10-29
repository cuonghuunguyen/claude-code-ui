// The oldest Node.js claude-ui runs on, read from the published package's `engines.node` (one source for the daemon's scripts and messages and the web UI).
import claudeUi from "../../claude-ui/package.json" with { type: "json" };

/** `">=22"` → `"22"`, `">=22.1"` → `"22.1"`; throws on any other shape (a changed `engines.node` must fail loudly). */
export function nodeMinOf(range: string): string {
  const m = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(range);
  if (!m) throw new Error(`engines.node "${range}" is not of the form ">=<version>"`);
  return m[1]!;
}
export const NODE_MIN = nodeMinOf(claudeUi.engines.node);
export const NODE_MIN_MAJOR = NODE_MIN.split(".")[0]!;
