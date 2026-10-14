import { describe, expect, it } from "vitest";
import { fileNameError } from "../src/file-name.ts";

describe("fileNameError (GH-360)", () => {
  it.each([[""], ["  "], ["."], [".."], ["a/b"], ["a\\b"], ["a\u0001b"], ["a\u007f"], ["x".repeat(256)], ["é".repeat(128)]])("refuses %j on both systems", (n) => {
    expect(fileNameError(n, false)).toBeTruthy();
    expect(fileNameError(n, true)).toBeTruthy();
  });
  it.each([["a:b"], ["a<b"], ["a?"], ["a*"], ['a"'], ["a|b"], ["a."], ["a "], ["CON"], ["con"], ["CON.txt"], ["lpt9.x"], ["NUL"]])("refuses %j on Windows only", (n) => {
    expect(fileNameError(n, true)).toBeTruthy();
    expect(fileNameError(n, false)).toBeUndefined();
  });
  it.each([[".env"], ["a b.ts"], ["ünï.md"], ["x".repeat(255)], ["console"], ["com10"], [".gitignore"]])("accepts %j", (n) => {
    expect(fileNameError(n, false)).toBeUndefined();
    expect(fileNameError(n, true)).toBeUndefined();
  });
});
