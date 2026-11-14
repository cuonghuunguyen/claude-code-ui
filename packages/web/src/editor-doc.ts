// The CodeMirror side of the editor's file helpers (docs/spec.md "Editor"). Apart from files.ts so App, which needs only the tab state there, does not pull @codemirror/state into the entry chunk.
import { Compartment, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import { mentionRel } from "./files.ts";
import { mentionPath } from "./mentions.ts";
import { QUOTE_MAX, quoteText } from "./quote.ts";

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
 * "Add to chat" (Alt+K): `@path#Lstart-end` of the main selection, path relative to `cwd`; the file alone when nothing is selected.
 * The SDK attaches only the range for `#L…` (`#start-end` attaches the whole file), and a quoted path needs the range inside the quotes.
 */
export function selectionMention(state: EditorState, path: string, cwd: string) {
  const rel = mentionRel(path, cwd);
  const { from, to, empty } = state.selection.main;
  if (empty) return mentionPath(rel);
  const start = state.doc.lineAt(from);
  const end = state.doc.lineAt(to);
  // A selection that ends at the start of a line (whole lines selected) does not include that line.
  const last = end.number > start.number && to === end.from ? end.number - 1 : end.number;
  return mentionPath(`${rel}#L${start.number}${last > start.number ? `-${last}` : ""}`);
}

/** "Quote" in the editor: the selected text as a fenced blockquote (cut at the quote cap); undefined for an empty selection. */
export function selectionQuote(state: EditorState) {
  const { from, to, empty } = state.selection.main;
  return empty ? undefined : quoteText(state.sliceDoc(from, to), QUOTE_MAX, true);
}
