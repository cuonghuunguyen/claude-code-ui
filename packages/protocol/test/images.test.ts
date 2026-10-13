import { describe, expect, it } from "vitest";
import { MEDIA_INLINE_MAX, omitMedia, omittedImage, parseOmitted, type Part } from "../src/index.ts";

const big = "A".repeat(20_000);
const result = (output: unknown): Part => ({ type: "tool_result", id: "r1", toolUseId: "t1", output, isError: false });
const prompt = (images: string[]): Part => ({ type: "user_text", id: "u1", text: "hi", images });

describe("omitMedia", () => {
  it("leaves out large tool_result image and document data, keeps small ones and other blocks", () => {
    const text = { type: "text", text: "x" };
    const small = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(100) } };
    const out = (omitMedia(result([text, { type: "image", source: { type: "base64", media_type: "image/png", data: big } }, small, { type: "document", source: { type: "base64", media_type: "application/pdf", data: big } }])) as Extract<Part, { type: "tool_result" }>).output as Record<string, unknown>[];
    expect(out[1]).toMatchObject({ type: "image", source: { type: "omitted", media_type: "image/png", bytes: 15000 } });
    expect(out[3]).toMatchObject({ type: "document", source: { type: "omitted", media_type: "application/pdf", bytes: 15000 } });
    expect(out[0]).toBe(text);
    expect(out[2]).toBe(small);
  });

  it("replaces large user_text images with an omitted marker parseOmitted reads", () => {
    const smallUrl = "data:image/png;base64,AAAA";
    const r = omitMedia(prompt([`data:image/png;base64,${big}`, smallUrl])) as Extract<Part, { type: "user_text" }>;
    expect(parseOmitted(r.images[0]!)).toEqual({ mediaType: "image/png", bytes: 15000 });
    expect(r.images[1]).toBe(smallUrl);
    expect(parseOmitted(smallUrl)).toBeUndefined();
    expect(parseOmitted(omittedImage("image/webp", 7))).toEqual({ mediaType: "image/webp", bytes: 7 });
  });

  it("returns the same part when nothing is large", () => {
    const parts = [{ type: "assistant_text", id: "a", text: "x", streaming: false } as Part, result("string output"), prompt(["data:image/png;base64,AAAA"])];
    for (const p of parts) expect(omitMedia(p)).toBe(p);
    expect(MEDIA_INLINE_MAX).toBe(16_384);
  });
});
