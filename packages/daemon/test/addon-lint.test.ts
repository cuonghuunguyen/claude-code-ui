// Addon lint (GH-871, docs/spec.md "Addon lint"): warnings only, never a block. Risk: a silent theme defect (a selector on a test hook or a
// misspelled part, a global name that overrides the app's own) reaches users unnoticed; the scanner must stay linear and quiet on broken CSS.
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARTS, type AddonManifest } from "@claude-ui/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { lintAddon, lintCss } from "../src/addon-lint.ts";

const codes = (css: string, addon = "acme") => lintCss(css, addon, "t.css").map((l) => `${l.code}${l.name ? `:${l.name}` : ""}`);

describe("selectors", () => {
  it.each([
    ['[data-testid="sidebar"] { color: red }', ["selects-testid"]],
    ["[ data-testid=sidebar ] .x { color: red }", ["selects-testid"]],
    ["@media (width < 48rem) { a:not([data-testid^='tab']) { color: red } }", ["selects-testid"]],
    ["[DATA-TESTID=x]{}", ["selects-testid"]],
    ['[data-part="sidebar"] { color: red }', []],
    ['/* [data-testid="x"] */ [data-part="tab"] {}', []],
    ['a { content: "[data-testid=x]" }', []],
    ['[title="[data-part=nope]"] {}', []],
    ["a { grid-template-columns: [data-testid] 1fr }", []],
    ["[data-testidx] {}", []],
    ["a { --sel: [data-testid=x]; &:hover { color: red } }", []],
    ["a { --sel: [data-part=nope]; &:hover { color: red } }", []],
  ])("test hook: %s", (css, want) => expect(codes(css)).toEqual(want));

  it("suggests the nearest part within two edits, and none for a far name", () => {
    const l = (css: string) => lintCss(css, "acme", "t.css").map((x) => x.suggest);
    expect(l('[data-part="sidebr"] {}')).toEqual(["sidebar"]);
    expect(l('[data-part="tabs"] {}')).toEqual(["tab"]);
    expect(l('[data-part="zzzzzzzz"] {}')).toEqual([undefined]);
  });

  it("warns about a part that is marked deprecated, with the release that removes it", () => {
    const part = PARTS.find((p) => p.name === "tab")!;
    part.deprecated = "1.7";
    try {
      expect(lintCss('[data-part="tab"] {}', "acme", "t.css")).toEqual([{ level: "warning", code: "deprecated-part", file: "t.css", line: 1, name: "tab", until: "1.7" }]);
    } finally {
      delete part.deprecated;
    }
    expect(codes('[data-part="tab"] {}')).toEqual([]);
  });

  it("reports one testid warning per file, with the count and the first line", () => {
    const l = lintCss('\n\n[data-testid="a"] {}\n[data-testid="b"] {}', "acme", "t.css");
    expect(l).toEqual([{ level: "warning", code: "selects-testid", file: "t.css", line: 3, count: 2 }]);
  });

  it.each([
    ['[data-part="sidebr"] {}', ["unknown-part:sidebr"]],
    ["[data-part=sidebr] {}", ["unknown-part:sidebr"]],
    ["[data-part='tab' i] {}", []],
    ['[data-part="TAB" i] {}', []],
    ['[data-part="TAB"] {}', ["unknown-part:TAB"]],
    ['[data-part~="x"] {}', ["unknown-part:x"]],
    ['[data-part] {}', []],
    ['[data-part^="side"], [data-part*="a"], [data-part|="session"], [data-part$="bar"] {}', []],
    ['[data-part^="zzz"] {}', ["unknown-part:zzz*"]],
    ['[data-part$="zzz"] {}', ["unknown-part:*zzz"]],
    ['[data-part*="zzz"] {}', ["unknown-part:*zzz*"]],
    ['[data-part|="sid"] {}', ["unknown-part:sid-*"]], // |= matches "sid" or "sid-...", not "sidebar"
    ['[data-part|="sidebar"] {}', []],
    ['[data-part^="SIDE" i] {}', []],
    ['[data-part^="SIDE"] {}', ["unknown-part:SIDE*"]],
    ['[data-part^=""] {}', []],
    ['[data-part="sidebar"], [data-part="nope"], [data-part="nope"], [data-part="nope2"] {}', ["unknown-part:nope", "unknown-part:nope2"]],
    ['[data-part="loader"] {}', []], // reserved parts are valid names
  ])("part name: %s", (css, want) => expect(codes(css)).toEqual(want));
});

describe("global names", () => {
  it.each([
    ["@keyframes spin { to { opacity: 0 } }", ["unprefixed-name:spin"]],
    ["@counter-style dots { system: cyclic }", ["unprefixed-name:dots"]],
    ["@counter-style acme-dots { system: cyclic }", []],
    ["@font-palette-values --warm { font-family: F }", ["unprefixed-name:--warm"]],
    ["@font-palette-values --acme-warm { font-family: F }", []],
    ['@font-feature-values Font One { @styleset { nice: 1 } }', ["unprefixed-name:Font One"]],
    ["@font-feature-values acme-display { @styleset { nice: 1 } }", []],
    ["@-webkit-keyframes spin { to { opacity: 0 } }", ["unprefixed-name:spin"]],
    ['@keyframes "spin" { to { opacity: 0 } }', ["unprefixed-name:spin"]],
    ["@keyframes acme-spin { to { opacity: 0 } }", []],
    ["@keyframes acmespin { to { opacity: 0 } }", ["unprefixed-name:acmespin"]],
    ["/* x */\n@media (width > 1px) { @keyframes pulse { to { opacity: 0 } } }", ["unprefixed-name:pulse"]],
    ['@font-face { font-family: "Inter"; src: url(a.woff2) }', ["unprefixed-name:Inter"]],
    ["@font-face { src: url(a.woff2); font-family: Acme Display }", []],
    ["@font-face { /* } */ font-family: Inter }", ["unprefixed-name:Inter"]],
    ['@font-face { src: url("a}.woff2"); font-family: Inter }', ["unprefixed-name:Inter"]],
    ['@font-face { font-family: "acme-display"; src: url(a.woff2) }', []],
    ["@property --glow { syntax: '<color>'; inherits: false; initial-value: red }", ["unprefixed-name:--glow"]],
    ["@property --acme-glow { syntax: '<color>'; inherits: false; initial-value: red }", []],
    ["a { animation: spin 1s }", []],
  ])("%s", (css, want) => expect(codes(css)).toEqual(want));

  it("suggests the prefixed name", () => {
    const l = lintCss("@keyframes spin {} @property --glow {}", "acme", "t.css");
    expect(l.map((x) => x.suggest)).toEqual(["acme-spin", "--acme-glow"]);
  });

  it("in a theme css the daemon renames keyframes, counter styles and palettes, so only the names it keeps are reported", () => {
    const css = "@keyframes spin {} @counter-style dots { system: cyclic } @font-palette-values --warm { font-family: F } @property --glow {} @font-face { font-family: Inter }";
    expect(lintCss(css, "acme", "t.css", "dusk").map((x) => x.name)).toEqual(["--glow", "Inter"]);
    expect(lintCss(css, "acme", "t.css").map((x) => x.name)).toEqual(["spin", "dots", "--warm", "--glow", "Inter"]);
  });
});

describe("broken css", () => {
  it.each([
    ["a { color: red } /* open", "css-broken"],
    ["a { background: url(x.png }", "css-broken"],
  ])("%s", (css, code) => expect(codes(css)).toContain(code));

  it("keeps what it found before the break", () => {
    expect(codes('[data-testid=x] {} /* open')).toEqual(["selects-testid", "css-broken"]);
  });

  it("a comment or url( that never ends is placed on its line", () => {
    expect(lintCss("a {}\nb {}\n/* open", "acme", "t.css")).toEqual([{ level: "warning", code: "css-broken", file: "t.css", line: 3 }]);
  });

  it.each([
    ["an unclosed block", "a {}\nb {\n color: red", 2],
    ["a stray }", "a {}\nb {}\n}\nc {}", 3],
    ["groups nested too deep (no position: the last line)", "@media (x) {".repeat(40) + "\n" + "}".repeat(40) + "\n", 3],
  ])("in a theme css, %s is placed on its line", (_n, css, line) => {
    expect(lintCss(css, "acme", "t.css", "dusk")).toEqual([{ level: "warning", code: "css-broken", file: "t.css", line }]);
    expect(lintCss(css, "acme", "t.css")).toEqual([]); // top-level css is not scoped by the daemon
  });

  it("stray braces and unclosed blocks do not throw", () => {
    expect(() => lintCss("} } a { b { [data-part=x] {", "acme", "t.css")).not.toThrow();
  });
});

// A scanner that never throws and stays linear on hostile input (the daemon must not stall on a file an addon author or a third party ships).
describe("hostile input stays fast and quiet", () => {
  const MB = 512 * 1024;
  const fill = (unit: string) => unit.repeat(Math.floor(MB / unit.length));
  it.each([
    ["unclosed attribute selectors", fill("[")],
    ["unclosed data-part attribute", fill("[data-part=")],
    ["unclosed data-testid attribute", fill("[data-testid")],
    ["unclosed font-face blocks", fill("@font-face{")],
    ["unclosed keyframes", fill("@keyframes ")],
    ["deep open blocks", fill("{")],
    ["deep close blocks", fill("}")],
    ["unterminated strings", fill('a"')],
    ["mixed quotes", fill("\"'")],
    ["backslashes", fill("\\")],
    ["comment starts", fill("/*/")],
    ["many parts", fill('[data-part="x"]{}')],
    ["many keyframes", fill("@keyframes a{}")],
    ["many distinct unknown parts", Array.from({ length: 20_000 }, (_, k) => `[data-part="p${k}x"]{}`).join("").slice(0, MB)],
    ["many part patterns", fill('[data-part*="zzz"]{}')],
    ["long unknown part names", fill(`[data-part="${"a".repeat(200)}"]{}`)],
    ["many brace pairs and strays", fill("}{")],
  ])("%s", (_, css) => {
    const t = performance.now();
    expect(() => lintCss(css, "acme", "t.css")).not.toThrow();
    expect(performance.now() - t).toBeLessThan(2000);
  });

  it("random token soup never throws", () => {
    const toks = ["{", "}", ";", "[", "]", "\"", "'", "\\", "/*", "*/", "url(", ")", "@keyframes ", "@font-face", "@property ", "data-part=", "data-testid", " ", "\n", "a", "--x", ":not("];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 3000; n++) {
      const css = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => toks[Math.floor(rnd() * toks.length)]).join("");
      expect(() => lintCss(css, "acme", "t.css"), css).not.toThrow();
    }
  });
});

describe("lintAddon", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const manifest = (o: Partial<AddonManifest>): AddonManifest => ({ name: "acme", version: "1", description: "", capabilities: [], themes: [], views: [], commands: [], renderers: [], ...o });
  const root = (files: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), "lint-"));
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    return dir;
  };

  it("lints theme css and top-level css, each file once", () => {
    const r = root({ "a.css": '[data-testid="x"] {}', "b.css": "@property --glow {}" });
    const l = lintAddon(r, manifest({ css: "a.css", themes: [{ id: "x", name: "X", css: "a.css" }, { id: "y", name: "Y", css: "b.css" }] }));
    expect(l.map((x) => `${x.code}:${x.file ?? ""}`)).toEqual(["top-level-css:a.css", "selects-testid:a.css", "unprefixed-name:b.css"]);
  });

  it("top-level css next to themes asks to move it into themes[].css; alone it is fine", () => {
    const r = root({ "a.css": "a {}" });
    expect(lintAddon(r, manifest({ css: "a.css", themes: [{ id: "x", name: "X" }] })).map((x) => x.code)).toEqual(["top-level-css"]);
    expect(lintAddon(r, manifest({ css: "a.css" }))).toEqual([]);
    expect(lintAddon(r, manifest({ themes: [{ id: "x", name: "X", css: "a.css" }] }))).toEqual([]);
  });

  it("a file over the scan cap is reported without being read", () => {
    const r = root({ "big.css": "a{}".repeat(200_000) });
    expect(lintAddon(r, manifest({ themes: [{ id: "x", name: "X", css: "big.css" }] })).map((x) => x.code)).toEqual(["css-too-large"]);
  });

  it("a file over 256 KB gets a size warning next to the other findings", () => {
    const r = root({ "big.css": '[data-testid="x"] {}' + " ".repeat(300_000) });
    expect(lintAddon(r, manifest({ themes: [{ id: "x", name: "X", css: "big.css" }] })).map((x) => x.code)).toEqual(["css-large", "selects-testid"]);
  });

  it("an edit that keeps size and mtime is linted again", () => {
    const r = root({ "t.css": '[data-part="tab"] {}' });
    const m = manifest({ themes: [{ id: "x", name: "X", css: "t.css" }] });
    expect(lintAddon(r, m)).toEqual([]);
    const { mtime } = statSync(join(r, "t.css"));
    writeFileSync(join(r, "t.css"), '[data-part="tax"] {}');
    utimesSync(join(r, "t.css"), mtime, mtime);
    expect(lintAddon(r, m).map((x) => x.code)).toEqual(["unknown-part"]);
  });

  describe("palette contrast", () => {
    const pal = (o: Record<string, string> = {}) => ({ bg: "#ffffff", card: "#ffffff", fg: "#111111", muted: "#555555", pfg: "#ffffff", primary: "#0044aa", err: "#aa0000", ok: "#006600", warn: "#8a4b00", ...o });
    const check = (light?: Record<string, string>, dark?: Record<string, string>) => lintAddon(root({}), manifest({ themes: [{ id: "dusk", name: "D", ...(light && { light }), ...(dark && { dark }) }] })).map((x) => `${x.code}:${x.name}`);

    it("a palette with enough contrast has no finding; a mode that is absent is not checked", () => {
      expect(check(pal())).toEqual([]);
    });

    it("names each text pair under 4.5:1 with its ratio and mode", () => {
      expect(check(undefined, pal({ bg: "#222222", card: "#222222", fg: "#777777", muted: "#2a2a2a" }))).toEqual(["low-contrast:dusk: fg on bg 3.5:1 (dark)", "low-contrast:dusk: muted on bg 1.1:1 (dark)", "low-contrast:dusk: fg on card 3.5:1 (dark)", "low-contrast:dusk: err on bg 2.0:1 (dark)", "low-contrast:dusk: ok on bg 2.1:1 (dark)", "low-contrast:dusk: warn on bg 2.3:1 (dark)"]);
    });

    it("checks the button and status pairs; border is not checked", () => {
      expect(check(pal({ pfg: "#cccccc", primary: "#dddddd", err: "#ff9999", border: "#ffffff" }))).toEqual(["low-contrast:dusk: pfg on primary 1.1:1 (light)", "low-contrast:dusk: err on bg 2.0:1 (light)"]);
    });

    it("a ratio just under 4.5 reads 4.4, never 4.5", () => {
      const f = check(pal({ fg: "#767676", muted: "#767676" })); // #767676 on white is 4.54, #777777 is 4.48
      expect(f).toEqual([]);
      expect(check(pal({ fg: "#777777" }))[0]).toBe("low-contrast:dusk: fg on bg 4.4:1 (light)");
    });
  });

  // The daemon serves a theme css that does not scan unscoped (its rules then apply under every theme): the lint must say so.
  it.each([
    ["an unclosed block", "a { color: red"],
    ["a stray }", "a { color: red } }"],
    ["groups nested too deep", "@media (x) {".repeat(40) + "a{}" + "}".repeat(40)],
    ["an unclosed comment", "a {} /* open"],
  ])("a theme css with %s is css-broken (once)", (_, css) => {
    const r = root({ "t.css": css });
    expect(lintAddon(r, manifest({ themes: [{ id: "x", name: "X", css: "t.css" }] })).map((x) => x.code)).toEqual(["css-broken"]);
  });

  it("top-level css is not scoped by the daemon, so only the scan-level breaks are reported for it", () => {
    const r = root({ "t.css": "a { color: red" });
    expect(lintAddon(r, manifest({ css: "t.css" }))).toEqual([]);
  });

  it("the same file is judged by its role: moving broken css from top-level to a theme (no edit) adds css-broken", () => {
    const r = root({ "t.css": "a { color: red" });
    expect(lintAddon(r, manifest({ css: "t.css" }))).toEqual([]);
    expect(lintAddon(r, manifest({ themes: [{ id: "x", name: "X", css: "t.css" }] })).map((x) => x.code)).toEqual(["css-broken"]);
  });

  it("a file that is not a regular file is skipped", () => {
    const r = root({});
    mkdirSync(join(r, "dir.css"));
    expect(lintAddon(r, manifest({ themes: [{ id: "x", name: "X", css: "dir.css" }] }))).toEqual([]);
  });

  it("a missing file is skipped, not an error", () => {
    const r = root({});
    expect(lintAddon(r, manifest({ themes: [{ id: "x", name: "X", css: "gone.css" }] }))).toEqual([]);
  });

  it("an addon without css has no findings", () => {
    expect(lintAddon(root({}), manifest({}))).toEqual([]);
  });
});
