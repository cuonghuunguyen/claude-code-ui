import { describe, expect, it } from "vitest";
import { omitMedia, partHash, type Part } from "../src/index.ts";

const big = "A".repeat(20_000);
const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const result = (output: unknown): Part => ({ type: "tool_result", id: "r1", toolUseId: "t1", output, isError: false });
const text = (t: string, streaming = false): Part => ({ type: "assistant_text", id: "a1", text: t, streaming });

describe("partHash", () => {
  it("is a short base36 string, stable for equal parts", () => {
    const h = partHash(text("hello"));
    expect(h).toMatch(/^[0-9a-z]{1,11}$/);
    expect(h.length).toBeLessThanOrEqual(16);
    expect(partHash(text("hello"))).toBe(h);
  });

  it("differs on any field change", () => {
    const base = partHash(text("hello"));
    expect(partHash(text("hellp"))).not.toBe(base);
    expect(partHash(text("hello", true))).not.toBe(base);
    expect(partHash({ type: "assistant_text", id: "a2", text: "hello", streaming: false })).not.toBe(base);
  });

  it("is equal for a live part with a 20 KB image and its omitMedia form", () => {
    const live = result([image(big)]);
    const omitted = omitMedia(live);
    expect(omitted).not.toBe(live);
    expect(partHash(live)).toBe(partHash(omitted));
  });

  it("omitMedia is idempotent on an already omitted part", () => {
    const once = omitMedia(result([image(big)]));
    expect(omitMedia(once)).toBe(once);
    const prompt: Part = { type: "user_text", id: "u1", text: "hi", images: [`data:image/png;base64,${big}`] };
    const p1 = omitMedia(prompt);
    expect(omitMedia(p1)).toEqual(p1);
    expect(partHash(p1)).toBe(partHash(prompt));
  });

  it("is the same after a JSON round trip (key order kept)", () => {
    const p = result([{ type: "text", text: "x" }, image("AAAA")]);
    expect(partHash(JSON.parse(JSON.stringify(p)))).toBe(partHash(p));
  });
});
