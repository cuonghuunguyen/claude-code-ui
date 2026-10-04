// Editor tab state (docs/spec.md "Editor"): the disk version the tab is based on, the user's draft, and a pending conflict.
import { Compartment, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import type { FsReadResult } from "@claude-ui/protocol";
import type { RequestError } from "./client.ts";
import { mentionPath } from "./mentions.ts";
import { isWinPath, relPath } from "./paths.ts";

export type Tab = {
  path: string;
  /** Content of the disk version identified by `mtime`. */
  disk: string;
  mtime: number;
  draft: string;
  /** A newer disk version that arrived while the draft had unsaved edits. */
  conflict?: FsReadResult;
  error?: string;
  /** The file turned into one that cannot be shown (binary, too large, not UTF-8) while the tab had no edits: shown in place of the editor. */
  notice?: string;
};

export const opened = (path: string, r: FsReadResult): Tab => ({ path, disk: r.content, mtime: r.mtime, draft: r.content });

export const isDirty = (t: Tab) => t.draft !== t.disk;

/** A disk version read after a change: a clean tab reloads, a dirty one gets a conflict. */
export function diskChanged(t: Tab, r: FsReadResult): Tab {
  if (t.notice) return { ...t, disk: r.content, draft: r.content, mtime: r.mtime, conflict: undefined, error: undefined, notice: undefined };
  if (r.mtime === t.mtime) return t;
  if (r.content === t.disk) return { ...t, mtime: r.mtime, conflict: undefined };
  if (!isDirty(t)) return { ...t, disk: r.content, draft: r.content, mtime: r.mtime, conflict: undefined, error: undefined };
  return { ...t, conflict: r };
}

/** Takes the conflicting disk version, dropping the draft. */
export const reload = (t: Tab): Tab =>
  t.conflict
    ? { ...t, disk: t.conflict.content, draft: t.conflict.content, mtime: t.conflict.mtime, conflict: undefined, error: undefined }
    : t;

/** `baseMtime` of a save: "Overwrite with mine" replaces the disk version seen in the conflict banner; a plain save of a tab in conflict gets refused. */
export const saveBase = (t: Tab, overwrite: boolean) => (overwrite && t.conflict ? t.conflict.mtime : t.mtime);

/** `content` was written with the resulting `mtime`; the draft may have moved on meanwhile. */
export const saved = (t: Tab, content: string, mtime: number): Tab => ({
  ...t,
  disk: content,
  mtime,
  conflict: undefined,
  error: undefined,
});


// CodeMirror splits on any line break and joins with "\n" unless the separator is set: a CRLF file would turn dirty and save as LF.
const separator = new Compartment();
const lineBreak = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

/** Editor extension that keeps `text`'s line breaks; the other kind of break stays inside a line, so the text round-trips as is. */
export const lineBreaks = (text: string) => separator.of(EditorState.lineSeparator.of(lineBreak(text)));

/** Replaces the whole document with `text`, switching to its line breaks. */
export function replaceDoc(state: EditorState, text: string): TransactionSpec {
  const sep = lineBreak(text);
  return {
    changes: { from: 0, to: state.doc.length, insert: Text.of(text.split(sep)) },
    effects: separator.reconfigure(EditorState.lineSeparator.of(sep)),
  };
}

/** The document joined with its own line breaks (`doc.toString()` always joins with "\n"). */
export const docText = (state: EditorState) => state.sliceDoc();

/**
 * "Send selection to Claude": `@path#Lstart-end` of the main selection, path relative to `cwd`; the file alone when nothing is selected.
 * The SDK attaches only the range for `#L…` (`#start-end` attaches the whole file), and a quoted path needs the range inside the quotes.
 */
export function selectionMention(state: EditorState, path: string, cwd: string) {
  // A Windows path in "/": the CLI resolves either, and "\" would read as an escape in a quoted mention.
  const rel = isWinPath(path) ? relPath(path, cwd).replace(/\\/g, "/") : relPath(path, cwd);
  const { from, to, empty } = state.selection.main;
  if (empty) return mentionPath(rel);
  const start = state.doc.lineAt(from);
  const end = state.doc.lineAt(to);
  // A selection that ends at the start of a line (whole lines selected) does not include that line.
  const last = end.number > start.number && to === end.from ? end.number - 1 : end.number;
  return mentionPath(`${rel}#L${start.number}${last > start.number ? `-${last}` : ""}`);
}

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${+(n / 1024).toFixed(1)} KB` : `${+(n / 1024 ** 2).toFixed(1)} MB`);

/** Mirrors the daemon's MAX_FILE_BYTES (fs.read). */
const MAX_FILE_CHARS = 2 * 1024 * 1024;

/**
 * The fs.read checks on a file the daemon already decoded (the changes tab's before side, from the SDK): too large, UTF-16 BOM or NUL bytes,
 * or U+FFFD from invalid UTF-8. Undefined for text. ponytail: a text file that holds U+FFFD itself counts as not UTF-8.
 */
export function textFailure(s: string): { text: string; notice: boolean } | undefined {
  const code = s.length > MAX_FILE_CHARS ? "too_large" : s.startsWith("\ufffd\ufffd") ? "not_utf8" : s.includes("\0") ? "binary" : s.includes("\ufffd") ? "not_utf8" : undefined;
  // The decoded string has no true byte size, so only a too large file shows one.
  return code && readFailure(Object.assign(new Error(code), { code, size: code === "too_large" ? s.length : undefined }));
}

/** What the viewer says about a failed fs.read: `notice` for a file that cannot be shown (not an error), no raw error code. */
export function readFailure(e: RequestError): { text: string; notice: boolean } {
  const size = e.size === undefined ? "" : ` (${fileSize(e.size)})`;
  switch (e.code) {
    case "binary":
      return { text: `Binary file, not shown${size}`, notice: true };
    case "too_large":
      return { text: `File too large to show${size}`, notice: true };
    case "not_utf8":
      return { text: `File is not UTF-8 text, not shown${size}`, notice: true };
    case "not_a_file":
      return { text: "Not a file", notice: true };
    default:
      return { text: e.message, notice: false };
  }
}
