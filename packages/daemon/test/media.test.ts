import { describe, expect, it } from "vitest";
import { mediaType, parseRange } from "../src/media.ts";

describe("parseRange", () => {
  it("single ranges, suffix, open end, clamped end", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
  });
  it("multi-range, garbage, reversed -> undefined (200 full); out of range -> unsatisfiable", () => {
    for (const h of [undefined, "", "bytes=0-1,5-6", "items=0-1", "bytes=a-b", "bytes=-", "bytes=5-2"]) expect(parseRange(h, 1000)).toBeUndefined();
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1", 0)).toBe("unsatisfiable");
  });
});

describe("mediaType", () => {
  it("allowlist, case-insensitive, rejects others", () => {
    expect(mediaType("/a/A.PNG")).toBe("image/png");
    expect(mediaType("/a/b.svg")).toBe("image/svg+xml");
    for (const p of ["/a/b.html", "/a/b.js", "/a/b.svgz", "/a/b.txt", "/a/noext", "/a/b.constructor", "/a/.png.bak"]) expect(mediaType(p)).toBeUndefined();
  });
});
