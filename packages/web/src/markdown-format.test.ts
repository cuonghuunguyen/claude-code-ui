import { describe, expect, it } from "vitest";
import { applyFormatEdit, formatEdit, type MarkdownFormat } from "./markdown-format.ts";

function run(text: string, start: number, end: number, f: MarkdownFormat) {
  const e = formatEdit(text, start, end, f);
  return { text: applyFormatEdit(text, e), sel: [e.selectionStart, e.selectionEnd] };
}

describe("formatEdit", () => {
  it("bold wraps the selection and keeps it selected", () => {
    expect(run("say hi now", 4, 6, "bold")).toEqual({ text: "say **hi** now", sel: [6, 8] });
  });

  it("bold with no selection inserts **** with the caret inside", () => {
    expect(run("ab", 1, 1, "bold")).toEqual({ text: "a****b", sel: [3, 3] });
  });

  it("bold unwraps when ** surround the selection, and when the selection includes them", () => {
    expect(run("**hi**", 2, 4, "bold")).toEqual({ text: "hi", sel: [0, 2] });
    expect(run("**hi**", 0, 6, "bold")).toEqual({ text: "hi", sel: [0, 2] });
  });

  it("italic uses * and unwraps; it does not unwrap inside **", () => {
    expect(run("hi", 0, 2, "italic")).toEqual({ text: "*hi*", sel: [1, 3] });
    expect(run("*hi*", 1, 3, "italic")).toEqual({ text: "hi", sel: [0, 2] });
    expect(run("**hi**", 2, 4, "italic")).toEqual({ text: "***hi***", sel: [3, 5] });
  });

  it("inline code: backtick fence longer than the selection's runs; multi-line becomes a code block", () => {
    expect(run("a`b", 0, 3, "code").text).toBe("``a`b``");
    expect(run("x", 0, 1, "code")).toEqual({ text: "`x`", sel: [1, 2] });
    expect(run("`x`", 1, 2, "code")).toEqual({ text: "x", sel: [0, 1] });
    expect(run("x\ny", 0, 3, "code").text).toBe("```\nx\ny\n```");
  });

  it("code block on its own lines; empty puts the caret on the middle line", () => {
    expect(run("ab", 1, 1, "codeBlock")).toEqual({ text: "a\n```\n\n```\nb", sel: [6, 6] });
    expect(run("x", 0, 1, "codeBlock")).toEqual({ text: "```\nx\n```", sel: [4, 5] });
    expect(run("```", 0, 3, "codeBlock").text).toBe("````\n```\n````");
  });

  it("link: text becomes [text](url) with url selected; a URL becomes [](URL) with the caret in []; empty gives [](url)", () => {
    expect(run("see docs", 4, 8, "link")).toEqual({ text: "see [docs](url)", sel: [11, 14] });
    expect(run("https://a.b/c", 0, 13, "link")).toEqual({ text: "[](https://a.b/c)", sel: [1, 1] });
    expect(run("", 0, 0, "link")).toEqual({ text: "[](url)", sel: [1, 1] });
  });

  it("bullet list prefixes each non-empty line of the selected lines and toggles off", () => {
    const a = run("a\n\nb", 0, 4, "bulletList");
    expect(a.text).toBe("- a\n\n- b");
    expect(run(a.text, a.sel[0]!, a.sel[1]!, "bulletList").text).toBe("a\n\nb");
    expect(run("a\nb", 2, 2, "bulletList")).toEqual({ text: "a\n- b", sel: [4, 4] });
    expect(run("", 0, 0, "bulletList")).toEqual({ text: "- ", sel: [2, 2] });
  });
});
