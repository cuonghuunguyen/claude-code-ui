// @-mention autocomplete: the `@query` being typed at the caret, and the text after choosing a path.

export type Mention = { start: number; query: string };

/** The `@word` that ends at the caret and starts the text or follows whitespace; undefined when the picker is closed. */
export function activeMention(text: string, caret: number): Mention | undefined {
  const m = /(?:^|\s)@(\S*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, query: m[1]! } : undefined;
}

/** Replaces the typed mention with `@path ` (quoted when the path has spaces); the SDK reads the file, not the client. */
export function insertMention(text: string, m: Mention, path: string) {
  const token = `${mentionPath(path)} `;
  const end = m.start + 1 + m.query.length;
  return { text: text.slice(0, m.start) + token + text.slice(end), caret: m.start + token.length };
}

/** `@path`, quoted when the path has spaces. */
export const mentionPath = (path: string) => `@${/\s/.test(path) ? `"${path}"` : path}`;

/** Inserts `token` and a space at the caret, with a space before it when it would touch the previous word. */
export function insertAtCaret(text: string, caret: number, token: string) {
  const before = text.slice(0, caret);
  const insert = `${before && !/\s$/.test(before) ? " " : ""}${token} `;
  return { text: before + insert + text.slice(caret), caret: caret + insert.length };
}
