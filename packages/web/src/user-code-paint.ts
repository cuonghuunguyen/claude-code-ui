import { bundledLanguagesInfo, createHighlighter, type GrammarState, type Highlighter, type ThemedToken } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { sinceUserScroll } from "./scroll-rest.ts";

/**
 * Syntax colors for long code blocks in user messages, painted over the plain block with the CSS Custom Highlight API
 * (GH-188). Streamdown colors a block by rendering one span per token: for a prompt with a few KB of code that is a
 * 100-250 ms task on every mount, and the virtual timeline mounts a row each time it scrolls into view. Here the block
 * stays plain DOM (one text node per line, as cheap as uncolored code) and the colors are ranges over its text nodes:
 * - only blocks on screen (IntersectionObserver), not the overscan rows around them; a block that leaves the screen drops its
 *   ranges (few ranges in the registry keep each change cheap);
 * - only once the user has not scrolled a timeline for SCROLL_REST ms (`scroll-rest.ts`);
 * - tokenized line by line in idle periods (at most IDLE_SLICE ms each), so no long task; tokens are cached, a block seen before is
 *   painted again from the cache (creating ranges, no tokenizing);
 * - the text nodes are never replaced, so a selection in the block stays as it is.
 * Browsers without `CSS.highlights` show these blocks plain.
 */

/** Painting waits until the user has not scrolled a timeline for this long (ms). */
export const SCROLL_REST = 500;
/** Work per slot (ms) when the browser gives no idle deadline; with one, up to IDLE_SLICE of it (below a 50 ms long task). */
const SLICE = 8;
const IDLE_SLICE = 30;
const THEMES = { light: "github-light", dark: "github-dark" } as const;
/** Tokenized blocks kept (by language and code). */
const CACHE_MAX = 300;

const ALIAS = new Map(bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])].map((a) => [a, l.id] as const)));
/** The shiki language of a fence's language (streamdown's mapping); undefined: shown plain. */
const langOf = (l: string | undefined) => ALIAS.get((l ?? "").trim().toLowerCase());

export const paintSupported = () =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function" && typeof StaticRange === "function" && typeof IntersectionObserver === "function";

let shiki: Promise<Highlighter> | undefined;
let ready: Highlighter | undefined;
const loading = new Set<string>();
const failed = new Set<string>();
/** Longer lines stay plain (one shiki call per line: no long task). */
const LINE_MAX = 1000;
/** Blocks half tokenized kept (a block that left the screen goes on where it stopped). */
const PROGRESS_MAX = 20;

/** Paint data of a block: [line, start, end, color] per run of one color. */
type Paint = Int32Array;
const cache = new Map<string, Paint>();
/** A block being tokenized: next line, grammar state after the lines before it, runs so far. */
type Progress = { lines: string[]; i: number; state?: GrammarState; out: number[] };
const progress = new Map<string, Progress>();

/** `ranges`: painted (until it leaves the screen); `skip`: cannot be painted (no such language, the DOM is not the plain block). */
type Block = { el: HTMLElement; key: string; lang: string; visible: boolean; ranges?: [Highlight, StaticRange][]; skip?: boolean };
const blocks = new Map<HTMLElement, Block>();
/** Ranges of blocks that left the screen or the page; removed from the highlights in a slot after the scroll, not during it. */
const stale: [Highlight, StaticRange][] = [];
let io: IntersectionObserver | undefined;

/** One Highlight per light/dark color pair: `::highlight(user-code-N)`. */
const colors = new Map<string, Highlight>();
let sheet: CSSStyleSheet | undefined;
function highlightFor(light: string, dark: string) {
  const pair = `${light}|${dark}`;
  let h = colors.get(pair);
  if (h) return h;
  const name = `user-code-${colors.size}`;
  h = new Highlight();
  colors.set(pair, h);
  CSS.highlights.set(name, h);
  if (!sheet) {
    const style = document.createElement("style");
    style.dataset.userCode = "";
    document.head.append(style);
    sheet = style.sheet!;
  }
  try {
    sheet.insertRule(`::highlight(${name}) { color: ${light}; }`, sheet.cssRules.length);
    sheet.insertRule(`.dark ::highlight(${name}) { color: ${dark}; }`, sheet.cssRules.length);
  } catch {
    // A parser without ::highlight (tests): the ranges stay, unpainted.
  }
  return h;
}
const palette: [string, string][] = [];
const paletteIndex = new Map<string, number>();
function colorOf(t: ThemedToken) {
  const light = (t.htmlStyle?.color as string | undefined) ?? t.color ?? "";
  const dark = (t.htmlStyle?.["--shiki-dark"] as string | undefined) ?? light;
  const pair = `${light}|${dark}`;
  let i = paletteIndex.get(pair);
  if (i === undefined) paletteIndex.set(pair, (i = palette.push([light, dark]) - 1));
  return i;
}

/** The lines of a plain streamdown block (`code` > a span per line; an empty line holds "\n"). */
const linesOf = (code: Element) => [...code.children].map((l) => (l.textContent === "\n" ? "" : (l.textContent ?? "")));
/** The code a plain streamdown block shows (the code given to the plugin: trailing newlines trimmed). */
export const codeOf = (code: Element) => linesOf(code).join("\n");

/** "ready" when shiki and the language are loaded; else starts loading them ("wait") and pumps again when done. */
function prepare(lang: string): "ready" | "wait" | "fail" {
  if (failed.has(lang)) return "fail";
  if (ready?.getLoadedLanguages().includes(lang)) return "ready";
  if (loading.has(lang)) return "wait";
  loading.add(lang);
  shiki ??= createHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  shiki
    .then(async (h) => {
      await h.loadLanguage(lang as never);
      ready = h;
    })
    .catch((e) => {
      failed.add(lang);
      console.error("[user code] could not load", lang, e);
    })
    .finally(() => {
      loading.delete(lang);
      pump();
    });
  return "wait";
}

/** Tokenizes lines of `b` until `until`; the finished paint data, undefined (not done yet) or null (no code element). */
function tokenize(b: Block, until: number): Paint | undefined | null {
  let p = progress.get(b.key);
  if (!p) {
    const code = b.el.querySelector("code");
    if (!code) return null;
    p = { lines: linesOf(code), i: 0, out: [] };
    progress.set(b.key, p);
    if (progress.size > PROGRESS_MAX) progress.delete(progress.keys().next().value!);
  }
  do {
    const line = p.lines[p.i]!;
    const r = ready!.codeToTokens(line, { lang: b.lang as never, themes: THEMES, grammarState: p.state, tokenizeMaxLineLength: LINE_MAX,
      // No time limit: a line cut short leaves a wrong grammar state and wrong colors for the rest of the block (a slow
      // device hit the default per-line limit). LINE_MAX bounds a line's work instead.
      tokenizeTimeLimit: 0,
    });
    p.state = r.grammarState;
    let at = 0;
    for (const t of r.tokens[0] ?? []) {
      const end = at + t.content.length;
      if (t.content.trim()) {
        const c = colorOf(t);
        const o = p.out;
        // A run of one color (spaces between tokens join it): one range.
        if (o.length && o[o.length - 4] === p.i && o[o.length - 1] === c) o[o.length - 2] = end;
        else o.push(p.i, at, end, c);
      }
      at = end;
    }
    p.i++;
  } while (p.i < p.lines.length && performance.now() < until);
  if (p.i < p.lines.length) return undefined;
  progress.delete(b.key);
  const paint = Int32Array.from(p.out);
  cache.set(b.key, paint);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return paint;
}

/** Adds the block's ranges (its plain text nodes, untouched). False when the DOM is not the plain block it was. */
function paint(b: Block, data: Paint) {
  const code = b.el.querySelector("code");
  if (!code) return false;
  const lines = [...code.children];
  const ranges: [Highlight, StaticRange][] = [];
  for (let i = 0; i < data.length; i += 4) {
    const line = lines[data[i]!];
    let node = line?.firstChild ?? null;
    while (node && !(node instanceof Text)) node = node.firstChild;
    if (!(node instanceof Text) || node.length < data[i + 2]!) return false;
    const [light, dark] = palette[data[i + 3]!]!;
    ranges.push([highlightFor(light, dark), new StaticRange({ startContainer: node, startOffset: data[i + 1]!, endContainer: node, endOffset: data[i + 2]! })]);
  }
  for (const [h, r] of ranges) h.add(r);
  b.ranges = ranges;
  return true;
}

/** A block on screen still to paint. */
function nextBlock() {
  for (const b of blocks.values()) if (b.visible && !b.ranges && !b.skip) return b;
  return undefined;
}
/** The block on screen to paint first: the one nearest the middle of the viewport. */
function pickBlock() {
  let best: Block | undefined;
  let bestDist = Infinity;
  const mid = (globalThis.innerHeight ?? 0) / 2;
  for (const b of blocks.values()) {
    if (!b.visible || b.ranges || b.skip) continue;
    const r = b.el.getBoundingClientRect();
    const dist = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
    if (dist < bestDist) (best = b), (bestDist = dist);
  }
  return best;
}

let scheduled = false;
let epoch = 0;
function pump() {
  // While shiki or a language loads, its `finally` pumps again.
  if (scheduled || loading.size || (!nextBlock() && !stale.length) || !paintSupported()) return;
  scheduled = true;
  const mine = epoch;
  const rest = SCROLL_REST - sinceUserScroll();
  const again = () => {
    if (mine !== epoch) return;
    scheduled = false;
    pump();
  };
  if (rest > 0) return void setTimeout(again, rest);
  const run = (d?: IdleDeadline) => {
    if (mine !== epoch) return;
    if (sinceUserScroll() >= SCROLL_REST) work(performance.now() + (d && !d.didTimeout ? Math.min(IDLE_SLICE, Math.max(1, d.timeRemaining())) : SLICE));
    again();
  };
  // A slice is at most IDLE_SLICE ms of an idle period (no long task); between slices the browser renders and handles input.
  if ("requestIdleCallback" in globalThis) requestIdleCallback(run, { timeout: 200 });
  else setTimeout(run, 16);
}

/** Paints blocks on screen (nearest the middle first) until `until`. */
function work(until: number) {
  for (const [h, r] of stale.splice(0)) h.delete(r);
  for (let b = pickBlock(); b && performance.now() < until; b = pickBlock()) {
    let data: Paint | null | undefined = cache.get(b.key);
    if (data) {
      cache.delete(b.key);
      cache.set(b.key, data);
    } else {
      const state = prepare(b.lang);
      if (state === "wait") return;
      data = state === "ready" ? tokenize(b, until) : null;
      if (data === undefined) return;
    }
    // The DOM is not the plain block (streamdown colored it after all): leave it.
    if (!data || !paint(b, data)) b.skip = true;
  }
}

function observer() {
  return (io ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      const b = blocks.get(e.target as HTMLElement);
      if (!b) continue;
      b.visible = e.isIntersecting;
      if (!b.visible && b.ranges) (stale.push(...b.ranges), (b.ranges = undefined));
    }
    pump();
  }));
}

/** Paints `el` (a plain `[data-streamdown=code-block]`) once it is on screen. */
export function watchBlock(el: HTMLElement) {
  if (blocks.has(el) || !paintSupported()) return;
  const lang = langOf(el.dataset.language);
  const code = el.querySelector("code");
  if (!lang || lang === "text" || !code) return;
  blocks.set(el, { el, key: `${lang}\0${codeOf(code)}`, lang, visible: false });
  observer().observe(el);
  // Load shiki and the grammar now (asynchronous, no tokenizing): the block is painted sooner once the scroll rests.
  prepare(lang);
}

/** `el` left the page (its row unmounted, or its text changed): stop watching, drop its ranges in an idle slot. */
export function unwatchBlock(el: HTMLElement) {
  const b = blocks.get(el);
  if (!b) return;
  blocks.delete(el);
  io?.unobserve(el);
  if (b.ranges) stale.push(...b.ranges);
  pump();
}

/** For tests. */
export function resetUserCodePaint() {
  epoch++;
  scheduled = false;
  for (const el of [...blocks.keys()]) io?.unobserve(el);
  blocks.clear();
  stale.length = 0;
  progress.clear();
  cache.clear();
  failed.clear();
  io = undefined;
  for (const h of colors.values()) h.clear();
  colors.clear();
  sheet?.ownerNode?.remove();
  sheet = undefined;
  if (paintSupported()) for (const name of [...CSS.highlights.keys()]) if (name.startsWith("user-code-")) CSS.highlights.delete(name);
}

/** For tests: the "light|dark" color pair a highlight paints. */
export const pairOf = (h: Highlight) => [...colors].find(([, x]) => x === h)?.[0];
