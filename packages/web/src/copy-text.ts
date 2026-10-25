/** Toast of a failed copy: the browser allows the clipboard only on HTTPS or localhost; the text is shown to copy by hand. */
export function copyFailText(text?: string): string {
  const why = "Copy failed: the browser allows the clipboard only on HTTPS or localhost";
  return text ? `${why}. Copy it by hand: ${text}` : why;
}
