// Pure markdown edits for the prompt box formatting row: what to replace and where to put the selection afterwards.

export type MarkdownFormat = "bold" | "italic" | "code" | "codeBlock" | "link" | "bulletList";

/** Replace text[from, to) with `insert`, then select [selectionStart, selectionEnd] (positions in the new text). */
export type FormatEdit = { from: number; to: number; insert: string; selectionStart: number; selectionEnd: number };

export function applyFormatEdit(text: string, e: FormatEdit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to);
}

const longestRun = (s: string, ch: string) => Math.max(0, ...[...s.matchAll(new RegExp(`${ch === "`" ? "`" : "\\" + ch}+`, "g"))].map((m) => m[0].length));

function edit(from: number, to: number, insert: string, selStart: number, selEnd = selStart): FormatEdit {
  return { from, to, insert, selectionStart: from + selStart, selectionEnd: from + selEnd };
}

/** Wrap the selection in `m`, or remove `m` when it already surrounds the selection (or the selection includes it). */
function wrap(text: string, start: number, end: number, m: string): FormatEdit {
  const s = text.slice(start, end);
  const before = text.slice(start - m.length, start);
  const after = text.slice(end, end + m.length);
  // A single `*` next to another `*` is part of `**`: not ours to remove.
  const beyondOk = m !== "*" || (text[start - 2] !== "*" && text[end + 1] !== "*");
  const innerOk = m !== "*" || (!s.startsWith("**") && !s.endsWith("**"));
  if (start >= m.length && before === m && after === m && beyondOk) return edit(start - m.length, end + m.length, s, 0, s.length);
  if (s.length >= 2 * m.length && s.startsWith(m) && s.endsWith(m) && innerOk) return edit(start, end, s.slice(m.length, -m.length), 0, s.length - 2 * m.length);
  return edit(start, end, m + s + m, m.length, m.length + s.length);
}

function inlineCode(text: string, start: number, end: number): FormatEdit {
  const s = text.slice(start, end);
  if (s.includes("\n")) return codeBlock(text, start, end);
  // Unwrap a matching backtick run just outside, or one inside the selection.
  let nb = 0;
  while (text[start - 1 - nb] === "`") nb++;
  let na = 0;
  while (text[end + na] === "`") na++;
  if (nb > 0 && nb === na) return edit(start - nb, end + na, s, 0, s.length);
  const inner = /^(`+)([^]*)\1$/.exec(s);
  if (inner && inner[2] !== "" && !inner[2]!.startsWith("`") && !inner[2]!.endsWith("`")) return edit(start, end, inner[2]!, 0, inner[2]!.length);
  const fence = "`".repeat(longestRun(s, "`") + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return edit(start, end, fence + pad + s + pad + fence, fence.length + pad.length, fence.length + pad.length + s.length);
}

function codeBlock(text: string, start: number, end: number): FormatEdit {
  const s = text.slice(start, end);
  const fence = "`".repeat(Math.max(3, longestRun(s, "`") + 1));
  const pre = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
  const post = end < text.length && text[end] !== "\n" ? "\n" : "";
  const open = pre.length + fence.length + 1;
  return edit(start, end, `${pre}${fence}\n${s}\n${fence}${post}`, open, open + s.length);
}

function link(text: string, start: number, end: number): FormatEdit {
  const s = text.slice(start, end);
  if (!s) return edit(start, end, "[](url)", 1);
  if (/^https?:\/\/\S+$/.test(s)) return edit(start, end, `[](${s})`, 1);
  return edit(start, end, `[${s}](url)`, s.length + 3, s.length + 6);
}

function bulletList(text: string, start: number, end: number): FormatEdit {
  const ls = text.lastIndexOf("\n", start - 1) + 1;
  // A selection that ends right after a newline does not include the next line.
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const nl = text.indexOf("\n", last);
  const le = nl === -1 ? text.length : nl;
  const lines = text.slice(ls, le).split("\n");
  const filled = lines.filter((l) => l.trim());
  const targets = filled.length ? filled : lines;
  const off = targets.every((l) => l.startsWith("- "));
  const block = lines
    .map((l) => (l.trim() === "" && filled.length ? l : off ? l.slice(2) : "- " + l))
    .join("\n");
  if (start !== end) return edit(ls, le, block, 0, block.length);
  const caret = off ? Math.max(ls, start - 2) : start + 2;
  return { from: ls, to: le, insert: block, selectionStart: caret, selectionEnd: caret };
}

export function formatEdit(text: string, start: number, end: number, format: MarkdownFormat): FormatEdit {
  switch (format) {
    case "bold":
      return wrap(text, start, end, "**");
    case "italic":
      return wrap(text, start, end, "*");
    case "code":
      return inlineCode(text, start, end);
    case "codeBlock":
      return codeBlock(text, start, end);
    case "link":
      return link(text, start, end);
    case "bulletList":
      return bulletList(text, start, end);
  }
}
