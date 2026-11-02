// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { themeById, tokensOf } from "./themes.ts";
import type { AddonInfo } from "@claude-ui/protocol";
import { addonThemes } from "./themes.ts";
import { applyAddonCss, applyAddonThemes, applyColorTheme, applyTheme, loadColorTheme, setColorTheme } from "./theme.ts";

const root = document.documentElement;
const meta = () => document.querySelector('meta[name="theme-color"]')!.getAttribute("content");

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("data-theme");
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
  const links = () => [...document.querySelectorAll("link[id^='addon-css-']")].map((l) => [l.id, l.getAttribute("href")]);

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

  it("applyAddonCss adds a link per enabled addon with css and removes it when the addon is gone", () => {
    applyAddonCss([addon("one", "theme.css"), addon("two", "css/a b.css"), addon("three")]);
    expect(links()).toEqual([
      ["addon-css-one", `/addon/${"0".repeat(32)}/one/theme.css`],
      ["addon-css-two", `/addon/${"0".repeat(32)}/two/css/a%20b.css`],
    ]);
    applyAddonCss([addon("two", "css/a b.css")]);
    expect(links().map((l) => l[0])).toEqual(["addon-css-two"]);
    applyAddonCss([]);
    expect(links()).toEqual([]);
  });
});
