// Theme vars of an addon theme (docs/site/features/addon-parts.md "Theme vars", docs/spec.md "Addon themes and CSS").
// A var name and value go into a <style> text: the daemon checks a manifest with these functions and the web app checks again before it writes the rule.

/** Custom properties per mode, at most. */
export const MAX_THEME_VARS = 64;
/** `graph` palette key: lane colours of the Git graph (`--graph-1..8`). */
export const ADDON_GRAPH_SIZE = 8;
/** Context meter colours taken from the first of the graph colours. */
export const ADDON_CONTEXT_SIZE = 6;
const MAX_VALUE = 200;

const NAME = /^--[a-z][a-z0-9-]{0,40}$/;
/** Tokens the palette keys set (themes.ts `MAP`, `tokensOf`): a var may not replace them. `--context-*` stay free: they default from `graph` and a theme may set its own. */
const PALETTE_TOKENS = new Set(
  [
    "background", "card", "popover", "secondary", "foreground", "card-foreground", "popover-foreground", "secondary-foreground", "accent-foreground", "ring-progress", "syntax-parameter",
    "muted-foreground", "syntax-punctuation", "ring-track", "tab-separator", "kbd", "primary", "send", "ring", "primary-foreground", "syntax-keyword", "ref-remote", "syntax-string", "syntax-regexp",
    "syntax-function", "syntax-type", "syntax-attribute", "syntax-number", "syntax-constant", "syntax-comment", "syntax-variable", "destructive", "syntax-tag", "syntax-critical", "warning",
    "syntax-builtin", "ref-head", "success", "ref-local", "info", "syntax-operator", "syntax-decorator", "syntax-escape", "muted", "faint", "border", "input", "accent",
  ].map((n) => `--${n}`),
);
const GRAPH_TOKEN = /^--graph-[1-8]$/;
const IMAGE_FN = /(?:^|[^a-z0-9-])(?:url|src|image|image-set|-webkit-image-set|cross-fade|element|paint)\s*\(/i;
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
