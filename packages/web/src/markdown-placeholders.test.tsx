// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it } from "vitest";
import { MathPlaceholderParagraph, MermaidPlaceholder } from "./markdown-placeholders.tsx";

beforeAll(() => void ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true));

const html = async (el: ReturnType<typeof createElement>) => {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(el));
  const out = host.innerHTML;
  await act(async () => root.unmount());
  return out;
};

describe("plugin placeholders", () => {
  it("mermaid placeholder reserves height", async () => {
    expect(await html(createElement(MermaidPlaceholder))).toContain("min-h-44");
  });
  it("a paragraph starting with a $$ block reserves height, other paragraphs do not", async () => {
    expect(await html(createElement(MathPlaceholderParagraph, null, ["$$", "\n", "x^2", "\n", "$$"]))).toContain("min-h-14");
    expect(await html(createElement(MathPlaceholderParagraph, null, "so \\(a+b\\) holds"))).not.toContain("min-h");
  });
});
