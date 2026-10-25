// Pasted-text blocks, after Claude Code 2.1.294 (see development-docs/GH-441/plan.md §1).
import { sha256Hex } from "./sha256";

export const PASTE_MAX_CHARS = 800;
export const PASTE_MAX_NEWLINES = 2;

/** Paste id -> full pasted content. */
export type Pastes = Record<number, string>;
export type Segment = { kind: "text"; text: string } | { kind: "paste"; body: string };

const NEWLINES = /\r\n|\r|\n/g;
const TOKEN = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;

export function newlineCount(t: string): number {
  return (t.match(NEWLINES) ?? []).length;
}

export function normalizePaste(t: string): string {
  return t.replace(/\r\n|\r/g, "\n");
}

export function isLargePaste(t: string): boolean {
  const n = normalizePaste(t);
  return n.length > PASTE_MAX_CHARS || newlineCount(n) > PASTE_MAX_NEWLINES;
}

export function pasteToken(id: number, content: string): string {
  const k = newlineCount(content);
  return k === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${k} lines]`;
}

export function pasteRefs(text: string): { id: number; index: number; match: string }[] {
  return [...text.matchAll(TOKEN)].map((m) => ({ id: Number(m[1]), index: m.index ?? 0, match: m[0] }));
}

export function nextPasteId(text: string, pastes: Pastes): number {
  const ids = [...pasteRefs(text).map((r) => r.id), ...Object.keys(pastes).map(Number)];
  return Math.max(0, ...ids) + 1;
}

export function prunePastes(text: string, pastes: Pastes): Pastes {
  const present = new Set(pasteRefs(text).map((r) => r.id));
  const keys = Object.keys(pastes).map(Number);
  if (keys.every((k) => present.has(k))) return pastes;
  const out: Pastes = {};
  for (const k of keys) if (present.has(k)) out[k] = pastes[k];
  return out;
}

export function pasteTagId(sessionId?: string): string {
  if (sessionId) return sha256Hex(sessionId).slice(0, 4);
  return Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
}

const escapeTags = (t: string) => t.replace(/<(?=\/?pasted_content)/gi, "<\\");
const unescapeTags = (t: string) => t.replace(/<\\(?=\/?pasted_content)/gi, "<");

/** Replace each token that has an entry by the CLI's pasted_content block. */
export function expandPastes(text: string, pastes: Pastes, tagId: string): string {
  const refs = pasteRefs(text).filter((r) => pastes[r.id] !== undefined);
  if (refs.length === 0) return text;
  let out = "";
  let at = 0;
  for (const r of refs) {
    out += escapeTags(text.slice(at, r.index));
    const body = escapeTags(pastes[r.id]);
    out += `\n\n<pasted_content id="${tagId}">\n${body}${body.endsWith("\n") ? "" : "\n"}</pasted_content id="${tagId}">\n`;
    at = r.index + r.match.length;
    // Same join rule as the CLI: a newline after the block unless the text already starts with one.
    const nextNext = refs.find((x) => x.index >= at);
    const upTo = nextNext ? nextNext.index : text.length;
    const chunk = text.slice(at, upTo);
    if (chunk.length > 0 && !chunk.startsWith("\n")) out += "\n";
  }
  out += escapeTags(text.slice(at));
  return out;
}

const OPENER = /<pasted_content id="([0-9a-f]{4})">\n/g;

export function splitPasted(text: string): Segment[] {
  const segs: Segment[] = [];
  const pushText = (t: string) => {
    if (t) segs.push({ kind: "text", text: t });
  };
  let at = 0;
  let from = 0;
  for (;;) {
    OPENER.lastIndex = from;
    const m = OPENER.exec(text);
    if (!m) break;
    const bodyStart = m.index + m[0].length;
    const closer = `\n</pasted_content id="${m[1]}">`;
    const end = text.indexOf(closer, bodyStart - 1);
    if (end < 0) {
      from = bodyStart;
      continue;
    }
    let before = m.index;
    for (let i = 0; i < 2 && before > at && text[before - 1] === "\n"; i++) before--;
    let after = end + closer.length;
    for (let i = 0; i < 2 && text[after] === "\n"; i++) after++;
    pushText(text.slice(at, before));
    segs.push({ kind: "paste", body: unescapeTags(text.slice(bodyStart, Math.max(bodyStart, end))) });
    at = after;
    from = after;
  }
  pushText(text.slice(at));
  return segs;
}

const hasBlock = (segs: Segment[]) => segs.some((s) => s.kind === "paste");

/** Blocks replaced by their body (copy, quote). */
export function stripPasted(text: string): string {
  const segs = splitPasted(text);
  if (!hasBlock(segs)) return text;
  return segs.map((s) => (s.kind === "text" ? s.text : s.body)).join("");
}

/** Blocks replaced by `[Pasted text +K lines]` (queue chip, focus page, prompt list). */
export function summarizePasted(text: string): string {
  const segs = splitPasted(text);
  if (!hasBlock(segs)) return text;
  return segs
    .map((s) => {
      if (s.kind === "text") return s.text;
      const k = newlineCount(s.body);
      return k === 0 ? "[Pasted text]" : `[Pasted text +${k} lines]`;
    })
    .join("");
}

/** Reverse of expandPastes: large blocks become tokens again, small ones inline text. */
export function collapsePasted(text: string, firstId = 1): { text: string; pastes: Pastes } {
  const segs = splitPasted(text);
  if (!hasBlock(segs)) return { text, pastes: {} };
  const pastes: Pastes = {};
  let id = firstId;
  const out = segs
    .map((s) => {
      if (s.kind === "text") return s.text;
      if (!isLargePaste(s.body)) return s.body;
      pastes[id] = s.body;
      return pasteToken(id++, s.body);
    })
    .join("");
  return { text: out, pastes };
}

type Edit = { text: string; caret: number };

/** Backspace with the caret right after a token removes the whole token. */
export function backspaceToken(text: string, start: number, end: number): Edit | undefined {
  if (start !== end) return undefined;
  const r = pasteRefs(text).find((x) => x.index + x.match.length === start);
  return r ? { text: text.slice(0, r.index) + text.slice(start), caret: r.index } : undefined;
}

/** Delete with the caret right before a token removes the whole token. */
export function deleteToken(text: string, start: number, end: number): Edit | undefined {
  if (start !== end) return undefined;
  const r = pasteRefs(text).find((x) => x.index === start);
  return r ? { text: text.slice(0, r.index) + text.slice(r.index + r.match.length), caret: r.index } : undefined;
}

/** A session title taken from a first prompt: pasted blocks as `[Pasted text +K lines]`; a block the title cut off ends it as `[Pasted text]`. */
export function cleanTitle(title: string): string {
  const t = summarizePasted(title).replace(/\s*<pasted_content id="[0-9a-f]{4}">[\s\S]*$/, " [Pasted text]");
  return t === title ? title : t.trim();
}
