// Artifact publish preview (GH-175): which session part names a previewable file, and the headers of GET /artifact/<nonce>/<name>.
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { Part } from "@claude-ui/protocol";
import { MEDIA_TYPES } from "./media.ts";

/** Largest previewable page: the Artifact tool's own page limit. */
export const ARTIFACT_PREVIEW_MAX = 16 << 20;

/** The CSP of a preview page, one directive per entry with its reason; relax here only (docs/spec.md "Security"). */
export const ARTIFACT_CSP = [
  "sandbox allow-scripts", // opaque origin also on a top-level load: no cookies, storage, parent DOM; no popups, forms, top navigation
  "default-src 'none'", // no fetch/XHR/image/script/frame/navigation requests (WebRTC is not governed by CSP in browsers: not blocked)
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
  "x-dns-prefetch-control": "off", // no speculative DNS lookups from links in the page
} as const;

export type ArtifactAsset = { key: string; path: string; type: string };
export type ArtifactFile = { path: string; title: string; assets: ArtifactAsset[]; unavailable: string[] } | { code: "unknown_part" | "unsupported_type"; message: string };

/** Largest number of supporting files of one preview (the Artifact tool keeps up to 511 per version). */
export const ARTIFACT_ASSETS_MAX = 512;

/** Types a supporting file is served as, by the extension of its published path (never sniffed, never the model's contentType). No .html (a second page cannot be navigated to), no .wasm, no .xml/.xsl. */
export const ARTIFACT_ASSET_TYPES: Record<string, string> = {
  ...MEDIA_TYPES,
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
export const assetType = (published: string): string | undefined => {
  const ext = extname(published).toLowerCase();
  return Object.hasOwn(ARTIFACT_ASSET_TYPES, ext) ? ARTIFACT_ASSET_TYPES[ext] : undefined;
};

const BAD_CHARS = /[\\\0]/;
/** The key of a request path (what follows /artifact/<nonce>/, still percent-encoded): each segment decoded once; undefined for an empty, "." or ".." segment or a separator or NUL in a decoded segment. */
export function assetKey(raw: string): string | undefined {
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return undefined;
    }
    if (d === "" || d === "." || d === ".." || d.includes("/") || BAD_CHARS.test(d)) return undefined;
    out.push(d);
  }
  return out.join("/");
}
/** The key of a published path of the tool input, as the browser resolves it: "." segments dropped; absolute, "..", backslash, NUL or empty segments refused. */
export function publishedKey(p: string): string | undefined {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === ".") continue;
    if (seg === "" || seg === ".." || BAD_CHARS.test(seg)) return undefined;
    out.push(seg);
  }
  return out.length ? out.join("/") : undefined;
}

/** The supporting files named in the `files` and `root` of one Artifact publish: published path -> lexical source path, and the published paths that are not served. Pure: no fs. */
export function artifactAssetsOf(input: { files?: unknown; root?: unknown }, cwd: string): { assets: ArtifactAsset[]; unavailable: string[] } {
  const assets: ArtifactAsset[] = [];
  const unavailable: string[] = [];
  const { files, root } = input;
  if (typeof files !== "object" || files === null) return { assets, unavailable };
  const rootOk = root === undefined || (typeof root === "string" && root !== "" && !root.includes("\0"));
  const base = typeof root === "string" && rootOk ? (isAbsolute(root) ? resolve(root) : resolve(cwd, root)) : cwd;
  const entries: [string, unknown][] = Array.isArray(files)
    ? files.map((f): [string, unknown] => {
        const path = (f as { path?: unknown } | null)?.path;
        return typeof path === "string" ? [path, path] : [String(path ?? f).slice(0, 200), undefined];
      })
    : Object.entries(files);
  const seen = new Set<string>();
  for (const [published, v] of entries) {
    if (v === null) continue; // a removal, not a file
    let source: string | undefined;
    if (typeof v === "string") source = v;
    else if (typeof v === "object" && typeof (v as { from?: unknown }).from === "string") source = (v as { from: string }).from;
    const key = publishedKey(published);
    const type = key && assetType(key);
    if (assets.length + unavailable.length >= ARTIFACT_ASSETS_MAX || !rootOk || source === undefined || source.includes("\0") || !key || !type || seen.has(key)) {
      unavailable.push(published.slice(0, 200));
      continue;
    }
    seen.add(key);
    assets.push({ key, path: isAbsolute(source) ? resolve(source) : resolve(base, source), type });
  }
  return { assets, unavailable };
}

/** The folder the Claude CLI names as a session's scratchpad: <tmp>/claude/<cwd slug>/<session id>/scratchpad. The slug is the cwd with every non-alphanumeric replaced by "-" (the CLI's own rule, verified against the folders under %TEMP%\\claude and the SDK's slug function); the CLI adds a hash to a slug over 200 characters, which is not reproduced: undefined then. Pure: the caller checks that the folder exists. */
export function scratchpadOf(cwd: string, sessionId: string, tmp: string): string | undefined {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length > 200 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) return undefined;
  return resolve(tmp, "claude", slug, sessionId, "scratchpad");
}

/** The page CSP of a multi-file publish: `assetBase` (http://<host>/artifact/<nonce>/, never 'self') joins the sources of the resource types a page links, plus connect-src for fetch of named files. Without it: ARTIFACT_CSP. */
export function artifactCsp(assetBase?: string): string {
  if (!assetBase) return ARTIFACT_CSP;
  const withBase = new Set(["script-src", "style-src", "img-src", "font-src", "media-src"]);
  return [...ARTIFACT_CSP.split("; ").map((d) => (withBase.has(d.split(" ")[0]!) ? `${d} ${assetBase}` : d)), `connect-src ${assetBase}`].join("; ");
}
export const artifactHeaders = (assetBase?: string) => ({ ...ARTIFACT_HEADERS, "content-security-policy": artifactCsp(assetBase) });

/** Headers of a supporting file (content-type and length come with the file). */
export const ARTIFACT_ASSET_HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "cross-origin", // same-origin would block the opaque-origin page (probe, Chromium)
  "access-control-allow-origin": "null", // module scripts, fonts and fetch of the opaque-origin page send Origin: null; no credentials header
  "referrer-policy": "no-referrer",
  "content-security-policy": "sandbox; default-src 'none'", // a file opened as a document (an SVG) is inert
  "x-dns-prefetch-control": "off",
} as const;

const ASSET_DESTS = new Set(["style", "script", "image", "font", "empty", "audio", "video", "track"]);
/** Fetch metadata of a supporting-file request: a subresource load by the page, never a navigation or frame. Sec-Fetch-Site is not checked: the page is an opaque origin, so its loads are cross-site; the nonce is the capability. */
export function assetRequestAllowed(h: { origin?: string; dest?: string; mode?: string }, ownOrigin: boolean): boolean {
  if (h.origin !== undefined && h.origin !== "null" && !ownOrigin) return false;
  if (h.mode === "navigate") return false;
  return h.dest === undefined || ASSET_DESTS.has(h.dest);
}

/** The absolute (lexical) file a done Artifact publish part names, resolved against `cwd`, with its supporting files; else why not. Pure: no fs. */
export function artifactFileOf(part: Part | undefined, cwd: string): ArtifactFile {
  const no = (message = "not an Artifact publish of this session"): ArtifactFile => ({ code: "unknown_part", message });
  if (part?.type !== "tool_call" || part.tool !== "Artifact" || part.status !== "done") return no();
  const input = part.input as { action?: unknown; asset?: unknown; file_path?: unknown; title?: unknown; files?: unknown; root?: unknown } | null;
  if (typeof input !== "object" || input === null) return no();
  if ((input.action !== undefined && input.action !== "publish") || input.asset === true) return no();
  const file = input.file_path;
  if (typeof file !== "string" || file === "" || file.includes("\0")) return no();
  if (!/^\.html?$/.test(extname(file).toLowerCase())) return { code: "unsupported_type", message: `not an HTML page: ${file}` };
  const path = isAbsolute(file) ? resolve(file) : resolve(cwd, file);
  return { path, title: typeof input.title === "string" && input.title !== "" ? input.title : basename(path), ...artifactAssetsOf(input, cwd) };
}
