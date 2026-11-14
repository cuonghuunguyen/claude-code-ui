// Size gate (GH-775): fails the build when the entry chunk (the module script of dist/index.html) is over its budget.
// Everything heavy (katex, mermaid, shiki, @pierre/diffs, CodeMirror, the dialogs and panels) is a lazy chunk; a static import that
// pulls one back into the entry shows up here. Raise a budget only with a reason in the commit; prefer a lazy import.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

/**
 * Bytes. Set from the GH-775 build plus about 5% headroom: entry chunk 893,167 raw / 226,553 brotli; the whole first load (the entry and
 * every chunk dist/index.html links to as a module script or modulepreload) 2,245,997 raw.
 */
export const BUDGET = { raw: 940_000, br: 240_000, initial: 2_360_000 };

export function entryOf(dist) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const m = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html) ?? /<script[^>]*src="([^"]+)"[^>]*type="module"/.exec(html);
  if (!m) throw new Error(`no module script in ${join(dist, "index.html")}`);
  return join(dist, m[1].replace(/^\//, ""));
}

export function entrySize(dist) {
  const file = entryOf(dist);
  const raw = statSync(file).size;
  const br = brotliCompressSync(readFileSync(file), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  return { file, raw, br };
}

/** Raw bytes of every script the first load fetches: the entry and its modulepreload links (a shared chunk the entry imports statically). */
export function initialSize(dist) {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const urls = new Set([...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="(\/[^"]+\.js)"/g)].map((m) => m[1]));
  return [...urls].reduce((n, u) => n + statSync(join(dist, u)).size, 0);
}

export function check(dist, budget = BUDGET) {
  const { file, raw, br } = entrySize(dist);
  const initial = initialSize(dist);
  const over = [
    raw > budget.raw && `entry raw ${raw} > ${budget.raw}`,
    br > budget.br && `entry brotli ${br} > ${budget.br}`,
    initial > budget.initial && `first load ${initial} > ${budget.initial}`,
  ].filter(Boolean);
  return { file, raw, br, initial, over };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  const r = check(dist);
  const line = `entry chunk ${r.file.split("/").pop()}: raw ${r.raw} B (budget ${BUDGET.raw}), brotli ${r.br} B (budget ${BUDGET.br}); first load ${r.initial} B (budget ${BUDGET.initial})`;
  if (r.over.length) {
    console.error(`${line}\nbundle over budget: ${r.over.join(", ")}. A static import probably pulls a lazy module back in; make it lazy (React.lazy or import()).`);
    process.exit(1);
  }
  console.log(line);
}
