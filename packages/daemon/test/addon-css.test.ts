import { describe, expect, it } from "vitest";
import { CssScanError, MAX_THEME_CSS, scopeCss, themeRoot } from "../src/addon-css.ts";

const ROOT = themeRoot("reze", "dusk");
const scope = (css: string) => scopeCss(css, ROOT);
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

  it("refuses a file over the size cap", () => {
    expect(() => scope(`.a { color: red }${" ".repeat(MAX_THEME_CSS)}`)).toThrow(CssScanError);
  });

  it("empty or comment-only CSS gives an empty scope, not a throw", () => {
    expect(flat(scope("/* nothing */"))).toBe(`${ROOT} { }`);
  });
});
