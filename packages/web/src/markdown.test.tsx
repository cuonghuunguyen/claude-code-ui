import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
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
