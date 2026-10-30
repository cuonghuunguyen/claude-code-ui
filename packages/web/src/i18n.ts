// UI language: a message catalog per locale (i18n/<code>/index.ts), English the source and the fallback.
// The language follows the browser (`navigator.languages`) by default, or a pick in Settings kept in this browser.
// A new language is one more i18n/<code>/ folder: it is found by the glob below, offered in Settings under its `name`.
import { useSyncExternalStore } from "react";
import en from "./i18n/en/index.ts";

/** A count-dependent message: one form per `Intl.PluralRules` category the language uses; `other` always. */
export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Message = string | Plural;
export type Key = keyof typeof en.messages;
export type Messages = Record<Key, Message>;
/** A locale's catalog. A key it lacks shows the English text (i18n.test.ts holds every shipped locale complete). */
export type Catalog = { name: string; messages: Partial<Messages> };
export type Vars = Record<string, string | number>;

const found = import.meta.glob<{ default: Catalog }>("./i18n/*/index.ts", { eager: true });
export const LOCALES: Record<string, Catalog> = Object.fromEntries(
  Object.entries(found).map(([path, mod]) => [path.split("/")[2], mod.default]),
);
export type LocalePref = "system" | string;

const KEY = "claude-ui.locale";

/** The first browser language with a catalog (by its primary subtag: `vi-VN` -> `vi`), else English. */
export function browserLocale(langs: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]): string {
  for (const l of langs) {
    const code = l.toLowerCase().split("-")[0];
    if (LOCALES[code]) return code;
  }
  return "en";
}

export const resolveLocale = (pref: LocalePref) => (pref !== "system" && LOCALES[pref] ? pref : browserLocale());

function loadPref(): LocalePref {
  try {
    const v = localStorage.getItem(KEY);
    return v && LOCALES[v] ? v : "system";
  } catch {
    return "system";
  }
}

/** The text of `key` in `locale`: plural form by `vars.count`, `{name}` placeholders filled from `vars`. */
export function translate(locale: string, key: Key, vars?: Vars): string {
  const m = LOCALES[locale]?.messages[key] ?? en.messages[key];
  // Unreachable through the Key type; a stale key from outside the type shows nothing rather than the raw key.
  if (m === undefined) return "";
  const text = typeof m === "string" ? m : (m[new Intl.PluralRules(locale).select(Number(vars?.count ?? 0))] ?? m.other);
  return vars ? text.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all)) : text;
}

let pref = loadPref();
let locale = resolveLocale(pref);
const listeners = new Set<() => void>();

function apply() {
  locale = resolveLocale(pref);
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  for (const l of listeners) l();
}
apply();
// "System" follows a browser language change without a reload.
if (typeof window !== "undefined") window.addEventListener("languagechange", () => pref === "system" && apply());

/** A user pick ("system" = follow the browser): applied at once and kept in this browser. */
export function setLocalePref(next: LocalePref) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
  pref = next;
  apply();
}

export const getLocale = () => locale;
export const getLocalePref = () => pref;

/** Text in the current language, for code outside render (toasts, notifications, titles). In a component use `useT`. */
export const t = (key: Key, vars?: Vars) => translate(locale, key, vars);

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** `t` for a component: re-renders it when the language changes. */
export function useT() {
  useSyncExternalStore(subscribe, getLocale, getLocale);
  return t;
}

/** The pick and the language in use, for the Settings picker. */
export function useLocale() {
  const current = useSyncExternalStore(subscribe, getLocale, getLocale);
  return { locale: current, pref: useSyncExternalStore(subscribe, getLocalePref, getLocalePref) };
}
