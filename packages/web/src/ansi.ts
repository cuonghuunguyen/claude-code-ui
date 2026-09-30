// ANSI SGR escapes → styled text segments for Bash output (docs/spec.md "Components": Bash output).
import type { CSSProperties } from "react";

export type Segment = { text: string; style: CSSProperties };

// xterm default palette: 0-7 normal, 8-15 bright.
const BASIC = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function color256(n: number): string {
  if (n < 16) return BASIC[n] ?? "";
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(c / 36))},${level(Math.floor(c / 6) % 6)},${level(c % 6)})`;
}

// SGR sequences are kept; any other CSI/OSC escape (cursor moves, titles, links) is dropped.
const ESCAPE = /\x1b\[([\d;]*)m|\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function apply(style: CSSProperties, params: string): CSSProperties {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  let s = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i] ?? 0;
    if (c === 0) s = {};
    else if (c === 1) s.fontWeight = "bold";
    else if (c === 2) s.opacity = 0.7;
    else if (c === 3) s.fontStyle = "italic";
    else if (c === 4) s.textDecoration = "underline";
    else if (c === 22) {
      delete s.fontWeight;
      delete s.opacity;
    } else if (c === 23) delete s.fontStyle;
    else if (c === 24) delete s.textDecoration;
    else if (c >= 30 && c <= 37) s.color = BASIC[c - 30];
    else if (c >= 90 && c <= 97) s.color = BASIC[c - 90 + 8];
    else if (c >= 40 && c <= 47) s.backgroundColor = BASIC[c - 40];
    else if (c >= 100 && c <= 107) s.backgroundColor = BASIC[c - 100 + 8];
    else if (c === 39) delete s.color;
    else if (c === 49) delete s.backgroundColor;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? "color" : "backgroundColor";
      if (codes[i + 1] === 5) {
        s[key] = color256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        s[key] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
  return s;
}

/** Splits text at ANSI escapes into segments with the style active for each. */
export function parseAnsi(input: string): Segment[] {
  const out: Segment[] = [];
  let style: CSSProperties = {};
  let last = 0;
  for (const m of input.matchAll(ESCAPE)) {
    if (m.index > last) out.push({ text: input.slice(last, m.index), style });
    if (m[1] !== undefined) style = apply(style, m[1]);
    last = m.index + m[0].length;
  }
  if (last < input.length) out.push({ text: input.slice(last), style });
  return out;
}
