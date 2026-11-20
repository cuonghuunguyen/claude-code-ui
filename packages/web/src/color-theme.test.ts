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
    expect(getThemeOptions(themeById("neon"))).toEqual([{ id: "rain", label: "Rain", on: false }, { id: "rain-light", label: "Light rain", on: false }]);
    localStorage.setItem("claude-ui.theme-options", '{"neon":{"rain":"no"}}');
    expect(getThemeOptions(themeById("neon"))[0]!.on).toBe(true);
    localStorage.setItem("claude-ui.theme-options", "not json");
    expect(getThemeOptions(themeById("neon"))[0]!.on).toBe(true);
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
