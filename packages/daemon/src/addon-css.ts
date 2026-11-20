// Scoped theme CSS (GH-868, docs/spec.md "Addon themes and CSS"): the daemon rewrites the CSS file of an addon theme (`themes[].css`)
// when it serves it, so every rule applies only while that theme is picked. The web app loads the result into the addon's cascade layer.
//
// Form: CSS nesting under `:root[data-theme="addon:<name>:<id>"]`. `@scope` was tried first and rejected: inside `@scope (:root[...])` the
// selectors `:root`, `html`, `.dark` and the old prefixed `:root[data-theme=...] .x` match nothing (only `:scope` names the root itself),
// so rewriting is needed either way, and nesting runs on older browsers (Chrome 120, Safari 17.2, Firefox 117 against 118 / 17.4 / 146).

/** The CSS is malformed (an unclosed comment or block, a stray `}`) or over the size cap. The caller serves the file as it is. */
export class CssScanError extends Error {}

/** Largest theme CSS file the daemon rewrites. */
export const MAX_THEME_CSS = 512 * 1024;

/** At-rules whose block holds style rules: their rules are scoped one level down. */
const GROUPS = new Set(["media", "supports", "container", "layer", "starting-style"]);
/** At-rules that are global by nature: hoisted out of the scope (`@keyframes`, `@font-face`, `@property` have no selector to scope). */
const HOISTED = new Set(["font-face", "keyframes", "-webkit-keyframes", "property", "counter-style", "font-feature-values", "font-palette-values", "namespace"]);

type Stmt = { prelude: string; block?: string };

/** Index after a comment, string or `url(...)` that starts at `i`, else `i` unchanged. */
function skipToken(t: string, i: number): number {
  const c = t[i];
  if (c === "/" && t[i + 1] === "*") {
    const end = t.indexOf("*/", i + 2);
    if (end < 0) throw new CssScanError("unterminated comment");
    return end + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < t.length && t[j] !== c && t[j] !== "\n") j += t[j] === "\\" ? 2 : 1; // an unescaped newline ends a bad string, as in browsers
    return t[j] === c ? j + 1 : Math.min(j, t.length);
  }
  if ((c === "u" || c === "U") && /^url\(\s*[^\s"')]/i.test(t.slice(i, i + 12)) && !/[\w-]/.test(t[i - 1] ?? " ")) {
    const end = t.indexOf(")", i);
    if (end < 0) throw new CssScanError("unterminated url()");
    return end + 1;
  }
  return i;
}

/** Splits a rule list into statements: `prelude;` or `prelude { block }` (the block text without its braces). Comments are dropped. */
function statements(t: string): Stmt[] {
  const out: Stmt[] = [];
  let i = 0;
  let start = 0;
  let prelude = "";
  const flush = (end: number) => (prelude += t.slice(start, end));
  while (i < t.length) {
    const j = skipToken(t, i);
    if (j !== i) {
      if (t[i] === "/") (flush(i), (start = j)); // drop the comment
      i = j;
      continue;
    }
    const c = t[i];
    if (c === "\\") i += 2;
    else if (c === ";") {
      flush(i);
      out.push({ prelude: prelude.trim() });
      prelude = "";
      start = ++i;
    } else if (c === "}") throw new CssScanError("unexpected }");
    else if (c === "{") {
      flush(i);
      let depth = 1;
      let k = i + 1;
      while (k < t.length && depth > 0) {
        const n = skipToken(t, k);
        if (n !== k) k = n;
        else {
          const d = t[k];
          if (d === "\\") k += 2;
          else (d === "{" ? depth++ : d === "}" && depth--, k++);
        }
      }
      if (depth > 0) throw new CssScanError("unclosed block");
      out.push({ prelude: prelude.trim(), block: t.slice(i + 1, k - 1) });
      prelude = "";
      start = i = k;
    } else i++;
  }
  flush(t.length);
  if (prelude.trim()) out.push({ prelude: prelude.trim() }); // a last statement without `;`
  return out;
}

/** A selector list split at its top-level commas (not those inside `()`, `[]` or strings). */
function splitList(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; ) {
    const j = skipToken(sel, i);
    if (j !== i) i = j;
    else {
      const c = sel[i]!;
      if (c === "\\") i++;
      else if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "," && depth === 0) (out.push(sel.slice(start, i)), (start = i + 1));
      i++;
    }
  }
  out.push(sel.slice(start));
  return out;
}

/** The leading compound that names the root element (`:root`, `html`, `:scope`, `.dark`: the app puts `dark` on <html>) becomes `&`, so it still matches the root; everything else stays a descendant of it. */
const ROOT_LEAD = /^(?::root|html|:scope)(?![\w-])|^(?=\.dark(?![\w-]))/i;
const rootRelative = (sel: string) => {
  const s = sel.trim();
  if (s.startsWith("&")) return s;
  const m = ROOT_LEAD.exec(s);
  return m ? "&" + s.slice(m[0].length) : s;
};

/** Deepest `@media`-in-`@media` nesting that is scanned: each level re-scans its block, so depth is capped (real CSS has 2 or 3 levels). */
const MAX_DEPTH = 32;

function scopeRules(css: string, hoist: string[], depth = 0): string {
  if (depth > MAX_DEPTH) throw new CssScanError("nested too deep");
  const out: string[] = [];
  for (const st of statements(css)) {
    const p = st.prelude;
    if (!p) continue;
    if (p.startsWith("@")) {
      const name = /^@([\w-]+)/.exec(p)?.[1]?.toLowerCase() ?? "";
      if (name === "charset" || name === "import") continue; // @charset cannot sit inside a rule; @import is refused (CSP blocks other origins, same-addon import is out of scope)
      const text = st.block === undefined ? `${p};` : `${p} {${st.block}}`;
      if (HOISTED.has(name) || (name === "layer" && st.block === undefined)) hoist.push(text);
      else if (GROUPS.has(name) && st.block !== undefined) out.push(`${p} {\n${scopeRules(st.block, hoist, depth + 1)}\n}`);
      else out.push(text);
    } else if (st.block !== undefined) out.push(`${splitList(p).map(rootRelative).join(", ")} {${st.block}}`);
  }
  return out.join("\n");
}

/** `css` rewritten so that it applies only under `root` (a selector for the root element, e.g. `:root[data-theme="addon:x:y"]`). Throws `CssScanError`. */
export function scopeCss(css: string, root: string): string {
  if (css.length > MAX_THEME_CSS) throw new CssScanError("too large");
  const hoist: string[] = [];
  const body = scopeRules(css, hoist);
  return [...hoist, `${root} {\n${body}\n}`].join("\n") + "\n";
}

/** The root selector of a theme, as the web app sets it (`data-theme` = `addon:<name>:<id>`; both parts match `^[a-z0-9-]+$`). */
export const themeRoot = (addon: string, theme: string) => `:root[data-theme="addon:${addon}:${theme}"]`;
