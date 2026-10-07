// Media files the file explorer previews: extension allowlist, Range parsing and the headers of GET /media/<nonce>/<name>.
import { extname } from "node:path";

export const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
};

export const mediaType = (path: string): string | undefined => {
  const ext = extname(path).toLowerCase();
  return Object.hasOwn(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : undefined;
};

/** One range only. `undefined`: serve the full file (no or unusable header); "unsatisfiable": 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== "" && start > Number(m[2])) return undefined;
  if (start >= size) return "unsatisfiable";
  return { start, end: m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

export const MEDIA_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "accept-ranges": "bytes",
};

export const MEDIA_TTL_MS = 10 * 60_000;
