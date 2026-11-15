import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { MessageResponse } from "./components/ai-elements/message.tsx";
import { describe, expect, it } from "vitest";

// MessageResponse (AI Elements) renders Streamdown; in streaming mode it repairs incomplete markdown.
describe("streaming markdown repair", () => {
  it("renders an unclosed bold span as bold while streaming", () => {
    const html = renderToStaticMarkup(<Streamdown mode="streaming">{"- **Monoton"}</Streamdown>);
    expect(html).toMatch(/data-streamdown="strong">Monoton</);
    expect(html).not.toContain("**");
  });

  it("renders an unclosed code fence as a code block", () => {
    const html = renderToStaticMarkup(<Streamdown mode="streaming">{"```ts\nlet seq = 0;"}</Streamdown>);
    expect(html).toContain('data-streamdown="code-block"');
    expect(html).not.toContain("```");
  });
});

describe("tables in a chat reply", () => {
  const rows = Array.from({ length: 40 }, (_, i) => `| r${i} | v${i} |`).join("\n");
  const table = `| a | b |\n|---|---|\n${rows}\n`;
  it("a chat reply keeps the table in a box capped at 300px; the Files preview passes tableMaxHeight 0 and shows it full height", () => {
    const capped = renderToStaticMarkup(<MessageResponse mode="static">{table}</MessageResponse>);
    expect(capped).toMatch(/max-height:\s*300px/);
    const full = renderToStaticMarkup(<MessageResponse mode="static" tableMaxHeight={0}>{table}</MessageResponse>);
    expect(full).not.toMatch(/max-height:\s*300px/);
  });
});
