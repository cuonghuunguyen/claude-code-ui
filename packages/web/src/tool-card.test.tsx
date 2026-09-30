import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "./store.ts";
import { ContextGroup, SubagentGroup, Thinking, TodoList, ToolBody, ToolCard } from "./tool-card.tsx";

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
  it("is expanded and shows the command and ANSI-colored monospace output", () => {
    const html = renderToStaticMarkup(<ToolCard call={done("Bash", { command: "ls --color" })} result={result("\x1b[34mdir\x1b[0m\nfile")} />);
    expect(html).toContain('data-testid="bash-command"');
    expect(html).toContain("ls --color");
    expect(html).toMatch(/<span style="color:#2472c8">dir<\/span>/);
    expect(html).toContain("file");
    expect(html).not.toContain("Parameters");
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
    expect(html).toContain("/w/a.ts · lines 10–14");
    expect(html).not.toContain('data-testid="read-path"');
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

describe("other tools", () => {
  it("fall back to the generic JSON card", () => {
    const html = renderToStaticMarkup(<ToolBody call={done("WebFetch", { url: "https://x" })} result={result("page")} />);
    expect(html).toContain("Parameters");
    expect(html).toContain("Result");
    expect(renderToStaticMarkup(<ToolCard call={done("WebFetch", { url: "https://x" })} />)).not.toContain("Parameters");
  });
});

describe("ContextGroup", () => {
  it("shows the call count and tool names", () => {
    const calls = [call("done", "Read"), { ...call("done", "Grep"), id: "t2" }, { ...call("done", "Read"), id: "t3" }];
    const html = renderToStaticMarkup(<ContextGroup calls={calls} result={() => undefined} />);
    expect(html).toMatch(/Context<\/span><span[^>]*>3<\/span>/);
    expect(html).toContain("Read, Grep");
  });
});

describe("Thinking", () => {
  it("renders collapsed by default, even while streaming", () => {
    for (const streaming of [false, true]) {
      const html = renderToStaticMarkup(<Thinking part={{ type: "thinking", id: "k", text: "secret plan", streaming }} />);
      expect(html).toContain('data-testid="thinking"');
      expect(html).not.toContain("secret plan");
    }
  });
});

describe("ToolCard edits", () => {
  const edit = (tool: string, input: unknown): ToolCall => ({ type: "tool_call", id: "e", toolUseId: "e", tool, input, status: "done" });

  it("Edit renders expanded as a diff instead of the JSON parameters", () => {
    const html = renderToStaticMarkup(<ToolCard call={edit("Edit", { file_path: "/p/a.ts", old_string: "b = 2", new_string: "b = 3" })} />);
    // @pierre/diffs renders the diff client-side into this element.
    expect(html).toMatch(/data-testid="edit-diff"><diffs-container>/);
    expect(html).not.toContain("Parameters");
  });

  it("an Edit mounted before its input streamed in is already expanded, showing parameters until the input is complete", () => {
    const html = renderToStaticMarkup(<ToolCard call={{ ...edit("Edit", {}), status: "pending" }} />);
    expect(html).not.toContain("edit-diff");
    expect(html).toContain("Parameters");
  });
});

describe("SubagentGroup", () => {
  const sub = (status: ToolCall["status"]) => ({ type: "subagent", id: "s", toolUseId: "s", description: "Inspect value.ts", status }) as const;

  it.each(["pending", "running"] as const)("shows description and status; mounted %s it is open with its child parts", (status) => {
    const html = renderToStaticMarkup(<SubagentGroup part={sub(status)}>child-part</SubagentGroup>);
    expect(html).toContain("Inspect value.ts");
    expect(html).toContain(status === "running" ? "Running" : "Pending");
    expect(html).toContain("child-part");
  });

  it("mounted finished (history) it is collapsed", () => {
    const html = renderToStaticMarkup(<SubagentGroup part={sub("done")}>child-part</SubagentGroup>);
    expect(html).toContain("Completed");
    expect(html).not.toContain("child-part");
  });
});

describe("TodoList", () => {
  it("shows progress, each item, and the active form of the in-progress item", () => {
    const html = renderToStaticMarkup(
      <TodoList
        items={[
          { content: "Inspect", status: "completed" },
          { content: "Change b", status: "in_progress", activeForm: "Changing b" },
          { content: "Test", status: "pending" },
        ]}
      />,
    );
    expect(html).toContain("Todos 1/3");
    expect(html).toContain("Changing b");
    expect(html).not.toContain("Change b<");
    expect(html.match(/data-status="(\w+)"/g)).toEqual(['data-status="completed"', 'data-status="in_progress"', 'data-status="pending"']);
  });
});
