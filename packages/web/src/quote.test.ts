import { describe, expect, it } from "vitest";
import { appendQuote, quoteText } from "./quote.ts";

describe("quote", () => {
  it('quoteText prefixes each line with "> " and ends with an empty line', () => {
    expect(quoteText("a\nb")).toBe("> a\n> b\n\n");
  });
  it('quoteText keeps blank lines as a bare ">" and trims surrounding blank lines', () => {
    expect(quoteText("\n a\n \nb \n")).toBe("> a\n>\n> b\n\n");
  });
  it("quoteText wraps code in a fence inside the quote", () => {
    expect(quoteText("  x = 1\n", 2000, true)).toBe(
      "> ```\n>   x = 1\n> ```\n\n",
    );
  });
  it("quoteText cuts above the cap with …", () => {
    expect(quoteText("a".repeat(2500))).toBe(`> ${"a".repeat(2000)}…\n\n`);
    expect(quoteText("a".repeat(2000))).toBe(`> ${"a".repeat(2000)}\n\n`);
  });
  it("appendQuote: empty box takes the quote, a draft gets an empty line before, a second quote stacks; caret at the end", () => {
    const a = appendQuote("", "> a\n\n");
    expect(a).toEqual({ text: "> a\n\n", caret: 5 });
    const d = appendQuote("draft ", "> a\n\n");
    expect(d.text).toBe("draft\n\n> a\n\n");
    const b = appendQuote(d.text, "> b\n\n");
    expect(b.text).toBe("draft\n\n> a\n\n> b\n\n");
    expect(b.caret).toBe(b.text.length);
  });
  it("quoteText uses a fence longer than any backtick run and does not split a surrogate pair", () => {
    expect(quoteText("a ```b``` c", 2000, true)).toBe(
      "> ````\n> a ```b``` c\n> ````\n\n",
    );
    expect(quoteText("a😀", 2)).toBe("> a…\n\n");
  });
});
