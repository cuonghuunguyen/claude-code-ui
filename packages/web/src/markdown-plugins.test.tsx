// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { backslashMathToDollars, loadMarkdownPlugin, markdownNeeds, resetMarkdownPlugins, useMarkdownPlugins, type MarkdownPlugins } from "./markdown-plugins.ts";

const sheet = vi.hoisted(() => ({ loaded: 0 }));

beforeAll(() => void ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true));
afterEach(resetMarkdownPlugins);

describe("markdownNeeds", () => {
  it("plain text and inline code need nothing", () => {
    expect(markdownNeeds("Just `code` and a price of 5 dollars.")).toEqual({ code: false, mermaid: false, math: false });
  });
  it("a code fence needs the code plugin, a mermaid fence also the mermaid plugin", () => {
    expect(markdownNeeds("text\n```ts\nlet a = 1\n```")).toEqual({ code: true, mermaid: false, math: false });
    expect(markdownNeeds("~~~mermaid\ngraph TD\n~~~")).toMatchObject({ code: true, mermaid: true });
    expect(markdownNeeds("  ```Mermaid\ngraph TD\n```")).toMatchObject({ mermaid: true });
  });
  it("math: $$ blocks and \\( \\) \\[ \\]; a single $ is text (the plugin has singleDollarTextMath off)", () => {
    expect(markdownNeeds("$$\nx^2\n$$").math).toBe(true);
    expect(markdownNeeds("\\(a+b\\)").math).toBe(true);
    expect(markdownNeeds("so $x^2$ holds").math).toBe(false);
    expect(markdownNeeds("costs $5 or $ 6").math).toBe(false);
  });
});

describe("useMarkdownPlugins", () => {
  const render = async (text: string) => {
    const seen: MarkdownPlugins[] = [];
    const Probe = () => (seen.push(useMarkdownPlugins(text)), null);
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () => root.render(createElement(Probe)));
    return { seen, root };
  };

  it("plain text never loads a plugin", async () => {
    const { seen, root } = await render("hello");
    const last = seen[seen.length - 1];
    expect(last.code ?? last.math ?? last.mermaid).toBeUndefined();
    expect(last.cjk).toBeDefined();
    await act(async () => root.unmount());
  });

  it("a code fence renders without the code plugin first, then with it once it loaded", async () => {
    const { seen, root } = await render("```ts\nx\n```");
    expect(seen[0].code).toBeUndefined();
    await act(async () => void (await loadMarkdownPlugin("code")));
    expect(seen[seen.length - 1].code).toBeDefined();
    expect(seen[seen.length - 1].math).toBeUndefined();
    await act(async () => root.unmount());
  });

  it("after the first load a later text has the plugin on its first render", async () => {
    await loadMarkdownPlugin("math");
    const { seen, root } = await render("$$x$$");
    expect(seen[0].math).toBeDefined();
    await act(async () => root.unmount());
  });
});

describe("math plugin stylesheet (GH-790)", () => {
  it("loading the math plugin loads the KaTeX stylesheet, the other plugins do not", async () => {
    vi.resetModules();
    sheet.loaded = 0;
    vi.doMock("katex/dist/katex.min.css", () => ((sheet.loaded += 1), {}));
    const fresh = await import("./markdown-plugins.ts");
    await fresh.loadMarkdownPlugin("code");
    await fresh.loadMarkdownPlugin("mermaid");
    expect(sheet.loaded).toBe(0);
    await fresh.loadMarkdownPlugin("math");
    expect(sheet.loaded).toBe(1);
  });
});

describe("backslash math delimiters (GH-798)", () => {
  it("rewrites \\( \\) inline and \\[ \\] block to $$", () => {
    expect(backslashMathToDollars("so \\(a+b\\) holds")).toBe("so $$a+b$$ holds");
    expect(backslashMathToDollars("x \\[\n a^2 \n\\] y")).toBe("x \n\n$$\na^2\n$$\n\n y");
  });
  it("a standalone \\[ \\] keeps its list indent and blockquote prefix, same length", () => {
    expect(backslashMathToDollars("1. Step:\n   \\[\n   x = 1\n   \\]\n2. Next")).toBe("1. Step:\n   $$\n   x = 1\n   $$\n2. Next");
    expect(backslashMathToDollars("> \\[\n> a^2\n> \\]")).toBe("> $$\n> a^2\n> $$");
  });
  it("text after a closing \\] on its line: the block form, so the $$ still closes the formula", () => {
    expect(backslashMathToDollars("\\[\nx\n\\] tail\n\nnext")).toBe("\n\n$$\nx\n$$\n\n tail\n\nnext");
    expect(backslashMathToDollars("\\[\nx\n\\].\n")).toBe("\n\n$$\nx\n$$\n\n.\n");
  });
  it("many indented code blocks stay fast", () => {
    const t = Date.now();
    backslashMathToDollars("a\n\n    c\n\n".repeat(20000) + "\\(x\\)".repeat(20000));
    expect(Date.now() - t).toBeLessThan(500);
  });
  it("indented code stays literal; a list item's indented continuation is not code", () => {
    for (const t of ["    \\(a\\)", "text\n\n    \\[a\\]\n\n\tx \\(b\\)"]) expect(backslashMathToDollars(t)).toBe(t);
    expect(backslashMathToDollars("text\n\n    \\(a\\)\n\nafter \\(b\\)")).toBe("text\n\n    \\(a\\)\n\nafter $$b$$");
    expect(backslashMathToDollars("text\n    \\(a\\)")).toBe("text\n    $$a$$");
    expect(backslashMathToDollars("- item\n\n    \\(a\\)")).toBe("- item\n\n    $$a$$");
  });
  it("\\[ \\] in a table cell is inline math, the row stays one line", () => {
    expect(backslashMathToDollars("| a | b |\n|---|---|\n| \\[y\\] | 2 |")).toBe("| a | b |\n|---|---|\n| $$y$$ | 2 |");
  });
  it("\\[ \\] inside a line of a list item or quote is inline math, so the list or quote is not split", () => {
    expect(backslashMathToDollars("- one \\[ p^2 \\]\n- two")).toBe("- one $$ p^2 $$\n- two");
    expect(backslashMathToDollars("1. one \\[p\\]\n2. two")).toBe("1. one $$p$$\n2. two");
    expect(backslashMathToDollars("> see \\[p\\]")).toBe("> see $$p$$");
  });
  it("a stray opener does not pair across a blank line, and an unclosed one is fast", () => {
    expect(backslashMathToDollars("group with \\( only\n\nlater \\(x\\)")).toBe("group with \\( only\n\nlater $$x$$");
    expect(backslashMathToDollars("a ` b\n\n\\(x\\)")).toBe("a ` b\n\n$$x$$");
    const t = Date.now();
    backslashMathToDollars("\\(".repeat(50000));
    expect(Date.now() - t).toBeLessThan(500);
  });
  it("leaves code spans, fences and escaped backslashes literal", () => {
    for (const t of ["`\\(a\\)`", "``x \\[a\\] ``", "```\n\\(a\\)\n```", "~~~tex\n\\[a\\]\n~~~", "\\\\(a\\\\)", "plain"]) expect(backslashMathToDollars(t)).toBe(t);
    expect(backslashMathToDollars("```\n\\(a\\)\n```\n\\(b\\)")).toBe("```\n\\(a\\)\n```\n$$b$$");
  });

  it("the loaded math plugin renders both forms as KaTeX, once, and code stays literal", async () => {
    const { Streamdown } = await import("streamdown");
    const { renderToStaticMarkup } = await import("react-dom/server");
    await loadMarkdownPlugin("math");
    let plugins: MarkdownPlugins = { cjk: (await import("@streamdown/cjk")).cjk };
    const Probe = () => (plugins = useMarkdownPlugins("$$"), null);
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    const html = renderToStaticMarkup(
      createElement(Streamdown, { plugins }, "in \\(a+b\\) and\n\n\\[\nc^2\n\\]\n\nuse `\\(x\\)` and\n\n```\n\\[y\\]\n```"),
    );
    expect((html.match(/class="katex"/g) ?? []).length).toBe(2);
    expect(html).toContain("katex-display");
    expect(html).toContain("\\(x\\)");
    expect(html).toContain("\\[y\\]");
    await act(async () => root.unmount());
  });
});
