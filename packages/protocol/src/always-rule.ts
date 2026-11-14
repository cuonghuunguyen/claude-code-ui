// Always allow (GH-756): the permission rule that lets exactly the denied call through.

export type AlwaysRule = { toolName: string; ruleContent?: string } | { unavailable: "agent" | "tool" | "input" };

const SHELLS = new Set(["Bash", "PowerShell"]);
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const AGENTS = new Set(["Agent", "Task", "Monitor"]);

/** The CLI's rule string of a rule value: `\`, `(` and `)` in the content are escaped with `\` (probed in the CLI 2.1.x binary). */
export const ruleString = ({ toolName, ruleContent }: { toolName: string; ruleContent?: string }) =>
  ruleContent ? `${toolName}(${ruleContent.replace(/[\\()]/g, "\\$&")})` : toolName;

/** Absolute path as a rule path (`//abs`; Windows `C:\a\b` is `//c/a/b`), gitignore specials escaped; undefined for a relative path. */
function pathContent(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return undefined;
  const win = /^([A-Za-z]):[\\/]/.exec(path);
  let posix: string;
  if (win) posix = `/${win[1]!.toLowerCase()}/${path.slice(3).replace(/\\/g, "/")}`;
  else if (path.startsWith("/")) posix = path;
  else return undefined;
  return `/${posix.replace(/[\\*?[\]]/g, "\\$&")}`;
}

/**
 * The allow rule for the denied call `tool(input)`: the exact command for a shell, the exact path for a file tool, the whole
 * domain / tool where Claude Code's own suggestion is that wide. `unavailable`: no rule fits (`agent`: auto mode ignores
 * Agent / Monitor rules; `tool`: unknown tool; `input`: the input has no usable command, URL or path).
 */
export function alwaysRule(tool: string, input: unknown): AlwaysRule {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (SHELLS.has(tool)) {
    const command = obj.command;
    if (typeof command !== "string" || !command.trim()) return { unavailable: "input" };
    // Probed (CLI 2.1.285): a rule with an escaped `*` (`\*`) never matched its own command, so no rule fits a command with a `*`.
    return command.includes("*") ? { unavailable: "input" } : { toolName: tool, ruleContent: command };
  }
  if (tool === "WebFetch") {
    try {
      const host = new URL(String(obj.url)).hostname;
      return host ? { toolName: tool, ruleContent: `domain:${host}` } : { unavailable: "input" };
    } catch {
      return { unavailable: "input" };
    }
  }
  if (tool === "WebSearch" || tool.startsWith("mcp__")) return { toolName: tool };
  if (EDITS.has(tool) || tool === "Read") {
    const ruleContent = pathContent(tool === "NotebookEdit" ? obj.notebook_path : obj.file_path);
    return ruleContent ? { toolName: tool === "Read" ? "Read" : "Edit", ruleContent } : { unavailable: "input" };
  }
  if (AGENTS.has(tool)) return { unavailable: "agent" };
  return { unavailable: "tool" };
}

/** `alwaysRule` as the rule string, when a rule fits. */
export function alwaysRuleString(tool: string, input: unknown): string | undefined {
  const r = alwaysRule(tool, input);
  return "toolName" in r ? ruleString(r) : undefined;
}
