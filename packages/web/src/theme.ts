// Color scheme: follows the OS by default (OpenCode `system`), or forced light / dark; kept per browser.
import { useSyncExternalStore } from "react";
import { themeById, themeCss, type ThemeId } from "./themes.ts";
export type ThemePref = "system" | "light" | "dark";

const KEY = "claude-ui.theme";
const COLOR_KEY = "claude-ui.colorTheme";
const query = () => matchMedia("(prefers-color-scheme: dark)");

export const nextPref = (p: ThemePref): ThemePref => (p === "system" ? "light" : p === "light" ? "dark" : "system");

export function loadPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

// The colour theme blocks (themes.ts) are generated, not hand-written in index.css; in the document before the first render.
// (Tests that import this module in a node environment have no document.)
if (typeof document !== "undefined") {
  const themeStyle = document.createElement("style");
  themeStyle.id = "claude-ui-themes";
  themeStyle.textContent = themeCss();
  document.head.append(themeStyle);
}

/** `<meta name="theme-color">` = the page background of the current theme and mode (Default's literals where no stylesheet is loaded). */
function syncMeta(dark = document.documentElement.classList.contains("dark")) {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg || (dark ? "#080808" : "#fafafa"));
}

export function loadColorTheme(): ThemeId {
  try {
    const v = localStorage.getItem(COLOR_KEY);
    return (themeById(v ?? "")?.id ?? "default") as ThemeId;
  } catch {
    return "default";
  }
}

/** Sets `data-theme` on <html> (removed for Default); writes nothing, so startup leaves a fresh browser fresh. */
export function applyColorTheme(id: ThemeId) {
  if (id === "default") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", id);
  syncMeta();
}

/** A user pick: applied at once and kept in this browser. */
export function setColorTheme(id: ThemeId) {
  try {
    localStorage.setItem(COLOR_KEY, id);
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
  applyColorTheme(id);
}

/** Sets `.dark` on <html>; with "system" it follows OS changes until the next call. Returns the stop function. */
export function applyTheme(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
  const mq = query();
  const set = () => {
    const dark = pref === "dark" || (pref === "system" && mq.matches);
    document.documentElement.classList.toggle("dark", dark);
    syncMeta(dark);
  };
  set();
  if (pref !== "system") return () => {};
  mq.addEventListener("change", set);
  return () => mq.removeEventListener("change", set);
}

const isDark = () => document.documentElement.classList.contains("dark");
const onDarkChange = (cb: () => void) => {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  return () => o.disconnect();
};

/** True while `.dark` is on <html>: for components that theme themselves (diffs). */
export const useDark = () => useSyncExternalStore(onDarkChange, isDark, () => false);

const colorTheme = () => (document.documentElement.getAttribute("data-theme") ?? "default") as ThemeId;
/** The colour theme id on <html>: for components that hand colours to a library (diffs, terminal). */
export const useColorTheme = () => useSyncExternalStore(onDarkChange, colorTheme, () => "default" as ThemeId);
