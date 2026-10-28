import { describe, expect, it } from "vitest";
import { copyFailText } from "./copy-text.ts";

describe("copyFailText", () => {
  it("ends with the text to copy by hand", () => {
    const m = copyFailText("/home/u/p");
    expect(m).toContain("Copy failed");
    expect(m.endsWith("/home/u/p")).toBe(true);
  });
  it("keeps the short message without a text", () => {
    expect(copyFailText(undefined)).toBe("Copy failed: the browser allows the clipboard only on HTTPS or localhost");
    expect(copyFailText("")).toBe(copyFailText(undefined));
  });
});
