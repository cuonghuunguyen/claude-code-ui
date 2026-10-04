// Editor tab state (docs/spec.md "Editor"): the disk version the tab is based on, the user's draft, and a pending conflict.
import { Compartment, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import type { FsReadResult } from "@claude-ui/protocol";
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
};

export const opened = (path: string, r: FsReadResult): Tab => ({ path, disk: r.content, mtime: r.mtime, draft: r.content });

export const isDirty = (t: Tab) => t.draft !== t.disk;

/** A disk version read after a change: a clean tab reloads, a dirty one gets a conflict. */
export function diskChanged(t: Tab, r: FsReadResult): Tab {
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
