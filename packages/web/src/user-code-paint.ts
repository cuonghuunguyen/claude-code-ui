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
/** Tokenized blocks kept: by size (key text 2 bytes a character plus the paint data), not by count. */
let cacheLimit = 8 * 1024 * 1024;
/** Time one line may take (ms): a line that takes this long is cut by shiki, and the block stays plain from that line on. */
const LINE_TIME = 40;
/** A failed shiki or grammar load is tried again after this long (ms). */
export const RETRY_MS = 30_000;
/** A block whose first line was cut (a busy machine, a cold grammar) is tried again after this long (ms), at most CUT_TRIES times. */
export const CUT_RETRY_MS = 3000;
const CUT_TRIES = 3;
/** Ranges painted (or removed) between two clock reads. */
const CHUNK = 100;

const ALIAS = new Map(bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])].map((a) => [a, l.id] as const)));
/** The shiki language of a fence's language (streamdown's mapping); undefined: shown plain. */
const langOf = (l: string | undefined) => ALIAS.get((l ?? "").trim().toLowerCase());

export const paintSupported = () =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function" && typeof StaticRange === "function" && typeof IntersectionObserver === "function";

let shiki: Promise<Highlighter> | undefined;
let ready: Highlighter | undefined;
const loading = new Set<string>();
/** Language -> when it may be loaded again (a failed load, also of shiki itself). */
const failed = new Map<string, number>();
/** The painter's clock (ms); tests move it (`skewClock`, `tickClock`) without touching `performance.now` that React uses. */
let skew = 0;
let tick = 0;
const now = () => performance.now() + (skew += tick);
/** For tests: the painter's clock jumps `ms` ahead. */
export const skewClock = (ms: number) => void (skew += ms);
/** For tests: the painter's clock moves `ms` on every read (a slow machine). */
export const tickClock = (ms: number) => void (tick = ms);
const cooling = (lang: string) => (failed.get(lang) ?? 0) > now();
/** Longer lines stay plain (one shiki call per line: no long task). */
const LINE_MAX = 1000;
/** Blocks half tokenized kept (a block that left the screen goes on where it stopped). */
const PROGRESS_MAX = 20;

/** Paint data of a block: [line, start, end, color] per run of one color. */
type Paint = Int32Array;
const cache = new Map<string, Paint>();
let cacheBytes = 0;
const sizeOf = (key: string, d: Paint) => key.length * 2 + d.byteLength;
function remember(key: string, d: Paint) {
  forget(key);
  cache.set(key, d);
  cacheBytes += sizeOf(key, d);
  // Oldest first; the newest stays even when it alone is over the limit.
  while (cacheBytes > cacheLimit && cache.size > 1) forget(cache.keys().next().value!);
}
function forget(key: string) {
  const d = cache.get(key);
  if (!d) return;
  cache.delete(key);
  cacheBytes -= sizeOf(key, d);
}
/** A block being tokenized: next line, grammar state after the lines before it, runs so far. */
type Progress = { lines: string[]; i: number; state?: GrammarState; out: number[] };
const progress = new Map<string, Progress>();

/** `ranges`: painted (until it leaves the screen); `skip`: cannot be painted (no such language, the DOM is not the plain block). */
type Block = {
  el: HTMLElement;
  key: string;
  lang: string;
  visible: boolean;
  /** Ranges added so far (painting is sliced); `at`: next index in `data`; `done`: all painted. */
  ranges?: [Highlight, StaticRange][];
  data?: Paint;
  at: number;
  done: boolean;
  skip?: boolean;
  /** Not tokenized before this time (now) after a cut first line; `tries`: how often that happened. */
  wait?: number;
  tries: number;
};
const held = (b: Block) => (b.wait ?? 0) > now();
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

/** Pumps at `at` (now); a timer that fires early arms itself again. */
const timers = new Set<ReturnType<typeof setTimeout>>();
function pumpAt(at: number) {
  const id = setTimeout(() => {
    timers.delete(id);
    if (now() < at) pumpAt(at);
    else pump();
  }, Math.max(0, at - now()) + 1);
  timers.add(id);
}

/** Set by the grammar when shiki stopped a line at its time limit (the line's colors and the grammar state after it are wrong). */
let cutSeen = false;
const watched = new WeakSet<object>();
function watchCut(lang: string) {
  const g = ready!.getLanguage(lang as never) as unknown as { tokenizeLine2: (...a: unknown[]) => { stoppedEarly?: boolean } };
  if (watched.has(g)) return;
  watched.add(g);
  const orig = g.tokenizeLine2.bind(g);
  g.tokenizeLine2 = (...a) => {
    const r = orig(...a);
    if (r.stoppedEarly) cutSeen = true;
    return r;
  };
}

/** The lines of a plain streamdown block (`code` > a span per line; an empty line holds "\n"). */
const linesOf = (code: Element) => [...code.children].map((l) => (l.textContent === "\n" ? "" : (l.textContent ?? "")));
/** The code a plain streamdown block shows (the code given to the plugin: trailing newlines trimmed). */
export const codeOf = (code: Element) => linesOf(code).join("\n");

/** "ready" when shiki and the language are loaded; else starts loading them ("wait") and pumps again when done. */
function prepare(lang: string): "ready" | "wait" {
  if (cooling(lang)) return "wait";
  if (ready?.getLoadedLanguages().includes(lang)) return "ready";
  if (loading.has(lang)) return "wait";
  loading.add(lang);
  if (!shiki) {
    const created = createHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
    shiki = created;
    // Only a failed creation makes a new instance: a failed language never does (one instance holds the languages).
    created.catch(() => void (shiki === created && (shiki = undefined)));
  }
  shiki
    .then(async (h) => {
      await h.loadLanguage(lang as never);
      ready = h;
    })
    .catch((e) => {
      // Tried again later (a network blip must not leave the blocks plain until reload).
      const at = now() + RETRY_MS;
      failed.set(lang, at);
      pumpAt(at);
      console.error("[user code] could not load", lang, e);
    })
    .finally(() => {
      loading.delete(lang);
      pump();
    });
  return "wait";
}

/**
 * Tokenizes lines of `b` until `until`; the finished paint data, undefined (not done yet), null (no code element) or "later"
 * (the first line was cut: tried again after CUT_RETRY_MS). A line is cut when shiki stops it at LINE_TIME (its own signal,
 * `stoppedEarly`): the line's colors and the grammar state after it are wrong, so the block stays plain from that line on and
 * is not cached (a later view tokenizes it again).
 */
function tokenize(b: Block, until: number): Paint | undefined | null | "later" {
  let p = progress.get(b.key);
  if (!p) {
    const code = b.el.querySelector("code");
    if (!code) return null;
    p = { lines: linesOf(code), i: 0, out: [] };
    progress.set(b.key, p);
    if (progress.size > PROGRESS_MAX) progress.delete(progress.keys().next().value!);
  }
  watchCut(b.lang);
  let cut = false;
  do {
    const line = p.lines[p.i]!;
    // A cut line is tried once more: the first run of a grammar compiles its regular expressions, the second is fast.
    let r: ReturnType<Highlighter["codeToTokens"]> | undefined;
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      cutSeen = false;
      const x = ready!.codeToTokens(line, { lang: b.lang as never, themes: THEMES, grammarState: p.state, tokenizeMaxLineLength: LINE_MAX, tokenizeTimeLimit: LINE_TIME });
      if (!cutSeen) r = x;
    }
    if (!r) {
      cut = true;
      break;
    }
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
  } while (p.i < p.lines.length && now() < until);
  if (!cut && p.i < p.lines.length) return undefined;
  progress.delete(b.key);
  if (cut && !p.i && ++b.tries < CUT_TRIES) {
    b.wait = now() + CUT_RETRY_MS;
    pumpAt(b.wait);
    return "later";
  }
  const paint = Int32Array.from(p.out);
  if (!cut) remember(b.key, paint);
  return paint;
}

/** Adds the block's ranges (its plain text nodes, untouched) until `until`: "more", "done", or "bad" (the DOM is not the plain block it was). */
function paint(b: Block, data: Paint, until: number): "more" | "done" | "bad" {
  const code = b.el.querySelector("code");
  if (!code) return "bad";
  const lines = [...code.children];
  const ranges = (b.ranges ??= []);
  for (let i = b.at, n = 0; i < data.length; i += 4, n++) {
    if (n && n % CHUNK === 0 && now() >= until) return "more";
    const line = lines[data[i]!];
    let node = line?.firstChild ?? null;
    while (node && !(node instanceof Text)) node = node.firstChild;
    if (!(node instanceof Text) || node.length < data[i + 2]!) return "bad";
    const [light, dark] = palette[data[i + 3]!]!;
    const h = highlightFor(light, dark);
    const r = new StaticRange({ startContainer: node, startOffset: data[i + 1]!, endContainer: node, endOffset: data[i + 2]! });
    h.add(r);
    ranges.push([h, r]);
    b.at = i + 4;
  }
  return "done";
}

/** Gives the ranges of a block that left the screen (or page) to the next slot to remove. */
function release(b: Block) {
  if (b.ranges) stale.push(...b.ranges);
  b.ranges = b.data = undefined;
  b.at = 0;
  b.done = false;
}

/** A block on screen still to paint. */
function nextBlock() {
  for (const b of blocks.values()) if (b.visible && !b.done && !b.skip && !cooling(b.lang) && !held(b)) return b;
  return undefined;
}
/** The block on screen to paint first: the one nearest the middle of the viewport. */
function pickBlock() {
  let best: Block | undefined;
  let bestDist = Infinity;
  const mid = (globalThis.innerHeight ?? 0) / 2;
  for (const b of blocks.values()) {
    if (!b.visible || b.done || b.skip || cooling(b.lang) || held(b)) continue;
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
    try {
      if (sinceUserScroll() >= SCROLL_REST) work(now() + (d && !d.didTimeout ? Math.min(IDLE_SLICE, Math.max(1, d.timeRemaining())) : SLICE));
    } catch (e) {
      console.error("[user code] painting failed", e);
    } finally {
      // Whatever happened in this slot, the next one runs.
      again();
    }
  };
  // A slice is at most IDLE_SLICE ms of an idle period (no long task); between slices the browser renders and handles input.
  if ("requestIdleCallback" in globalThis) requestIdleCallback(run, { timeout: 200 });
  else setTimeout(run, 16);
}

/** Removes stale ranges (a slice of them) until `until`; true when none are left. */
function sweep(until: number) {
  while (stale.length) {
    for (const [h, r] of stale.splice(0, CHUNK)) h.delete(r);
    if (now() >= until) break;
  }
  return !stale.length;
}

/** Paints blocks on screen (nearest the middle first) until `until`. */
function work(until: number) {
  if (!sweep(until)) return;
  for (let b = pickBlock(); b && now() < until; b = pickBlock()) {
    try {
      let data: Paint | null | undefined = b.data;
      if (!data) {
        data = cache.get(b.key);
        if (data) remember(b.key, data);
        else {
          if (prepare(b.lang) === "wait") return;
          const t = tokenize(b, until);
          if (t === undefined) return;
          if (t === "later") continue;
          data = t;
        }
      }
      // The DOM is not the plain block (streamdown colored it after all): leave it.
      const result = data ? paint(b, (b.data = data), until) : "bad";
      if (result === "more") return;
      if (result === "bad") (release(b), (b.skip = true));
      else (b.done = true, (b.data = undefined));
    } catch (e) {
      // One block that fails (a bad range, a grammar error) stays plain; the others go on.
      console.error("[user code] could not paint a block", e);
      progress.delete(b.key);
      release(b);
      b.skip = true;
    }
  }
}

function observer() {
  return (io ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      const b = blocks.get(e.target as HTMLElement);
      if (!b) continue;
      b.visible = e.isIntersecting;
      if (!b.visible) release(b);
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
  blocks.set(el, { el, key: `${lang}\0${codeOf(code)}`, lang, visible: false, at: 0, done: false, tries: 0 });
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
  release(b);
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
  cacheBytes = 0;
  for (const id of timers) clearTimeout(id);
  timers.clear();
  cacheLimit = 8 * 1024 * 1024;
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

/** For tests: what the token cache holds. */
export const cacheStats = () => ({ entries: cache.size, bytes: cacheBytes });
/** For tests: the cache size limit in bytes (reset to the default by `resetUserCodePaint`). */
export const limitCache = (bytes: number) => void (cacheLimit = bytes);
/** For tests: whether `el` (a watched block) is completely painted. */
export const isPainted = (el: HTMLElement) => blocks.get(el)?.done === true;
/** For tests: shiki is created anew (and its languages loaded again) on next use. */
export function resetShiki() {
  shiki = ready = undefined;
  loading.clear();
}
