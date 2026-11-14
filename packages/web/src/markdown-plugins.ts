import { cjk } from "@streamdown/cjk";
import type { code as codePlugin } from "@streamdown/code";
import type { math as mathPlugin, MathPlugin } from "@streamdown/math";
import type { mermaid as mermaidPlugin } from "@streamdown/mermaid";
import { useEffect, useMemo, useState } from "react";

/**
 * The streamdown plugins that cost bundle size (katex ~585 KB, mermaid ~190 KB, shiki ~145 KB) load on demand, once, when a
 * text has what they draw: a code fence, a mermaid fence or math. Until a plugin has loaded the text renders without it
 * (a code block plain, math as source); after the first load every later render has it at once.
 */
export type MarkdownPlugins = { cjk: typeof cjk; code?: typeof codePlugin; math?: typeof mathPlugin; mermaid?: typeof mermaidPlugin };
type Need = "code" | "math" | "mermaid";

const FENCE = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/;
const MERMAID_FENCE = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*mermaid/i;
// The math plugin has singleDollarTextMath off: only $$ blocks and the \( \) \[ \] forms are math, a lone $ is text.
const MATH = /\$\$|\\\(|\\\[|\\begin\{/;

/** What `text` needs; pure, so a test can pin it. */
export function markdownNeeds(text: string): Record<Need, boolean> {
  return { code: FENCE.test(text), mermaid: MERMAID_FENCE.test(text), math: MATH.test(text) };
}

// Code first (fence to its end or the end of text, then a span of equal backtick runs), so a \( or \[ inside code is skipped.
const BACKSLASH_MATH = /((?:^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n[ \t]{0,3}\2[`~]*[ \t]*(?=\n|$)|$)|$))|(`+)[\s\S]*?\3|(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)|(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g;

/**
 * `\( x \)` and `\[ x \]` as `$$ x $$` (inline) and a `$$` block, outside code. Markdown eats the backslash of `\(` as an escape,
 * so remark-math never sees these forms; the source is rewritten before the parser runs. Pure, so a test can pin it.
 */
export function backslashMathToDollars(text: string): string {
  if (!text.includes("\\")) return text;
  return text.replace(BACKSLASH_MATH, (m, fence, _f, _t, inline, block) =>
    fence !== undefined ? m : inline !== undefined ? `$$${inline}$$` : block !== undefined ? `\n\n$$\n${String(block).trim()}\n$$\n\n` : m,
  );
}

type Pluggable = MathPlugin["remarkPlugin"];
type Processor = { parser?: (doc: string, file: unknown) => unknown };
type RemarkFn = (this: Processor, options?: unknown) => void;

/** The math plugin with `\( \)` and `\[ \]` as math delimiters too. */
function withBackslashDelimiters(base: typeof mathPlugin): typeof mathPlugin {
  const [attach, options] = base.remarkPlugin as [RemarkFn, unknown];
  function remarkMathBackslash(this: Processor) {
    const parse = this.parser;
    if (parse) this.parser = (doc, file) => parse(backslashMathToDollars(doc), file);
    attach.call(this, options);
  }
  return { ...base, remarkPlugin: remarkMathBackslash as Pluggable };
}

const loaders: { [K in Need]: () => Promise<NonNullable<MarkdownPlugins[K]>> } = {
  code: () => import("@streamdown/code").then((m) => m.code),
  // The KaTeX stylesheet comes with the plugin: without it the MathML copy shows beside the formula and the fonts are missing.
  math: () => Promise.all([import("katex/dist/katex.min.css"), import("@streamdown/math")]).then(([, m]) => withBackslashDelimiters(m.math)),
  mermaid: () => import("@streamdown/mermaid").then((m) => m.mermaid),
};
const loaded: { [K in Need]?: NonNullable<MarkdownPlugins[K]> } = {};
const pending: { [K in Need]?: Promise<void> } = {};
const listeners = new Set<() => void>();

function load(need: Need): Promise<void> | undefined {
  if (loaded[need]) return;
  return (pending[need] ??= loaders[need]().then(
    (p) => {
      (loaded as Record<Need, unknown>)[need] = p;
      for (const l of listeners) l();
    },
    () => {
      // A failed chunk fetch is retried by the next text that needs it.
      pending[need] = undefined;
    },
  ));
}

/** Preload hook for tests and for callers that know a plugin is needed. */
export function loadMarkdownPlugin(need: Need): Promise<void> {
  return load(need) ?? Promise.resolve();
}

export function resetMarkdownPlugins(): void {
  for (const k of ["code", "math", "mermaid"] as const) (delete loaded[k], (pending[k] = undefined));
}

/** The plugins `text` needs, as far as they have loaded; a re-render follows each load. Stable while nothing loads. */
export function useMarkdownPlugins(text: string): MarkdownPlugins {
  const needs = useMemo(() => markdownNeeds(text), [text]);
  const [, bump] = useState(0);
  useEffect(() => {
    const want = (["code", "math", "mermaid"] as const).filter((n) => needs[n] && !loaded[n]);
    if (!want.length) return;
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    for (const n of want) load(n);
    return () => void listeners.delete(l);
  }, [needs]);
  const code = needs.code ? loaded.code : undefined;
  const math = needs.math ? loaded.math : undefined;
  const mermaid = needs.mermaid ? loaded.mermaid : undefined;
  return useMemo(() => ({ cjk, ...(code && { code }), ...(math && { math }), ...(mermaid && { mermaid }) }), [code, math, mermaid]);
}
