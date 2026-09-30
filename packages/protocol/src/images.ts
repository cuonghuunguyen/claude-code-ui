// Prompt images travel as data URLs (wire, user_text.images) and reach the SDK as base64 image content blocks.
const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

export type ImageBlock = { type: "image"; source: { type: "base64"; media_type: MediaType; data: string } };

/** Image content block for a `data:<image type>;base64,` URL, or undefined if it is not one the API accepts. */
export function imageBlock(dataUrl: unknown): ImageBlock | undefined {
  const m = typeof dataUrl === "string" ? /^data:([\w/+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl) : null;
  if (!m || !MEDIA_TYPES.includes(m[1] as MediaType)) return undefined;
  return { type: "image", source: { type: "base64", media_type: m[1] as MediaType, data: m[2]! } };
}
