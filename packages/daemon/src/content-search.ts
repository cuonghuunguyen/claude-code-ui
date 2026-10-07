// Content search over the CLI transcripts: prompt and answer text of the main chain, case-insensitive substring.
// ponytail: no index, every query reads the transcripts newest first (1.73 GB: ~9 s full scan, measured 2026-10-06); add a per-file word index keyed by size+mtime if scans get too slow.
import { createReadStream } from "node:fs";
import type { SearchHit, SessionSearchHits, SessionsSearchResult } from "@claude-ui/protocol";
import { redact } from "./plugins.ts";

export const SEARCH_LIMITS = { sessions: 50, hitsPerSession: 3, ms: 15_000, bytes: 2 ** 31, lineBytes: 8 << 20, chunkBytes: 256 << 10, before: 30, snippetChars: 120, window: 480 };
export type SearchLimits = typeof SEARCH_LIMITS;
export type SearchFile = { sessionId: string; cwd: string; title: string; file: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const textOf = (content: unknown) =>
  Array.isArray(content) ? content.flatMap((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n") : "";

/** A main-chain prompt's or answer's text of one parsed transcript line; undefined for anything else. */
export function messageText(e: unknown): { messageId: string; role: "user" | "assistant"; text: string } | undefined {
  if (!isObj(e) || e.isSidechain === true || !isObj(e.message)) return undefined;
  if (e.type === "user") {
    if (e.isMeta || e.isCompactSummary || typeof e.uuid !== "string") return undefined;
    const c = e.message.content;
    // A string starting with "<" is a command wrapper or notification: the adapter does not show it as a prompt.
    const text = typeof c === "string" ? (c.startsWith("<") ? "" : c) : textOf(c);
    return text ? { messageId: e.uuid, role: "user", text } : undefined;
  }
  if (e.type === "assistant" && typeof e.message.id === "string") {
    const text = textOf(e.message.content);
    return text ? { messageId: e.message.id, role: "assistant", text } : undefined;
  }
  return undefined;
}

/**
 * Text around the first case-insensitive match of `q` (lowercase), whitespace collapsed, redact() applied; undefined when there is
 * no match or it is inside a redacted part. Only a window around the match is redacted and collapsed (a message can be MBs).
 */
export function snippet(text: string, q: string, limits: SearchLimits = SEARCH_LIMITS): string | undefined {
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return undefined;
  // Both window ends sit at whitespace, so a URL's `scheme://user:pass@` is never cut (redact would miss it): each end moves
  // out to the next whitespace. ponytail: past 2000 chars without whitespace the partial token is dropped instead; a token
  // that holds the match itself over that size gives no snippet.
  const ws = /\s/;
  const W = limits.window;
  let from = Math.max(0, at - W);
  for (const stop = Math.max(0, from - 2000); from > stop && !ws.test(text[from - 1]!); from--);
  if (from > 0 && !ws.test(text[from - 1]!)) {
    while (from < at && !ws.test(text[from - 1]!)) from++;
    if (!ws.test(text[from - 1]!)) return undefined;
  }
  let to = Math.min(text.length, at + q.length + W);
  for (const stop = Math.min(text.length, to + 2000); to < stop && !ws.test(text[to]!); to++);
  if (to < text.length && !ws.test(text[to]!)) {
    for (const low = at + q.length; to > low && !ws.test(text[to]!); to--);
    if (!ws.test(text[to]!)) return undefined;
  }
  const flat = redact(text.slice(from, to)).replace(/\s+/g, " ").trim();
  const i = flat.toLowerCase().indexOf(q);
  if (i < 0) return undefined;
  const start = Math.max(0, i - limits.before);
  const end = Math.min(flat.length, start + limits.snippetChars);
  return (start ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

export async function searchTranscripts(
  files: SearchFile[],
  query: string,
  onResult: (r: SessionSearchHits) => void,
  opts: { signal: AbortSignal; limits?: Partial<SearchLimits> },
): Promise<SessionsSearchResult> {
  const limits = { ...SEARCH_LIMITS, ...opts.limits };
  const { signal } = opts;
  const q = query.toLowerCase();
  // Transcript lines hold the text JSON-escaped (the CLI writes non-ASCII raw).
  const needle = JSON.stringify(q).slice(1, -1);
  const decode = /^[\x20-\x7e]*$/.test(q) ? "latin1" : "utf8";
  const t0 = performance.now();
  const out: SessionsSearchResult = { scannedFiles: 0, scannedBytes: 0, ms: 0 };
  let found = 0;

  /** Adds the hit of one line to `hits` (a transcript line may repeat a message id). */
  const scanLine = (line: string, hits: SearchHit[]) => {
    if (!line.toLowerCase().includes(needle)) return;
    let m;
    try {
      m = messageText(JSON.parse(line));
    } catch {
      return;
    }
    if (!m || hits.some((h) => h.messageId === m.messageId)) return;
    const s = snippet(m.text, q, limits);
    if (s !== undefined) hits.push({ messageId: m.messageId, role: m.role, snippet: s });
  };
  const over = () => (signal.aborted ? "canceled" : found >= limits.sessions ? "sessions" : performance.now() - t0 >= limits.ms ? "time" : out.scannedBytes >= limits.bytes ? "bytes" : undefined);

  for (const f of files) {
    const stop = over();
    if (stop) {
      out.stopped = stop;
      break;
    }
    const hits: SearchHit[] = [];
    // The chunks of the line being read, joined once its newline arrives (a long line is not re-copied per chunk).
    let parts: Buffer[] = [];
    let partsLen = 0;
    let skipping = false;
    out.scannedFiles++;
    try {
      for await (const chunk of createReadStream(f.file, { highWaterMark: limits.chunkBytes, signal }) as AsyncIterable<Buffer>) {
        out.scannedBytes += chunk.length;
        const nl = chunk.lastIndexOf(10);
        if (nl < 0) {
          if (skipping) continue;
          parts.push(chunk);
          if ((partsLen += chunk.length) > limits.lineBytes) (parts = []), (partsLen = 0), (skipping = true);
          continue;
        }
        let buf: Buffer = parts.length ? Buffer.concat([...parts, chunk.subarray(0, nl + 1)]) : chunk.subarray(0, nl + 1);
        const tail = chunk.subarray(nl + 1);
        parts = tail.length ? [tail] : [];
        partsLen = tail.length;
        if (skipping) {
          buf = buf.subarray(buf.indexOf(10) + 1);
          skipping = false;
        }
        const end = buf.length - 1;
        if (end > 0 && buf.toString(decode, 0, end).toLowerCase().includes(needle))
          for (const line of buf.toString("utf8", 0, end).split("\n")) if (hits.length < limits.hitsPerSession) scanLine(line, hits);
        if (hits.length >= limits.hitsPerSession || over()) break;
      }
      if (parts.length && !skipping && hits.length < limits.hitsPerSession) scanLine(Buffer.concat(parts).toString("utf8"), hits);
    } catch (e) {
      if (signal.aborted) {
        out.stopped = "canceled";
        break;
      }
      // Deleted meanwhile or unreadable: skipped.
      void e;
    }
    if (hits.length) {
      found++;
      out.firstMs ??= Math.round(performance.now() - t0);
      onResult({ sessionId: f.sessionId, cwd: f.cwd, title: f.title, hits });
    }
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
}
