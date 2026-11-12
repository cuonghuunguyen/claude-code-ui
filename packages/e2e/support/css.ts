// CSS selector helpers for paths. No Playwright import.

/** Escapes a value for a double-quoted CSS attribute selector (Windows paths hold backslashes). */
export const cssStr = (s: string): string => s.replace(/["\\]/g, "\\$&");

/** Matches an attribute that ends in `rel` with either separator: WSL-side projects use `/` on a Windows host. */
export const endsWithPath = (attr: string, rel: string): string =>
  `:is([${attr}$="/${cssStr(rel)}"],[${attr}$="${cssStr("\\" + rel.replaceAll("/", "\\"))}"])`;
