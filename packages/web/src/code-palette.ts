import pierreLight from "@pierre/theme/pierre-light";
import pierreDark from "@pierre/theme/pierre-dark";
import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";

/**
 * GH-394: the one code palette of the editor (`--syntax-*` in index.css, the CodeMirror HighlightStyle) and of every diff (a custom Shiki
 * theme registered with @pierre/diffs). It is pierre-light/dark with each colour that fails 4.5:1 moved in OKLCH lightness only (hue kept)
 * to the first value that reaches 4.5:1 on every background code sits on: the editor (card), its active line, the diff's context line and
 * its added and removed lines. Measured in development-docs/GH-394/plan-adjust.mjs; code-palette.test.ts keeps it honest.
 * Not covered, by decision: the diff's changed-word highlight (about 3.2-4.5:1 on it).
 */
type Mode = "light" | "dark";

/** The app's `--card` and `--foreground` (index.css): the diff sits on the same surface as the editor. */
export const SURFACE = { light: { bg: "#ffffff", fg: "#161616" }, dark: { bg: "#161616", fg: "#fafafa" } } as const;

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
const sources = { light: pierreLight, dark: pierreDark } as const;

/** pierre with every foreground mapped through ADJUST and the editor background/foreground set to the app's card/foreground. */
export function adjustedTheme(mode: Mode): ThemeRegistration {
  const src = sources[mode];
  return {
    name: DIFF_THEMES[mode],
    displayName: `Claude UI ${mode}`,
    type: mode,
    colors: { ...src.colors, "editor.background": SURFACE[mode].bg, "editor.foreground": SURFACE[mode].fg },
    tokenColors: src.tokenColors.map((rule) => (rule.settings.foreground ? { ...rule, settings: { ...rule.settings, foreground: adjust(mode, rule.settings.foreground) } } : { ...rule })),
    semanticTokenColors: Object.fromEntries(
      Object.entries(src.semanticTokenColors).map(([k, v]) => [k, typeof v === "string" ? adjust(mode, v) : v.foreground ? { ...v, foreground: adjust(mode, v.foreground) } : { ...v }]),
    ),
  } as ThemeRegistration;
}

let registered = false;
/** Register both themes with @pierre/diffs (main thread: the app has no diffs worker pool). Safe to call more than once. */
export function registerDiffThemes() {
  if (registered) return;
  registered = true;
  for (const mode of ["light", "dark"] as const) registerCustomTheme(DIFF_THEMES[mode], () => Promise.resolve(adjustedTheme(mode)));
}
