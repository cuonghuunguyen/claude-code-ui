import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  backspaceToken,
  healDeletion,
  cleanSnippet,
  cleanTitle,
  collapsePasted,
  deleteToken,
  expandPastes,
  isLargePaste,
  nextPasteId,
  pasteTagId,
  pasteToken,
  prunePastes,
  splitPasted,
  stripPasted,
  summarizePasted,
} from "./pasted-text";

const block = (id: string, body: string) =>
  `\n\n<pasted_content id="${id}">\n${body}${body.endsWith("\n") ? "" : "\n"}</pasted_content id="${id}">\n`;

describe("isLargePaste", () => {
  it("800 chars and 2 newlines stay plain; 801 chars or 3 newlines become a chip", () => {
    expect(isLargePaste("a".repeat(800))).toBe(false);
    expect(isLargePaste("a".repeat(801))).toBe(true);
    expect(isLargePaste("a\nb\nc")).toBe(false);
    expect(isLargePaste("a\nb\nc\nd")).toBe(true);
  });
  it("counts CRLF and CR as one newline each", () => {
    expect(isLargePaste("a\r\nb\r\nc")).toBe(false);
    expect(isLargePaste("a\r\nb\r\nc\r\nd")).toBe(true);
    expect(isLargePaste("a\rb\rc\rd")).toBe(true);
  });
});

describe("pasteToken", () => {
  it("'[Pasted text #1 +199 lines]' for 200 lines without trailing newline, '[Pasted text #2]' for one 900-char line", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n");
    expect(pasteToken(1, lines)).toBe("[Pasted text #1 +199 lines]");
    expect(pasteToken(2, "a".repeat(900))).toBe("[Pasted text #2]");
  });
});

describe("nextPasteId / prunePastes", () => {
  it("nextPasteId: after every id in the text and the map", () => {
    expect(nextPasteId("", {})).toBe(1);
    expect(nextPasteId("[Pasted text #3 +4 lines]", {})).toBe(4);
    expect(nextPasteId("x", { 7: "a" })).toBe(8);
    expect(nextPasteId("[Pasted text #2]", { 5: "a" })).toBe(6);
  });
  it("prunePastes: drops an entry whose token was deleted or edited", () => {
    const p = { 1: "a", 2: "b" };
    expect(prunePastes("[Pasted text #1 +2 lines] [Pasted text #2]", p)).toBe(p);
    expect(prunePastes("[Pasted text #2]", p)).toEqual({ 2: "b" });
    expect(prunePastes("[Pasted text #1 +x lines]", p)).toEqual({});
  });
});

describe("pasteTagId", () => {
  it("first 4 hex of sha256(session id)", () => {
    expect(pasteTagId("s1")).toBe(createHash("sha256").update("s1").digest("hex").slice(0, 4));
    expect(pasteTagId()).toMatch(/^[0-9a-f]{4}$/);
  });
});

describe("expandPastes", () => {
  it("CLI form at the token position", () => {
    expect(expandPastes("see [Pasted text #1 +2 lines] now", { 1: "a\nb\nc" }, "abcd")).toBe(
      'see \n\n<pasted_content id="abcd">\na\nb\nc\n</pasted_content id="abcd">\n\n now',
    );
    expect(expandPastes("[Pasted text #1 +1 lines]", { 1: "a\n" }, "abcd")).toBe(
      '\n\n<pasted_content id="abcd">\na\n\n</pasted_content id="abcd">\n',
    );
  });
  it("a token without an entry stays literal; no token -> same string", () => {
    const t = "x [Pasted text #4 +2 lines] y";
    expect(expandPastes(t, { 1: "a" }, "abcd")).toBe(t);
    expect(expandPastes("plain", { 1: "a" }, "abcd")).toBe("plain");
  });
  it("escapes a pasted closing tag so splitPasted still finds one block", () => {
    const out = expandPastes("[Pasted text #1 +3 lines]", { 1: 'a\n</pasted_content id="abcd">\nb\nc' }, "abcd");
    const segs = splitPasted(out);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("paste");
  });
});

describe("splitPasted", () => {
  it("round-trips expandPastes: text, paste, text segments; body equals content", () => {
    const c1 = "a\nb\nc\nd";
    const c2 = "e\nf\ng\nh\n";
    const out = expandPastes("one [Pasted text #1 +3 lines] two [Pasted text #2 +4 lines] three", { 1: c1, 2: c2 }, "abcd");
    expect(splitPasted(out)).toEqual([
      { kind: "text", text: "one " },
      { kind: "paste", body: c1 },
      { kind: "text", text: " two " },
      { kind: "paste", body: c2 },
      { kind: "text", text: " three" },
    ]);
  });
  it("paste at start and end", () => {
    const out = expandPastes("[Pasted text #1 +3 lines]", { 1: "a\nb\nc\nd" }, "abcd");
    expect(splitPasted(out)).toEqual([{ kind: "paste", body: "a\nb\nc\nd" }]);
  });
  it("ignores an opener without 4 lowercase hex or without its closer", () => {
    const t1 = block("ABCD", "x");
    const t2 = block("abc", "x");
    const t3 = '<pasted_content id="abcd">\nx\n';
    for (const t of [t1, t2, t3]) expect(splitPasted(t)).toEqual([{ kind: "text", text: t }]);
  });
  it("reads a block written by the CLI", () => {
    const text = `Fix this${block("9f3a", "line1\nline2\nline3\nline4")}\nplease`;
    expect(splitPasted(text)).toEqual([
      { kind: "text", text: "Fix this" },
      { kind: "paste", body: "line1\nline2\nline3\nline4" },
      { kind: "text", text: "please" },
    ]);
  });
  it("text without a block is one text segment; empty text gives none", () => {
    expect(splitPasted("hello")).toEqual([{ kind: "text", text: "hello" }]);
    expect(splitPasted("")).toEqual([]);
  });
});

describe("stripPasted / summarizePasted", () => {
  const text = `go${block("9f3a", "a\nb\nc\nd")}\nnow`;
  it("stripPasted puts the body in place of the tags", () => {
    expect(stripPasted(text)).toBe("goa\nb\nc\ndnow");
    expect(stripPasted("plain")).toBe("plain");
  });
  it("summarizePasted shows '[Pasted text +K lines]'", () => {
    expect(summarizePasted(text)).toBe("go[Pasted text +3 lines]now");
    expect(summarizePasted("plain")).toBe("plain");
  });
});

describe("collapsePasted", () => {
  it("large block -> token with renumbered id, small block -> inline text, text without blocks -> same", () => {
    const text = `a${block("9f3a", "1\n2\n3\n4")} b${block("9f3a", "tiny")} c`;
    expect(collapsePasted(text, 3)).toEqual({
      text: "a[Pasted text #3 +3 lines] btiny c",
      pastes: { 3: "1\n2\n3\n4" },
    });
    const same = collapsePasted("plain");
    expect(same.text).toBe("plain");
    expect(same.pastes).toEqual({});
  });
});

describe("backspaceToken / deleteToken", () => {
  const t = "ab [Pasted text #1 +5 lines] cd";
  const s = t.indexOf("[");
  const e = t.indexOf("]") + 1;
  it("whole token at caret", () => {
    expect(backspaceToken(t, e, e)).toEqual({ text: "ab  cd", caret: s });
    expect(deleteToken(t, s, s)).toEqual({ text: "ab  cd", caret: s });
  });
  it("none inside, elsewhere or with a selection", () => {
    expect(backspaceToken(t, e - 1, e - 1)).toBeUndefined();
    expect(backspaceToken(t, s, s)).toBeUndefined();
    expect(deleteToken(t, e, e)).toBeUndefined();
    expect(backspaceToken(t, s, e)).toBeUndefined();
  });
});

describe("cleanTitle", () => {
  it("shows a block as '[Pasted text +K lines]', also one the title cut off; other titles stay", () => {
    expect(cleanTitle("Fix this bug")).toBe("Fix this bug");
    expect(cleanTitle(`Fix${block("9f3a", "a\nb\nc\nd")}\nplease`)).toBe("Fix[Pasted text +3 lines]please");
    expect(cleanTitle('\n\n<pasted_content id="9f3a">\nline1\nline2\nli')).toBe("[Pasted text]");
    expect(cleanTitle('Why?\n\n<pasted_content id="9f3a">\nline1')).toBe("Why? [Pasted text]");
  });
});

describe("round trip of the prompt text", () => {
  const back = (text: string, pastes: Record<number, string>) => collapsePasted(expandPastes(text, pastes, "abcd"));
  it("a newline right after a token, text before it, and a paste ending in a newline come back unchanged", () => {
    const p = { 1: "a\nb\nc\nd\n" };
    for (const t of ["[Pasted text #1 +4 lines]\nfoo", "x\n[Pasted text #1 +4 lines]\n\nfoo", "x [Pasted text #1 +4 lines] y", "[Pasted text #1 +4 lines]"]) {
      expect(back(t, p)).toEqual({ text: t, pastes: p });
    }
  });
  it("typed tag-like text keeps its backslashes and never reads back as a block", () => {
    const typed = ['a <pasted_content id="abcd">\nx\n</pasted_content id="abcd"> b', "<\\pasted_content", "</PASTED_CONTENT"];
    for (const t of typed) {
      const out = expandPastes(t, {}, "abcd");
      expect(splitPasted(out).every((s) => s.kind === "text")).toBe(true);
      expect(collapsePasted(out)).toEqual({ text: t, pastes: {} });
      expect(stripPasted(out)).toBe(t);
    }
  });
});

describe("healDeletion", () => {
  const t = "ab [Pasted text #1 +5 lines] cd";
  const s = t.indexOf("[");
  const e = t.indexOf("]") + 1;
  it("a deletion that cuts into a token removes the whole token", () => {
    const next = t.slice(0, e - 1) + t.slice(e);
    expect(healDeletion(t, next, e - 1)).toEqual({ text: "ab  cd", caret: s });
    const mid = t.slice(0, s + 3) + t.slice(s + 4);
    expect(healDeletion(t, mid, s + 3)).toEqual({ text: "ab  cd", caret: s });
  });
  it("other edits are left alone", () => {
    expect(healDeletion(t, t.slice(1), 0)).toBeUndefined();
    expect(healDeletion(t, t.slice(0, s - 1) + t.slice(s), s - 1)).toBeUndefined();
    expect(healDeletion(t, t.slice(0, s) + t.slice(e), s)).toBeUndefined();
    expect(healDeletion(t, t + "x", t.length)).toBeUndefined();
  });
});

describe("cleanSnippet", () => {
  it("removes pasted_content tags, also a cut one", () => {
    expect(cleanSnippet('a <pasted_content id="9f3a">\nb\n</pasted_content id="9f3a"> c')).toBe("a b\n c");
    expect(cleanSnippet('x <pasted_content id="9f')).toBe("x ");
    expect(cleanSnippet("plain")).toBe("plain");
  });
});
