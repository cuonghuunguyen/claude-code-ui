// Terminal scrollback as text for an agent (docs/spec.md "Agent terminal access"): escape sequences removed, secrets redacted.
import { redact as urlCredentials } from "./plugins.ts";

// OSC (BEL or ST end), CSI, then any other two-char escape.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g;

/**
 * The text a terminal screen would roughly show for `raw` output. A bare CR restarts the line (progress bars), a backspace deletes one char.
 * ponytail: full-screen programs (vim, htop, the alternate screen) give approximate text; no terminal emulation.
 */
export function plainText(raw: string): string {
  const s = raw.replace(ESCAPES, "").replace(/\r\n/g, "\n");
  return s
    .split("\n")
    .map((line) => {
      const last = line.split("\r").pop()!;
      let out = "";
      for (const ch of last) {
        if (ch === "\b") out = out.slice(0, -1);
        else if (ch === "\t" || ch >= " ") out += ch === "\x7f" ? "" : ch;
      }
      return out;
    })
    .join("\n");
}

const MARK = "[redacted]";
const NAME = String.raw`[\w.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key)[\w.-]*`;
// Whole match replaced, unless `keep` (a capture group index of the part to keep).
const PATTERNS: { re: RegExp; keep?: number }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { re: /sk-ant-[\w-]{20,}/g },
  { re: /sk-[A-Za-z0-9_-]{20,}/g },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { re: /github_pat_\w{40,}/g },
  { re: /glpat-[\w-]{20,}/g },
  { re: /xox[abprs]-[\w-]{10,}/g },
  { re: /AKIA[0-9A-Z]{16}/g },
  { re: /AIza[\w-]{35}/g },
  { re: /eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g },
  { re: /\b((?:Authorization:\s*)?(?:Bearer|Basic)\s+)[\w.~+/=-]{6,}/gi, keep: 1 },
  { re: new RegExp(String.raw`(\b${NAME}\s*[=:]\s*)\S+`, "gi"), keep: 1 },
];

/** `text` with secrets replaced by `[redacted]`: the exact `known` values (8+ chars), then common token formats. Pattern-based, not exhaustive. */
export function redactSecrets(text: string, known: string[]): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const k of known) {
    if (k.length < 8 || !out.includes(k)) continue;
    const parts = out.split(k);
    count += parts.length - 1;
    out = parts.join(MARK);
  }
  for (const { re, keep } of PATTERNS)
    out = out.replace(re, (...m: string[]) => {
      // A value that is already redacted stays one hit.
      if (m[0]!.endsWith(MARK) && keep !== undefined) return m[0]!;
      count++;
      return keep === undefined ? MARK : `${m[keep]}${MARK}`;
    });
  const bare = urlCredentials(out);
  if (bare !== out) {
    count += (out.match(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#]*@/gi) ?? []).length;
    out = bare;
  }
  return { text: out, count };
}
