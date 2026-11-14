// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMarkdownPlugin, markdownNeeds, resetMarkdownPlugins, useMarkdownPlugins, type MarkdownPlugins } from "./markdown-plugins.ts";

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
