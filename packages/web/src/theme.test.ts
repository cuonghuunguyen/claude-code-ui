import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AVATAR_COLORS } from "./tabs.ts";
import { THEMES, tokensOf, type Mode } from "./themes.ts";

// WCAG contrast of every text/background token pair in index.css, light and dark (4.5:1 text, 3:1 icons).
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

function tokens(selector: string) {
  const body = new RegExp(`^${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "m").exec(css)![1]!;
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6,8})\s*;/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

const rgba = (hex: string) => [1, 3, 5, 7].map((i) => (i < 7 || hex.length > 7 ? parseInt(hex.slice(i, i + 2), 16) / 255 : 1));
/** Alpha tokens (accent hover overlay) are composited onto the surface below. */
const over = (top: string, below: string) => {
  const [r, g, b, a] = rgba(top);
  const [r2, g2, b2] = rgba(below);
  return [r! * a! + r2! * (1 - a!), g! * a! + g2! * (1 - a!), b! * a! + b2! * (1 - a!)];
};
const luminance = (c: number[]) =>
  c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** The style rules of a stylesheet, in groups (`@layer`, `@media`, `@supports`, `@container`) too; comments dropped; other at-rules skipped. */
function styleRules(text: string): { selector: string; body: string }[] {
  const src = text.replace(/\/\*[^]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  const walk = (from: number, to: number) => {
    let start = from;
    for (let i = from; i < to; i++) {
      const c = src[i];
      if (c === ";") start = i + 1;
      else if (c === "{") {
        let depth = 1;
        let k = i + 1;
        while (k < to && depth > 0) (src[k] === "{" ? depth++ : src[k] === "}" && depth--, k++);
        const prelude = src.slice(start, i).trim();
        if (prelude.startsWith("@")) {
          if (/^@(layer|media|supports|container)\b/.test(prelude)) walk(i + 1, k - 1);
        } else out.push({ selector: prelude.replace(/\s+/g, " "), body: src.slice(i + 1, k - 1) });
        i = k - 1;
        start = k;
      }
    }
  };
  walk(0, src.length);
  return out;
}
const LIBRARY = /\.cm-|\.xterm/;
/** `selector: declaration` for each declaration of the rule without `!important`. */
const missingImportant = (r: { selector: string; body: string }) =>
  r.body
    .split(";")
    .map((d) => d.trim().replace(/\s+/g, " "))
    .filter((d) => d && !d.includes("!important"))
    .map((d) => `${r.selector}: ${d}`);

const SURFACES = ["background", "card", "popover", "muted", "secondary"];
const SYNTAX = ["comment", "punctuation", "parameter", "keyword", "type", "function", "variable", "builtin", "string", "number", "constant", "operator", "decorator", "tag", "attribute", "regexp", "escape", "critical"];
const TEXT = ["foreground", "muted-foreground", "destructive", "success", "warning", "info"];

// Default (index.css) plus every theme x mode: the theme's tokens over Default's (context, graph, avatar and elevation stay Default).
const PAIRS = [
  { name: "default light", mode: "light" as Mode, t: tokens(":root") },
  { name: "default dark", mode: "dark" as Mode, t: tokens(".dark") },
  ...THEMES.flatMap((th) =>
    (["light", "dark"] as const).flatMap((mode) => {
      const p = th[mode];
      if (!p) return [];
      const own = Object.fromEntries(Object.entries(tokensOf(p, mode)).map(([k, v]) => [k.slice(2), v]));
      return [{ name: `${th.id} ${mode}`, mode, t: { ...tokens(mode === "light" ? ":root" : ".dark"), ...own } }];
    }),
  ),
];

it("covers Default and every theme in both modes (Dracula: dark only)", () => expect(PAIRS).toHaveLength(2 + 6 * 2 + 1));

for (const { name, mode, t } of PAIRS) {
  describe(`theme ${name}`, () => {
    const solid = (name: string) => {
      expect(t[name], `--${name}`).toBeDefined();
      return over(t[name]!, t.card!);
    };

    it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))("%s on %s reaches 4.5:1", (fg, bg) => {
      expect(contrast(solid(fg), over(t[bg]!, t.card!))).toBeGreaterThanOrEqual(4.5);
    });

    it.each([
      ["primary-foreground", "primary"],
      ["secondary-foreground", "secondary"],
      ["card-foreground", "card"],
      ["popover-foreground", "popover"],
    ])("%s on %s reaches 4.5:1", (fg, bg) => expect(contrast(solid(fg), solid(bg))).toBeGreaterThanOrEqual(4.5));

    it("text on a hovered row (accent over card or background) reaches 4.5:1", () => {
      for (const bg of ["card", "background"])
        for (const fg of ["accent-foreground", "muted-foreground"]) expect(contrast(solid(fg), over(t.accent!, t[bg]!))).toBeGreaterThanOrEqual(4.5);
    });

    it("keybind chip muted text reaches 4.5:1", () => {
      expect(contrast(solid("muted-foreground"), solid("kbd"))).toBeGreaterThanOrEqual(4.5);
    });

    it("send button: its fill reaches 3:1 against the prompt box (card), its icon 4.5:1 on it", () => {
      expect(contrast(solid("send"), solid("card"))).toBeGreaterThanOrEqual(3);
      expect(contrast(solid("primary-foreground"), solid("send"))).toBeGreaterThanOrEqual(4.5);
    });

    it("editor autocomplete selected row: --secondary background with a --foreground left bar; the bar reaches 3:1 against the popup and the row, the text 4.5:1", () => {
      for (const bg of ["popover", "secondary"]) expect(contrast(solid("foreground"), solid(bg)), bg).toBeGreaterThanOrEqual(3);
      expect(contrast(solid("secondary-foreground"), solid("secondary"))).toBeGreaterThanOrEqual(4.5);
    });

    it("faint icons reach 3:1 on every surface", () => {
      for (const bg of SURFACES) expect(contrast(solid("faint"), solid(bg))).toBeGreaterThanOrEqual(3);
    });

    it("context ring progress reaches 3:1 on every surface and on its track", () => {
      for (const bg of [...SURFACES, "ring-track"]) expect(contrast(solid("ring-progress"), solid(bg)), bg).toBeGreaterThanOrEqual(3);
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])("graph lane color %i reaches 3:1 against card, background, secondary and a hovered row", (i) => {
      for (const bg of [t.card!, t.background!, t.secondary!, over(t.accent!, t.card!)]) expect(contrast(solid(`graph-${i}`), typeof bg === "string" ? over(bg, t.card!) : bg)).toBeGreaterThanOrEqual(3);
    });

    it.each(["local", "remote", "head"])("graph ref chip %s: text on its 18%% tint over card, background, secondary and a hovered row reaches 4.5:1", (name) => {
      const fg = solid(`ref-${name}`);
      const tint = (surface: number[]) => fg.map((v, i) => v * 0.18 + surface[i]! * 0.82);
      for (const bg of [solid("card"), over(t.background!, t.card!), solid("secondary"), over(t.accent!, t.card!), over(t.accent!, t.background!)]) expect(contrast(fg, tint(bg))).toBeGreaterThanOrEqual(4.5);
    });

    it.each([1, 2, 3, 4, 5, 6])("context category %i reaches 3:1 on the popover and on the breakdown bar track", (i) => {
      for (const bg of ["popover", "secondary"]) expect(contrast(solid(`context-${i}`), solid(bg)), bg).toBeGreaterThanOrEqual(3);
    });

    it.each(SYNTAX)("syntax %s reaches 4.5:1 in the editor (card) and on its active line (accent over card)", (name) => {
      expect(contrast(solid(`syntax-${name}`), solid("card"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(solid(`syntax-${name}`), over(t.accent!, t.card!))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(AVATAR_COLORS)("avatar %s letter reaches 4.5:1", (c) => {
      expect(contrast(solid(`avatar-${c}-fg`), solid(`avatar-${c}`))).toBeGreaterThanOrEqual(4.5);
    });

    it("focus ring reaches 3:1 against background and card/popover surfaces (WCAG 1.4.11)", () => {
      for (const bg of ["background", "card", "popover"]) {
        expect(contrast(solid("ring"), solid(bg)), `ring on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  });
}

// Cascade contract (GH-868): addon CSS lives in later layers (`addon.<name>`); an unlayered host rule would beat every addon rule, so no host rule may stay outside a layer.
describe("index.css cascade layers", () => {
  /** Top-level statements: at-rule name + prelude, or "rule" for a style rule; comments and block bodies skipped. */
  const noComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const topLevel = (() => {
    const src = css;
    const out: { kind: string; prelude: string }[] = [];
    let depth = 0;
    let start = 0;
    let quote = "";
    for (let i = 0; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
      } else if (c === "/" && src[i + 1] === "*") {
        i = src.indexOf("*/", i + 2) + 1;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") {
        if (depth++ === 0) {
          const prelude = noComments(src.slice(start, i));
          out.push({ kind: prelude.startsWith("@") ? /^@[\w-]+/.exec(prelude)![0] : "rule", prelude });
        }
      } else if (c === "}") {
        if (--depth === 0) start = i + 1;
      } else if (c === ";" && depth === 0) {
        const prelude = noComments(src.slice(start, i));
        out.push({ kind: /^@[\w-]+/.exec(prelude)![0], prelude });
        start = i + 1;
      }
    }
    return out;
  })();

  it("declares the layer order first, host after utilities and addon last", () => {
    expect(topLevel[0]!.prelude).toBe("@layer theme, base, components, utilities, host, addon");
  });

  it("keeps no host rule outside a layer", () => {
    const loose = topLevel.filter((s) => !["@layer", "@import", "@source", "@custom-variant", "@theme", "@property"].includes(s.kind));
    expect(loose.map((s) => s.prelude.slice(0, 60))).toEqual([]);
    const blocks = topLevel.filter((s) => s.kind === "@layer" && !s.prelude.includes(","));
    expect([...new Set(blocks.map((s) => s.prelude))].sort()).toEqual(["@layer base", "@layer host"]);
  });

  it("pauses every animation while the page is hidden with !important in the host layer", () => {
    expect(css).toMatch(/@layer host \{\n[^]*?:root\[data-page-hidden\] \*, :root\[data-page-hidden\] \*::before, :root\[data-page-hidden\] \*::after \{ animation-play-state: paused !important; \}/);
  });

  it("a host rule on CodeMirror (.cm-*) or xterm (.xterm*) is !important: their styles are unlayered and beat every layer", () => {
    const rules = styleRules(css).filter((r) => LIBRARY.test(r.selector));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.flatMap(missingImportant)).toEqual([]);
  });

  it("the guard sees multi-line rules, rules inside @media and @layer, and .xterm rules", () => {
    const sample = `@layer host {
      .cm-a,
      .cm-b {
        color: red;
        background: blue !important;
      }
      @media (width > 1px) { .x .xterm-rows { color: red } .ok .cm-c { color: red !important } }
      /* .cm-d { color: red } */
      .plain { color: red }
    }`;
    expect(styleRules(sample).filter((r) => LIBRARY.test(r.selector)).flatMap(missingImportant)).toEqual([".cm-a, .cm-b: color: red", ".x .xterm-rows: color: red"]);
  });
});
