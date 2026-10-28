import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

const ref = (x: string) => createHash("sha256").update(x).digest("hex");

describe("sha256Hex", () => {
  it("matches node:crypto for ascii, empty, multi-byte and a 1 MB string", () => {
    const samples = [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "session-id-1234",
      "héllo wörld ✦ 日本語 😀",
      "x".repeat(1_000_000),
    ];
    for (const s of samples) expect(sha256Hex(s)).toBe(ref(s));
  });
});
