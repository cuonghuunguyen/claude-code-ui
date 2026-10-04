import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "./store.ts";
import { ContextGroup, CwdContext, SubagentGroup, ToolBody, ToolCard } from "./tool-card.tsx";

const call = (status: ToolCall["status"], tool = "Bash"): ToolCall => ({
  type: "tool_call",
  id: "t1",
  toolUseId: "t1",
  tool,
  input: { command: "echo hello", description: "Print hello" },
  status,
});

describe("ToolCard", () => {
  it("header shows tool name, one-line summary and status; body is collapsed", () => {
    const html = renderToStaticMarkup(<ToolCard call={call("running")} />);
    expect(html).toContain("Bash");
    expect(html).toContain("echo hello");
    expect(html).toContain("Running");
    expect(html).toContain('data-status="running"');
    expect(html).not.toContain("Parameters");
  });

  it("header says when the input is the user's edit from the permission panel", () => {
    expect(renderToStaticMarkup(<ToolCard call={call("running")} />)).not.toContain("edited by you");
    expect(renderToStaticMarkup(<ToolCard call={{ ...call("running"), editedByUser: true }} />)).toContain("edited by you");
  });

  it.each([
    ["pending", "Pending"],
    ["done", "Completed"],
    ["error", "Error"],
    ["denied", "Denied"],
  ] as const)("status %s renders as %s", (status, label) => {
    expect(renderToStaticMarkup(<ToolCard call={call(status)} />)).toContain(label);
  });
});

const done = (tool: string, input: unknown): ToolCall => ({ type: "tool_call", id: "t1", toolUseId: "t1", tool, input, status: "done" });
const result = (output: unknown, isError = false) => ({
  type: "tool_result" as const,
  id: "t1:result",
  toolUseId: "t1",
  output,
  isError,
});

describe("Bash card", () => {
  it("shows the command and ANSI-colored monospace output", () => {
    const html = renderToStaticMarkup(<ToolBody call={done("Bash", { command: "ls --color" })} result={result("\x1b[34mdir\x1b[0m\nfile")} />);
    expect(html).toContain('data-testid="bash-command"');
    expect(html).toContain("ls --color");
    expect(html).toMatch(/<span style="color:#2472c8">dir<\/span>/);
    expect(html).toContain("file");
    expect(html).not.toContain("Parameters");
  });

  it("is one bordered box: command and output as plain text, no inner box", () => {
    const html = renderToStaticMarkup(<ToolBody call={done("Bash", { command: "ls" })} result={result("file")} />);
    expect(html).not.toContain("bg-muted");
  });

  it("collapses output after 20 lines with an expand button", () => {
    const out = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join("\n");
    const html = renderToStaticMarkup(<ToolBody call={done("Bash", { command: "seq 25" })} result={result(out)} />);
    expect(html).toContain("line20");
    expect(html).not.toContain("line21");
    expect(html).toContain("Show all 25 lines");
  });

  it("shows no expand button for short output, and errors in the error style", () => {
    const html = renderToStaticMarkup(<ToolBody call={done("Bash", { command: "false" })} result={result("boom", true)} />);
    expect(html).not.toContain("Show all");
    expect(html).toContain("boom");
    expect(html).toContain("text-destructive");
  });
});

describe("Read card", () => {
  it("header shows the file path and the line range read, while collapsed", () => {
    const html = renderToStaticMarkup(<ToolCard call={done("Read", { file_path: "/w/a.ts", offset: 10, limit: 5 })} />);
    expect(html).toContain("a.ts");
    expect(html).toContain("lines 10–14");
    expect(html).not.toContain('data-testid="read-path"');
  });

  it("header shows the file name, then the directory relative to cwd; the full path in a tooltip", () => {
    const html = renderToStaticMarkup(
      <CwdContext value="/w">
        <ToolCard call={done("Read", { file_path: "/w/src/lib/a.ts" })} />
      </CwdContext>,
    );
    // Tooltip on the whole row trigger, not only on the summary.
    expect(html).toMatch(/<button[^>]*title="\/w\/src\/lib\/a.ts"/);
    expect(html).toMatch(/data-testid="file-name"[^>]*>a.ts</);
    // The directory, not the name, is cut when the row is narrow: right-to-left ellipsis.
    expect(html).toMatch(/data-testid="file-dir" class="[^"]*\[direction:rtl\][^"]*"><bdi>src\/lib<\/bdi>/);
    expect(html).not.toMatch(/>\/w\/src/);
  });

  it("a narrow row cuts the directory first, then the name; the range stays visible", () => {
    const html = renderToStaticMarkup(
      <CwdContext value="/w">
        <ToolCard call={done("Read", { file_path: "/w/src/a.ts", offset: 1, limit: 2 })} />
      </CwdContext>,
    );
    expect(html).toMatch(/data-testid="file-name" class="[^"]*min-w-0 truncate/);
    expect(html).toMatch(/data-testid="file-dir" class="[^"]*shrink-\[1000\]/);
    // The range does not shrink, so it is never clipped.
    expect(html).toMatch(/<\/bdi><\/span><span data-testid="read-range" class="shrink-0[^"]*">· lines 1–2</);
  });

  it("body shows the file path, range and content", () => {
    const html = renderToStaticMarkup(<ToolBody call={done("Read", { file_path: "/w/a.ts", limit: 2 })} result={result("1\ta\n2\tb")} />);
    expect(html).toContain('data-testid="read-path"');
    expect(html).toContain("lines 1–2");
    expect(html).toContain("2\tb");
  });

  it("takes the range from the result line numbers when the input has none", () => {
    const html = renderToStaticMarkup(<ToolCard call={done("Read", { file_path: "/w/a.ts" })} result={result("     1\ta\n     2\tb\n     3\tc")} />);
    expect(html).toContain("lines 1–3");
  });
});

describe("Grep/Glob card", () => {
  it.each(["Grep", "Glob"])("%s shows the pattern, scope and matches", (tool) => {
    const html = renderToStaticMarkup(
      <ToolBody call={done(tool, { pattern: "foo.*", path: "/w/src" })} result={result("/w/src/a.ts\n/w/src/b.ts")} />,
    );
    expect(html).toContain('data-testid="search-pattern"');
    expect(html).toContain("foo.*");
    expect(html).toContain("/w/src");
    expect(html).toContain("/w/src/b.ts");
    expect(html).not.toContain("Parameters");
  });
});

describe("ExitPlanMode", () => {
  it("shows the plan as markdown, not the JSON parameters", () => {
    const html = renderToStaticMarkup(<ToolBody call={done("ExitPlanMode", { plan: "# Plan\n\n- step **one**" })} result={result("ok")} />);
    expect(html).toContain('data-testid="plan"');
    expect(html).toContain('data-streamdown="strong">one<');
    expect(html).not.toContain("Parameters");
  });
});

describe("other tools", () => {
  it("fall back to the generic JSON card", () => {
    const html = renderToStaticMarkup(<ToolBody call={done("WebFetch", { url: "https://x" })} result={result("page")} />);
    expect(html).toContain("Parameters");
    expect(html).toContain("Result");
    expect(renderToStaticMarkup(<ToolCard call={done("WebFetch", { url: "https://x" })} />)).not.toContain("Parameters");
  });
});

describe("ContextGroup", () => {
  const calls = [call("done", "Read"), { ...call("done", "Grep"), id: "t2" }, { ...call("done", "Read"), id: "t3" }];

  it("is one row: Explored and the read/search counts", () => {
    const html = renderToStaticMarkup(<ContextGroup calls={calls} result={() => undefined} />);
    expect(html).toContain("Explored");
    expect(html).toContain("2 reads, 1 search");
    expect(html).not.toContain("Error");
  });

  it("says Exploring while a call runs, and flags a failed call", () => {
    expect(renderToStaticMarkup(<ContextGroup calls={[...calls, { ...call("running", "Glob"), id: "t4" }]} result={() => undefined} />)).toContain(
      "Exploring",
    );
    expect(renderToStaticMarkup(<ContextGroup calls={[...calls, { ...call("error", "Glob"), id: "t4" }]} result={() => undefined} />)).toContain("Error");
  });
});

describe("ToolCard edits", () => {
  const edit = (tool: string, input: unknown): ToolCall => ({ type: "tool_call", id: "e", toolUseId: "e", tool, input, status: "done" });

  it("Edit body is a diff instead of the JSON parameters", () => {
    const html = renderToStaticMarkup(<ToolBody call={edit("Edit", { file_path: "/p/a.ts", old_string: "b = 2", new_string: "b = 3" })} />);
    // @pierre/diffs renders the diff client-side into this element.
    expect(html).toMatch(/data-testid="edit-diff"><diffs-container>/);
    expect(html).not.toContain("Parameters");
  });

  it("an Edit body shows parameters until the input is complete", () => {
    const html = renderToStaticMarkup(<ToolBody call={{ ...edit("Edit", {}), status: "pending" }} />);
    expect(html).not.toContain("edit-diff");
    expect(html).toContain("Parameters");
  });

  it("Edit body shows the result text only on error", () => {
    const input = { file_path: "/p/a.ts", old_string: "b = 2", new_string: "b = 3" };
    expect(renderToStaticMarkup(<ToolBody call={edit("Edit", input)} result={result("The file was updated")} />)).not.toContain("was updated");
    expect(renderToStaticMarkup(<ToolBody call={edit("Edit", input)} result={result("String not found", true)} />)).toContain("String not found");
  });

  it("collapsed Edit header shows path and +/- line counts", () => {
    const html = renderToStaticMarkup(
      <ToolCard call={edit("Edit", { file_path: "/p/a.ts", old_string: "a\nb = 2", new_string: "a\nb = 3\nc" })} />,
    );
    expect(html).toContain("/p/a.ts");
    expect(html).toMatch(/data-testid="diff-stats"[^>]*><span[^>]*>\+2<\/span><span[^>]*>-1<\/span>/);
    // Theme tokens at 4.5:1 or more in light and dark; raw green-600 is 3.2:1 on white.
    expect(html).toMatch(/class="text-success">\+2</);
    expect(html).toMatch(/class="ml-1 text-destructive">-1</);
    expect(html).not.toContain("edit-diff");
  });

  it("no diff stats until the input is complete, and none for other tools", () => {
    expect(renderToStaticMarkup(<ToolCard call={{ ...edit("Edit", {}), status: "pending" }} />)).not.toContain("diff-stats");
    expect(renderToStaticMarkup(<ToolCard call={done("Bash", { command: "ls" })} />)).not.toContain("diff-stats");
  });
});

describe("collapsed by default", () => {
  it.each([
    ["Bash", { command: "ls" }, "bash-command"],
    ["Edit", { file_path: "/p/a.ts", old_string: "x", new_string: "y" }, "edit-diff"],
    ["Write", { file_path: "/p/n.txt", content: "hi" }, "edit-diff"],
    ["Read", { file_path: "/p/a.ts" }, "read-path"],
    ["Grep", { pattern: "x" }, "search-pattern"],
    ["WebFetch", { url: "https://x" }, "Parameters"],
  ])("%s card renders collapsed", (tool, input, body) => {
    const html = renderToStaticMarkup(<ToolCard call={done(tool, input)} result={result("out")} />);
    expect(html).not.toContain(body);
    expect(html).toContain('aria-expanded="false"');
  });

  it("a card with a pending permission request is expanded and says it awaits approval", () => {
    const html = renderToStaticMarkup(<ToolCard call={{ ...done("Bash", { command: "rm -rf x" }), status: "running" }} awaiting />);
    expect(html).toContain("bash-command");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Awaiting approval");
  });

  it("a context group holding the awaited call is expanded", () => {
    const html = renderToStaticMarkup(
      <ContextGroup calls={[call("running", "Read"), { ...call("running", "Read"), id: "t2", toolUseId: "t2" }]} result={() => undefined} awaiting={(c) => c.id === "t2"} />,
    );
    expect(html).toMatch(/data-testid="context-group"/);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(2);
  });
});

describe("SubagentGroup", () => {
  const sub = (status: ToolCall["status"]) => ({ type: "subagent", id: "s", toolUseId: "s", description: "Inspect value.ts", status, startedAt: 0 }) as const;

  it.each([
    ["pending", "Pending"],
    ["running", "Running"],
    ["done", "Completed"],
  ] as const)("shows description and status; mounted %s it is collapsed", (status, label) => {
    const html = renderToStaticMarkup(<SubagentGroup part={sub(status)}>child-part</SubagentGroup>);
    expect(html).toContain("Inspect value.ts");
    expect(html).toContain(label);
    expect(html).not.toContain("child-part");
  });

  it("is expanded while a child call waits for a permission answer", () => {
    expect(renderToStaticMarkup(<SubagentGroup part={sub("running")} awaiting>child-part</SubagentGroup>)).toContain("child-part");
  });
});


describe("Read of an image or PDF", () => {
  const b64 = "iVBORw0KGgo".repeat(200);
  const read = (output: unknown) =>
    renderToStaticMarkup(<ToolBody call={done("Read", { file_path: "/w/a.png" })} result={{ type: "tool_result", toolUseId: "t1", output, isError: false } as never} />);

  it("shows the image, with no base64 JSON", () => {
    const html = read([{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }]);
    expect(html).toContain(`<img src="data:image/png;base64,${b64}"`);
    expect(html).toContain("image/png, 1.6 KB");
    expect(html).not.toContain("&quot;data&quot;");
    expect(html).not.toContain("<pre");
  });

  it("shows a short notice for a PDF (and for any binary block in a generic card), not the base64", () => {
    const pdf = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }];
    const html = read(pdf);
    expect(html).toContain("application/pdf, 1.6 KB");
    expect(html).not.toContain(b64);
    expect(renderToStaticMarkup(<ToolBody call={done("mcp__x__shot", {})} result={{ type: "tool_result", toolUseId: "t1", output: pdf, isError: false } as never} />)).not.toContain(b64);
  });
});

describe("failed Read card", () => {
  it("shows the error message without the <tool_use_error> wrapper", () => {
    const html = renderToStaticMarkup(
      <ToolBody call={done("Read", { file_path: "/p/pic.png" })} result={result("<tool_use_error>This tool cannot read binary files.</tool_use_error>", true)} />,
    );
    expect(html).toContain("This tool cannot read binary files.");
    expect(html).not.toContain("tool_use_error");
  });
});
