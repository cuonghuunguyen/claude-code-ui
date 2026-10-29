import { describe, expect, it } from "vitest";
import { KEYS, SURFACE, swatchOf, terminalTheme, themeCss, THEMES, tokensOf } from "./themes.ts";

const HEX = /^#[0-9a-f]{6}$/;
const dracula = THEMES.find((t) => t.id === "dracula")!;
const catppuccin = THEMES.find((t) => t.id === "catppuccin")!;

describe("THEMES", () => {
  it("lists Default, Catppuccin, Tokyo Night, Solarized, Nord, Dracula, One in order", () => {
    expect(THEMES.map((t) => t.name)).toEqual(["Default", "Catppuccin", "Tokyo Night", "Solarized", "Nord", "Dracula", "One"]);
    expect(THEMES.map((t) => t.id)).toEqual(["default", "catppuccin", "tokyonight", "solarized", "nord", "dracula", "one"]);
  });

  it("every palette has the 19 keys as #rrggbb; Default has none (index.css), Dracula has no light", () => {
    expect(KEYS).toHaveLength(19);
    expect(THEMES[0]!.light).toBeUndefined();
    expect(THEMES[0]!.dark).toBeUndefined();
    expect(dracula.light).toBeUndefined();
    for (const t of THEMES.slice(1))
      for (const p of [t.light, t.dark]) if (p) for (const k of KEYS) expect(p[k], `${t.id} ${k}`).toMatch(HEX);
  });
});

describe("tokensOf", () => {
  const dark = tokensOf(catppuccin.dark!, "dark");
  const light = tokensOf(catppuccin.light!, "light");

  it("maps palette keys to tokens", () => {
    const p = catppuccin.dark!;
    expect(dark).toMatchObject({
      "--background": p.bg, "--card": p.card, "--popover": p.card, "--secondary": p.side, "--muted": p.side,
      "--foreground": p.fg, "--syntax-parameter": p.fg, "--ring-progress": p.fg, "--muted-foreground": p.muted, "--syntax-punctuation": p.muted,
      "--ring-track": p.border, "--tab-separator": p.border, "--kbd": p.border, "--primary": p.primary, "--send": p.primary, "--ring": p.primary,
      "--primary-foreground": p.pfg, "--syntax-keyword": p.kw, "--ref-remote": p.kw, "--syntax-string": p.str, "--syntax-regexp": p.str,
      "--syntax-function": p.fn, "--syntax-type": p.type, "--syntax-attribute": p.type, "--syntax-number": p.num, "--syntax-constant": p.num,
      "--syntax-comment": p.cmt, "--syntax-variable": p.varc, "--destructive": p.err, "--syntax-tag": p.err, "--syntax-critical": p.err,
      "--warning": p.warn, "--syntax-builtin": p.warn, "--ref-head": p.warn, "--success": p.ok, "--ref-local": p.ok,
      "--info": p.info, "--syntax-operator": p.info, "--syntax-decorator": p.info, "--syntax-escape": p.info,
    });
  });

  it("derives border/input/accent from fg and --faint from muted and card", () => {
    expect(dark["--border"]).toBe(catppuccin.dark!.fg + "1f");
    expect(dark["--input"]).toBe(catppuccin.dark!.fg + "24");
    expect(dark["--accent"]).toBe(catppuccin.dark!.fg + "14");
    expect(light["--accent"]).toBe(catppuccin.light!.fg + "0f");
    expect(dark["--faint"]).toMatch(HEX);
    expect(dark["--faint"]).not.toBe(catppuccin.dark!.muted);
  });

  it("light --muted is bg, dark --muted is side", () => {
    expect(light["--muted"]).toBe(catppuccin.light!.bg);
    expect(dark["--muted"]).toBe(catppuccin.dark!.side);
  });

  it("leaves context, graph, avatar, overlay and elevation tokens to Default", () => {
    for (const name of Object.keys(dark)) expect(name).not.toMatch(/^--(context|graph|avatar|overlay|elevation)/);
  });
});

describe("themeCss", () => {
  const css = themeCss();
  it("emits a :not(.dark) and a .dark block per palette; none for Default or Dracula light", () => {
    expect(css).toContain(':root[data-theme="catppuccin"]:not(.dark) {');
    expect(css).toContain(':root[data-theme="catppuccin"].dark {');
    expect(css).toContain(':root[data-theme="dracula"].dark {');
    expect(css).not.toContain('[data-theme="dracula"]:not(.dark)');
    expect(css).not.toContain('[data-theme="default"]');
    expect(css.match(/\{/g)).toHaveLength(11);
  });
});

describe("terminalTheme", () => {
  it("derives ANSI colors from the palette", () => {
    const p = catppuccin.dark!;
    expect(terminalTheme("catppuccin", "dark")).toMatchObject({
      foreground: p.fg, background: p.card, cursor: p.fg, selectionBackground: p.fg + "40",
      black: p.side, red: p.err, green: p.ok, yellow: p.warn, blue: p.fn, magenta: p.kw, cyan: p.info, white: p.muted,
      brightBlack: p.side, brightRed: p.err, brightGreen: p.ok, brightYellow: p.warn, brightBlue: p.fn, brightMagenta: p.kw, brightCyan: p.info, brightWhite: p.muted,
    });
    expect(terminalTheme("catppuccin", "light").selectionBackground).toBe(catppuccin.light!.fg + "33");
  });

  it("Default and Dracula light return the Default surface with no ANSI keys", () => {
    for (const [id, mode] of [["default", "dark"], ["default", "light"], ["dracula", "light"]] as const) {
      const t = terminalTheme(id, mode);
      expect(Object.keys(t).sort()).toEqual(["background", "cursor", "foreground", "selectionBackground"]);
      expect(t.background).toBe(SURFACE[mode].bg);
      expect(t.foreground).toBe(SURFACE[mode].fg);
    }
  });
});

describe("swatchOf", () => {
  it("is the light card and the dark card; Dracula's left half is the Default light card", () => {
    expect(swatchOf("catppuccin")).toEqual([catppuccin.light!.card, catppuccin.dark!.card]);
    expect(swatchOf("dracula")).toEqual([SURFACE.light.bg, dracula.dark!.card]);
    expect(swatchOf("default")).toEqual([SURFACE.light.bg, SURFACE.dark.bg]);
  });
});
