import { expect, it } from "vitest";
import { TERMINAL_SNIPPET_MAX, cellRect, stripAnsi, terminalSnippet } from "./terminal-snippet.ts";

const opts = { title: "Terminal 1", cwd: "/abs/project" };

it("stripAnsi removes colors, OSC hyperlinks and controls, normalizes line ends", () => {
  expect(stripAnsi("\x1b[31mred\x1b[0m ok")).toBe("red ok");
  expect(stripAnsi("\x1b]8;;https://example.com\x07link\x1b]8;;\x07 and \x1b]0;title\x1b\\x")).toBe("link and x");
  expect(stripAnsi("a\r\nb\rc\x07d\x00e\x9bf\tg")).toBe("a\nb\ncdef\tg");
  expect(stripAnsi("trail   \nnext  ")).toBe("trail\nnext");
  expect(stripAnsi("\x1b(Bx")).toBe("x");
});

it("terminalSnippet wraps the selection in a text fence with the terminal name and cwd", () => {
  expect(terminalSnippet("\x1b[31mred-710\x1b[0m\n", opts)).toBe('Output of terminal "Terminal 1" in `/abs/project`:\n```text\nred-710\n```\n');
});

it("terminalSnippet is undefined for a blank selection", () => {
  expect(terminalSnippet("  \n \x1b[0m\n", opts)).toBeUndefined();
});

it("terminalSnippet uses a fence longer than any backtick run inside", () => {
  const s = terminalSnippet("echo ```x```", opts)!;
  expect(s).toContain("````text\necho ```x```\n````\n");
});

it("terminalSnippet keeps the tail at a line boundary over the cap and says so", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
  const s = terminalSnippet(lines.join("\n"), opts)!;
  const body = s.split("```text\n")[1]!.replace(/```\n$/, "");
  expect(body.length).toBeLessThanOrEqual(TERMINAL_SNIPPET_MAX);
  expect(body.endsWith("line 3000\n")).toBe(true);
  expect(body.startsWith("line ")).toBe(true);
  const kept = body.trimEnd().split("\n").length;
  expect(s.split("\n")[0]).toBe(`Output of terminal "Terminal 1" in \`/abs/project\` (truncated: last ${kept.toLocaleString("en-US")} of 3,000 lines):`);
  expect(body.split("\n")[0]).toBe(`line ${3000 - kept + 1}`);
});

it("terminalSnippet keeps the last chars of one huge line without splitting a surrogate pair", () => {
  const huge = "x" + "😀".repeat(TERMINAL_SNIPPET_MAX);
  const s = terminalSnippet(huge, opts)!;
  expect(s.split("\n")[0]).toContain(`(truncated: last ${TERMINAL_SNIPPET_MAX.toLocaleString("en-US")} of ${huge.length.toLocaleString("en-US")} characters)`);
  const body = s.split("```text\n")[1]!.replace(/\n```\n$/, "");
  expect(body.length).toBeLessThanOrEqual(TERMINAL_SNIPPET_MAX);
  expect(/^[\uDC00-\uDFFF]/.test(body)).toBe(false);
  expect(body.startsWith("😀")).toBe(true);
});

it("cellRect maps a selection end cell to a screen rect", () => {
  const screen = { left: 100, top: 50, width: 800, height: 480 } as DOMRect;
  // 80 x 24 cells of 10 x 20 px; y is the buffer row (0-based); viewportY 5: row 7 is viewport row 2.
  expect(cellRect({ x: 3, y: 7 }, screen, 80, 24, 5)).toEqual({ left: 130, top: 90, width: 10, height: 20 });
  expect(cellRect({ x: 0, y: 4 }, screen, 80, 24, 5)).toBeUndefined();
  expect(cellRect({ x: 0, y: 29 }, screen, 80, 24, 5)).toBeUndefined();
  expect(cellRect({ x: 0, y: 28 }, screen, 80, 24, 5)).toEqual({ left: 100, top: 50 + 23 * 20, width: 10, height: 20 });
});

it("terminalSnippet keeps a cwd with a backtick inside inline code", () => {
  expect(terminalSnippet("x", { title: "T", cwd: "/a`b" })!.split("\n")[0]).toBe('Output of terminal "T" in ``/a`b``:');
});
