import { describe, expect, it } from "vitest";
import { optionCss, optionDefault, optionValue, varNameError, varValueError, type AddonThemeOption } from "../src/index.ts";

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
    ["-webkit-image-set(x 1x)", "prefixed image-set"],
    ["-moz-element(#app)", "prefixed element"],
    ["-webkit-cross-fade(a, b)", "prefixed cross-fade"],
    ["a<b", "angle bracket alone"],
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

  it("refuses hostile input fast (length cap first; one linear pass up to 200 characters)", () => {
    const t = performance.now();
    for (const v of ["(".repeat(1_000_000), '"'.repeat(1_000_000), "a".repeat(1_000_000)]) expect(varValueError(v)).toBeDefined();
    for (let i = 0; i < 2000; i++) varValueError("(".repeat(100) + ")".repeat(100));
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("typed theme options: a stored value is checked against the type, a bad one is the default", () => {
  const select: AddonThemeOption = { id: "mood", label: "M", type: "select", choices: [{ value: "calm", label: "C" }, { value: "storm", label: "S" }], default: "storm" };
  const range: AddonThemeOption = { id: "d", label: "D", type: "range", min: 0, max: 1, step: 0.1, default: 0.5 };
  const color: AddonThemeOption = { id: "t", label: "T", type: "color", default: "#aa00ff" };
  const bool: AddonThemeOption = { id: "b", label: "B" };

  it("defaults: boolean on unless false; select its default, else the first choice; range and color their default", () => {
    expect(optionDefault(bool)).toBe(true);
    expect(optionDefault({ ...bool, default: false })).toBe(false);
    expect(optionDefault(select)).toBe("storm");
    expect(optionDefault({ ...select, default: "zzz" })).toBe("calm");
    expect(optionDefault(range)).toBe(0.5);
  });

  it.each([
    [bool, "yes", true],
    [bool, false, false],
    [select, "calm", "calm"],
    [select, "other", "storm"],
    [range, 0.7, 0.7],
    [range, 2, 0.5],
    [range, Number.NaN, 0.5],
    [range, "0.7", 0.5],
    [color, "#00FF88", "#00ff88"],
    [color, "#0f8", "#aa00ff"],
    [color, "red", "#aa00ff"],
  ])("%j with %j gives %j", (o, v, want) => expect(optionValue(o as AddonThemeOption, v)).toBe(want));

  it("the CSS value: boolean 0/1, the choice, the number, the hex; nothing that could leave the declaration", () => {
    expect(optionCss(bool, true)).toBe("1");
    expect(optionCss(bool, false)).toBe("0");
    expect(optionCss(select, "calm")).toBe("calm");
    expect(optionCss(range, 0.25)).toBe("0.25");
    expect(optionCss(color, "#00ff88")).toBe("#00ff88");
    expect(optionCss(select, "a;}b")).toBe("storm");
    expect(optionCss(color, "#aa00ff;}")).toBe("#aa00ff");
  });
});
