import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi.ts";

describe("parseAnsi", () => {
  it("splits colored text and resets", () => {
    expect(parseAnsi("a\x1b[31mred\x1b[0mb")).toEqual([
      { text: "a", style: {} },
      { text: "red", style: { color: "#cd3131" } },
      { text: "b", style: {} },
    ]);
  });

  it("combines bold, bright, background, 256 and truecolor", () => {
    expect(parseAnsi("\x1b[1;92;44mx")[0]?.style).toEqual({ fontWeight: "bold", color: "#23d18b", backgroundColor: "#2472c8" });
    expect(parseAnsi("\x1b[38;5;196mx")[0]?.style).toEqual({ color: "rgb(255,0,0)" });
    expect(parseAnsi("\x1b[48;2;1;2;3mx")[0]?.style).toEqual({ backgroundColor: "rgb(1,2,3)" });
    expect(parseAnsi("\x1b[31m\x1b[39mx")[0]?.style).toEqual({});
  });

  it("drops non-color escapes and keeps plain text as is", () => {
    expect(parseAnsi("\x1b[2K\x1b]0;title\x07ok")).toEqual([{ text: "ok", style: {} }]);
    expect(parseAnsi("plain\ntext")).toEqual([{ text: "plain\ntext", style: {} }]);
  });
});
