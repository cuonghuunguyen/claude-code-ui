import { describe, expect, it } from "vitest";
import { assetsInlineLimit } from "../assets-inline.ts";

describe("assetsInlineLimit", () => {
  it("never inlines a font, even a small one (CSP font-src 'self' blocks data:)", () => {
    for (const f of ["KaTeX_Size3-Regular.woff2", "a.woff", "a.ttf", "a.otf", "A.WOFF2"]) {
      expect(assetsInlineLimit(`/x/${f}`, Buffer.alloc(10))).toBe(false);
    }
  });
  it("keeps the default 4 KiB inline limit for other assets", () => {
    expect(assetsInlineLimit("/x/a.svg", Buffer.alloc(100))).toBe(true);
    expect(assetsInlineLimit("/x/a.svg", Buffer.alloc(5000))).toBeUndefined();
  });
});
