// Color scheme: follows the OS by default (OpenCode `system`), or forced light / dark; kept per browser.
import { useSyncExternalStore } from "react";
import { optionCss, optionType, optionValue, type AddonInfo } from "@claude-ui/protocol";
import { ADDON_THEME_ID, baseThemes, THEMES, themeById, themeCss, type Theme, type ThemeId, type ThemeOption } from "./themes.ts";
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

/** The colour rules go in the `host` layer with index.css: unlayered they would beat every addon sheet (layer `addon.<name>`). */
const hostLayer = (css: string) => (css ? `@layer host {\n${css}\n}` : "");

// The colour theme blocks (themes.ts) are generated, not hand-written in index.css; in the document before the first render.
// (Tests that import this module in a node environment have no document.)
if (typeof document !== "undefined") {
  const themeStyle = document.createElement("style");
  themeStyle.id = "claude-ui-themes";
  themeStyle.textContent = hostLayer(themeCss());
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

/** What a user chose per theme: `{ "<themeId>": { "<optionId>": boolean | string | number } }`. Only primitive values are kept here; each is checked against the option's type when it is read (`optionValue`). */
type Stored = Record<string, Record<string, boolean | string | number>>;
const storable = (v: unknown): v is boolean | string | number => typeof v === "boolean" || (typeof v === "string" && v.length <= 64) || (typeof v === "number" && Number.isFinite(v));
function loadOptions(): Stored {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).flatMap<[string, Stored[string]]>(([t, o]) => (typeof o === "object" && o !== null && !Array.isArray(o) ? [[t, Object.fromEntries(Object.entries(o).filter(([, x]) => storable(x))) as Stored[string]]] : [])),
    );
  } catch {
    return {};
  }
}

/** Choices of this page when storage is blocked. */
let memory: Stored = {};

/** One option of the current theme with its current value (stored value when valid for the option's type, else the option's default). */
export type OptionState = { id: string; label: string; option: ThemeOption; value: boolean | string | number };

/** The options of a theme with their current values. */
export function getThemeOptions(theme: Theme | undefined): OptionState[] {
  const stored = theme ? { ...loadOptions()[theme.id], ...memory[theme.id] } : undefined;
  return (theme?.options ?? []).map((o) => ({ id: o.id, label: o.label, option: o, value: optionValue(o, stored?.[o.id]) }));
}

/** The addon themes the last `applyAddonThemes` knew: their options are applied once the addons arrive. */
let addonList: readonly Theme[] = [];

/** On <html> for the options of the current theme: `data-opt-<id>` (boolean `on`/`off`, select the value) and `--opt-<id>` (boolean `0`/`1`, select the value, range the number, color the hex; checked again by `optionCss`). Those of every other theme's options go. */
function syncThemeOptions() {
  const root = document.documentElement;
  const cur = [...THEMES, ...addonList].find((t) => t.id === (root.getAttribute("data-theme") ?? "default"));
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  for (const o of getThemeOptions(cur)) {
    const css = optionCss(o.option, o.value);
    if (css === undefined) continue;
    const type = optionType(o.option);
    if (type === "boolean") attrs.set(`data-opt-${o.id}`, o.value ? "on" : "off");
    else if (type === "select") attrs.set(`data-opt-${o.id}`, css);
    props.set(`--opt-${o.id}`, css);
  }
  for (const a of [...root.attributes]) if (a.name.startsWith("data-opt-") && !attrs.has(a.name)) root.removeAttribute(a.name);
  for (const [name, v] of attrs) root.setAttribute(name, v);
  for (const name of [...root.style]) if (name.startsWith("--opt-") && !props.has(name)) root.style.removeProperty(name);
  for (const [name, v] of props) root.style.setProperty(name, v);
}

/** A user choice: applied at once and kept in this browser. */
export function setThemeOption(themeId: ThemeId, optionId: string, value: boolean | string | number) {
  try {
    const all = loadOptions();
    localStorage.setItem(OPTIONS_KEY, JSON.stringify({ ...all, [themeId]: { ...all[themeId], [optionId]: value } }));
  } catch {
    // Storage blocked: the choice lasts for this page.
    memory = { ...memory, [themeId]: { ...memory[themeId], [optionId]: value } };
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
  style.textContent = hostLayer(themeCss(themes));
  addonList = themes;
  syncThemeOptions();
  syncMeta();
}

/** CSS identifier for an addon name (`[a-z0-9-]`): a leading digit is escaped (`\31 `), else the layer name would be invalid and the whole import dropped. */
const identOf = (name: string) => name.replace(/^[0-9]/, (d) => `\\3${d} `);

/** How long the sheet an edit replaced (dev mode) stays when the new one never reports load or error. */
const STALE_MS = 2000;

/** The stylesheets of the enabled addons, each a `<style>` that imports a file into the addon's cascade layer (`layer(addon.<name>)`: after `host`, so it wins without `!important`, and a broken file cannot leave the layer). Per addon: the legacy top-level `css` (every theme, unscoped). Per theme with `css`: the same file scoped by the daemon to that theme (`?theme=<id>`), loaded for every enabled theme so a switch shows no unstyled flash. Styles of addons or themes no longer there go (GH-516, GH-868). Same-origin, so the app CSP allows it and blocks what a sheet loads from elsewhere. Dev mode (`rev`): `v=<rev>` in the URL makes an edit load the file again; the sheet it replaces stays until the new one has loaded (or 2 s), so the page never shows the unstyled theme between the two. */
export function applyAddonCss(addons: readonly AddonInfo[]) {
  /** `file`: the addon whose file it is (URL, `v=`); `owner`: the addon whose layer it loads into; `as`: the extending theme (`<addon>:<theme>`) the daemon scopes a base theme's file under. */
  const imp = (file: AddonInfo, path: string, owner: AddonInfo, theme?: string, as?: string) => {
    const q = [...(theme ? [`theme=${theme}`] : []), ...(as ? [`as=${as}`] : []), ...(file.dev && file.rev !== undefined ? [`v=${file.rev}`] : [])].join("&");
    return `@import url("${file.base + path.split("/").map(encodeURIComponent).join("/") + (q && `?${q}`)}") layer(addon.${identOf(owner.name)});`;
  };
  const running = addons.filter((a) => a.base && a.manifest);
  const want = new Map<string, string>(
    running.flatMap((a) => [
      ...(a.manifest!.css ? [[`addon-css-${a.name}`, imp(a, a.manifest!.css, a)] as const] : []),
      // An addon name has no `--`, so these ids cannot collide with the legacy one or another addon's.
      // One sheet per theme: the css of the themes it extends first (the daemon scopes each under this theme, `as`), then its own, so its own wins at equal specificity.
      ...a.manifest!.themes.flatMap((t) => {
        const lines = [...baseThemes(running, a, t).flatMap((b) => (b.theme.css ? [imp(b.addon, b.theme.css, a, b.theme.id, `${a.name}:${t.id}`)] : [])), ...(t.css ? [imp(a, t.css, a, t.id)] : [])];
        return lines.length ? [[`addon-css-${a.name}--${t.id}`, lines.join("\n")] as const] : [];
      }),
    ]),
  );
  for (const l of document.querySelectorAll<HTMLElement>('style[id^="addon-css-"], link[id^="addon-css-"]')) {
    if (want.get(l.id) === l.textContent) continue;
    if (l.tagName === "STYLE" && want.has(l.id)) {
      // Replaced, not gone: the id moves to the new sheet; this one is dropped when that one has loaded.
      l.setAttribute("data-addon-stale", l.id);
      l.removeAttribute("id");
      setTimeout(() => l.remove(), STALE_MS);
    } else l.remove();
  }
  for (const [id, text] of want)
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = text;
      const done = () => s.id === id && document.querySelectorAll(`style[data-addon-stale="${id}"]`).forEach((x) => x.remove());
      s.addEventListener("load", done, { once: true });
      s.addEventListener("error", done, { once: true });
      document.head.append(s);
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
