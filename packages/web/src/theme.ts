// Color scheme: follows the OS by default (OpenCode `system`), or forced light / dark; kept per browser.
import { useSyncExternalStore } from "react";
import type { AddonInfo } from "@claude-ui/protocol";
import { ADDON_THEME_ID, THEMES, themeById, themeCss, type Theme, type ThemeId } from "./themes.ts";
export type ThemePref = "system" | "light" | "dark";

const KEY = "claude-ui.theme";
const COLOR_KEY = "claude-ui.colorTheme";
const OPTIONS_KEY = "claude-ui.theme-options";
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
    // An addon theme id is kept before the addons arrive; with no matching rule the default tokens show.
    if (v && ADDON_THEME_ID.test(v)) return v as ThemeId;
    return (themeById(v ?? "")?.id ?? "default") as ThemeId;
  } catch {
    return "default";
  }
}

/** The switches a user turned on or off, per theme: `{ "<themeId>": { "<optionId>": boolean } }`; anything that is not a boolean is ignored. */
function loadOptions(): Record<string, Record<string, boolean>> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).flatMap<[string, Record<string, boolean>]>(([t, o]) => (typeof o === "object" && o !== null && !Array.isArray(o) ? [[t, Object.fromEntries(Object.entries(o).filter(([, b]) => typeof b === "boolean")) as Record<string, boolean>]] : [])),
    );
  } catch {
    return {};
  }
}

/** Switches of this page when storage is blocked. */
let memory: Record<string, Record<string, boolean>> = {};

/** The options of a theme with their current state (stored value, else the option's default, else on). */
export function getThemeOptions(theme: Theme | undefined): { id: string; label: string; on: boolean }[] {
  const stored = theme ? { ...loadOptions()[theme.id], ...memory[theme.id] } : undefined;
  return (theme?.options ?? []).map((o) => ({ id: o.id, label: o.label, on: stored?.[o.id] ?? o.default ?? true }));
}

/** The addon themes the last `applyAddonThemes` knew: their options are applied once the addons arrive. */
let addonList: readonly Theme[] = [];

/** `data-opt-<id>="on"|"off"` on <html> for the options of the current theme; the `data-opt-*` of every other theme's options go. */
function syncThemeOptions() {
  const root = document.documentElement;
  const cur = [...THEMES, ...addonList].find((t) => t.id === (root.getAttribute("data-theme") ?? "default"));
  const want = new Map(getThemeOptions(cur).map((o) => [`data-opt-${o.id}`, o.on ? "on" : "off"]));
  for (const a of [...root.attributes]) if (a.name.startsWith("data-opt-") && !want.has(a.name)) root.removeAttribute(a.name);
  for (const [name, v] of want) root.setAttribute(name, v);
}

/** A user switch: applied at once and kept in this browser. */
export function setThemeOption(themeId: ThemeId, optionId: string, on: boolean) {
  try {
    const all = loadOptions();
    localStorage.setItem(OPTIONS_KEY, JSON.stringify({ ...all, [themeId]: { ...all[themeId], [optionId]: on } }));
  } catch {
    // Storage blocked: the choice lasts for this page.
    memory = { ...memory, [themeId]: { ...memory[themeId], [optionId]: on } };
  }
  syncThemeOptions();
}

/** Sets `data-theme` on <html> (removed for Default) and its `data-opt-*`; writes nothing, so startup leaves a fresh browser fresh. */
export function applyColorTheme(id: ThemeId) {
  if (id === "default") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", id);
  syncThemeOptions();
  syncMeta();
}

/** The colour rules of the enabled addons' themes (GH-516), in a <style> of their own. */
export function applyAddonThemes(themes: readonly Theme[]) {
  let style = document.getElementById("claude-ui-addon-themes");
  if (!style) {
    style = document.createElement("style");
    style.id = "claude-ui-addon-themes";
    document.head.append(style);
  }
  style.textContent = themeCss(themes);
  addonList = themes;
  syncThemeOptions();
  syncMeta();
}

/** One stylesheet link per enabled addon with `css`; links of addons no longer enabled go (GH-516). Same-origin, so the app CSP allows it and blocks what the sheet loads from elsewhere. */
export function applyAddonCss(addons: readonly AddonInfo[]) {
  const want = new Map<string, string>(addons.flatMap((a) => (a.base && a.manifest?.css ? [[`addon-css-${a.name}`, a.base + a.manifest.css.split("/").map(encodeURIComponent).join("/")] as const] : [])));
  for (const l of document.querySelectorAll<HTMLLinkElement>('link[id^="addon-css-"]')) if (want.get(l.id) !== l.getAttribute("href")) l.remove();
  for (const [id, href] of want)
    if (!document.getElementById(id)) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.id = id;
      l.href = href;
      document.head.append(l);
    }
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
