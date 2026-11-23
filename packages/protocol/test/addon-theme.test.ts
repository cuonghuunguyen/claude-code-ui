import { describe, expect, it } from "vitest";
import { extendsChain, optionCss, optionDefault, optionValue, phrasesFor, satisfiesClaudeUi, varNameError, varValueError, type AddonThemeOption } from "../src/index.ts";

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

describe("claudeUi ranges", () => {
  it.each([
    ["*", "0.1.0", true],
    [">=1.6", "1.5.0", false],
    [">=1.5", "1.5.0", true],
    [">=1.5.1", "1.5.0", false],
    [">=1.5", "2.0.0", true],
    ["^1.5", "1.9.2", true],
    ["^1.5", "2.0.0", false],
    ["^1.5", "1.4.9", false],
    ["^0.2", "0.2.9", true],
    ["^0.2", "0.3.0", false],
    ["~1.5", "1.5.9", true],
    ["~1.5", "1.6.0", false],
    ["~1.5.2", "1.5.1", false],
    ["1.5.0", "1.5.0", true],
    ["1.5.0", "1.5.1", false],
    [">=1.6", "1.6.0-beta.1", true],
    [">=9.0", "dev", true],
    [">=9.0", undefined, true],
  ])("%s with app %s is %s", (range, version, ok) => expect(satisfiesClaudeUi(range, version)).toBe(ok));
});

describe("extends chain and thinking phrases", () => {
  type T = { id: string; extends?: string };
  const all: Record<string, T> = { "a:t1": { id: "t1", extends: "t2" }, "a:t2": { id: "t2", extends: "b:t3" }, "b:t3": { id: "t3" }, "a:loop": { id: "loop", extends: "b:l2" }, "b:l2": { id: "l2", extends: "a:loop" } };
  const find = (a: string, id: string) => all[`${a}:${id}`];
  it("follows the links nearest first; a missing target, a loop and a malformed value give no base", () => {
    expect(extendsChain("a", all["a:t1"]!, find).chain.map((c) => `${c.addon}:${c.theme.id}`)).toEqual(["a:t2", "b:t3"]);
    expect(extendsChain("a", { id: "x", extends: "gone" }, find)).toEqual({ chain: [], problem: "missing" });
    expect(extendsChain("a", all["a:loop"]!, find)).toEqual({ chain: [], problem: "cycle" });
    expect(extendsChain("a", { id: "x", extends: "Bad Id" }, find)).toEqual({ chain: [], problem: "bad" });
  });
  it("allows 3 links and refuses a fourth", () => {
    const l: Record<string, T> = { "a:b": { id: "b", extends: "c" }, "a:c": { id: "c", extends: "d" }, "a:d": { id: "d" }, "a:e": { id: "e", extends: "f" }, "a:f": { id: "f" } };
    const f = (a: string, id: string) => l[`${a}:${id}`];
    expect(extendsChain("a", { id: "x", extends: "b" }, f).chain).toHaveLength(3);
    l["a:d"] = { id: "d", extends: "e" };
    expect(extendsChain("a", { id: "x", extends: "b" }, f).problem).toBe("deep");
  });
  it("phrases: the exact locale, then its language, else none", () => {
    const p = { en: ["a"], "pt-BR": ["b"], pt: ["c"] };
    expect([phrasesFor(p, "en"), phrasesFor(p, "pt-BR"), phrasesFor(p, "pt-PT"), phrasesFor(p, "vi"), phrasesFor(undefined, "en")]).toEqual([["a"], ["b"], ["c"], undefined, undefined]);
  });
});
