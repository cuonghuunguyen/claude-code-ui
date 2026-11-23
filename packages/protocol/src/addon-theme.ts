// Theme vars of an addon theme (docs/site/features/addons.md "Themes", docs/spec.md Addons "Theme vars").
// A var name and value go into a <style> text: the daemon checks a manifest with these functions and the web app checks again before it writes the rule.
import type { AddonThemeOption } from "./wire.ts";

/** Custom properties per mode, at most. */
export const MAX_THEME_VARS = 64;
/** `graph` palette key: lane colours of the Git graph (`--graph-1..8`). */
export const ADDON_GRAPH_SIZE = 8;
/** Context meter colours taken from the first of the graph colours. */
export const ADDON_CONTEXT_SIZE = 6;
const MAX_VALUE = 200;

const NAME = /^--[a-z][a-z0-9-]{0,40}$/;
/** Tokens the palette keys set (themes.ts `MAP`, `tokensOf`): a var may not replace them. `--context-*` stay free: they default from `graph` and a theme may set its own. */
export const PALETTE_TOKENS: ReadonlySet<string> = new Set(
  [
    "background", "card", "popover", "secondary", "foreground", "card-foreground", "popover-foreground", "secondary-foreground", "accent-foreground", "ring-progress", "syntax-parameter",
    "muted-foreground", "syntax-punctuation", "ring-track", "tab-separator", "kbd", "primary", "send", "ring", "primary-foreground", "syntax-keyword", "ref-remote", "syntax-string", "syntax-regexp",
    "syntax-function", "syntax-type", "syntax-attribute", "syntax-number", "syntax-constant", "syntax-comment", "syntax-variable", "destructive", "syntax-tag", "syntax-critical", "warning",
    "syntax-builtin", "ref-head", "success", "ref-local", "info", "syntax-operator", "syntax-decorator", "syntax-escape", "muted", "faint", "border", "input", "accent",
  ].map((n) => `--${n}`),
);
const GRAPH_TOKEN = /^--graph-[1-8]$/;
const IMAGE_FN = /(?:^|[^a-z0-9_])(?:-(?:webkit|moz)-)?(?:url|src|image|image-set|cross-fade|element|paint)\s*\(/i;
const CLOSER: Record<string, string> = { "(": ")", "[": "]" };

/** Why a var name is refused, else undefined. */
export function varNameError(name: string): string | undefined {
  if (!NAME.test(name)) return "var name must match --[a-z][a-z0-9-]* (up to 41 characters after the dashes)";
  if (PALETTE_TOKENS.has(name) || GRAPH_TOKEN.test(name)) return "palette token: set it with a palette key (graph for --graph-*)";
  return undefined;
}

/** Why a var value is refused, else undefined: up to 200 characters; no `; { } < > \` newline, control character or comment opener; no image-loading function (images go through background and slots); no `@`; parentheses, brackets and quotes balanced. One linear pass. */
export function varValueError(v: string): string | undefined {
  if (v === "" || v.length > MAX_VALUE) return `var value must be 1-${MAX_VALUE} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[;{}<>\\@\u0000-\u001f\u007f]/.test(v) || v.includes("/*")) return "var value has a character that is not allowed (; { } < > \\ @ newline /*)";
  if (IMAGE_FN.test(v)) return "var value may not load an image (url, image-set, ...): use the background field";
  const stack: string[] = [];
  let quote = "";
  for (const ch of v) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") stack.push(CLOSER[ch]!);
    else if (ch === ")" || ch === "]") {
      if (stack.pop() !== ch) return "var value has unbalanced brackets";
    }
  }
  return quote || stack.length ? "var value has an unclosed quote or bracket" : undefined;
}

/** Theme options at most. */
export const MAX_THEME_OPTIONS = 8;
export const MAX_SELECT_CHOICES = 12;
export const MIN_SELECT_CHOICES = 2;
/** Assets at most per addon. */
export const MAX_ADDON_ASSETS = 16;
/** Over this size an asset gets an `asset-large` lint finding. */
export const ASSET_LARGE_BYTES = 2 * 1024 * 1024;
/** Image types an asset may have. */
export const ASSET_EXT = /\.(?:png|jpe?g|webp|avif|gif|svg)$/i;
const CHOICE = /^[a-z0-9-]{1,40}$/;
const HEX6 = /^#[0-9a-f]{6}$/i;
const BOUND = 1e9;
/** At most 3 decimals and a sane size: the number is written as is into a <style> text. */
export const numberOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= BOUND && Math.round(n * 1000) / 1000 === n;

/** The effective type of an option (`type` absent = boolean). */
export const optionType = (o: AddonThemeOption): "boolean" | "select" | "range" | "color" => o.type ?? "boolean";

/** The value an option has before the user changes it: boolean on unless `default: false`; select its `default` if it is a choice, else the first; range and color their `default`. */
export function optionDefault(o: AddonThemeOption): boolean | string | number {
  switch (o.type) {
    case "select":
      return o.choices.some((c) => c.value === o.default) ? o.default! : (o.choices[0]?.value ?? "");
    case "range":
    case "color":
      return o.default;
    default:
      return o.default ?? true;
  }
}

/** `v` when it is a valid value of the option (boolean: a boolean; select: a choice; range: a number inside min..max; color: `#rrggbb`), else the option's default. A stored value is never trusted. */
export function optionValue(o: AddonThemeOption, v: unknown): boolean | string | number {
  switch (o.type) {
    case "select":
      return typeof v === "string" && o.choices.some((c) => c.value === v) ? v : optionDefault(o);
    case "range":
      return typeof v === "number" && Number.isFinite(v) && v >= o.min && v <= o.max ? v : optionDefault(o);
    case "color":
      return typeof v === "string" && HEX6.test(v) ? v.toLowerCase() : optionDefault(o);
    default:
      return typeof v === "boolean" ? v : optionDefault(o);
  }
}

/** The `--opt-<id>` value written into the style text: boolean `0`/`1`, select the choice (checked against the choices), range the number, color the hex. Undefined when the option itself is malformed (the rule is then left out). */
export function optionCss(o: AddonThemeOption, v: boolean | string | number): string | undefined {
  const x = optionValue(o, v);
  switch (o.type) {
    case "select":
      return CHOICE.test(String(x)) ? String(x) : undefined;
    case "range":
      return numberOk(x) ? String(x) : undefined;
    case "color":
      return HEX6.test(String(x)) ? String(x).toLowerCase() : undefined;
    default:
      return x ? "1" : "0";
  }
}

/** Why the option's type fields are refused, else undefined: select 2..12 choices (`value` `[a-z0-9-]+` and unique); range finite `min < max`, `step > 0`, `default` inside, 3 decimals at most; color `#rrggbb`. Used by the daemon on `addon.json`. */
export function optionError(o: Record<string, unknown>): string | undefined {
  const type = o.type ?? "boolean";
  if (type === "boolean") return o.default !== undefined && typeof o.default !== "boolean" ? "default: must be true or false" : o.choices !== undefined || o.min !== undefined ? "choices, min and max are for select and range" : undefined;
  if (type === "select") {
    const c = o.choices;
    if (!Array.isArray(c) || c.length < MIN_SELECT_CHOICES || c.length > MAX_SELECT_CHOICES) return `choices: ${MIN_SELECT_CHOICES} to ${MAX_SELECT_CHOICES} entries {value, label}`;
    const seen = new Set<string>();
    for (const x of c) {
      if (typeof x !== "object" || x === null || typeof (x as { value?: unknown }).value !== "string" || !CHOICE.test((x as { value: string }).value)) return "choices[].value: must match [a-z0-9-]+ (up to 40 characters)";
      const { value, label } = x as { value: string; label?: unknown };
      if (typeof label !== "string" || label === "" || label.length > 40) return "choices[].label: required text up to 40 characters";
      if (seen.has(value)) return `choices: duplicate value ${value}`;
      seen.add(value);
    }
    return o.default !== undefined && (typeof o.default !== "string" || !seen.has(o.default)) ? "default: must be one of the choices" : undefined;
  }
  if (type === "range") {
    if (![o.min, o.max, o.step, o.default].every(numberOk)) return "min, max, step and default: numbers with up to 3 decimals";
    const { min, max, step, default: d } = o as { min: number; max: number; step: number; default: number };
    if (!(min < max)) return "min must be less than max";
    if (!(step > 0)) return "step must be greater than 0";
    return d < min || d > max ? "default must be inside min..max" : undefined;
  }
  if (type === "color") return typeof o.default === "string" && HEX6.test(o.default) ? undefined : "default: required colour as #rrggbb";
  return "type: must be boolean, select, range or color";
}
