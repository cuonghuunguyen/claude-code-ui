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

/** Inserts `token` at the caret, with a space on each side where it would touch a word. */
export function insertAtCaret(text: string, caret: number, token: string) {
  const before = text.slice(0, caret);
  const insert = `${before && !/\s$/.test(before) ? " " : ""}${token}${/^\s/.test(text.slice(caret)) ? "" : " "}`;
  return { text: before + insert + text.slice(caret), caret: caret + insert.length };
}

// fs.upload paths: `<upload folder>/u-XXXXXX/<name>` (daemon mkdtemp, 6 random characters); quoted when the path has spaces.
// ponytail: matched by path shape, so a project path with a `u-XXXXXX` folder also shows as a chip; send the upload folder in the wire if that bites.
const UPLOAD = /(?<=^|\s)@(?:"(\/[^"]*\/u-[A-Za-z0-9]{6}\/([^"/]+))"|(\/\S*\/u-[A-Za-z0-9]{6}\/([^\s/"]+)))(?: |$)/g;

/** Attached files (`@<upload path>` mentions) taken out of a prompt: the text without them and each file's name and path. */
export function splitUploads(text: string) {
  const files = [...text.matchAll(UPLOAD)].map((m) => ({ path: (m[1] ?? m[3])!, name: (m[2] ?? m[4])! }));
  return { text: files.length ? text.replace(UPLOAD, "").trimEnd() : text, files };
}
