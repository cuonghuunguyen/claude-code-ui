/*
 * GH-468: colour themes. The values below are colour values only (no theme files copied) taken from these palettes; some were moved in
 * lightness (OKLCH, hue and chroma kept) to reach 4.5:1 contrast, the upstream value is in a comment. Licenses and copyright lines:
 * THIRD_PARTY_NOTICES.md, section "Colour palettes".
 *   Catppuccin (Latte / Mocha)        https://github.com/catppuccin/catppuccin           MIT         Copyright (c) 2021 Catppuccin
 *   Tokyo Night (Day / Night)         https://github.com/folke/tokyonight.nvim           Apache-2.0  Folke Lemaitre (values changed, see above)
 *   Solarized                         https://github.com/altercation/solarized           MIT         Copyright (c) 2011 Ethan Schoonover
 *   Nord                              https://github.com/nordtheme/nord                  MIT         Copyright (c) 2016-present Sven Greb (https://www.svengreb.de)
 *   Dracula                           https://github.com/dracula/dracula-theme          MIT         Copyright (c) 2023 Dracula Theme
 *   One Light / One Dark              https://github.com/atom/atom (one-{light,dark}-syntax)  MIT    Copyright (c) 2011-2022 GitHub Inc.
 */

import { ADDON_CONTEXT_SIZE, ADDON_GRAPH_SIZE, numberOk, varNameError, varValueError, type AddonInfo, type AddonPalette, type AddonThemeOption } from "@claude-ui/protocol";

export type Mode = "light" | "dark";
export const KEYS = ["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"] as const;
export type Key = (typeof KEYS)[number];
/** `x`: extra tokens (`--graph-*`, `--context-*`) moved in lightness from Default so they reach 3:1 on this palette's surfaces (Neon: its own hues, also 3:1). */
export type Palette = Record<Key, string> & { x?: Record<string, string> };
export type BuiltinThemeId = "default" | "catppuccin" | "tokyonight" | "solarized" | "nord" | "dracula" | "one" | "neon";
/** `addon:<addon name>:<theme id>` (GH-516): a theme an addon declares. */
export type ThemeId = BuiltinThemeId | `addon:${string}:${string}`;
export const ADDON_THEME_ID = /^addon:[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Default has no palette: it is the `:root` / `.dark` blocks of index.css. Dracula has no light. */
/** A control of a theme (boolean, select, range, color): `data-opt-<id>` and `--opt-<id>` on <html> while the theme is current (theme.ts); boolean `default` absent = on. The built-in Neon options are booleans. */
export type ThemeOption = AddonThemeOption;
/** `background` (addon themes): the image URLs of the modes whose file exists now (same-origin addon file URLs), shown as `<div data-part="backdrop">` (backdrop.tsx). The tokens it needs (`--backdrop-image`, `--backdrop-image-mobile`, `--backdrop-veil`, `--panel-alpha`) are in the mode's palette `x`. */
export type ThemeBackground = { light?: { image: string; mobile?: string }; dark?: { image: string; mobile?: string } };
export type Theme = { id: ThemeId; name: string; light?: Palette; dark?: Palette; options?: ThemeOption[]; background?: ThemeBackground };

/** The Default `--card` and `--foreground` (index.css): the editor, diff and terminal surface. */
export const SURFACE = { light: { bg: "#ffffff", fg: "#161616" }, dark: { bg: "#161616", fg: "#fafafa" } } as const;

/** Values in KEYS order. */
const P = (v: string[], x?: Record<string, string>) => ({ ...Object.fromEntries(KEYS.map((k, i) => [k, v[i]!])), ...(x && { x }) }) as Palette;

// Contrast pass: side (active tab surface), fg, muted, primary and some status/ref colours were moved again in lightness so the "palette contrast" rules (themes.test.ts) and theme.test.ts hold; the comments below predate that pass.
export const THEMES: readonly Theme[] = [
  { id: "default", name: "Default" },
  {
    id: "catppuccin",
    name: "Catppuccin",
    // upstream: kw #8839ef, str #40a02b, fn #1e66f5, type/warn #df8e1d, num #fe640b, cmt #7c7f93, varc #e64553, err #d20f39, ok #40a02b, info #1e66f5
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: muted #5c5f77 -> #555870, kw #812ee6 -> #6a05cf, str #007300 -> #007200, fn #0d57e5 -> #0a54e2, type #9b4f00 -> #984c00, num #bf2300 -> #bd2100, cmt #5f6275 -> #5d6073, varc #c21b36 -> #c01734, err #c70030 -> #c5002e, warn #9b4f00 -> #873b00, ok #007300 -> #006000, info #0d57e5 -> #0a54e2
    light: P(["#e6e9ef", "#eff1f5", "#dbdee6", "#45475f", "#53566c", "#ccd0da", "#8839ef", "#ffffff", "#6805cc", "#007200", "#0a54e2", "#984c00", "#bd2100", "#5d6073", "#bd1733", "#c2002d", "#853a00", "#005e00", "#0a54e2"], { "--context-4": "#ea3a00", "--context-6": "#008aa0" }),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: cmt #9399b2 -> #a2a8c1
    dark: P(["#181825", "#1e1e2e", "#2d2d3e", "#cdd6f4", "#a6adc8", "#313244", "#cba6f7", "#11111b", "#cba6f7", "#a6e3a1", "#89b4fa", "#f9e2af", "#fab387", "#a2a8c1", "#eba0ac", "#f38ba8", "#f9e2af", "#a6e3a1", "#89b4fa"]),
  },
  {
    id: "tokyonight",
    name: "Tokyo Night",
    // upstream light: fg #3760bf, muted #6172b0, primary/fn #2e7de9, kw #9854f1, str/ok #587539, type/info #007197, num #b15c00, cmt #848cb5, varc/err #f52a65, warn #8c6c3e; dark: cmt #565f89
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: muted #42518c -> #34437e, kw #7224c4 -> #5900ab, warn #6d4e1f -> #5c3d0e, ok #415c20 -> #304b0f
    light: P(["#d0d5e3", "#e1e2e7", "#c4c8da", "#183080", "#34437e", "#b4b5b9", "#2270d7", "#ffffff", "#5900ab", "#415c20", "#004eb6", "#005a7e", "#8d3b00", "#4b5277", "#ab002e", "#ab002e", "#5c3d0e", "#304b0f", "#005a7e"], { "--graph-2": "#a24ea9", "--graph-4": "#c84000", "--graph-5": "#876c00", "--graph-6": "#007993", "--context-2": "#a24ea9", "--context-4": "#d82300", "--context-5": "#876c00", "--context-6": "#007a90" }),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: kw #bb9af7 -> #bd9cf9, cmt #7882ae -> #959fcb, err #f7768e -> #f97890
    dark: P(["#16161e", "#1a1b26", "#272c3f", "#c0caf5", "#a9b1d6", "#292e42", "#7aa2f7", "#16161e", "#c1a2f9", "#9ece6a", "#7aa2f7", "#2ac3de", "#ff9e64", "#959fcb", "#e0af68", "#f97890", "#e0af68", "#9ece6a", "#7dcfff"]),
  },
  {
    id: "solarized",
    name: "Solarized",
    // upstream light: fg #586e75, muted #657b83, primary/fn/info #268bd2, kw/ok #859900, str #2aa198, type/warn #b58900, num #d33682, cmt #93a1a1, varc #6c71c4, err #dc322f
    // upstream dark: muted #839496, primary/fn/info #268bd2, kw/ok #859900, str #2aa198, type/warn #b58900, num #d33682, cmt #586e75, varc #6c71c4, err #dc322f
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: fg #556b72 -> #3a4f56, muted #576c74 -> #4b6068, kw #5e7000 -> #485a00, str #00756d -> #007169, fn #006cb1 -> #0067ac, type #8b6000 -> #875c00, num #c12173 -> #bd1b6f, cmt #5e6b6b -> #596666, varc #5b5fb0 -> #585cad, err #cc1d20 -> #c7131b, warn #8b6000 -> #744900, ok #5e7000 -> #485a00, info #006cb1 -> #0067ac
    light: P(["#eee8d5", "#fdf6e3", "#e4ddc9", "#354a51", "#44595f", "#ddd6c1", "#0071b5", "#fdf6e3", "#465800", "#007169", "#0067ac", "#875c00", "#bd1b6f", "#596666", "#585cad", "#c1131b", "#724800", "#465800", "#0065a9"], { "--context-6": "#008a9f", "--context-4": "#e44204" }),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: fg #93a1a1 -> #c2cdcd, muted #8a9c9e -> #9caeb0, kw #8ea219 -> #abbf3b, str #35a9a0 -> #48bcb3, fn #3f9fe8 -> #52b2fb, type #bf921a -> #d1a430, num #fc5ea5 -> #ff7fc6, cmt #859ca4 -> #98afb7, varc #8a91e7 -> #9da4fa, err #ff675c -> #ff887d, warn #bf921a -> #d9ac38, ok #8ea219 -> #abbf3b, info #3f9fe8 -> #52b2fb
    dark: P(["#00212b", "#002b36", "#073642", "#c2cdcd", "#9fb0b2", "#0e3f4c", "#3b99dc", "#002b36", "#b0c347", "#4dbeb5", "#57b4fb", "#d2a736", "#ff83c8", "#9bb1b9", "#a0a7fa", "#ff8c81", "#dcb24a", "#b0c347", "#57b4fb"]),
  },
  {
    id: "nord",
    name: "Nord",
    // upstream light: primary/kw/info #5e81ac, str/ok #a3be8c, fn #88c0d0, type #8fbcbb, num #b48ead, cmt #7b88a1, varc #d08770, err #bf616a, warn #ebcb8b
    // upstream dark: kw/info #81a1c1, num #b48ead, cmt #616e88, varc #d08770, err #bf616a
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: kw #42648d -> #31537c, str #51693b -> #4f6739, fn #326978 -> #306776, type #3e6968 -> #3c6766, num #795773 -> #775571, cmt #56627a -> #546078, varc #924f3a -> #914e39, err #9f454f -> #9d434d, warn #7a5d1b -> #694c09, ok #51693b -> #40582a, info #42648d -> #40628b
    light: P(["#e5e9f0", "#eceff4", "#d8dee9", "#2e3440", "#4c566a", "#d8dee9", "#52749e", "#ffffff", "#31537c", "#4f6739", "#306776", "#3c6766", "#775571", "#546078", "#914e39", "#9d434d", "#694c09", "#40582a", "#40628b"], { "--context-4": "#ec3900", "--context-6": "#008aa0" }),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: kw #90b1d1 -> #b8d9f9, str #a3be8c -> #b0cb99, fn #88c0d0 -> #93cbdb, type #8fbcbb -> #9ecbca, num #c9a2c2 -> #deb7d7, cmt #a1afcb -> #b5c3df, varc #e89d85 -> #fcb199, err #f6929a -> #ffacb4, warn #ebcb8b -> #f1d191, ok #a3be8c -> #c3deac, info #90b1d1 -> #a5c6e6
    dark: P(["#242933", "#2e3440", "#3b4252", "#eceff4", "#cdd3dd", "#3b4252", "#88c0d0", "#2e3440", "#b8d9f9", "#b0cb99", "#93cbdb", "#9ecbca", "#deb7d7", "#b5c3df", "#fcb199", "#ffacb4", "#f1d191", "#c3deac", "#a5c6e6"]),
  },
  {
    id: "dracula",
    name: "Dracula",
    // upstream: cmt #6272a4
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: kw #ff79c6 -> #ffaaf7, num #bd93f9 -> #d1a7ff, cmt #7f90c4 -> #a7b8ec, err #ff5555 -> #ff9e9e
    dark: P(["#21222c", "#282a36", "#333543", "#f8f8f2", "#bfc3d9", "#44475a", "#bd93f9", "#21222c", "#ffaaf7", "#f1fa8c", "#50fa7b", "#8be9fd", "#d1a7ff", "#a7b8ec", "#ffb86c", "#ff9e9e", "#ffb86c", "#50fa7b", "#8be9fd"]),
  },
  {
    id: "one",
    name: "One",
    // upstream light: primary/fn #4078f2, str/ok #50a14f, type/warn #c18401, num #986801, cmt #a0a1a7, varc/err #e45649, info #0184bc; dark: cmt #7f848e, varc/err #e06c75
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: muted #5c5e66 -> #595b63, kw #a626a4 -> #8e028c, str #227624 -> #217523, varc #bf3229 -> #be3128, err #bf3229 -> #be3128, warn #935800 -> #7e4300, ok #227624 -> #065f0d
    light: P(["#eaeaeb", "#fafafa", "#dfdfe0", "#383a42", "#53555d", "#dbdbdc", "#366be2", "#ffffff", "#8c028a", "#217523", "#295ed6", "#935800", "#8c5c00", "#65666b", "#be3128", "#b82f26", "#7c4200", "#065f0d", "#00689e"], { "--context-4": "#eb3e00", "--context-6": "#008aa0" }),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: fg #abb2bf -> #d7dae0, muted #9da5b4 -> #adb5c4, kw #c678dd -> #f2a4ff, fn #61afef -> #6dbbfb, num #d19a66 -> #e1aa76, cmt #8e939d -> #b0b5bf, varc #e36f78 -> #ff969f, err #e36f78 -> #ff969f, ok #98c379 -> #a2cd83, info #56b6c2 -> #62c2ce
    dark: P(["#21252b", "#282c34", "#323842", "#d7dae0", "#adb5c4", "#3e4451", "#61afef", "#21252b", "#f2adff", "#98c379", "#71bdfb", "#e5c07b", "#e1aa76", "#b0b5bf", "#ff99a2", "#ff99a2", "#e5c07b", "#abd18e", "#67c4cf"]),
  },
  {
    id: "neon",
    name: "Neon",
    options: [{ id: "rain", label: "Rain" }, { id: "rain-light", label: "Light rain", default: false }],
    // Cyberpunk HUD: navy-black / pale blue-white surfaces, electric cyan primary, hot magenta keywords, yellow / lime / purple accents.
    // Moved in lightness for contrast (ref chips, diff lines, text over the scene): light primary #007a8f -> #006577, kw #b8146f -> #9c0d5c, warn #7a5200 -> #6a4600, ok #2b6a00 -> #225a00;
    // dark kw #ff3ea5 -> #ff6ebc, cmt #7f95b8 -> #98aed1, err #ff4d7d -> #ff7898. `x`: graph lanes and context colours in the same hues (cyan, magenta, yellow, lime, purple).
    light: P(["#eef4fb", "#f8fbff", "#dde8f5", "#0a1a2f", "#3b5373", "#b9cde4", "#006577", "#ffffff", "#9c0d5c", "#3d6600", "#0058b0", "#7a5800", "#6a2fc0", "#52668a", "#a3420b", "#c2183f", "#6a4600", "#225a00", "#0058b0"], { "--graph-1": "#007a8f", "--graph-2": "#c2187a", "--graph-3": "#7a5800", "--graph-4": "#2b6a00", "--graph-5": "#6a2fc0", "--graph-6": "#b84a00", "--graph-7": "#c2183f", "--graph-8": "#0058b0", "--context-1": "#007a8f", "--context-2": "#c2187a", "--context-3": "#2b6a00", "--context-4": "#ea3a00", "--context-5": "#7a5800", "--context-6": "#6a2fc0" }),
    dark: P(["#05070d", "#0a0f1c", "#0e1526", "#e4f6ff", "#8fa9c8", "#1c2a44", "#00e5ff", "#05070d", "#ff6ebc", "#b6ff5c", "#5cc8ff", "#ffe34d", "#c38bff", "#98aed1", "#ff9e64", "#ff7898", "#ffe34d", "#a8ff3e", "#5cc8ff"], { "--graph-1": "#00e5ff", "--graph-2": "#ff3ea5", "--graph-3": "#ffe34d", "--graph-4": "#a8ff3e", "--graph-5": "#c38bff", "--graph-6": "#ff9e64", "--graph-7": "#ff4d7d", "--graph-8": "#5cc8ff", "--context-1": "#00e5ff", "--context-2": "#ff3ea5", "--context-3": "#a8ff3e", "--context-4": "#ff9e64", "--context-5": "#ffe34d", "--context-6": "#c38bff" }),
  },
];

export const themeById = (id: string, list: readonly Theme[] = THEMES) => list.find((t) => t.id === id);

/** Palette key -> the index.css tokens it sets (docs: issue "Token mapping"). */
const MAP: Record<Key, string[]> = {
  bg: ["background"],
  card: ["card", "popover"],
  side: ["secondary"],
  fg: ["foreground", "card-foreground", "popover-foreground", "secondary-foreground", "accent-foreground", "ring-progress", "syntax-parameter"],
  muted: ["muted-foreground", "syntax-punctuation"],
  border: ["ring-track", "tab-separator", "kbd"],
  primary: ["primary", "send", "ring"],
  pfg: ["primary-foreground"],
  kw: ["syntax-keyword", "ref-remote"],
  str: ["syntax-string", "syntax-regexp"],
  fn: ["syntax-function"],
  type: ["syntax-type", "syntax-attribute"],
  num: ["syntax-number", "syntax-constant"],
  cmt: ["syntax-comment"],
  varc: ["syntax-variable"],
  err: ["destructive", "syntax-tag", "syntax-critical"],
  warn: ["warning", "syntax-builtin", "ref-head"],
  ok: ["success", "ref-local"],
  info: ["info", "syntax-operator", "syntax-decorator", "syntax-escape"],
};

/** `a` at `pa` over `b`, per sRGB channel. */
const mix = (a: string, pa: number, b: string) =>
  "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * pa + parseInt(b.slice(i, i + 2), 16) * (1 - pa)).toString(16).padStart(2, "0")).join("");

/** The CSS custom properties (`--name` -> value) a palette sets in one mode. */
export function tokensOf(p: Palette, mode: Mode): Record<string, string> {
  const t: Record<string, string> = {};
  for (const k of KEYS) for (const name of MAP[k]) t[`--${name}`] = p[k];
  t["--muted"] = mode === "dark" ? p.side : p.bg;
  t["--faint"] = mix(p.muted, 0.75, p.card);
  t["--border"] = p.fg + "1f";
  t["--input"] = p.fg + "24";
  Object.assign(t, p.x);
  t["--accent"] = p.fg + (mode === "dark" ? "14" : "0f");
  return t;
}

/** One rule per palette and mode; Default and Dracula light have none (index.css `:root` applies). */
export function themeCss(list: readonly Theme[] = THEMES): string {
  const out: string[] = [];
  for (const t of list)
    for (const mode of ["light", "dark"] as const) {
      const p = t[mode];
      if (!p) continue;
      const body = Object.entries(tokensOf(p, mode)).map(([k, v]) => `${k}: ${v};`).join(" ");
      out.push(`:root[data-theme="${t.id}"]${mode === "dark" ? ".dark" : ":not(.dark)"} { ${body} }`);
    }
  return out.join("\n");
}

/** xterm theme. ANSI colors come from the palette; Default (and Dracula light) leave xterm's own ANSI colors. */
export function terminalTheme(id: ThemeId, mode: Mode): Record<string, string> {
  const p = themeById(id)?.[mode];
  const sel = mode === "dark" ? "40" : "33";
  if (!p) return { foreground: SURFACE[mode].fg, background: SURFACE[mode].bg, cursor: SURFACE[mode].fg, selectionBackground: SURFACE[mode].fg + sel };
  // black: the foreground on light themes; on dark themes the side surface (ANSI black is dark by definition, so it is not readable on the card there).
  // brightBlack is grey text: the comment colour.
  const ansi = { black: mode === "light" ? p.fg : p.side, red: p.err, green: p.ok, yellow: p.warn, blue: p.fn, magenta: p.kw, cyan: p.info, white: p.muted };
  const bright = Object.fromEntries(Object.entries(ansi).map(([k, v]) => ["bright" + k[0]!.toUpperCase() + k.slice(1), k === "black" ? p.cmt : v]));
  return { foreground: p.fg, background: p.card, cursor: p.fg, selectionBackground: p.fg + sel, ...ansi, ...bright };
}

/** Swatch halves: light card, dark card (Default's where the theme has none). */
export const swatchOf = (id: ThemeId, list: readonly Theme[] = THEMES): [string, string] => {
  const t = themeById(id, list);
  return [t?.light?.card ?? SURFACE.light.bg, t?.dark?.card ?? SURFACE.dark.bg];
};

const HEX6 = /^#[0-9a-f]{6}$/i;
/** A palette an addon declares: all 19 keys as `#rrggbb` (tokensOf mixes and adds alpha to hex), unknown keys ignored; else undefined (that mode is left out, like Dracula light).
 * `graph` (8 colours) sets `--graph-1..8` and the first 6 `--context-1..6`; `vars` (custom properties, checked again here: they go into a <style> text) come last and may replace `--context-*`. */
function addonPalette(raw: AddonPalette | undefined, vars: Record<string, string> | undefined, extra?: Record<string, string>): Palette | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v !== "string" || !HEX6.test(v)) return undefined;
    out[k] = v;
  }
  const x: Record<string, string> = {};
  const g = raw.graph;
  if (Array.isArray(g) && g.length === ADDON_GRAPH_SIZE && g.every((c) => typeof c === "string" && HEX6.test(c))) {
    g.forEach((c, i) => (x[`--graph-${i + 1}`] = c));
    g.slice(0, ADDON_CONTEXT_SIZE).forEach((c, i) => (x[`--context-${i + 1}`] = c));
  }
  for (const [name, value] of Object.entries(vars ?? {})) if (varNameError(name) === undefined && typeof value === "string" && varValueError(value) === undefined) x[name] = value;
  Object.assign(x, extra); // built by this module from checked values (addonBackground)
  return (Object.keys(x).length ? { ...out, x } : out) as Palette;
}

/** A same-origin addon file URL: `/addon/<nonce>/<name>/<encoded path>` with nothing but unreserved characters and `%XX` after it (it goes into `url("...")` of a <style> text, so it is checked again here). */
const FILE_URL = /^\/addon\/[0-9a-f]{1,64}\/[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9._~%/-]+(?:\?v=\d{1,16})?$/;
const encodePath = (p: string) => p.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

/** The background of one addon theme as the web app shows it: per mode the image (and `mobile`) URL, only when the file of the image asset exists now; the veil and panel alpha tokens. Undefined when no mode has a background. */
function addonBackground(a: AddonInfo, th: NonNullable<AddonInfo["manifest"]>["themes"][number]): { background: ThemeBackground; x: { light: Record<string, string>; dark: Record<string, string> } } | undefined {
  const bg = th.background;
  if (!bg || !a.base || !a.manifest?.assets) return undefined;
  const url = (id: string | undefined) => {
    const as = id === undefined ? undefined : a.manifest!.assets![id];
    if (!as || !a.assets?.[id!]?.present) return undefined;
    const u = a.base! + encodePath(as.path) + (a.dev && a.rev !== undefined ? `?v=${a.rev}` : "");
    return FILE_URL.test(u) ? u : undefined;
  };
  const background: ThemeBackground = {};
  const x = { light: {} as Record<string, string>, dark: {} as Record<string, string> };
  for (const mode of ["light", "dark"] as const) {
    const m = bg[mode];
    const image = url(m?.image);
    if (!m || !image) continue;
    const mobile = url(m.mobile);
    background[mode] = { image, ...(mobile && { mobile }) };
    x[mode]["--backdrop-image"] = `url("${image}")`;
    if (mobile) x[mode]["--backdrop-image-mobile"] = `url("${mobile}")`;
    if (numberOk(bg.veil) && bg.veil >= 0 && bg.veil <= 1) x[mode]["--backdrop-veil"] = String(bg.veil);
    if (numberOk(bg.panelAlpha) && bg.panelAlpha >= 0 && bg.panelAlpha <= 1) x[mode]["--panel-alpha"] = String(bg.panelAlpha);
  }
  return background.light || background.dark ? { background, x } : undefined;
}

/** The background of `theme` in `mode`, when it shows one. */
export const backgroundOf = (theme: Theme | undefined, mode: Mode) => theme?.background?.[mode];

/** The themes of these addons (pass the enabled ones), as `addon:<name>:<id>`; a theme without a complete palette in either mode is left out. */
export function addonThemes(addons: readonly AddonInfo[]): Theme[] {
  return addons.flatMap((a) =>
    (a.manifest?.themes ?? []).flatMap((th) => {
      const id = `addon:${a.name}:${th.id}`;
      const bg = addonBackground(a, th);
      const light = addonPalette(th.light, th.vars?.light, bg?.x.light);
      const dark = addonPalette(th.dark, th.vars?.dark, bg?.x.dark);
      // A mode without a palette is not themed, so its background is not shown either.
      const background = bg && { ...(light && bg.background.light && { light: bg.background.light }), ...(dark && bg.background.dark && { dark: bg.background.dark }) };
      return ADDON_THEME_ID.test(id) && (light || dark)
        ? [{ id: id as ThemeId, name: th.name, ...(light && { light }), ...(dark && { dark }), ...(th.options?.length && { options: th.options }), ...(background && (background.light || background.dark) && { background }) }]
        : [];
    }),
  );
}
