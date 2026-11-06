// A hunk of pierre's parsed diff (`parseDiffFromFile`) as the lines `git.rollbackHunk` sends (docs/spec.md, Changes tab hunk Rollback).
import type { FileDiffMetadata } from "@pierre/diffs";

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
