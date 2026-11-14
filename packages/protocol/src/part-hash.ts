import { omitMedia } from "./images.ts";
import type { Part } from "./parts.ts";

// FNV-1a over UTF-16 code units, two 32-bit lanes (different offset basis and prime) joined to 53 bits.
const hash = (s: string): [number, number] => {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000197) >>> 0;
  }
  return [a, b];
};

/**
 * Content hash of a part as a snapshot carries it (large media left out, so a live part and its snapshot form hash equal):
 * 53 bits, base36. Equality check only (a resume sends the hashes of the cached parts; GH-771), not a security measure.
 */
export function partHash(part: Part): string {
  const [a, b] = hash(JSON.stringify(omitMedia(part)));
  return (a * 0x200000 + (b >>> 11)).toString(36);
}
