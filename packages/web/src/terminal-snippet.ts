// Terminal output selected in the terminal panel, as a fenced prompt block (GH-710). Model-facing text, so English (like `diffSelection`).

/** Cap of the block body in characters; over it the tail is kept (errors and the last result sit at the end). */
export const TERMINAL_SNIPPET_MAX = 8000;

// CSI, OSC (BEL or ST end), other two-byte ESC sequences, then C0 controls except \n and \t, DEL and C1.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]/g;
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Plain text of a terminal selection: escape sequences and control characters removed, `\r\n` and `\r` as `\n`, no trailing spaces per line. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(ESCAPES, "")
    .replace(CONTROLS, "")
    .replace(/[ \t]+$/gm, "");
}

const n = (v: number) => v.toLocaleString("en-US");

/** The last `max` chars of `s`, not starting inside a surrogate pair. */
const tailChars = (s: string, max: number) => {
  let from = s.length - max;
  if (/[\udc00-\udfff]/.test(s[from]!)) from++;
  return s.slice(from);
};

/** The block to insert into the prompt box, or undefined for a blank selection. */
export function terminalSnippet(raw: string, { title, cwd }: { title: string; cwd: string }): string | undefined {
  const text = stripAnsi(raw).replace(/^\n+/, "").replace(/\s+$/, "");
  if (!text) return;
  let body = text;
  let note = "";
  if (text.length > TERMINAL_SNIPPET_MAX) {
    const lines = text.split("\n");
    const kept: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const add = lines[i]!.length + (kept.length ? 1 : 0);
      if (size + add > TERMINAL_SNIPPET_MAX) break;
      kept.unshift(lines[i]!);
      size += add;
    }
    if (kept.length) {
      body = kept.join("\n");
      note = ` (truncated: last ${n(kept.length)} of ${n(lines.length)} lines)`;
    } else {
      // The last line alone is over the cap.
      body = tailChars(lines.at(-1)!, TERMINAL_SNIPPET_MAX);
      note = ` (truncated: last ${n(TERMINAL_SNIPPET_MAX)} of ${n(text.length)} characters)`;
    }
  }
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const tick = "`".repeat(Math.max(1, ...[...cwd.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const where = cwd.startsWith("`") || cwd.endsWith("`") ? `${tick} ${cwd} ${tick}` : `${tick}${cwd}${tick}`;
  return `Output of terminal "${title}" in ${where}${note}:\n${fence}text\n${body}\n${fence}\n`;
}

/**
 * Screen rect of the cell `pos` (x column, y buffer row) of an xterm whose `.xterm-screen` is `screen`, or undefined when its row is not visible.
 * `viewportY`: the buffer row shown at the top.
 */
export function cellRect(pos: { x: number; y: number }, screen: { left: number; top: number; width: number; height: number }, cols: number, rows: number, viewportY: number) {
  const row = pos.y - viewportY;
  if (row < 0 || row >= rows || !cols || !rows) return;
  const width = screen.width / cols;
  const height = screen.height / rows;
  return { left: screen.left + pos.x * width, top: screen.top + row * height, width, height };
}
