import { describe, expect, it } from "vitest";
import { varNameError, varValueError } from "../src/index.ts";

describe("addon theme var names", () => {
  it.each(["--glow", "--gojo-glow-2", "--a", "--context-3"])("accepts %s", (n) => expect(varNameError(n)).toBeUndefined());

  it.each(["glow", "-glow", "--Glow", "--1a", "--", "--a_b", "--a b", `--${"a".repeat(42)}`, "--a;b", "--a}"])("refuses the malformed name %s", (n) => expect(varNameError(n)).toMatch(/name/));

  // The palette owns these tokens: a var of the same name would override a colour the palette keys are checked for contrast.
  it.each(["--background", "--foreground", "--card", "--primary", "--primary-foreground", "--border", "--muted", "--accent", "--faint", "--ring", "--destructive", "--syntax-keyword", "--ref-head", "--graph-1", "--graph-8"])("refuses the palette token %s", (n) => expect(varNameError(n)).toMatch(/palette/));
});

describe("addon theme var values (a value is written into a <style> text)", () => {
  it.each(["#fff", "0 0 12px rgb(255 0 0 / 40%)", "calc(1px + 2px)", '"Noto Sans", sans-serif', "'a b'", "linear-gradient(90deg, red, blue)", "1.5s ease-in-out", "var(--card)", "[a] 1fr"])("accepts %s", (v) => expect(varValueError(v)).toBeUndefined());

  it.each([
    ["a;b", "break out of the declaration"],
    ["a}b", "close the rule"],
    ["a{b", "open a rule"],
    ["</style><script>", "close the style element"],
    ["a>b", "angle"],
    ["a\\b", "escape that could spell url("],
    ["url(x.png)", "url"],
    ["URL (x.png)", "url, case and space"],
    ["image-set(x 1x)", "image-set"],
    ["cross-fade(a, b)", "cross-fade"],
    ["paint(x)", "paint"],
    ["@import x", "at-rule"],
    ["a /* b", "comment opener"],
    ["a\nb", "newline"],
    ["a\u0000b", "control character"],
    ["calc(1px", "unclosed paren"],
    ["a)", "stray paren"],
    ["[a", "unclosed bracket"],
    ['"abc', "unclosed string"],
    ["(]", "mismatched"],
    ["", "empty"],
    ["x".repeat(201), "too long"],
  ])("refuses %j (%s)", (v) => expect(varValueError(v)).toBeDefined());

  it("is bounded by the length cap on hostile input", () => {
    const t = performance.now();
    for (const v of ["(".repeat(1_000_000), '"'.repeat(1_000_000), "a".repeat(1_000_000)]) expect(varValueError(v)).toBeDefined();
    for (let i = 0; i < 2000; i++) varValueError("(".repeat(100) + ")".repeat(100));
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
