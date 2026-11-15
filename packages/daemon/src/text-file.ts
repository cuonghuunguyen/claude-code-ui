// Reading a file as editor text: the size limit and the UTF-8 check shared by `fs.read` (area-files.ts) and `git.fileAt` (area-git.ts).

/** Larger files are not opened in the editor. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** UTF-8 text of a file's bytes; a UTF-16 BOM or NUL means binary-ish, invalid UTF-8 is refused (a lossy decode would be written back by a save). */
export function decodeText(buf: Buffer): { content: string } | { code: "binary" | "not_utf8" } {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return { code: "not_utf8" };
  if (buf.includes(0)) return { code: "binary" };
  try {
    // ignoreBOM keeps the BOM in the content.
    return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf) };
  } catch {
    return { code: "not_utf8" };
  }
}
