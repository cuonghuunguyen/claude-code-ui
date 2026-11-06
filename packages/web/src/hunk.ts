// A hunk of pierre's parsed diff (`parseDiffFromFile`) as the lines `git.rollbackHunk` sends (docs/spec.md, Changes tab hunk Rollback).
import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";

const NO_EOL = "\\ No newline at end of file";
const bare = (l: string) => l.replace(/\r?\n$/, "");

/** Unified-diff lines (" x", "-x", "+x", and the no-newline marker after the last line of a side without final newline) and the new side's start (unified convention). */
export function wireHunk(d: FileDiffMetadata, index: number): { newStart: number; lines: string[] } {
  const h = d.hunks[index]!;
  const items: { tag: " " | "-" | "+"; text: string }[] = [];
  for (const c of h.hunkContent) {
    if (c.type === "context") for (let i = 0; i < c.lines; i++) items.push({ tag: " ", text: bare(d.additionLines[c.additionLineIndex + i]!) });
    else {
      for (let i = 0; i < c.deletions; i++) items.push({ tag: "-", text: bare(d.deletionLines[c.deletionLineIndex + i]!) });
      for (let i = 0; i < c.additions; i++) items.push({ tag: "+", text: bare(d.additionLines[c.additionLineIndex + i]!) });
    }
  }
  // The marker follows the last line of each side that has no final newline (once for a shared context line).
  const lastOf = (tags: string) => items.map((it) => tags.includes(it.tag)).lastIndexOf(true);
  const marks = new Set<number>();
  if (h.noEOFCRDeletions) marks.add(lastOf(" -"));
  if (h.noEOFCRAdditions) marks.add(lastOf(" +"));
  const lines = items.flatMap((it, i) => [`${it.tag}${it.text}`, ...(marks.has(i) ? [NO_EOL] : [])]);
  return { newStart: h.additionCount ? h.additionLineIndex + 1 : h.additionLineIndex, lines };
}

/** Where a hunk's Rollback button goes: the last line of its last change block (additions side when that block adds, else deletions). */
export function hunkAnchor(d: FileDiffMetadata, index: number): { side: "additions" | "deletions"; lineNumber: number; first: number; last: number } | undefined {
  const h = d.hunks[index]!;
  const c = [...h.hunkContent].reverse().find((x) => x.type === "change");
  if (c?.type !== "change") return undefined;
  const first = h.hunkContent.find((x) => x.type === "change")!;
  const start = (x: typeof c) => (x.additions ? x.additionLineIndex + 1 : x.deletionLineIndex + 1);
  const end = (x: typeof c) => (x.additions ? x.additionLineIndex + x.additions : x.deletionLineIndex + x.deletions);
  return c.additions ? { side: "additions", lineNumber: end(c), first: start(first as typeof c), last: end(c) } : { side: "deletions", lineNumber: end(c), first: start(first as typeof c), last: end(c) };
}

type Row = { tag: " " | "-" | "+"; old?: number; new?: number; text: string };

/** Every line of the file in unified order (gaps between hunks are context, so lines expanded from collapsed context are selectable too). */
function diffRows(d: FileDiffMetadata): Row[] {
  const rows: Row[] = [];
  let o = 1;
  let n = 1;
  const same = (to: number) => {
    for (; n < to; o++, n++) rows.push({ tag: " ", old: o, new: n, text: bare(d.additionLines[n - 1]!) });
  };
  for (const h of d.hunks)
    for (const c of h.hunkContent) {
      if (c.type === "context") {
        same(c.additionLineIndex + 1);
        same(n + c.lines);
      } else {
        same(c.additionLineIndex + 1);
        for (let i = 0; i < c.deletions; i++) rows.push({ tag: "-", old: o++, text: bare(d.deletionLines[c.deletionLineIndex + i]!) });
        for (let i = 0; i < c.additions; i++) rows.push({ tag: "+", new: n++, text: bare(d.additionLines[c.additionLineIndex + i]!) });
      }
    }
  same(d.additionLines.length + 1);
  return rows;
}

const span = (a: number[]) => (a.length ? (a[0] === a.at(-1) ? `${a[0]}` : `${a[0]}-${a.at(-1)}`) : "");

/**
 * "Send selection to Claude" in the Changes tab: the selected rows of a diff as prompt text (path, line ranges, a fenced diff with line numbers).
 * `-` rows carry the old number and are not in the current file. A side missing in the range is `additions` (unified view, context lines).
 * undefined: an end of the range is not in the diff any more.
 */
export function diffSelection(d: FileDiffMetadata, range: SelectedLineRange, rel: string): string | undefined {
  const rows = diffRows(d);
  const find = (line: number, side: "additions" | "deletions" = "additions") => rows.findIndex((r) => (side === "deletions" ? r.old : r.new) === line);
  let a = find(range.start, range.side);
  let b = find(range.end, range.endSide ?? range.side);
  if (a < 0 || b < 0) return undefined;
  if (a > b) [a, b] = [b, a];
  const sel = rows.slice(a, b + 1);
  const olds = sel.flatMap((r) => (r.tag === "+" ? [] : [r.old!]));
  const news = sel.flatMap((r) => (r.tag === "-" ? [] : [r.new!]));
  const body = sel.map((r) => `${r.tag}${r.tag === "-" ? r.old : r.new} | ${r.text}`);
  const fence = "`".repeat(Math.max(3, ...body.flatMap((l) => [...l.matchAll(/`+/g)].map((m) => m[0].length + 1))));
  const where = [olds.length > 0 && `old lines ${span(olds)}`, news.length > 0 && `new lines ${span(news)}`].filter(Boolean).join(", ");
  return `\`${rel}\` diff, ${where} (\`-\` removed, old line number, not in the current file; \`+\` added and \` \` unchanged, new line number):\n${fence}diff\n${body.join("\n")}\n${fence}\n`;
}
