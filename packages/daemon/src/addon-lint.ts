// Addon lint (GH-871, docs/spec.md "Addon lint"): warnings about an addon theme's CSS and manifest. Never blocks an install or an enable.
// The scan is one linear pass without recursion (`skipToken` of addon-css.ts for comments, strings and url()); broken CSS ends it with a
// `css-broken` finding, never an exception. Every look-ahead is bounded (an attribute selector 300 characters, an `@font-face` block up to its next brace).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PARTS, type AddonLint, type AddonManifest } from "@claude-ui/protocol";
import { CssScanError, MAX_THEME_CSS, skipToken } from "./addon-css.ts";

const PART_SET: ReadonlySet<string> = new Set(PARTS.map((p) => p.name));
/** Findings kept per file: a file full of mistakes does not flood the list. */
const MAX_FINDINGS = 50;
const ATTR_LEAD = /^\[\s{0,8}data-(part|testid)(?![\w-])/i;
const ATTR = /^\[\s*data-part(?![\w-])\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]"']+))(?:\s*([iIsS])(?![\w-]))?)?/i;
const AT = /^@(?:-webkit-)?(keyframes|font-face|property)(?![\w-])\s*(?:"([^"]*)"|'([^']*)'|([^\s{;]+))?/i;
const FAMILY = /(?:^|[;\s])font-family\s*:\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i;

type Hit = { pos: number; part?: string };

/** Findings of one CSS text. `addon`: the addon name (prefix of its global names). `file`: shown in the findings. */
export function lintCss(css: string, addon: string, file: string): AddonLint[] {
  const found: (AddonLint & { pos: number })[] = [];
  const seen = new Set<string>();
  let testid: { pos: number; count: number } | undefined;
  let broken = false;
  const add = (l: Omit<AddonLint, "level" | "file">, pos: number, key: string) => {
    if (seen.has(key) || found.length >= MAX_FINDINGS) return;
    seen.add(key);
    found.push({ level: "warning", ...l, file, pos });
  };
  const global = (name: string, ok: boolean, suggest: string, pos: number) => ok || add({ code: "unprefixed-name", name, suggest }, pos, `n:${name}`);

  const n = css.length;
  let i = 0;
  let start = -1; // first significant character of the current statement
  let pending: Hit[] = []; // attribute selectors seen since the last `;`, `{` or `}`: they are selectors only if a `{` follows
  try {
    while (i < n) {
      const j = skipToken(css, i);
      if (j !== i) {
        if (start < 0 && css[i] !== "/") start = i;
        i = j;
        continue;
      }
      const c = css[i]!;
      if (c === ";" || c === "}") {
        start = -1;
        pending = [];
      } else if (c === "{") {
        for (const h of pending) {
          if (h.part === undefined) testid = testid ? { pos: testid.pos, count: testid.count + 1 } : { pos: h.pos, count: 1 };
          else if (!PART_SET.has(h.part)) add({ code: "unknown-part", name: h.part }, h.pos, `p:${h.part}`);
        }
        if (start >= 0 && css[start] === "@") atRule(css.slice(start, i), i, start);
        start = -1;
        pending = [];
      } else if (c === "\\") {
        if (start < 0) start = i;
        i++;
      } else if (c !== " " && c !== "\n" && c !== "\t" && c !== "\r") {
        if (start < 0) start = i;
        if (c === "[") {
          const lead = ATTR_LEAD.exec(css.slice(i, i + 32));
          if (lead) {
            if (lead[1]!.toLowerCase() === "testid") pending.push({ pos: i });
            else {
              const m = ATTR.exec(css.slice(i, i + 300));
              const op = m?.[1];
              const value = m?.[2] ?? m?.[3] ?? m?.[4];
              if (m && (op === "=" || op === "~=") && value !== undefined) pending.push({ pos: i, part: m[5]?.toLowerCase() === "i" ? value.toLowerCase() : value });
            }
          }
        }
      }
      i++;
    }
  } catch (e) {
    if (!(e instanceof CssScanError)) throw e;
    broken = true;
  }

  function atRule(prelude: string, brace: number, pos: number) {
    const m = AT.exec(prelude);
    if (!m) return;
    const kind = m[1]!.toLowerCase();
    const name = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (kind === "keyframes") name && global(name, name.startsWith(`${addon}-`), `${addon}-${name}`, pos);
    else if (kind === "property") name && global(name, name.startsWith(`--${addon}-`), `--${addon}-${name.replace(/^--/, "")}`, pos);
    else {
      let k = brace + 1; // font-face holds declarations only: the block ends at the next brace
      while (k < n && css[k] !== "}" && css[k] !== "{") k++;
      const f = FAMILY.exec(css.slice(brace + 1, k));
      const family = (f?.[1] ?? f?.[2] ?? f?.[3] ?? "").trim();
      if (!family) return;
      const slug = family.toLowerCase().replace(/\s+/g, "-");
      global(family, slug === addon || slug.startsWith(`${addon}-`), `${addon}-${slug}`, pos);
    }
  }

  const all: (AddonLint & { pos: number })[] = [...(testid ? [{ level: "warning" as const, code: "selects-testid" as const, file, count: testid.count, pos: testid.pos }] : []), ...found];
  if (broken) all.push({ level: "warning", code: "css-broken", file, pos: -1 });
  // Line numbers: one pass over the text for all positions, in order.
  const order = [...all].filter((l) => l.pos >= 0).sort((a, b) => a.pos - b.pos);
  let line = 1;
  let at = 0;
  for (const l of order) {
    for (; at < l.pos; at++) if (css.charCodeAt(at) === 10) line++;
    (l as AddonLint).line = line;
  }
  return all.map(({ pos: _pos, ...l }) => l);
}

const cache = new Map<string, AddonLint[]>();
const CACHE_MAX = 64;

/** Findings of an addon: manifest rules, and its CSS files (top-level `css` and every `themes[].css`, each once). Files are checked by size before they are read; a missing file is skipped (the manifest check reports it). */
export function lintAddon(root: string, m: AddonManifest): AddonLint[] {
  const out: AddonLint[] = [];
  if (m.css && m.themes.length) out.push({ level: "warning", code: "top-level-css", file: m.css });
  const files = [...new Set([m.css, ...m.themes.map((t) => t.css)].filter((f): f is string => !!f))];
  for (const f of files) {
    try {
      const st = statSync(join(root, f));
      if (st.size > MAX_THEME_CSS) {
        out.push({ level: "warning", code: "css-too-large", file: f });
        continue;
      }
      const key = `${root}\0${f}\0${m.name}\0${st.mtimeMs}\0${st.size}`;
      let l = cache.get(key);
      if (!l) {
        l = lintCss(readFileSync(join(root, f), "utf8"), m.name, f);
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, l);
      }
      out.push(...l);
    } catch {
      // unreadable: not a lint matter
    }
  }
  return out;
}
