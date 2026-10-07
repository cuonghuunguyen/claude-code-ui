// Quoting a timeline passage into the prompt box as a markdown blockquote (plain prompt text, no part type).

export const QUOTE_MAX = 2000;
/** Timeline elements a quote can come from (one message each). */
export const QUOTABLE =
  '[data-testid="assistant-text"], [data-testid="user-message"], [data-testid="tool-card"]';

/** Markdown blockquote of `text`: `> ` per line, `>` for a blank line, one empty line after; cut at `max` chars with "…"; `code` wraps it in a ``` fence (longer than any backtick run inside). */
export function quoteText(text: string, max = QUOTE_MAX, code = false): string {
  const norm = text.replace(/\r\n?/g, "\n");
  let body = code ? norm.replace(/^\n+/, "").replace(/\s+$/, "") : norm.trim();
  if (body.length > max) {
    // Do not cut a surrogate pair in half.
    const end = /[\ud800-\udbff]/.test(body[max - 1]!) ? max - 1 : max;
    body = body.slice(0, end).trimEnd() + "…";
  }
  if (code) {
    const fence = "`".repeat(
      Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)),
    );
    body = `${fence}\n${body}\n${fence}`;
  }
  return (
    body
      .split("\n")
      .map((l) => (l.trim() ? "> " + l : ">"))
      .join("\n") + "\n\n"
  );
}

/** Prompt text with `quote` appended as its own block at the end; caret at the end. */
export function appendQuote(
  text: string,
  quote: string,
): { text: string; caret: number } {
  const head = text.replace(/\s+$/, "");
  const t = head ? `${head}\n\n${quote}` : quote;
  return { text: t, caret: t.length };
}

export type QuoteSegment = { quote: boolean; text: string };

/** Splits a user prompt into `> ` runs (quote: true, prefix removed) and the plain text between them. */
export function splitQuotes(text: string): QuoteSegment[] {
  const lines = text.split("\n");
  // Only `> x` or a bare `>` is a quote line; lines inside a ``` fence of the prompt never are.
  let fenced = false;
  const isQuote = lines.map((l) => {
    if (!fenced && /^>( |$)/.test(l)) return true;
    if (/^\s*```/.test(l)) fenced = !fenced;
    return false;
  });
  if (!isQuote.some(Boolean)) return [{ quote: false, text }];
  const out: QuoteSegment[] = [];
  let run: string[] = [];
  let cur = false;
  const flush = () => {
    const t = cur ? run.join("\n") : run.join("\n").replace(/^\n+|\n+$/g, "");
    if (run.length && t.trim()) out.push({ quote: cur, text: t });
    run = [];
  };
  lines.forEach((l, i) => {
    if (isQuote[i] !== cur) (flush(), (cur = isQuote[i]!));
    run.push(cur ? l.slice(2) : l);
  });
  flush();
  return out;
}

const elOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement);

/** The quotable timeline element holding both ends of the selection (and being `within` when given); cheap, no text is read. */
export function selectionTarget(within?: Element): Element | undefined {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const a = elOf(sel.anchorNode)?.closest(QUOTABLE);
  if (
    !a ||
    a !== elOf(sel.focusNode)?.closest(QUOTABLE) ||
    !a.closest(".timeline") ||
    (within && a !== within)
  )
    return;
  return a;
}

/** The current selection as a quote and its rect, when `selectionTarget` finds one. A fence only when both ends sit in the same <pre>; the code-block header (language label, buttons) is left out. */
export function selectedQuote(
  within?: Element,
): { quote: string; rect: DOMRect } | undefined {
  const a = selectionTarget(within);
  if (!a) return;
  const sel = document.getSelection()!;
  const headers = [
    ...a.querySelectorAll<HTMLElement>('[data-streamdown="code-block-header"]'),
  ].filter((h) => sel.containsNode(h, true));
  headers.forEach((h) => h.style.setProperty("display", "none"));
  const raw = sel.toString();
  headers.forEach((h) => h.style.removeProperty("display"));
  if (!raw.trim()) return;
  const pre = (n: Node | null) => elOf(n)?.closest("pre");
  const code =
    !!pre(sel.anchorNode) && pre(sel.anchorNode) === pre(sel.focusNode);
  return {
    quote: quoteText(raw, QUOTE_MAX, code),
    rect: sel.getRangeAt(0).getBoundingClientRect(),
  };
}
