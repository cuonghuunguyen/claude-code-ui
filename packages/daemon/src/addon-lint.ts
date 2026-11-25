// Addon lint (GH-871, docs/spec.md "Addon lint"): warnings about an addon theme's CSS and manifest. Never blocks an install or an enable.
// The scan is one linear pass without recursion (`skipToken` of addon-css.ts for comments, strings and url()); broken CSS ends it with a
// `css-broken` finding, never an exception. Every look-ahead is bounded (an attribute selector 300 characters, an `@font-face` block up to its next brace).
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { ASSET_LARGE_BYTES, EFFECT_TARGETS, effectAttrs, extendsChain, PARTS, type AddonAssetState, type AddonLint, type AddonManifest, type AddonTheme } from "@claude-ui/protocol";
import { CssScanError, MAX_THEME_CSS, scopeCss, skipToken, themeRoot } from "./addon-css.ts";

const PART_BY_NAME = new Map(PARTS.map((p) => [p.name as string, p]));
const PART_NAMES_LIST = [...PART_BY_NAME.keys()];
/** Css over this size gets a `css-large` warning (the cap is `MAX_THEME_CSS`). */
const LARGE_CSS = 256 * 1024;
/** Edits (insert, delete, replace) between a part name and the nearest known one for a suggestion. */
const SUGGEST_DISTANCE = 2;
/** Findings kept per file: a file full of mistakes does not flood the list. */
const MAX_FINDINGS = 50;
const ATTR_LEAD = /^\[\s{0,8}data-(part|testid)(?![\w-])/i;
const ATTR = /^\[\s*data-part(?![\w-])\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]"']+))(?:\s*([iIsS])(?![\w-]))?)?/i;
const AT = /^@(?:-webkit-)?(keyframes|font-face|property|counter-style|font-palette-values|font-feature-values)(?![\w-])\s*(?:"([^"]*)"|'([^']*)'|([^{;]+))?/i;
const FAMILY = /(?:^|[;\s])font-family\s*:\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i;

type Op = "=" | "~=" | "^=" | "$=" | "*=" | "|=";
type Hit = { pos: number; part?: string; op?: Op; ci?: boolean };

/** Whether an attribute selector `[data-part<op>value]` can match a part of this name. */
const canMatch = (op: Op, value: string, name: string) => (op === "^=" ? name.startsWith(value) : op === "$=" ? name.endsWith(value) : op === "*=" ? name.includes(value) : op === "|=" ? name === value || name.startsWith(`${value}-`) : name === value);
/** The value as the pattern it stands for (`side*`), shown instead of a part name. */
const glob = (op: Op, v: string) => (op === "^=" ? `${v}*` : op === "$=" ? `*${v}` : op === "*=" ? `*${v}*` : `${v}-*`);

/** The part name nearest to `v` within `SUGGEST_DISTANCE` edits (bounded rows: names are at most ~20 characters, so is the compared prefix). */
function nearestPart(v: string): string | undefined {
  const w = v.toLowerCase().slice(0, 40);
  let best: string | undefined;
  let bestD = SUGGEST_DISTANCE + 1;
  for (const name of PART_NAMES_LIST) {
    if (Math.abs(name.length - w.length) > SUGGEST_DISTANCE) continue;
    let prev = Array.from({ length: w.length + 1 }, (_, k) => k);
    for (let a = 1; a <= name.length; a++) {
      const row = [a];
      for (let b = 1; b <= w.length; b++) row.push(Math.min(prev[b]! + 1, row[b - 1]! + 1, prev[b - 1]! + (name[a - 1] === w[b - 1] ? 0 : 1)));
      prev = row;
    }
    const d = prev[w.length]!;
    if (d < bestD) (best = name, (bestD = d));
  }
  return best;
}

/** Findings of one CSS text. `addon`: the addon name (prefix of its global names). `file`: shown in the findings. `theme`: the id of the theme whose `css` it is: the daemon scopes it (so brace errors are `css-broken`) and renames its `@keyframes`, `@counter-style` and `@font-palette-values`, which are then not reported. */
export function lintCss(css: string, addon: string, file: string, theme?: string): AddonLint[] {
  const found: (AddonLint & { pos: number })[] = [];
  const seen = new Set<string>();
  let testid: { pos: number; count: number } | undefined;
  let brokenAt = -1; // position of the scan failure; css-broken is reported when set
  const opens: number[] = []; // positions of the `{` not yet closed, to place a brace error
  let strayClose = -1;
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
        if (c === "}" && opens.pop() === undefined && strayClose < 0) strayClose = i;
        start = -1;
        pending = [];
      } else if (c === "{") {
        opens.push(i);
        for (const h of pending) {
          if (h.part === undefined) testid = testid ? { pos: testid.pos, count: testid.count + 1 } : { pos: h.pos, count: 1 };
          else part(h);
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
              if (m && op && value !== undefined) {
                const ci = m[5]?.toLowerCase() === "i";
                pending.push({ pos: i, part: ci ? value.toLowerCase() : value, op: op as Op, ci });
              }
            }
          }
        }
      }
      i++;
    }
  } catch (e) {
    if (!(e instanceof CssScanError)) throw e;
    brokenAt = i; // the comment or url( that never ends starts here
  }

  /** One `[data-part...]` selector: an unknown name (with the nearest known one), a pattern no part matches, a part that is on its way out. */
  function part(h: Hit) {
    const { part: v = "", op = "=" } = h;
    if (op === "=" || op === "~=") {
      const known = PART_BY_NAME.get(v);
      if (!known) return seen.has(`p:${v}`) || found.length >= MAX_FINDINGS || add({ code: "unknown-part", name: v, suggest: nearestPart(v) }, h.pos, `p:${v}`); // the suggestion is computed only for a finding that is kept
      if (known.deprecated) add({ code: "deprecated-part", name: v, until: known.deprecated }, h.pos, `d:${v}`);
    } else if (v && !PART_NAMES_LIST.some((n) => canMatch(op, v, n))) add({ code: "unknown-part", name: glob(op, v) }, h.pos, `p:${glob(op, v)}`);
  }

  function atRule(prelude: string, brace: number, pos: number) {
    const m = AT.exec(prelude);
    if (!m) return;
    const kind = m[1]!.toLowerCase();
    const name = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (kind === "keyframes" || kind === "counter-style") theme === undefined && name && global(name, name.startsWith(`${addon}-`), `${addon}-${name}`, pos);
    else if (kind === "font-palette-values") theme === undefined && name && global(name, name.startsWith(`--${addon}-`), `--${addon}-${name.replace(/^--/, "")}`, pos);
    else if (kind === "property") name && global(name, name.startsWith(`--${addon}-`), `--${addon}-${name.replace(/^--/, "")}`, pos);
    else if (kind === "font-feature-values") {
      const family = name.replace(/^["']|["']$/g, ""); // the name is a font family, as in @font-face: it is not renamed
      const slug = family.toLowerCase().replace(/\s+/g, "-");
      family && global(family, slug === addon || slug.startsWith(`${addon}-`), `${addon}-${slug}`, pos);
    } else {
      let k = brace + 1; // font-face holds declarations only: the block ends at the next brace outside a comment, string or url()
      while (k < n) {
        const j = skipToken(css, k);
        if (j !== k) k = j;
        else if (css[k] === "}" || css[k] === "{") break;
        else k++;
      }
      const f = FAMILY.exec(css.slice(brace + 1, k));
      const family = (f?.[1] ?? f?.[2] ?? f?.[3] ?? "").trim();
      if (!family) return;
      const slug = family.toLowerCase().replace(/\s+/g, "-");
      global(family, slug === addon || slug.startsWith(`${addon}-`), `${addon}-${slug}`, pos);
    }
  }

  const all: (AddonLint & { pos: number })[] = [...(testid ? [{ level: "warning" as const, code: "selects-testid" as const, file, count: testid.count, pos: testid.pos }] : []), ...found];
  // The brace errors (stray `}`, unclosed block) matter only where the daemon scopes the file: it then serves it empty. Groups nested too deep have no position: the last line.
  if (brokenAt < 0 && theme !== undefined)
    try {
      scopeCss(css, themeRoot(addon, theme));
    } catch {
      brokenAt = strayClose >= 0 ? strayClose : opens.length ? opens[0]! : n;
    }
  if (brokenAt >= 0) all.push({ level: "warning", code: "css-broken", file, pos: brokenAt });
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

/** The bytes of a regular file up to the scan cap (`size`: false when over it, then not read); undefined when it cannot be read or is not a regular file. One open: the checks and the read see the same file. */
function readCss(path: string): { bytes: Buffer } | { size: false } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); // not blocking: a FIFO swapped in cannot stall the daemon
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    if (st.size > MAX_THEME_CSS) return { size: false };
    return { bytes: readFileSync(fd) };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Text pairs of a palette that must reach 4.5:1 (WCAG 2.x AA for body text): `[foreground key, background key]`. `border` is not text and is not checked. */
const TEXT_PAIRS = [["fg", "bg"], ["muted", "bg"], ["fg", "card"], ["pfg", "primary"], ["err", "bg"], ["ok", "bg"], ["warn", "bg"]] as const;
const MIN_CONTRAST = 4.5;

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
/** WCAG 2.x relative luminance of `#rrggbb`, undefined for another form. */
function luminance(hex: unknown): number | undefined {
  const m = typeof hex === "string" ? HEX.exec(hex) : null;
  if (!m) return undefined;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `low-contrast` findings: per theme and mode, the text pairs under 4.5:1. */
function lintContrast(m: AddonManifest): AddonLint[] {
  const out: AddonLint[] = [];
  for (const t of m.themes)
    for (const mode of ["light", "dark"] as const) {
      const pal = t[mode];
      if (!pal) continue;
      for (const [fg, bg] of TEXT_PAIRS) {
        const a = luminance(pal[fg]);
        const b = luminance(pal[bg]);
        if (a === undefined || b === undefined) continue;
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        // Truncated, not rounded: 4.497 must not read "4.5:1" next to a warning that says it is under 4.5.
        if (ratio < MIN_CONTRAST) out.push({ level: "warning", code: "low-contrast", name: `${t.id}: ${fg} on ${bg} ${(Math.floor(ratio * 10) / 10).toFixed(1)}:1 (${mode})` });
      }
    }
  return out;
}

/** Whether each asset file of the manifest exists now, and its size. Same test as the file server (`addonFile`): no dot segment, no link, real path inside the root. */
export function assetStates(root: string, m: AddonManifest): Record<string, AddonAssetState> | undefined {
  if (!m.assets) return undefined;
  const out: Record<string, AddonAssetState> = {};
  for (const [aid, a] of Object.entries(m.assets)) {
    try {
      const path = join(root, a.path);
      if (lstatSync(path).isSymbolicLink()) throw 0;
      const real = realpathSync(path);
      const st = statSync(real);
      if (!inside(realpathSync(root), real) || !st.isFile()) throw 0;
      out[aid] = { present: true, size: st.size };
    } catch {
      out[aid] = { present: false };
    }
  }
  return out;
}

const inside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
};

/** `asset-missing` per declared asset without a file, `asset-large` per file over 2 MB. */
function lintAssets(root: string, m: AddonManifest): AddonLint[] {
  const out: AddonLint[] = [];
  for (const [aid, st] of Object.entries(assetStates(root, m) ?? {})) {
    const file = m.assets![aid]!.path;
    if (!st.present) out.push({ level: "warning", code: "asset-missing", name: aid, file });
    else if (st.size! > ASSET_LARGE_BYTES) out.push({ level: "warning", code: "asset-large", name: aid, file, count: Math.round(st.size! / 1024) });
  }
  return out;
}

/** `extends-missing` per theme whose `extends` cannot be followed (target not found, not running, a loop, deeper than 3): the theme works without its base. `find`: themes of the addons that run in other addons (same-addon targets are found in the manifest itself). */
function lintExtends(m: AddonManifest, find?: (addon: string, theme: string) => AddonTheme | undefined): AddonLint[] {
  const lookup = (addon: string, id: string) => (addon === m.name ? m.themes.find((t) => t.id === id) : find?.(addon, id));
  return m.themes.flatMap((t) => (t.extends !== undefined && extendsChain(m.name, t, lookup).problem ? [{ level: "warning" as const, code: "extends-missing" as const, name: t.id, suggest: t.extends }] : []));
}

/** Findings of an addon: manifest rules (palette contrast), and its CSS files (top-level `css` and every `themes[].css`, each once). A missing or irregular file is skipped (the manifest check reports a missing one). A theme CSS that the daemon cannot scope (unclosed block, stray `}`, groups nested too deep) is served empty, so it gets `css-broken` too. Results are cached by the file content (a hash), so an edit that keeps size and mtime is seen. Assets: `asset-missing` (declared, no file yet: the user fills it; background and slot images alike) and `asset-large` (over 2 MB). `extends-missing`: see `lintExtends`. */
/** `effect-target`: an effect whose target is not `window` nor a v1 effect target (never mounted; `suggest` = the nearest target name). `effect-attr`: an attribute in `when` or `watch` that the target does not publish (never read; `name` = attribute, `suggest` = target). */
function lintEffects(m: AddonManifest): AddonLint[] {
  const out: AddonLint[] = [];
  for (const e of m.effects ?? []) {
    if (!(EFFECT_TARGETS as readonly string[]).includes(e.target)) {
      const near = PART_BY_NAME.has(e.target) ? undefined : nearestPart(e.target);
      out.push({ level: "warning", code: "effect-target", name: e.target, ...(near && (EFFECT_TARGETS as readonly string[]).includes(near) && { suggest: near }) });
      continue;
    }
    const pub = effectAttrs(e.target);
    const named = [...Object.keys(e.when ?? {}).flatMap((k) => (k.startsWith("attr:") ? [k.slice(5)] : [])), ...(e.watch ?? [])];
    for (const a of new Set(named)) if (!pub.includes(a)) out.push({ level: "warning", code: "effect-attr", name: a, suggest: e.target });
  }
  return out;
}

export function lintAddon(root: string, m: AddonManifest, find?: (addon: string, theme: string) => AddonTheme | undefined): AddonLint[] {
  const out: AddonLint[] = [];
  if (m.css && m.themes.length) out.push({ level: "warning", code: "top-level-css", file: m.css });
  out.push(...lintContrast(m));
  out.push(...lintAssets(root, m));
  out.push(...lintExtends(m, find));
  out.push(...lintEffects(m));
  const files = [...new Set([m.css, ...m.themes.map((t) => t.css)].filter((f): f is string => !!f))];
  for (const f of files) {
    const r = readCss(join(root, f));
    if (!r) continue;
    // No line: the file is not read over the cap, so there is no text to count lines in.
    if ("size" in r) {
      out.push({ level: "warning", code: "css-too-large", file: f });
      continue;
    }
    const theme = m.themes.find((t) => t.css === f);
    const key = `${m.name}\0${theme?.id ?? ""}\0${f}\0${createHash("sha1").update(r.bytes).digest("hex")}`; // the role (theme file or not) changes the result
    let l = cache.get(key);
    if (!l) {
      l = lintCss(r.bytes.toString("utf8"), m.name, f, theme?.id);
      if (r.bytes.length > LARGE_CSS) l = [{ level: "warning", code: "css-large", file: f }, ...l];
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, l);
    }
    out.push(...l);
  }
  return out;
}
