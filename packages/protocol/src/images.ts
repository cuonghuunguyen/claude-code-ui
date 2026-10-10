import type { Part } from "./parts.ts";
// Prompt images travel as data URLs (wire, user_text.images) and reach the SDK as base64 image content blocks.
const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

/** True for a MIME type the API takes as an image block; other images (svg, bmp, heic) go as files. */
export const isPromptImage = (type: string): type is MediaType => MEDIA_TYPES.includes(type as MediaType);

export type ImageBlock = { type: "image"; source: { type: "base64"; media_type: MediaType; data: string } };

/** Image content block for a `data:<image type>;base64,` URL, or undefined if it is not one the API accepts. */
export function imageBlock(dataUrl: unknown): ImageBlock | undefined {
  const m = typeof dataUrl === "string" ? /^data:([\w/+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl) : null;
  if (!m || !isPromptImage(m[1]!)) return undefined;
  return { type: "image", source: { type: "base64", media_type: m[1] as MediaType, data: m[2]! } };
}

/** Base64 payloads longer than this leave snapshot and page parts; the client loads them with `session.media` (GH-274). */
export const MEDIA_INLINE_MAX = 16_384;

/** Source of a tool_result image/document block whose data was left out of a snapshot or page. `bytes`: decoded size. */
export type OmittedSource = { type: "omitted"; media_type: string; bytes: number };

const OMITTED = "omitted:";
const decodedBytes = (base64: string) => Math.floor((base64.length * 3) / 4);

/** A `user_text.images` entry left out of a snapshot or page: `omitted:<media type>;<bytes>`. */
export const omittedImage = (mediaType: string, bytes: number) => `${OMITTED}${mediaType};${bytes}`;

export function parseOmitted(s: string): { mediaType: string; bytes: number } | undefined {
  const m = s.startsWith(OMITTED) ? /^omitted:([^;]+);(\d+)$/.exec(s) : null;
  return m ? { mediaType: m[1]!, bytes: Number(m[2]) } : undefined;
}

/** The part with large base64 payloads replaced (tool_result image/document blocks, user_text images); the same object when none. */
export function omitMedia(part: Part): Part {
  if (part.type === "tool_result" && Array.isArray(part.output)) {
    let changed = false;
    const output = part.output.map((b: unknown) => {
      const block = b as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | null;
      const src = block?.source;
      if ((block?.type !== "image" && block?.type !== "document") || src?.type !== "base64" || typeof src.data !== "string" || src.data.length <= MEDIA_INLINE_MAX) return b;
      changed = true;
      const source: OmittedSource = { type: "omitted", media_type: String(src.media_type), bytes: decodedBytes(src.data) };
      return { ...block, source };
    });
    return changed ? { ...part, output } : part;
  }
  if (part.type === "user_text" && part.images.some((i) => i.length > MEDIA_INLINE_MAX)) {
    let changed = false;
    const images = part.images.map((i) => {
      const m = i.length > MEDIA_INLINE_MAX ? /^data:([^;,]+);base64,/.exec(i) : null;
      if (!m) return i;
      changed = true;
      return omittedImage(m[1]!, decodedBytes(i.slice(m[0].length)));
    });
    return changed ? { ...part, images } : part;
  }
  return part;
}
