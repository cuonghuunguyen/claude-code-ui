// Artifact publish preview (GH-175): which session part names a previewable file, and the headers of GET /artifact/<nonce>/<name>.
import { extname, isAbsolute, resolve } from "node:path";
import type { Part } from "@claude-ui/protocol";

/** Largest previewable page: the Artifact tool's own page limit. */
export const ARTIFACT_PREVIEW_MAX = 16 << 20;

/** The CSP of a preview page, one directive per entry with its reason; relax here only (docs/spec.md "Security"). */
export const ARTIFACT_CSP = [
  "sandbox allow-scripts", // opaque origin also on a top-level load: no cookies, storage, parent DOM; no popups, forms, top navigation
  "default-src 'none'", // no network: connect, frame, worker, object, manifest all none
  "script-src 'unsafe-inline'", // the page's own inline scripts; no remote script, no eval (CDN libraries do not load: documented)
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'", // only the app frames it
].join("; ");

export const ARTIFACT_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": ARTIFACT_CSP,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
} as const;

export type ArtifactFile = { path: string } | { code: "unknown_part" | "unsupported_type"; message: string };

/** The absolute (lexical) file a done Artifact publish part names, resolved against `cwd`; else why not. Pure: no fs. */
export function artifactFileOf(part: Part | undefined, cwd: string): ArtifactFile {
  const no = (message = "not an Artifact publish of this session"): ArtifactFile => ({ code: "unknown_part", message });
  if (part?.type !== "tool_call" || part.tool !== "Artifact" || part.status !== "done") return no();
  const input = part.input as { action?: unknown; asset?: unknown; file_path?: unknown } | null;
  if (typeof input !== "object" || input === null) return no();
  if ((input.action !== undefined && input.action !== "publish") || input.asset === true) return no();
  const file = input.file_path;
  if (typeof file !== "string" || file === "" || file.includes("\0")) return no();
  if (!/^\.html?$/.test(extname(file).toLowerCase())) return { code: "unsupported_type", message: `not an HTML page: ${file}` };
  return { path: isAbsolute(file) ? resolve(file) : resolve(cwd, file) };
}
