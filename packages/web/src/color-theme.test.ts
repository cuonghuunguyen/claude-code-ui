// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { themeById, tokensOf } from "./themes.ts";
import type { AddonInfo } from "@claude-ui/protocol";
import { addonThemes } from "./themes.ts";
import { applyAddonCss, applyAddonThemes, applyColorTheme, applyTheme, getThemeOptions, loadColorTheme, setColorTheme, setThemeOption } from "./theme.ts";

const root = document.documentElement;
const meta = () => document.querySelector('meta[name="theme-color"]')!.getAttribute("content");

beforeEach(() => {
  localStorage.clear();
  document.querySelectorAll("style[id^='addon-css-'], style[data-addon-stale]").forEach((x) => x.remove());
  root.removeAttribute("data-theme");
  root.removeAttribute("data-opt-rain");
  root.removeAttribute("data-opt-rain-light");
  root.removeAttribute("data-opt-glow");
  root.classList.remove("dark");
  if (!document.querySelector('meta[name="theme-color"]')) document.head.insertAdjacentHTML("beforeend", '<meta name="theme-color" content="#fafafa">');
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
});

describe("colour theme", () => {
  it("loadColorTheme: missing or unknown value is default", () => {
    expect(loadColorTheme()).toBe("default");
    localStorage.setItem("claude-ui.colorTheme", "nope");
    expect(loadColorTheme()).toBe("default");
    localStorage.setItem("claude-ui.colorTheme", "nord");
    expect(loadColorTheme()).toBe("nord");
  });

  it("setColorTheme sets data-theme, writes storage; default removes the attribute", () => {
    setColorTheme("catppuccin");
    expect(root.getAttribute("data-theme")).toBe("catppuccin");
    expect(localStorage.getItem("claude-ui.colorTheme")).toBe("catppuccin");
    setColorTheme("default");
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("claude-ui.colorTheme")).toBe("default");
  });

  it("theme options: data-opt-<id> is on by default, follows the current theme only, and a stored off is kept", () => {
    setColorTheme("neon");
    expect(root.getAttribute("data-opt-rain")).toBe("on");
    expect(root.getAttribute("data-opt-rain-light")).toBe("off");
    setThemeOption("neon", "rain", false);
    expect(root.getAttribute("data-opt-rain")).toBe("off");
    expect(JSON.parse(localStorage.getItem("claude-ui.theme-options")!)).toEqual({ neon: { rain: false } });
    setColorTheme("nord");
    expect(root.hasAttribute("data-opt-rain")).toBe(false);
    applyColorTheme("neon");
    expect(root.getAttribute("data-opt-rain")).toBe("off");
    expect(getThemeOptions(themeById("neon")).map((o) => [o.id, o.label, o.value])).toEqual([["rain", "Rain", false], ["rain-light", "Light rain", false]]);
    localStorage.setItem("claude-ui.theme-options", '{"neon":{"rain":"no"}}');
    expect(getThemeOptions(themeById("neon"))[0]!.value).toBe(true);
    localStorage.setItem("claude-ui.theme-options", "not json");
    expect(getThemeOptions(themeById("neon"))[0]!.value).toBe(true);
  });

  it("applyColorTheme at startup writes no storage (a fresh browser stays fresh)", () => {
    applyColorTheme("nord");
    expect(root.getAttribute("data-theme")).toBe("nord");
    expect(localStorage.length).toBe(0);
  });

  it("injects one style element with the generated theme blocks", () => {
    const css = document.getElementById("claude-ui-themes")?.textContent ?? "";
    expect(css).toContain(':root[data-theme="nord"].dark');
  });

  it("<meta theme-color> follows --background of the current theme and mode", () => {
    // jsdom does not cascade custom properties: resolve --background from the same table the generated CSS comes from.
    vi.spyOn(window, "getComputedStyle").mockImplementation((() => ({
      getPropertyValue: () => {
        const mode = root.classList.contains("dark") ? "dark" : "light";
        const p = themeById(root.getAttribute("data-theme") ?? "")?.[mode];
        return p ? tokensOf(p, mode)["--background"]! : "";
      },
    })) as never);
    applyTheme("dark")();
    applyColorTheme("catppuccin");
    expect(meta()).toBe("#181825");
    applyTheme("light")();
    expect(meta()).toBe("#e6e9ef");
    applyColorTheme("default");
    expect(meta()).toBe("#fafafa");
  });
});

describe("addon themes and CSS (GH-516)", () => {
  const addon = (name: string, css?: string): AddonInfo =>
    ({ name, source: { kind: "local", path: "/x" }, approved: [], state: "enabled", base: `/addon/${"0".repeat(32)}/${name}/`, manifest: { name, version: "1", description: "", capabilities: [], themes: [], css, views: [], commands: [], renderers: [] } }) as AddonInfo;
  const sheets = () => [...document.querySelectorAll("style[id^='addon-css-']")].map((l) => [l.id, l.textContent]);

  it("a stored addon theme id is kept before addons load", () => {
    localStorage.setItem("claude-ui.colorTheme", "addon:example:dusk");
    expect(loadColorTheme()).toBe("addon:example:dusk");
    localStorage.setItem("claude-ui.colorTheme", 'addon:x"y:z');
    expect(loadColorTheme()).toBe("default");
  });

  it("applyAddonThemes writes one style element and replaces its content", () => {
    const palette = Object.fromEntries(["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"].map((k) => [k, "#101010"]));
    const a = { ...addon("example"), manifest: { ...addon("example").manifest!, themes: [{ id: "dusk", name: "D", dark: palette }] } };
    applyAddonThemes(addonThemes([a]));
    expect(document.getElementById("claude-ui-addon-themes")!.textContent).toContain('[data-theme="addon:example:dusk"].dark');
    applyAddonThemes([]);
    expect(document.querySelectorAll("#claude-ui-addon-themes")).toHaveLength(1);
    expect(document.getElementById("claude-ui-addon-themes")!.textContent).toBe("");
  });

  it("addon theme options: the option default applies once the addons arrive", () => {
    const palette = Object.fromEntries(["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"].map((k) => [k, "#101010"]));
    const a = { ...addon("example"), manifest: { ...addon("example").manifest!, themes: [{ id: "dusk", name: "D", dark: palette, options: [{ id: "glow", label: "Glow", default: false }] }] } };
    applyColorTheme("addon:example:dusk");
    expect(root.hasAttribute("data-opt-glow")).toBe(false);
    applyAddonThemes(addonThemes([a]));
    expect(root.getAttribute("data-opt-glow")).toBe("off");
    applyAddonThemes([]);
    expect(root.hasAttribute("data-opt-glow")).toBe(false);
  });

  it("applyAddonCss adds a layered import per enabled addon with css and removes it when the addon is gone", () => {
    applyAddonCss([addon("one", "theme.css"), addon("two", "css/a b.css"), addon("three")]);
    expect(sheets()).toEqual([
      ["addon-css-one", `@import url("/addon/${"0".repeat(32)}/one/theme.css") layer(addon.one);`],
      ["addon-css-two", `@import url("/addon/${"0".repeat(32)}/two/css/a%20b.css") layer(addon.two);`],
    ]);
    applyAddonCss([addon("two", "css/b.css")]);
    expect(sheets()).toEqual([["addon-css-two", `@import url("/addon/${"0".repeat(32)}/two/css/b.css") layer(addon.two);`]]);
    applyAddonCss([]);
    expect(sheets()).toEqual([]);
  });

  it("a theme with css gets its own layered import of the file scoped to that theme; it is removed with the addon", () => {
    const a = addon("example");
    a.manifest!.themes = [
      { id: "dusk", name: "Dusk", css: "themes/dusk light.css" },
      { id: "dawn", name: "Dawn", css: "dawn.css" },
      { id: "plain", name: "Plain" },
    ];
    applyAddonCss([a]);
    const base = `/addon/${"0".repeat(32)}/example`;
    expect(sheets()).toEqual([
      ["addon-css-example--dusk", `@import url("${base}/themes/dusk%20light.css?theme=dusk") layer(addon.example);`],
      ["addon-css-example--dawn", `@import url("${base}/dawn.css?theme=dawn") layer(addon.example);`],
    ]);
    applyAddonCss([]);
    expect(sheets()).toEqual([]);
  });

  it("a theme that extends loads its bases' css first, each scoped under the extending theme (as=), then its own; a base without css adds none", () => {
    const base = (n: string) => `/addon/${"0".repeat(32)}/${n}`;
    const pack = addon("pack");
    pack.manifest!.themes = [{ id: "night", name: "N", css: "n.css" }, { id: "deep", name: "D", css: "d.css" }];
    const main = addon("main");
    main.manifest!.themes = [
      { id: "kid", name: "K", css: "k.css", extends: "pack:night" },
      { id: "grand", name: "G", extends: "kid" },
      { id: "bare", name: "B", extends: "pack:night" },
      { id: "lost", name: "L", extends: "gone:x", css: "l.css" },
    ];
    applyAddonCss([pack, main]);
    expect(Object.fromEntries(sheets())).toEqual({
      "addon-css-pack--night": `@import url("${base("pack")}/n.css?theme=night") layer(addon.pack);`,
      "addon-css-pack--deep": `@import url("${base("pack")}/d.css?theme=deep") layer(addon.pack);`,
      "addon-css-main--kid": `@import url("${base("pack")}/n.css?theme=night&as=main:kid") layer(addon.main);\n@import url("${base("main")}/k.css?theme=kid") layer(addon.main);`,
      "addon-css-main--grand": `@import url("${base("pack")}/n.css?theme=night&as=main:grand") layer(addon.main);\n@import url("${base("main")}/k.css?theme=kid&as=main:grand") layer(addon.main);`,
      "addon-css-main--bare": `@import url("${base("pack")}/n.css?theme=night&as=main:bare") layer(addon.main);`,
      "addon-css-main--lost": `@import url("${base("main")}/l.css?theme=lost") layer(addon.main);`,
    });
  });

  it("dev mode: the file URLs carry ?v=<rev>; a new rev loads a new sheet and drops the old one when the new one is loaded, or after 2 s", () => {
    vi.useFakeTimers();
    try {
      const dev = (rev: number) => {
        const a = { ...addon("example"), dev: true, rev };
        a.manifest!.css = "legacy.css";
        a.manifest!.themes = [{ id: "dusk", name: "Dusk", css: "dusk.css" }];
        return a;
      };
      const base = `/addon/${"0".repeat(32)}/example`;
      applyAddonCss([dev(1)]);
      expect(sheets()).toEqual([
        ["addon-css-example", `@import url("${base}/legacy.css?v=1") layer(addon.example);`],
        ["addon-css-example--dusk", `@import url("${base}/dusk.css?theme=dusk&v=1") layer(addon.example);`],
      ]);
      applyAddonCss([dev(1)]);
      expect(sheets()).toHaveLength(2); // same rev: untouched
      applyAddonCss([dev(2)]);
      const all = () => document.querySelectorAll("style[id^='addon-css-'], style[data-addon-stale]");
      expect(all()).toHaveLength(4); // old sheets stay until the new ones are loaded: no unstyled flash
      expect(sheets().map((x) => x[1])).toEqual([`@import url("${base}/legacy.css?v=2") layer(addon.example);`, `@import url("${base}/dusk.css?theme=dusk&v=2") layer(addon.example);`]);
      document.getElementById("addon-css-example")!.dispatchEvent(new Event("load"));
      expect(all()).toHaveLength(3);
      vi.advanceTimersByTime(2000);
      expect(all()).toHaveLength(2);
      applyAddonCss([]);
      expect(all()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dev mode: a sheet replaced before it loaded does not drop the older sheets when it fires load", () => {
    const dev = (rev: number) => ({ ...addon("example", "legacy.css"), dev: true, rev });
    applyAddonCss([dev(1)]);
    applyAddonCss([dev(2)]);
    const first = document.querySelector<HTMLElement>("style[data-addon-stale]")!;
    applyAddonCss([dev(3)]);
    const stale = document.querySelectorAll("style[data-addon-stale]").length;
    first.dispatchEvent(new Event("load")); // rev 2 never became the current sheet: nothing may go yet
    expect(document.querySelectorAll("style[data-addon-stale]")).toHaveLength(stale);
  });

  it("an addon name that starts with a digit still gets a valid layer name", () => {
    applyAddonCss([addon("1st-theme", "t.css")]);
    expect(sheets()[0]![1]).toContain("layer(addon.\\31 st-theme)");
  });

  it("the colour rules of built-in and addon themes are in the host layer, so an addon sheet (later layer) beats them", () => {
    expect(document.getElementById("claude-ui-themes")!.textContent).toMatch(/^@layer host \{/);
    const palette = Object.fromEntries(["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"].map((k) => [k, "#101010"]));
    applyAddonThemes(addonThemes([{ ...addon("example"), manifest: { ...addon("example").manifest!, themes: [{ id: "dusk", name: "D", dark: palette }] } }]));
    expect(document.getElementById("claude-ui-addon-themes")!.textContent).toMatch(/^@layer host \{[\s\S]*addon:example:dusk[\s\S]*\}$/);
  });
});
