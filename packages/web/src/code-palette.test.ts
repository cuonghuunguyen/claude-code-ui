import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pierreLight from "@pierre/theme/pierre-light";
import pierreDark from "@pierre/theme/pierre-dark";
import { ADJUST, adjustTheme, DIFF_THEMES, diffThemes, paletteTheme, registerDiffThemes, SYNTAX_SOURCE } from "./code-palette.ts";
import { THEMES, tokensOf } from "./themes.ts";

// GH-394: one palette for the editor and every diff. Every colour must reach 4.5:1 on every background code sits on.
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");
const block = (selector: string) => new RegExp(`^${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "m").exec(css)![1]!;
const cssVar = (selector: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6,8})\\s*;`, "i").exec(block(selector))![1]!.toLowerCase();

// sRGB <-> CIE Lab (D50), what `color-mix(in lab, ...)` in @pierre/diffs' style.js computes.
const M = [[0.4123908, 0.3575843, 0.1804808], [0.212639, 0.7151687, 0.0721923], [0.0193308, 0.1191948, 0.9505322]];
const Mi = [[3.2409699, -1.5373832, -0.4986108], [-0.9692436, 1.8759675, 0.0415551], [0.0556301, -0.203977, 1.0569715]];
const A = [[1.0479298, 0.0229469, -0.0501923], [0.0296278, 0.9904344, -0.0170738], [-0.009243, 0.0150552, 0.7518743]];
const Ai = [[0.9554734, -0.0230985, 0.0632593], [-0.0283697, 1.0099955, 0.0210414], [0.012314, -0.0205077, 1.3303659]];
const WP = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const E = 216 / 24389;
const K = 24389 / 27;
const mul = (m: number[][], v: number[]) => m.map((r) => r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!);
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const hex = (c: number[]) => "#" + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const fromLab = ([L, a, b]: number[]) => {
  const f1 = (L + 16) / 116;
  const f0 = a! / 500 + f1;
  const f2 = f1 - b! / 200;
  const x = [f0 ** 3 > E ? f0 ** 3 : (116 * f0 - 16) / K, L > K * E ? f1 ** 3 : L / K, f2 ** 3 > E ? f2 ** 3 : (116 * f2 - 16) / K].map((v, i) => v * WP[i]!);
  return mul(Mi, mul(Ai, x)).map(gam);
};
/** color-mix(in lab, a pa%, b) */
const mixLab = (a: string, pa: number, b: string) => {
  const la = labOf(a);
  const lb = labOf(b);
  return hex(fromLab(la.map((v, i) => v * pa + lb[i]! * (1 - pa))));
};
const labOf = (h: string) => {
  const xyz = mul(A, mul(M, rgb(h).map(lin))).map((v, i) => v / WP[i]!);
  const f = xyz.map((v) => (v > E ? Math.cbrt(v) : (K * v + 16) / 116));
  return [116 * f[1]! - 16, 500 * (f[0]! - f[1]!), 200 * (f[1]! - f[2]!)];
};
/** rgb(from c r g b / alpha) over a surface */
const over = (fg: string, alpha: number, bg: string) => hex(rgb(fg).map((v, i) => v * alpha + rgb(bg)[i]! * (1 - alpha)));
const luminance = (h: string) => rgb(h).map(lin).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const themes = { light: pierreLight, dark: pierreDark };
const MODE = {
  light: { selector: ":root", addMix: 0.88, emph: 0.15, ctxMix: 0.985, mixer: "#000000" },
  dark: { selector: ".dark", addMix: 0.8, emph: 0.2, ctxMix: 0.925, mixer: "#ffffff" },
} as const;

/** The backgrounds code sits on: editor, its active line, diff context line, diff added and removed line (the changed-word highlight is a documented exception). */
function backgrounds(mode: "light" | "dark") {
  const m = MODE[mode];
  const card = cssVar(m.selector, "card");
  const accent = cssVar(m.selector, "accent");
  const colors = themes[mode].colors as Record<string, string>;
  return {
    card,
    active: over(accent.slice(0, 7), parseInt(accent.slice(7, 9), 16) / 255, card),
    context: mixLab(card, m.ctxMix, m.mixer),
    added: mixLab(card, m.addMix, colors["gitDecoration.addedResourceForeground"]!),
    removed: mixLab(card, m.addMix, colors["gitDecoration.deletedResourceForeground"]!),
  };
}

const foregrounds = (mode: "light" | "dark") =>
  new Set<string>([
    ...(themes[mode].tokenColors as { settings?: { foreground?: string } }[]).map((s) => s.settings?.foreground).filter((c): c is string => !!c).map((c) => c.toLowerCase()),
    ...Object.values(themes[mode].semanticTokenColors as Record<string, string | { foreground?: string }>).map((v) => (typeof v === "string" ? v : v.foreground)).filter((c): c is string => !!c && c.startsWith("#")).map((c) => c.toLowerCase()),
  ]);

describe.each(["light", "dark"] as const)("code palette (%s)", (mode) => {
  it("every pierre foreground has an adjusted value (the app foreground for pierre's text colour)", () => {
    for (const fg of foregrounds(mode)) expect(ADJUST[mode][fg], fg).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("every adjusted colour reaches 4.5:1 on the editor, its active line, and the diff's context, added and removed lines", () => {
    const bgs = backgrounds(mode);
    for (const [fg, adj] of Object.entries(ADJUST[mode]))
      for (const [name, bg] of Object.entries(bgs)) expect(contrast(adj, bg), `${fg} -> ${adj} on ${name} ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("a colour that already passed stays pierre's; only failing ones move", () => {
    const bgs = Object.values(backgrounds(mode));
    for (const [fg, adj] of Object.entries(ADJUST[mode])) {
      if (fg === themes[mode].colors["editor.foreground"]) continue;
      const passes = bgs.every((bg) => contrast(fg, bg) >= 4.5);
      expect(passes ? adj : "moved", fg).toBe(passes ? fg : "moved");
      if (!passes) expect(adj, fg).not.toBe(fg);
    }
  });

  it("adjustedTheme keeps every scope and fontStyle of pierre; only colours change; background and foreground are the app's card and foreground", () => {
    const adjusted = adjustTheme(mode, themes[mode]);
    const src = themes[mode];
    expect(adjusted.tokenColors).toHaveLength(src.tokenColors.length);
    src.tokenColors.forEach((rule, i) => {
      const got = adjusted.tokenColors![i]! as typeof rule;
      expect(got.scope).toEqual(rule.scope);
      expect(got.settings.fontStyle).toBe(rule.settings.fontStyle);
      if (rule.settings.foreground) expect(got.settings.foreground).toBe(ADJUST[mode][rule.settings.foreground.toLowerCase()]);
    });
    const colors = adjusted.colors as Record<string, string>;
    expect(colors["editor.background"]).toBe(cssVar(MODE[mode].selector, "card"));
    expect(colors["editor.foreground"]).toBe(cssVar(MODE[mode].selector, "foreground"));
    expect(colors["gitDecoration.addedResourceForeground"]).toBe((src.colors as Record<string, string>)["gitDecoration.addedResourceForeground"]);
    expect(adjusted.type).toBe(mode);
    expect(adjusted.name).toBe(DIFF_THEMES[mode]);
  });

  it("the --syntax-* values in index.css are the adjusted pierre colours", () => {
    for (const [name, source] of Object.entries(SYNTAX_SOURCE)) expect(cssVar(MODE[mode].selector, `syntax-${name}`), name).toBe(ADJUST[mode][source[mode]]);
  });
});

it("the dark diff sits on the app's card surface (#161616), not pierre's #0a0a0a", () => {
  expect((adjustTheme("dark", themes.dark).colors as Record<string, string>)["editor.background"]).toBe("#161616");
});

it("registerDiffThemes registers both themes with @pierre/diffs, once", async () => {
  const { resolveTheme } = await import("@pierre/diffs");
  registerDiffThemes();
  registerDiffThemes();
  for (const mode of ["light", "dark"] as const) {
    const t = await resolveTheme(DIFF_THEMES[mode] as never);
    expect(t.name).toBe(DIFF_THEMES[mode]);
    expect(t.bg).toBe(cssVar(MODE[mode].selector, "card"));
  }
});

// GH-468: one diff theme per colour theme and mode, built from the theme's own --syntax-* values.
// Known gap (accepted): light pierre uses #636363 for punctuation and parameter, a colour-keyed map cannot split them, so light-theme diffs show parameters in the muted colour (editor: foreground).
describe.each(THEMES.slice(1).flatMap((t) => (["light", "dark"] as const).filter((m) => t[m]).map((m) => [t.id, m] as const)))("diff theme %s %s", (id, mode) => {
  const p = THEMES.find((t) => t.id === id)![mode]!;
  const tok = tokensOf(p, mode);
  const built = paletteTheme(id, mode, themes[mode]);
  const colors = built.colors as Record<string, string>;

  it("sits on the theme's card and foreground; added and removed lines follow its ok and err", () => {
    expect(colors["editor.background"]).toBe(p.card);
    expect(colors["editor.foreground"]).toBe(p.fg);
    expect(colors["gitDecoration.addedResourceForeground"]).toBe(p.ok);
    expect(colors["gitDecoration.deletedResourceForeground"]).toBe(p.err);
    expect(built.type).toBe(mode);
    expect(built.name).toBe(`claude-ui-${id}-${mode}`);
  });

  it("every foreground is one of the theme's --syntax-* values or its foreground", () => {
    const allowed = new Set([...Object.entries(tok).filter(([k]) => k.startsWith("--syntax-")).map(([, v]) => v), p.fg]);
    const used = [
      ...built.tokenColors!.map((r) => (r as { settings?: { foreground?: string } }).settings?.foreground),
      ...Object.values(built.semanticTokenColors as Record<string, string | { foreground?: string }>).map((v) => (typeof v === "string" ? v : v.foreground)),
    ].filter((c): c is string => !!c && c.startsWith("#"));
    for (const c of used) expect(allowed.has(c.toLowerCase()), c).toBe(true);
  });

  it("every syntax colour reaches 4.5:1 on the editor, its active line, and the diff's context, added and removed lines", () => {
    const m = MODE[mode];
    const bgs = {
      card: p.card,
      active: over(tok["--accent"]!.slice(0, 7), parseInt(tok["--accent"]!.slice(7, 9), 16) / 255, p.card),
      context: mixLab(p.card, m.ctxMix, m.mixer),
      added: mixLab(p.card, m.addMix, p.ok),
      removed: mixLab(p.card, m.addMix, p.err),
    };
    for (const [name, v] of Object.entries(tok).filter(([k]) => k.startsWith("--syntax-")))
      for (const [bgName, bg] of Object.entries(bgs)) expect(contrast(v, bg), `${name} on ${bgName} ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});

it("diffThemes: Dracula's light is Default's light theme; others have their own", () => {
  expect(diffThemes("dracula")).toEqual({ light: DIFF_THEMES.light, dark: "claude-ui-dracula-dark" });
  expect(diffThemes("default")).toEqual(DIFF_THEMES);
  expect(diffThemes("catppuccin").dark).toBe("claude-ui-catppuccin-dark");
});

it("registerDiffThemes registers Default and every theme and mode (13 names)", async () => {
  const { resolveTheme } = await import("@pierre/diffs");
  registerDiffThemes();
  const names = new Set(THEMES.flatMap((t) => Object.values(diffThemes(t.id))));
  expect(names.size).toBe(13);
  for (const n of names) expect((await resolveTheme(n as never)).name).toBe(n);
});
