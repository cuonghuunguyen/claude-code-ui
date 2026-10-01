import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AVATAR_COLORS } from "./tabs.ts";

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

const SURFACES = ["background", "card", "popover", "muted", "secondary"];
const TEXT = ["foreground", "muted-foreground", "destructive", "success", "warning", "info"];

for (const theme of [":root", ".dark"]) {
  describe(`theme ${theme}`, () => {
    const t = tokens(theme);
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

    it("keybind chip: OpenCode bg-layer-03 (#eeeeee light, #3a3a3a dark); its muted text reaches 4.5:1", () => {
      expect(t.kbd).toBe(theme === ":root" ? "#eeeeee" : "#3a3a3a");
      expect(contrast(solid("muted-foreground"), solid("kbd"))).toBeGreaterThanOrEqual(4.5);
    });

    it("faint icons reach 3:1 on every surface", () => {
      for (const bg of SURFACES) expect(contrast(solid("faint"), solid(bg))).toBeGreaterThanOrEqual(3);
    });

    it("context ring progress reaches 3:1 on every surface and on its track", () => {
      for (const bg of [...SURFACES, "ring-track"]) expect(contrast(solid("ring-progress"), solid(bg)), bg).toBeGreaterThanOrEqual(3);
    });

    it.each([1, 2, 3, 4, 5, 6])("context category %i reaches 3:1 on the popover and on the breakdown bar track", (i) => {
      for (const bg of ["popover", "secondary"]) expect(contrast(solid(`context-${i}`), solid(bg)), bg).toBeGreaterThanOrEqual(3);
    });

    it.each(AVATAR_COLORS)("avatar %s letter reaches 4.5:1", (c) => {
      expect(contrast(solid(`avatar-${c}-fg`), solid(`avatar-${c}`))).toBeGreaterThanOrEqual(4.5);
    });
  });
}
