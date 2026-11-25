// Quick compact (docs/spec.md "Quick compact"): the digest of a session, built with code and no model. User and assistant text and
// tool inputs are kept, tool outputs go to files, the recent tail stays verbatim. Only over the cap is the oldest part condensed by a
// small model (`Summarise`). Engine-neutral: an Engine adapter maps its history to `DigestEvent`s (quick-compact-claude.ts, -opencode.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QUICK_COMPACT_MARKER } from "@claude-ui/protocol";

/** One step of the conversation. A tool event carries its own result, so any event boundary is a safe cut. */
export type DigestEvent = { kind: "user" | "assistant"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown>; out?: string; err?: boolean };
export type DigestSource = {
  sessionId: string;
  title: string;
  /** What the header's "Full transcript:" line says: the file path, or a sentence for an Engine with no file. */
  transcript: string;
  /** Folder the tool output and long input files go to (`writeDigestFiles`). */
  outDir: string;
  /** The text of a native compact (or an earlier quick compact) the events start after. */
  earlier?: string;
  events: DigestEvent[];
};
export type Digest = { text: string; files: { name: string; content: string }[]; tokens: number; summarised: boolean };
/** Condenses `text` to about `maxTokens` tokens. */
export type Summarise = (text: string, maxTokens: number, signal?: AbortSignal) => Promise<string>;

/** The verbatim tail: from the end back while it stays within this many characters (~15k tokens; at least one event). */
export const RECENT_CHARS = 60_000;
/** A tool input longer than this goes to a file. */
export const LONG_INPUT = 500;
/** An old tool output up to this long stays inline. */
export const INLINE_OUT = 200;
/** A recent tool output is cut at this length; the rest is in its file. */
export const RECENT_OUT_MAX = 4_000;
/** The digest is at most this share of the model's context window. */
export const CAP_SHARE = 0.3;
/** A model call gets at most this many tokens of text (Haiku's window with room). */
export const SUMMARY_CHUNK_TOKENS = 100_000;
const SUMMARY_MAX_TOKENS = 4_000;
const SUMMARY_HEADING = "## Summary of the oldest part (model-written; exact text in the full transcript)";

export const tokensOf = (s: string) => Math.ceil(s.length / 4);
export const capOf = (contextWindow: number) => Math.floor(contextWindow * CAP_SHARE);

/** Text of a message without what the model was told on the side: reminders, local command output; "" for a slash command row. */
export function stripText(s: string): string {
  const t = s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-std(out|err)>[\s\S]*?<\/local-command-std\1>/g, "")
    .trim();
  return t.startsWith("<command-name>") ? "" : t;
}

const firstLine = (s: string, n: number) => {
  const l = s.split("\n")[0]!;
  return l.length > n ? `${l.slice(0, n)}…` : l;
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const BODY_TOOLS = new Set(["edit", "write", "notebookedit", "multiedit", "apply_patch"]);

/** The one-line form of a tool input and the text a file of it holds. */
function inputOf(name: string, input: Record<string, unknown>): { short: string; full: string } {
  const n = name.toLowerCase();
  const json = JSON.stringify(input);
  const pretty = JSON.stringify(input, null, 1);
  if (n === "bash" || n === "shell" || n === "powershell") {
    const c = str(input.command) ?? json;
    return { short: c, full: c };
  }
  const path = str(input.file_path) ?? str(input.filePath) ?? str(input.notebook_path) ?? str(input.path);
  if (["read", "edit", "write", "notebookedit", "multiedit"].includes(n) && path) return { short: path + (input.offset ? ` (from line ${String(input.offset)})` : ""), full: pretty };
  if ((n === "grep" || n === "glob") && str(input.pattern) !== undefined) return { short: `${str(input.pattern)}${path ? ` in ${path}` : ""}`, full: json };
  return { short: json, full: pretty };
}

const fileName = (n: number, name: string, kind: "input" | "output") => `${String(n).padStart(4, "0")}-${name.replace(/\W+/g, "_")}.${kind}.txt`;
/** A code fence longer than any backtick run in `s`. */
const fenceOf = (s: string) => {
  let f = "```";
  while (s.includes(f)) f += "`";
  return f;
};

type File = { name: string; content: string };
type Line = { text: string; tool?: string };

/** The line of one event and the files it names. `recent`: the output is kept verbatim (capped). */
function render(e: DigestEvent, n: number, recent: boolean, outDir: string): { line: Line; files: File[] } {
  if (e.kind !== "tool") return { line: { text: `**${e.kind === "user" ? "User" : "Assistant"}:** ${e.text}` }, files: [] };
  const files: File[] = [];
  const { short, full } = inputOf(e.name, e.input);
  let text = `- ${e.name}: `;
  if (short.length > LONG_INPUT || BODY_TOOLS.has(e.name.toLowerCase())) {
    const name = fileName(n, e.name, "input");
    files.push({ name, content: full });
    text += `${firstLine(short, 150)} [input: ${join(outDir, name)}]`;
  } else text += short;
  if (e.out === undefined) return { line: { text: `${text} (no result)`, tool: e.name }, files };
  const out = e.out;
  const status = e.err ? "error" : "ok";
  const outFile = () => {
    const name = fileName(n, e.name, "output");
    files.push({ name, content: out });
    return join(outDir, name);
  };
  if (recent) {
    const shown = out.length > RECENT_OUT_MAX ? `${out.slice(0, RECENT_OUT_MAX)}\n…[truncated; full: ${outFile()}]` : out;
    const f = fenceOf(shown);
    return { line: { text: `${text} → ${status}\n${f}\n${shown}\n${f}`, tool: e.name }, files };
  }
  if (out.length <= INLINE_OUT) return { line: { text: `${text} → ${status}: ${out.replace(/\s+/g, " ").trim()}`, tool: e.name }, files };
  return { line: { text: `${text} → ${status}${e.err ? `: ${firstLine(out, 200)}` : ""}, ${out.split("\n").length} lines [output: ${outFile()}]`, tool: e.name }, files };
}

type Layout = { src: DigestSource; old: Line[]; recent: string[]; files: File[] };

function layout(src: DigestSource, recentChars = RECENT_CHARS): Layout {
  const ev = src.events;
  let cut = ev.length;
  let size = 0;
  while (cut > 0) {
    const s = render(ev[cut - 1]!, cut - 1, true, src.outDir).line.text.length + 1;
    if (size + s > recentChars && cut < ev.length) break;
    size += s;
    cut--;
  }
  const files = new Map<string, string>();
  const take = (r: { line: Line; files: File[] }) => (r.files.forEach((f) => files.set(f.name, f.content)), r.line);
  const old = ev.slice(0, cut).map((e, i) => take(render(e, i, false, src.outDir)));
  const recent = ev.slice(cut).map((e, i) => take(render(e, cut + i, true, src.outDir)).text);
  return { src, old, recent, files: [...files].map(([name, content]) => ({ name, content })) };
}

/** `- (3× Read, 1× Bash; …)` for a run of collapsed tool lines. */
const runLine = (names: string[]) => {
  const c = new Map<string, number>();
  for (const n of names) c.set(n, (c.get(n) ?? 0) + 1);
  return `- (${[...c].map(([n, k]) => `${k}× ${n}`).join(", ")}; details in the tool output files)`;
};

/** The old lines with the first `collapsed` tool lines folded into runs. */
function collapse(old: Line[], collapsed: Set<number>): string[] {
  const out: string[] = [];
  for (let i = 0; i < old.length; i++) {
    if (!collapsed.has(i)) {
      out.push(old[i]!.text);
      continue;
    }
    const names: string[] = [];
    while (i < old.length && collapsed.has(i)) names.push(old[i++]!.tool!);
    i--;
    out.push(runLine(names));
  }
  return out;
}

function assemble(l: Layout, oldLines: string[], summary: string | undefined): string {
  const s = l.src;
  const header = `${QUICK_COMPACT_MARKER} source=${s.sessionId}${summary !== undefined ? " summarised" : ""}
This conversation was compacted from session ${s.sessionId} ("${s.title}") by quick compact (no model rewrite: user and assistant text and tool inputs are kept; tool outputs are in files).
Full transcript: ${s.transcript}
Tool outputs and long tool inputs: ${s.outDir} (each tool line names its file). Read them, or grep the full transcript, for exact details.
The last part is kept verbatim under "Recent (verbatim)". Later turns override earlier ones.`;
  const parts = [header];
  if (s.earlier) parts.push(`## Earlier compact summary\n\n${s.earlier}`);
  if (summary !== undefined) parts.push(`${SUMMARY_HEADING}\n\n${summary}`);
  if (oldLines.length || summary === undefined) parts.push(`## Conversation (condensed)\n\n${oldLines.join("\n")}`);
  parts.push(`## Recent (verbatim)\n\n${l.recent.join("\n")}`);
  return `${parts.join("\n\n")}\n`;
}

const finish = (l: Layout, text: string, summarised: boolean): Digest => ({ text, files: l.files, tokens: tokensOf(text), summarised });

/** The digest with no cap (files are returned, not written). */
export function buildDigest(src: DigestSource): Digest {
  const l = layout(src);
  return finish(l, assemble(l, collapse(l.old, new Set()), undefined), false);
}

/** Splits `lines` into chunks of at most `maxChars`, at line boundaries (a line longer than that is a chunk of its own). */
function chunksOf(lines: string[], maxChars: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (cur.length && len + line.length + 1 > maxChars) (out.push(cur.join("\n")), (cur = []), (len = 0));
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/**
 * The digest within `capTokens`. Under the cap no model is called. Over it: the oldest tool lines collapse into runs (no
 * loss: their outputs are in files); still over, the oldest prefix of the old part is condensed by `summarise`. The header and
 * the recent tail are never condensed.
 */
export async function fitCap(src: DigestSource, capTokens: number, summarise: Summarise, signal?: AbortSignal): Promise<Digest> {
  // The verbatim tail is at most half the cap (a small model window must not get a tail bigger than its digest may be).
  const l = layout(src, Math.min(RECENT_CHARS, Math.floor(capTokens * 2)));
  const plain = assemble(l, collapse(l.old, new Set()), undefined);
  if (tokensOf(plain) <= capTokens) return finish(l, plain, false);

  // Step 1: collapse the oldest tool lines.
  const collapsed = new Set<number>();
  // A running size, not a rebuild per line (a 9000-event session would block the event loop for a minute); the result is measured once below.
  let len = plain.length;
  for (let i = 0; i < l.old.length && Math.ceil(len / 4) > capTokens; i++) {
    if (!l.old[i]!.tool) continue;
    len -= l.old[i]!.text.length + 1;
    // A run costs one line of about 70 characters, however many tool lines it folds.
    if (!collapsed.has(i - 1)) len += 70;
    collapsed.add(i);
  }
  const lines = collapse(l.old, collapsed);
  const tight = assemble(l, lines, undefined);
  if (tokensOf(tight) <= capTokens) return finish(l, tight, false);

  // Step 2: condense the oldest prefix. Its replacement is at most a tenth of it (never over SUMMARY_MAX_TOKENS), so the prefix is
  // the excess plus 10 % margin, grown for what the replacement takes back.
  const excess = tokensOf(tight) - capTokens;
  const wantChars = Math.ceil((excess * 1.1) / 0.9) * 4 + SUMMARY_HEADING.length;
  let n = 0;
  let chars = 0;
  while (n < lines.length && (n === 0 || chars < wantChars)) chars += lines[n++]!.length + 1;
  const prefix = lines.slice(0, n);
  const rest = lines.slice(n);
  const summaries: string[] = [];
  for (const chunk of chunksOf(prefix, SUMMARY_CHUNK_TOKENS * 4)) {
    summaries.push((await summarise(chunk, Math.min(SUMMARY_MAX_TOKENS, Math.max(1, Math.ceil(tokensOf(chunk) / 10))), signal)).trim());
  }
  let summary = summaries.join("\n\n");
  const rebuilt = (s: string) => assemble(l, rest, s);
  const over = tokensOf(rebuilt(summary)) - capTokens;
  // A summary that still overflows is cut to its budget.
  if (over > 0) summary = summary.slice(0, Math.max(0, summary.length - over * 4));
  return finish(l, rebuilt(summary), true);
}

/** Writes the digest's files (the folder is created; 0600 like the uploads). */
export function writeDigestFiles(outDir: string, files: File[]): void {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  for (const f of files) writeFileSync(join(outDir, f.name), f.content, { mode: 0o600 });
}
