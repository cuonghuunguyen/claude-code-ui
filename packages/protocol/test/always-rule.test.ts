import { describe, expect, it } from "vitest";
import { alwaysRule, alwaysRuleString, ruleString } from "../src/always-rule.ts";

describe("ruleString", () => {
  it("escapes parentheses and backslashes in the content", () => {
    expect(ruleString({ toolName: "Bash", ruleContent: "echo (a) \\n" })).toBe("Bash(echo \\(a\\) \\\\n)");
    expect(ruleString({ toolName: "WebSearch" })).toBe("WebSearch");
  });
});

describe("alwaysRule", () => {
  it("uses the exact shell command", () => {
    expect(alwaysRule("Bash", { command: "git push --force origin main" })).toEqual({ toolName: "Bash", ruleContent: "git push --force origin main" });
    expect(alwaysRule("PowerShell", { command: "Get-ChildItem" })).toEqual({ toolName: "PowerShell", ruleContent: "Get-ChildItem" });
  });
  it("a command with a * has no rule (the CLI never matched the escaped form); a backslash alone is kept", () => {
    expect(alwaysRule("Bash", { command: "rm -rf build/*" })).toEqual({ unavailable: "input" });
    expect(alwaysRule("PowerShell", { command: "ls *.txt" })).toEqual({ unavailable: "input" });
    expect(alwaysRule("Bash", { command: "echo a\\nb" })).toEqual({ toolName: "Bash", ruleContent: "echo a\\nb" });
  });
  it("rejects an empty or missing command", () => {
    expect(alwaysRule("Bash", { command: "  " })).toEqual({ unavailable: "input" });
    expect(alwaysRule("PowerShell", {})).toEqual({ unavailable: "input" });
    expect(alwaysRule("Bash", null)).toEqual({ unavailable: "input" });
  });
  it("WebFetch is the whole domain, a bad URL is input", () => {
    expect(alwaysRule("WebFetch", { url: "https://docs.example.com/a?b=1" })).toEqual({ toolName: "WebFetch", ruleContent: "domain:docs.example.com" });
    expect(alwaysRule("WebFetch", { url: "not a url" })).toEqual({ unavailable: "input" });
  });
  it("WebSearch and MCP tools are whole-tool rules", () => {
    expect(alwaysRule("WebSearch", { query: "x" })).toEqual({ toolName: "WebSearch" });
    expect(alwaysRule("mcp__a__b", { x: 1 })).toEqual({ toolName: "mcp__a__b" });
  });
  it("file tools use the absolute path", () => {
    expect(alwaysRule("Write", { file_path: "/tmp/a.txt" })).toEqual({ toolName: "Edit", ruleContent: "//tmp/a.txt" });
    expect(alwaysRule("MultiEdit", { file_path: "/tmp/a.txt" })).toEqual({ toolName: "Edit", ruleContent: "//tmp/a.txt" });
    expect(alwaysRule("NotebookEdit", { notebook_path: "/tmp/n.ipynb" })).toEqual({ toolName: "Edit", ruleContent: "//tmp/n.ipynb" });
    expect(alwaysRule("Read", { file_path: "/etc/hosts" })).toEqual({ toolName: "Read", ruleContent: "//etc/hosts" });
  });
  it("converts a Windows path and escapes gitignore specials", () => {
    expect(alwaysRule("Edit", { file_path: "C:\\x\\y z" })).toEqual({ toolName: "Edit", ruleContent: "//c/x/y z" });
    expect(alwaysRule("Edit", { file_path: "/a/b[1]*?.txt" })).toEqual({ toolName: "Edit", ruleContent: "//a/b\\[1\\]\\*\\?.txt" });
  });
  it("rejects a relative or missing path", () => {
    expect(alwaysRule("Edit", { file_path: "src/a.ts" })).toEqual({ unavailable: "input" });
    expect(alwaysRule("Read", {})).toEqual({ unavailable: "input" });
  });
  it("Agent, Task and Monitor are agent, other tools are tool", () => {
    for (const t of ["Agent", "Task", "Monitor"]) expect(alwaysRule(t, {})).toEqual({ unavailable: "agent" });
    expect(alwaysRule("Skill", { skill: "x" })).toEqual({ unavailable: "tool" });
  });
});

describe("alwaysRuleString", () => {
  it("renders the rule, escaped", () => {
    expect(alwaysRuleString("Bash", { command: "echo (x)" })).toBe("Bash(echo \\(x\\))");
    expect(alwaysRuleString("Agent", {})).toBeUndefined();
  });
});
