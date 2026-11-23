// Scoped theme CSS (GH-868, docs/spec.md "Addon themes and CSS"): the daemon rewrites the CSS file of an addon theme (`themes[].css`)
// when it serves it, so every rule applies only while that theme is picked. The web app loads the result into the addon's cascade layer.
//
// Form: CSS nesting under `:root[data-theme="addon:<name>:<id>"]`. `@scope` was tried first and rejected: inside `@scope (:root[...])` the
// selectors `:root`, `html`, `.dark` and the old prefixed `:root[data-theme=...] .x` match nothing (only `:scope` names the root itself),
// so rewriting is needed either way, and nesting runs on older browsers (Chrome 120, Safari 17.2, Firefox 117 against 118 / 17.4 / 146).

/** The CSS is malformed (an unclosed comment or block, a stray `}`) or over the size cap. The caller serves an empty stylesheet (the theme's palette still applies). */
export class CssScanError extends Error {}

/** Largest theme CSS file the daemon rewrites. */
export const MAX_THEME_CSS = 512 * 1024;

/** At-rules whose block holds style rules: their rules are scoped one level down. */
const GROUPS = new Set(["media", "supports", "container", "layer", "starting-style"]);
/** At-rules that are global by nature: hoisted out of the scope (`@keyframes`, `@font-face`, `@property` have no selector to scope). */
const HOISTED = new Set(["font-face", "keyframes", "-webkit-keyframes", "property", "counter-style", "font-feature-values", "font-palette-values", "namespace"]);

type Stmt = { prelude: string; block?: string };

/** Index after a comment, string or `url(...)` that starts at `i`, else `i` unchanged. */
export function skipToken(t: string, i: number): number {
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
const ROOT_LEAD = /^(?::root|html|:scope)(?![\w-])/i;
const DARK_LEAD = /^(?=\.dark(?![\w-]))/; // class names are case-sensitive
/** Deepest `:where(:is(...))` wrapping that is rewritten (each level re-scans the rest of the selector). */
const MAX_WRAP = 4;
const rootRelative = (sel: string, wrap = 0): string => {
  const s = sel.trim();
  if (s.startsWith("&")) return s;
  // A leading `*` matches every element, the root too: inside the scope it would miss the root, so it is both the root and its descendants.
  if (s.startsWith("*") && !s.startsWith("*|")) return `&${s.slice(1)}, & *${s.slice(1)}`;
  const m = ROOT_LEAD.exec(s) ?? DARK_LEAD.exec(s);
  if (m) return "&" + s.slice(m[0].length);
  // `:where(:root[...].dark)` / `:is(:root, .dark)` at the start: every item that names the root gets the same rewrite inside the wrapper.
  const w = /^:(?:where|is)\(/i.exec(s);
  if (w && wrap < MAX_WRAP) {
    let depth = 1;
    let i = w[0].length;
    while (i < s.length && depth > 0) {
      const j = skipToken(s, i);
      if (j !== i) i = j;
      else {
        const c = s[i];
        if (c === "\\") i++;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        i++;
      }
    }
    if (depth === 0) {
      const items = splitList(s.slice(w[0].length, i - 1)).map((x) => x.trim());
      const out = items.map((x) => rootRelative(x, wrap + 1));
      if (out.every((x, k) => x !== items[k])) return `${w[0]}${out.join(", ")})${s.slice(i)}`;
    }
  }
  return s;
};

/** Deepest `@media`-in-`@media` nesting that is scanned: each level re-scans its block, so depth is capped (real CSS has 2 or 3 levels). */
const MAX_DEPTH = 32;

type Node = { prelude: string; block?: string; kids?: Node[] };

/** The rule tree: group at-rules hold their statements as `kids` (parsed once, then read twice: names first, output second). */
function parse(css: string, depth = 0): Node[] {
  if (depth > MAX_DEPTH) throw new CssScanError("nested too deep");
  return statements(css).map((st) => {
    const name = st.prelude.startsWith("@") ? /^@([\w-]+)/.exec(st.prelude)?.[1]?.toLowerCase() ?? "" : "";
    return GROUPS.has(name) && st.block !== undefined ? { ...st, kids: parse(st.block, depth + 1) } : st;
  });
}

/** Names a theme declares itself, per namespace: old name -> new name. */
type Names = { keyframes: Map<string, string>; counter: Map<string, string>; palette: Map<string, string> };
/** Property -> namespace of the names its value may hold. */
const REF_PROPS: Record<string, keyof Names> = { animation: "keyframes", "animation-name": "keyframes", "list-style": "counter", "list-style-type": "counter", "font-palette": "palette" };
/** Inside `@counter-style` blocks. */
const COUNTER_PROPS: Record<string, keyof Names> = { fallback: "counter", system: "counter" };
const IDENT = /[\w-]/;

const atName = (prelude: string) => /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? "";
/** The one name after an at-rule keyword when it is a plain identifier (a string name is left alone). */
const defName = (prelude: string) => /^@[\w-]+\s+(-{0,2}[A-Za-z_][\w-]*)\s*$/.exec(prelude)?.[1];

function collect(nodes: Node[], prefix: string, names: Names): void {
  for (const n of nodes) {
    if (n.kids) collect(n.kids, prefix, names);
    else if (n.block !== undefined && n.prelude.startsWith("@")) {
      const kind = atName(n.prelude);
      const name = defName(n.prelude);
      if (!name) continue;
      if (kind === "keyframes" || kind === "-webkit-keyframes") names.keyframes.set(name, prefix + name);
      else if (kind === "counter-style") names.counter.set(name, prefix + name);
      else if (kind === "font-palette-values" && name.startsWith("--")) names.palette.set(name, `--${prefix}${name.slice(2)}`);
    }
  }
}

/** `text` (declarations and nested rules) with the identifiers in the values of `props` swapped for their new names. Token level: strings, comments, url() and `var(...)` are left alone. */
function renameRefs(text: string, props: Record<string, keyof Names>, names: Names): string {
  let out = "";
  let last = 0;
  let i = 0;
  let declStart = true;
  const n = text.length;
  while (i < n) {
    const j = skipToken(text, i);
    if (j !== i) {
      i = j;
      declStart = false;
      continue;
    }
    const c = text[i]!;
    if (c === ";" || c === "{" || c === "}") {
      declStart = true;
      i++;
    } else if (c === " " || c === "\n" || c === "\t" || c === "\r") i++;
    else if (declStart && IDENT.test(c)) {
      let k = i;
      while (k < n && IDENT.test(text[k]!)) k++;
      const space = /^\s*:/.exec(text.slice(k, k + 40)); // only whitespace (bounded) between the property and its colon
      const ns = space ? props[text.slice(i, k).toLowerCase().replace(/^-webkit-/, "")] : undefined;
      declStart = false;
      i = k;
      if (!ns || !space) continue;
      const map = names[ns];
      if (!map.size) continue;
      // The value: up to the next `;` or `}` outside strings, urls and parentheses.
      let v = k + space[0].length;
      const valueStart = v;
      let depth = 0;
      while (v < n) {
        const w = skipToken(text, v);
        if (w !== v) v = w;
        else {
          const d = text[v]!;
          if (d === "\\") v += 2;
          else if (d === "(") (depth++, v++);
          else if (d === ")") (depth--, v++);
          else if ((d === ";" || d === "}") && depth <= 0) break;
          else v++;
        }
      }
      v = Math.min(v, n);
      let p = valueStart;
      let value = "";
      let from = valueStart;
      while (p < v) {
        const w = skipToken(text, p);
        if (w !== p) p = w;
        else if (IDENT.test(text[p]!) && !(text[p - 1] === "." || text[p - 1] === "\\")) {
          let e = p;
          while (e < v && IDENT.test(text[e]!)) e++;
          const word = text.slice(p, e);
          const to = map.get(word);
          if (to && !/var\(\s*$/i.test(text.slice(Math.max(valueStart, p - 12), p))) (value += text.slice(from, p) + to, (from = e));
          p = e;
        } else p++;
      }
      out += text.slice(last, valueStart) + value + text.slice(from, v);
      last = v;
      i = v;
    } else {
      declStart = false;
      i++;
    }
  }
  return out + text.slice(last);
}

function render(nodes: Node[], hoist: string[], names: Names | undefined): string {
  const out: string[] = [];
  const fix = (t: string, props = REF_PROPS) => (names ? renameRefs(t, props, names) : t);
  for (const st of nodes) {
    const p = st.prelude;
    if (!p) continue;
    if (p.startsWith("@")) {
      const name = atName(p);
      if (name === "charset" || name === "import") continue; // @charset cannot sit inside a rule; @import is refused (CSP blocks other origins, same-addon import is out of scope)
      if (st.kids) out.push(`${p} {\n${render(st.kids, hoist, names)}\n}`);
      else if (HOISTED.has(name) || (name === "layer" && st.block === undefined)) {
        let head = p;
        const def = defName(p);
        if (names && st.block !== undefined && def) {
          const to = name === "counter-style" ? names.counter.get(def) : name === "font-palette-values" ? names.palette.get(def) : name.endsWith("keyframes") ? names.keyframes.get(def) : undefined;
          if (to) head = p.slice(0, p.length - def.length) + to; // the name ends the prelude
        }
        hoist.push(st.block === undefined ? `${head};` : `${head} {${name === "counter-style" ? fix(st.block, COUNTER_PROPS) : st.block}}`);
      } else out.push(st.block === undefined ? `${p};` : `${p} {${fix(st.block)}}`);
    } else if (st.block !== undefined) out.push(`${splitList(p).map((x) => rootRelative(x)).join(", ")} {${fix(st.block)}}`);
  }
  return out.join("\n");
}

/** `css` rewritten so that it applies only under `root` (a selector for the root element, e.g. `:root[data-theme="addon:x:y"]`). `prefix` (see `themeNames`): the names of the theme's own @keyframes, @counter-style and @font-palette-values get it, and the references to them follow, so they cannot replace a name of the app or of another theme. `baseCss`: texts of the css files of the theme's base chain, whose names the file may reference. Throws `CssScanError`. */
export function scopeCss(css: string, root: string, prefix?: string, baseCss: string[] = []): string {
  if (css.length > MAX_THEME_CSS) throw new CssScanError("too large");
  const tree = parse(css);
  let names: Names | undefined;
  if (prefix) {
    names = { keyframes: new Map(), counter: new Map(), palette: new Map() };
    // `baseCss`: the css of the base themes of an extending theme. They are served under this theme with the same prefix, so the names they define are renamed alike and this file may refer to them. A base file that does not scan is served empty, so it defines nothing.
    for (const b of baseCss) {
      try {
        if (b.length <= MAX_THEME_CSS) collect(parse(b), prefix, names);
      } catch {
        /* served empty */
      }
    }
    collect(tree, prefix, names);
  }
  const hoist: string[] = [];
  const body = render(tree, hoist, names);
  return [...hoist, `${root} {\n${body}\n}`].join("\n") + "\n";
}

/** The prefix of the global names of one theme: `<addon>-<theme>--` (both parts match `^[a-z0-9-]+$`). */
export const themeNames = (addon: string, theme: string) => `${addon}-${theme}--`;

/** The root selector of a theme, as the web app sets it (`data-theme` = `addon:<name>:<id>`; both parts match `^[a-z0-9-]+$`). */
export const themeRoot = (addon: string, theme: string) => `:root[data-theme="addon:${addon}:${theme}"]`;
