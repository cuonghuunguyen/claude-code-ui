// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { themeById, tokensOf } from "./themes.ts";
import { applyColorTheme, applyTheme, loadColorTheme, setColorTheme } from "./theme.ts";

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
