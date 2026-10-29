import type pierreLight from "@pierre/theme/pierre-light";
import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";
import { SURFACE, themeById, THEMES, tokensOf, type Mode, type ThemeId } from "./themes.ts";

/**
 * GH-394: the one code palette of the editor (`--syntax-*` in index.css, the CodeMirror HighlightStyle) and of every diff (a custom Shiki
 * theme registered with @pierre/diffs). It is pierre-light/dark with each colour that fails 4.5:1 moved in OKLCH lightness only (hue kept)
 * to the first value that reaches 4.5:1 on every background code sits on: the editor (card), its active line, the diff's context line and
 * its added and removed lines. Measured in development-docs/GH-394/plan-adjust.mjs; code-palette.test.ts keeps it honest.
 * Not covered, by decision: the diff's changed-word highlight (about 3.2-4.5:1 on it).
 */
export { SURFACE };

/** pierre foreground (lower case) -> adjusted foreground. Every colour of both pierre themes is a key; unchanged ones map to themselves. */
export const ADJUST: Record<Mode, Record<string, string>> = {
  light: {
    "#737373": "#6a6a6a", // comment
    "#636363": "#636363", // punctuation, parameter
    "#d32a61": "#cc215b", // keyword
    "#a631be": "#a631be", // type
    "#693acf": "#693acf", // function
    "#d47628": "#a65502", // variable
    "#d5901c": "#926006", // builtin
    "#199f43": "#057c30", // string
    "#1ca1c7": "#067491", // number
    "#d5a910": "#846701", // constant
    "#08c0ef": "#087492", // operator
    "#1a85d4": "#036eb4", // decorator
    "#d5512f": "#c03d19", // tag
    "#18a46c": "#047a4e", // attribute
    "#17a5af": "#07767e", // regexp
    "#16a994": "#047869", // escape
    "#0a0a0a": SURFACE.light.fg, // pierre's text colour is the app's foreground
  },
  dark: {
    "#737373": "#989898",
    "#636363": "#989898",
    "#a3a3a3": "#a3a3a3",
    "#ff678d": "#ff678d",
    "#d568ea": "#d86bed",
    "#9d6afb": "#a981fe",
    "#ffa359": "#ffa359",
    "#ffab16": "#ffab16",
    "#5ecc71": "#5ecc71",
    "#68cdf2": "#68cdf2",
    "#ffd452": "#ffd452",
    "#08c0ef": "#08c0ef",
    "#69b1ff": "#69b1ff",
    "#ff855e": "#ff855e",
    "#60d199": "#60d199",
    "#64d1db": "#64d1db",
    "#61d5c0": "#61d5c0",
    "#fafafa": SURFACE.dark.fg,
  },
};

/** `--syntax-<name>`: the pierre colour (per mode) it comes from; index.css holds `ADJUST[mode][source]`. */
export const SYNTAX_SOURCE = {
  comment: { light: "#737373", dark: "#737373" },
  punctuation: { light: "#636363", dark: "#636363" },
  parameter: { light: "#636363", dark: "#a3a3a3" },
  keyword: { light: "#d32a61", dark: "#ff678d" },
  type: { light: "#a631be", dark: "#d568ea" },
  function: { light: "#693acf", dark: "#9d6afb" },
  variable: { light: "#d47628", dark: "#ffa359" },
  builtin: { light: "#d5901c", dark: "#ffab16" },
  string: { light: "#199f43", dark: "#5ecc71" },
  number: { light: "#1ca1c7", dark: "#68cdf2" },
  constant: { light: "#d5a910", dark: "#ffd452" },
  operator: { light: "#08c0ef", dark: "#08c0ef" },
  decorator: { light: "#1a85d4", dark: "#69b1ff" },
  tag: { light: "#d5512f", dark: "#ff855e" },
  attribute: { light: "#18a46c", dark: "#60d199" },
  regexp: { light: "#17a5af", dark: "#64d1db" },
  escape: { light: "#16a994", dark: "#61d5c0" },
} as const;

export const DIFF_THEMES = { light: "claude-ui-light", dark: "claude-ui-dark" } as const;

const adjust = (mode: Mode, color: string) => ADJUST[mode][color.toLowerCase()] ?? color;
/** The pierre theme files (about 61 KB) are imported when the first diff asks for its theme, not at startup (`registerCustomTheme` takes a loader). */
const loadSource = (mode: Mode): Promise<Source> => (mode === "light" ? import("@pierre/theme/pierre-light") : import("@pierre/theme/pierre-dark")).then((m) => m.default as Source);
type Source = typeof pierreLight;

/** pierre with every foreground mapped through `map` (pierre colour -> theme colour); colours not in it stay. */
function recolor(name: string, displayName: string, mode: Mode, src: Source, map: Record<string, string>, colors: Record<string, string>): ThemeRegistration {
  const to = (color: string) => map[color.toLowerCase()] ?? color;
  return {
    name,
    displayName,
    type: mode,
    colors: { ...src.colors, ...colors },
    tokenColors: src.tokenColors.map((rule) => (rule.settings.foreground ? { ...rule, settings: { ...rule.settings, foreground: to(rule.settings.foreground) } } : { ...rule })),
    semanticTokenColors: Object.fromEntries(
      Object.entries(src.semanticTokenColors).map(([k, v]) => [k, typeof v === "string" ? to(v) : v.foreground ? { ...v, foreground: to(v.foreground) } : { ...v }]),
    ),
  } as ThemeRegistration;
}

/** Default: pierre with every foreground mapped through ADJUST and the editor background/foreground set to the app's card/foreground. */
export const adjustTheme = (mode: Mode, src: Source) =>
  recolor(DIFF_THEMES[mode], `Claude UI ${mode}`, mode, src, ADJUST[mode], { "editor.background": SURFACE[mode].bg, "editor.foreground": SURFACE[mode].fg });

/** Registered name of the diff theme for a colour theme and mode (Default's where the theme has no such mode). */
export const diffThemeName = (id: ThemeId, mode: Mode) => (themeById(id)?.[mode] ? `claude-ui-${id}-${mode}` : DIFF_THEMES[mode]);
export const diffThemes = (id: ThemeId) => ({ light: diffThemeName(id, "light"), dark: diffThemeName(id, "dark") });

/** A theme's diff theme: pierre with each pierre colour replaced by the theme's `--syntax-*` value it stands for (SYNTAX_SOURCE), the text colour by fg. */
export function paletteTheme(id: ThemeId, mode: Mode, src: Source): ThemeRegistration {
  const p = themeById(id)![mode]!;
  const tok = tokensOf(p, mode);
  const map: Record<string, string> = {};
  // Light pierre uses #636363 for punctuation and parameter; the first (punctuation) wins.
  for (const [name, source] of Object.entries(SYNTAX_SOURCE)) map[source[mode]] ??= tok[`--syntax-${name}`]!;
  map[(src.colors as Record<string, string>)["editor.foreground"]!.toLowerCase()] = p.fg;
  return recolor(diffThemeName(id, mode), `Claude UI ${id} ${mode}`, mode, src, map, {
    "editor.background": p.card,
    "editor.foreground": p.fg,
    "gitDecoration.addedResourceForeground": p.ok,
    "gitDecoration.deletedResourceForeground": p.err,
  });
}

let registered = false;
/** Register Default and every theme's diff themes with @pierre/diffs (main thread: the app has no diffs worker pool). Safe to call more than once. */
export function registerDiffThemes() {
  if (registered) return;
  registered = true;
  for (const mode of ["light", "dark"] as const) registerCustomTheme(DIFF_THEMES[mode], () => loadSource(mode).then((src) => adjustTheme(mode, src)));
  for (const t of THEMES)
    for (const mode of ["light", "dark"] as const) if (t[mode]) registerCustomTheme(diffThemeName(t.id, mode), () => loadSource(mode).then((src) => paletteTheme(t.id, mode, src)));
}
