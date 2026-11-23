import { describe, expect, it } from "vitest";
import { CssScanError, MAX_THEME_CSS, scopeCss, themeNames, themeRoot } from "../src/addon-css.ts";

const ROOT = themeRoot("reze", "dusk");
const scope = (css: string) => scopeCss(css, ROOT);
const PFX = themeNames("reze", "dusk");
const scopeN = (css: string) => flat(scopeCss(css, ROOT, PFX));
/** The text with whitespace folded, to compare rules. */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

describe("scopeCss", () => {
  it("wraps every rule under the theme root, so no rule applies to another theme", () => {
    expect(flat(scope(".a { color: red } .b { color: blue }"))).toBe(`${ROOT} { .a { color: red } .b { color: blue } }`);
  });

  it.each([
    [":root { --background: #000 }", "& { --background: #000 }"],
    ["html { --x: 1 }", "& { --x: 1 }"],
    [".dark { --background: #000 }", "&.dark { --background: #000 }"],
    [":root.dark { --x: 1 }", "&.dark { --x: 1 }"],
    [':root[data-theme="addon:reze:dusk"] .card { --x: 1 }', '&[data-theme="addon:reze:dusk"] .card { --x: 1 }'],
    ["html body .a { --x: 1 }", "& body .a { --x: 1 }"],
    [".dark .a, :root:not(.dark) .b { --x: 1 }", "&.dark .a, &:not(.dark) .b { --x: 1 }"],
    [':where(:root[data-theme="addon:reze:dusk"].dark) { --x: 1 }', ':where(&[data-theme="addon:reze:dusk"].dark) { --x: 1 }'],
    [":is(:root, .dark) .a { --x: 1 }", ":is(&, &.dark) .a { --x: 1 }"],
    [":where(.a, :root) { --x: 1 }", ":where(.a, :root) { --x: 1 }"],
    [".a, .b, .c, .d, :where(:root) { --x: 1 }", ".a, .b, .c, .d, :where(&) { --x: 1 }"],
    [".a, .b, .c, .d, :is(:root, .dark) .x { --x: 1 }", ".a, .b, .c, .d, :is(&, &.dark) .x { --x: 1 }"],
    [".Dark .a { --x: 1 }", ".Dark .a { --x: 1 }"],
    [".html-like { --x: 1 }", ".html-like { --x: 1 }"],
  ])("a token rule on the root element keeps matching it: %s", (css, rule) => {
    expect(flat(scope(css))).toBe(`${ROOT} { ${rule} }`);
  });

  it("keeps a comma inside :is() and a string in one selector", () => {
    expect(flat(scope(':is(.a, :root) [title="x,y"] { --x: 1 }'))).toBe(`${ROOT} { :is(.a, :root) [title="x,y"] { --x: 1 } }`);
  });

  it("hoists @font-face, @keyframes, @property and @layer statements out of the scope; drops @charset and @import", () => {
    const out = flat(
      scope(
        '@charset "utf-8"; @import url("x.css"); @layer a, b; @font-face { font-family: F; src: url(f.woff2) } @keyframes spin { from { opacity: 0 } to { opacity: 1 } } @property --p { syntax: "<color>"; inherits: false; initial-value: red } .a { animation: spin 1s }',
      ),
    );
    expect(out).toBe(
      `@layer a, b; @font-face { font-family: F; src: url(f.woff2) } @keyframes spin { from { opacity: 0 } to { opacity: 1 } } @property --p { syntax: "<color>"; inherits: false; initial-value: red } ${ROOT} { .a { animation: spin 1s } }`,
    );
  });

  it("scopes the rules inside @media and @supports, and hoists a @keyframes inside them", () => {
    const out = flat(scope("@media (width < 48rem) { :root { --x: 1 } .a { color: red } @keyframes k { to { opacity: 1 } } } @supports (display: grid) { .g { display: grid } }"));
    expect(out).toBe(`@keyframes k { to { opacity: 1 } } ${ROOT} { @media (width < 48rem) { & { --x: 1 } .a { color: red } } @supports (display: grid) { .g { display: grid } } }`);
  });

  it("a brace, semicolon or comment marker inside a string, comment or url() does not end the rule", () => {
    const css = '/* } { ; */ .a::before { content: "}{;/*" } .b { background: url(data:image/svg+xml;utf8,<svg>{x}</svg>) } /* .c { x: y } */ .d { color: red }';
    expect(flat(scope(css))).toBe(`${ROOT} { .a::before { content: "}{;/*" } .b { background: url(data:image/svg+xml;utf8,<svg>{x}</svg>) } .d { color: red } }`);
  });

  it("leaves the nested rules an author wrote inside a rule as they are", () => {
    expect(flat(scope(".a { color: red; &:hover { color: blue } :root & { x: y } }"))).toBe(`${ROOT} { .a { color: red; &:hover { color: blue } :root & { x: y } } }`);
  });

  it.each([
    ["an unclosed block", ".a { color: red"],
    ["a stray }", ".a { color: red } }"],
    ["an unterminated comment", ".a { color: red } /* x"],
    ["an unclosed url()", ".a { background: url(x.png }"],
  ])("throws CssScanError for %s (the caller serves the file unscoped)", (_n, css) => {
    expect(() => scope(css)).toThrow(CssScanError);
  });

  it("refuses groups nested far deeper than real CSS, quickly", () => {
    const t = Date.now();
    expect(() => scope("@media all{".repeat(40_000) + "}".repeat(40_000))).toThrow(CssScanError);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("deeply wrapped :where() selectors do not stall the scan", () => {
    const t = Date.now();
    const rule = `${":where(".repeat(6000)}:root${")".repeat(6000)}{}`;
    scope(rule.repeat(10));
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("refuses a file over the size cap", () => {
    expect(() => scope(`.a { color: red }${" ".repeat(MAX_THEME_CSS)}`)).toThrow(CssScanError);
  });

  it("empty or comment-only CSS gives an empty scope, not a throw", () => {
    expect(flat(scope("/* nothing */"))).toBe(`${ROOT} { }`);
  });

  it.each([
    ["*", "&, & *"],
    ["* > .a", "& > .a, & * > .a"],
    ["*::before", "&::before, & *::before"],
    [".a, *", ".a, &, & *"],
    ["*.a", "&.a, & *.a"],
    [".a *", ".a *"],
    ["& *", "& *"],
  ])("a selector that starts with * also matches the root element itself: %s", (sel, want) => {
    expect(flat(scope(`${sel} { --x: 1 }`))).toBe(`${ROOT} { ${want} { --x: 1 } }`);
  });
});

describe("scopeCss names", () => {
  it("renames @keyframes (and -webkit-) per theme and rewrites animation / animation-name references", () => {
    const out = scopeN("@keyframes spin { to { opacity: 0 } } @-webkit-keyframes spin { to { opacity: 0 } } .a { animation: spin 1s linear infinite; animation-name: spin, other } .b { animation: spinner 1s } .c { content: 'spin'; background: url(spin.png) }");
    expect(out).toContain("@keyframes reze-dusk--spin {");
    expect(out).toContain("@-webkit-keyframes reze-dusk--spin {");
    expect(out).toContain(".a { animation: reze-dusk--spin 1s linear infinite; animation-name: reze-dusk--spin, other }");
    expect(out).toContain(".b { animation: spinner 1s }");
    expect(out).toContain(".c { content: 'spin'; background: url(spin.png) }");
  });

  it("renames a @keyframes inside @media and the reference inside a nested rule or another group", () => {
    const out = scopeN("@media (width > 1px) { @keyframes k { to { opacity: 1 } } } .a { &:hover { animation: k 1s } } @supports (a: b) { .b { animation-name: k } }");
    expect(out).toContain("@keyframes reze-dusk--k {");
    expect(out).toContain("&:hover { animation: reze-dusk--k 1s }");
    expect(out).toContain(".b { animation-name: reze-dusk--k }");
  });

  it("a reference before the definition, a var() of the same name and a custom property are left right", () => {
    const out = scopeN(".a { animation: k 1s; --k: k; color: var(--k) } @keyframes k { to { opacity: 1 } }");
    expect(out).toContain(".a { animation: reze-dusk--k 1s; --k: k; color: var(--k) }");
  });

  it("renames @counter-style and @font-palette-values and rewrites list-style / font-palette", () => {
    const out = scopeN("@counter-style dots { system: cyclic; symbols: '*' } @counter-style more { system: extends dots; fallback: dots } @font-palette-values --warm { font-family: F; base-palette: 1 } li { list-style: dots inside; list-style-type: more } .t { font-palette: --warm; font-family: F }");
    expect(out).toContain("@counter-style reze-dusk--dots {");
    expect(out).toContain("@counter-style reze-dusk--more { system: extends reze-dusk--dots; fallback: reze-dusk--dots }");
    expect(out).toContain("@font-palette-values --reze-dusk--warm {");
    expect(out).toContain("li { list-style: reze-dusk--dots inside; list-style-type: reze-dusk--more }");
    expect(out).toContain(".t { font-palette: --reze-dusk--warm; font-family: F }");
  });

  it("keeps @font-face and @property global and names unchanged without a prefix", () => {
    const css = "@font-face { font-family: F; src: url(f.woff2) } @property --p { syntax: '*'; inherits: false } @keyframes spin { to { opacity: 0 } } .a { animation: spin 1s }";
    expect(scopeN(css)).toContain("@font-face { font-family: F; src: url(f.woff2) } @property --p { syntax: '*'; inherits: false }");
    expect(flat(scope(css))).toContain("@keyframes spin {");
  });

  it("many names and references stay linear", () => {
    const t = Date.now();
    const css = Array.from({ length: 3000 }, (_, i) => `@keyframes k${i} { to { opacity: 1 } } .a${i} { animation: k${i} 1s; list-style: none }`).join("\n");
    scopeCss(css, ROOT, PFX);
    expect(Date.now() - t).toBeLessThan(1500);
  });
});

describe("scopeCss names of a base theme", () => {
  const base = ["@keyframes spin { to { opacity: 0 } } @counter-style dots { system: cyclic; symbols: '*' } @font-palette-values --warm { font-family: F }"];
  it("an extending theme's own css reaches the names its base css defines (renamed under the extending theme)", () => {
    const out = scopeCss(".x { animation: spin 1s; list-style: dots; font-palette: --warm; animation-name: other } @keyframes own { to { opacity: 1 } } .y { animation: own 1s }", themeRoot("reze", "dusk"), themeNames("reze", "dusk"), base);
    expect(out).toContain(".x { animation: reze-dusk--spin 1s; list-style: reze-dusk--dots; font-palette: --reze-dusk--warm; animation-name: other }");
    expect(out).toContain("@keyframes reze-dusk--own {");
    expect(out).toContain(".y { animation: reze-dusk--own 1s }");
    expect(out).not.toContain("@keyframes reze-dusk--spin"); // defined by the base file only
  });
  it("a broken base file is ignored", () => {
    expect(scopeCss(".x { animation: spin 1s }", themeRoot("reze", "dusk"), themeNames("reze", "dusk"), ["@keyframes spin {"])).toContain("animation: spin 1s");
  });
});
