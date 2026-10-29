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

export type Mode = "light" | "dark";
export const KEYS = ["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"] as const;
export type Key = (typeof KEYS)[number];
/** `x`: extra tokens (`--graph-*`, `--context-*`) moved in lightness from Default so they reach 3:1 on this palette's surfaces. */
export type Palette = Record<Key, string> & { x?: Record<string, string> };
export type ThemeId = "default" | "catppuccin" | "tokyonight" | "solarized" | "nord" | "dracula" | "one";
/** Default has no palette: it is the `:root` / `.dark` blocks of index.css. Dracula has no light. */
export type Theme = { id: ThemeId; name: string; light?: Palette; dark?: Palette };

/** The Default `--card` and `--foreground` (index.css): the editor, diff and terminal surface. */
export const SURFACE = { light: { bg: "#ffffff", fg: "#161616" }, dark: { bg: "#161616", fg: "#fafafa" } } as const;

/** Values in KEYS order. */
const P = (v: string[], x?: Record<string, string>) => ({ ...Object.fromEntries(KEYS.map((k, i) => [k, v[i]!])), ...(x && { x }) }) as Palette;

export const THEMES: readonly Theme[] = [
  { id: "default", name: "Default" },
  {
    id: "catppuccin",
    name: "Catppuccin",
    // upstream: kw #8839ef, str #40a02b, fn #1e66f5, type/warn #df8e1d, num #fe640b, cmt #7c7f93, varc #e64553, err #d20f39, ok #40a02b, info #1e66f5
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: muted #5c5f77 -> #555870, kw #812ee6 -> #6a05cf, str #007300 -> #007200, fn #0d57e5 -> #0a54e2, type #9b4f00 -> #984c00, num #bf2300 -> #bd2100, cmt #5f6275 -> #5d6073, varc #c21b36 -> #c01734, err #c70030 -> #c5002e, warn #9b4f00 -> #873b00, ok #007300 -> #006000, info #0d57e5 -> #0a54e2
    light: P(["#e6e9ef", "#eff1f5", "#dce0e8", "#4c4f69", "#555870", "#ccd0da", "#8839ef", "#ffffff", "#6a05cf", "#007200", "#0a54e2", "#984c00", "#bd2100", "#5d6073", "#c01734", "#c5002e", "#873b00", "#006000", "#0a54e2"], { "--context-4": "#ee3b00", "--context-6": "#008ca2" }),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: cmt #9399b2 -> #a2a8c1
    dark: P(["#181825", "#1e1e2e", "#11111b", "#cdd6f4", "#a6adc8", "#313244", "#cba6f7", "#11111b", "#cba6f7", "#a6e3a1", "#89b4fa", "#f9e2af", "#fab387", "#a2a8c1", "#eba0ac", "#f38ba8", "#f9e2af", "#a6e3a1", "#89b4fa"]),
  },
  {
    id: "tokyonight",
    name: "Tokyo Night",
    // upstream light: fg #3760bf, muted #6172b0, primary/fn #2e7de9, kw #9854f1, str/ok #587539, type/info #007197, num #b15c00, cmt #848cb5, varc/err #f52a65, warn #8c6c3e; dark: cmt #565f89
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: muted #42518c -> #34437e, kw #7224c4 -> #5900ab, warn #6d4e1f -> #5c3d0e, ok #415c20 -> #304b0f
    light: P(["#d0d5e3", "#e1e2e7", "#c4c8da", "#274eab", "#34437e", "#b4b5b9", "#2374df", "#ffffff", "#5900ab", "#415c20", "#004eb6", "#005a7e", "#8d3b00", "#4b5277", "#ab002e", "#ab002e", "#5c3d0e", "#304b0f", "#005a7e"], { "--graph-2": "#a24ea9", "--graph-4": "#c84000", "--graph-5": "#876c00", "--graph-6": "#007993", "--context-2": "#a24ea9", "--context-4": "#d82300", "--context-5": "#876c00", "--context-6": "#007a90" }),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: kw #bb9af7 -> #bd9cf9, cmt #7882ae -> #959fcb, err #f7768e -> #f97890
    dark: P(["#16161e", "#1a1b26", "#13131a", "#c0caf5", "#a9b1d6", "#292e42", "#7aa2f7", "#16161e", "#bd9cf9", "#9ece6a", "#7aa2f7", "#2ac3de", "#ff9e64", "#959fcb", "#e0af68", "#f97890", "#e0af68", "#9ece6a", "#7dcfff"]),
  },
  {
    id: "solarized",
    name: "Solarized",
    // upstream light: fg #586e75, muted #657b83, primary/fn/info #268bd2, kw/ok #859900, str #2aa198, type/warn #b58900, num #d33682, cmt #93a1a1, varc #6c71c4, err #dc322f
    // upstream dark: muted #839496, primary/fn/info #268bd2, kw/ok #859900, str #2aa198, type/warn #b58900, num #d33682, cmt #586e75, varc #6c71c4, err #dc322f
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: fg #556b72 -> #51676e, muted #576c74 -> #4b6068, kw #5e7000 -> #485a00, str #00756d -> #007169, fn #006cb1 -> #0067ac, type #8b6000 -> #875c00, num #c12173 -> #bd1b6f, cmt #5e6b6b -> #596666, varc #5b5fb0 -> #585cad, err #cc1d20 -> #c7131b, warn #8b6000 -> #744900, ok #5e7000 -> #485a00, info #006cb1 -> #0067ac
    light: P(["#eee8d5", "#fdf6e3", "#f5efdc", "#51676e", "#4b6068", "#ddd6c1", "#0075bb", "#fdf6e3", "#485a00", "#007169", "#0067ac", "#875c00", "#bd1b6f", "#596666", "#585cad", "#c7131b", "#744900", "#485a00", "#0067ac"]),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: fg #93a1a1 -> #a0aeae, muted #8a9c9e -> #9caeb0, kw #8ea219 -> #abbf3b, str #35a9a0 -> #48bcb3, fn #3f9fe8 -> #52b2fb, type #bf921a -> #d1a430, num #fc5ea5 -> #ff7fc6, cmt #859ca4 -> #98afb7, varc #8a91e7 -> #9da4fa, err #ff675c -> #ff887d, warn #bf921a -> #d9ac38, ok #8ea219 -> #abbf3b, info #3f9fe8 -> #52b2fb
    dark: P(["#00212b", "#002b36", "#073642", "#a0aeae", "#9caeb0", "#0e3f4c", "#3093da", "#002b36", "#abbf3b", "#48bcb3", "#52b2fb", "#d1a430", "#ff7fc6", "#98afb7", "#9da4fa", "#ff887d", "#d9ac38", "#abbf3b", "#52b2fb"]),
  },
  {
    id: "nord",
    name: "Nord",
    // upstream light: primary/kw/info #5e81ac, str/ok #a3be8c, fn #88c0d0, type #8fbcbb, num #b48ead, cmt #7b88a1, varc #d08770, err #bf616a, warn #ebcb8b
    // upstream dark: kw/info #81a1c1, num #b48ead, cmt #616e88, varc #d08770, err #bf616a
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: kw #42648d -> #31537c, str #51693b -> #4f6739, fn #326978 -> #306776, type #3e6968 -> #3c6766, num #795773 -> #775571, cmt #56627a -> #546078, varc #924f3a -> #914e39, err #9f454f -> #9d434d, warn #7a5d1b -> #694c09, ok #51693b -> #40582a, info #42648d -> #40628b
    light: P(["#e5e9f0", "#eceff4", "#d8dee9", "#2e3440", "#4c566a", "#d8dee9", "#5578a3", "#ffffff", "#31537c", "#4f6739", "#306776", "#3c6766", "#775571", "#546078", "#914e39", "#9d434d", "#694c09", "#40582a", "#40628b"], { "--context-4": "#ec3900", "--context-6": "#008aa0" }),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: kw #90b1d1 -> #b8d9f9, str #a3be8c -> #b0cb99, fn #88c0d0 -> #93cbdb, type #8fbcbb -> #9ecbca, num #c9a2c2 -> #deb7d7, cmt #a1afcb -> #b5c3df, varc #e89d85 -> #fcb199, err #f6929a -> #ffacb4, warn #ebcb8b -> #f1d191, ok #a3be8c -> #c3deac, info #90b1d1 -> #a5c6e6
    dark: P(["#242933", "#2e3440", "#3b4252", "#eceff4", "#d8dee9", "#3b4252", "#88c0d0", "#2e3440", "#b8d9f9", "#b0cb99", "#93cbdb", "#9ecbca", "#deb7d7", "#b5c3df", "#fcb199", "#ffacb4", "#f1d191", "#c3deac", "#a5c6e6"]),
  },
  {
    id: "dracula",
    name: "Dracula",
    // upstream: cmt #6272a4
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: kw #ff79c6 -> #ffaaf7, num #bd93f9 -> #d1a7ff, cmt #7f90c4 -> #a7b8ec, err #ff5555 -> #ff9e9e
    dark: P(["#21222c", "#282a36", "#191a21", "#f8f8f2", "#bfc3d9", "#44475a", "#bd93f9", "#21222c", "#ffaaf7", "#f1fa8c", "#50fa7b", "#8be9fd", "#d1a7ff", "#a7b8ec", "#ffb86c", "#ff9e9e", "#ffb86c", "#50fa7b", "#8be9fd"]),
  },
  {
    id: "one",
    name: "One",
    // upstream light: primary/fn #4078f2, str/ok #50a14f, type/warn #c18401, num #986801, cmt #a0a1a7, varc/err #e45649, info #0184bc; dark: cmt #7f848e, varc/err #e06c75
    // light values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: muted #5c5e66 -> #595b63, kw #a626a4 -> #8e028c, str #227624 -> #217523, varc #bf3229 -> #be3128, err #bf3229 -> #be3128, warn #935800 -> #7e4300, ok #227624 -> #065f0d
    light: P(["#eaeaeb", "#fafafa", "#e5e5e6", "#383a42", "#595b63", "#dbdbdc", "#376ee8", "#ffffff", "#8e028c", "#217523", "#295ed6", "#935800", "#8c5c00", "#65666b", "#be3128", "#be3128", "#7e4300", "#065f0d", "#006ca2"], { "--context-4": "#f34000", "--context-6": "#0090a6" }),
    // dark values the issue lists, moved again for the active line, diff lines, keybind chip and graph chips: fg #abb2bf -> #aeb5c2, muted #9da5b4 -> #adb5c4, kw #c678dd -> #f2a4ff, fn #61afef -> #6dbbfb, num #d19a66 -> #e1aa76, cmt #8e939d -> #b0b5bf, varc #e36f78 -> #ff969f, err #e36f78 -> #ff969f, ok #98c379 -> #a2cd83, info #56b6c2 -> #62c2ce
    dark: P(["#21252b", "#282c34", "#1e2227", "#aeb5c2", "#adb5c4", "#3e4451", "#61afef", "#21252b", "#f2a4ff", "#98c379", "#6dbbfb", "#e5c07b", "#e1aa76", "#b0b5bf", "#ff969f", "#ff969f", "#e5c07b", "#a2cd83", "#62c2ce"]),
  },
];

export const themeById = (id: string) => THEMES.find((t) => t.id === id);

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
export function themeCss(): string {
  const out: string[] = [];
  for (const t of THEMES)
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
export const swatchOf = (id: ThemeId): [string, string] => {
  const t = themeById(id);
  return [t?.light?.card ?? SURFACE.light.bg, t?.dark?.card ?? SURFACE.dark.bg];
};
