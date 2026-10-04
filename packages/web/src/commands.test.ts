import { describe, expect, it } from "vitest";
import { choose, dialogOf, matchCommands, withDialogCommands } from "./commands.ts";

const cmd = (name: string, argumentHint = "") => ({ name, description: `${name} desc`, argumentHint });
const all = [cmd("review", "<pr>"), cmd("compact"), cmd("code-review"), cmd("init")];

describe("matchCommands", () => {
  it("is closed unless the text is a slash followed by a name without spaces", () => {
    expect(matchCommands(all, "")).toBeUndefined();
    expect(matchCommands(all, "hello /re")).toBeUndefined();
    expect(matchCommands(all, "/review 12")).toBeUndefined();
  });

  it("lists every command for a bare slash", () => {
    expect(matchCommands(all, "/")!.map((c) => c.name)).toEqual(["review", "compact", "code-review", "init"]);
  });

  it("puts prefix matches before substring matches, case-insensitive", () => {
    expect(matchCommands(all, "/RE")!.map((c) => c.name)).toEqual(["review", "code-review"]);
  });

  it("ranks an exact name match first, then prefix, then substring matches", () => {
    const list = [cmd("context7-mcp"), cmd("my-context"), cmd("context")];
    expect(matchCommands(list, "/context")!.map((c) => c.name)).toEqual(["context", "context7-mcp", "my-context"]);
  });

  it("ranks an exact alias match first", () => {
    const usage = { ...cmd("usage"), aliases: ["cost"] };
    expect(matchCommands([cmd("costly"), usage], "/cost")!.map((c) => c.name)).toEqual(["usage", "costly"]);
  });

  it("matches aliases by prefix", () => {
    const usage = { ...cmd("usage"), aliases: ["cost", "stats"] };
    expect(matchCommands([...all, usage], "/cos")!.map((c) => c.name)).toEqual(["usage"]);
  });
});

describe("choose", () => {
  it("sends a command without an argument hint right away", () => {
    expect(choose(cmd("compact"))).toEqual({ send: "/compact" });
  });

  it("puts a command with an argument hint in the prompt box for the arguments", () => {
    expect(choose(cmd("review", "<pr>"))).toEqual({ text: "/review " });
  });

  it("sends a command with an argument hint when its full name is typed, like Enter in Claude Code (/compact needs one Enter)", () => {
    expect(choose(cmd("compact", "<optional custom summarization instructions>"), "/compact")).toEqual({ send: "/compact" });
    expect(choose(cmd("compact", "<optional custom summarization instructions>"), "/comp")).toEqual({ text: "/compact " });
  });
});

describe("dialog commands", () => {
  it("/mcp alone opens the MCP servers dialog, with or without the CLI's own mcp row", () => {
    expect(dialogOf(" /mcp ")).toBe("mcp");
    expect(dialogOf("/mcp list")).toBeUndefined();
    expect(dialogOf("/mcpx")).toBeUndefined();
    const rows = withDialogCommands([cmd("mcp"), cmd("init")]);
    expect(rows.map((r) => [r.name, r.description])).toEqual([["init", "init desc"], ["mcp", "Configure Model Context Protocol servers"], ["skills", "List available skills"], ["plugins", "Install, enable, or disable plugins"]]);
    expect(matchCommands(rows, "/mc")!.map((c) => c.name)).toEqual(["mcp"]);
  });

  it("/plugin, /plugins and /marketplace alone open Manage Plugins unless the session has a command of that name", () => {
    expect(["/plugin", "/plugins", " /marketplace "].map((t) => dialogOf(t))).toEqual(["plugins", "plugins", "plugins"]);
    expect(dialogOf("/plugins install x")).toBeUndefined();
    expect(dialogOf("/plugin", [cmd("plugin")])).toBeUndefined();
    expect(dialogOf("/plugins", [cmd("plugin")])).toBe("plugins");
    expect(dialogOf("/mcp", [cmd("mcp")])).toBe("mcp");
    expect(withDialogCommands([cmd("init")]).map((r) => r.name)).toEqual(["init", "mcp", "skills", "plugins"]);
    expect(withDialogCommands([cmd("plugins")]).filter((r) => r.name === "plugins").map((r) => r.description)).toEqual(["plugins desc"]);
    expect(matchCommands(withDialogCommands([]), "/market")!.map((c) => c.name)).toEqual(["plugins"]);
  });
});

describe("/skills and /help", () => {
  it("open the Slash commands dialog alone, unless the CLI has a command of that name", () => {
    expect(dialogOf("/skills")).toBe("skills");
    expect(dialogOf(" /help ")).toBe("skills");
    expect(dialogOf("/skills x")).toBeUndefined();
    expect(dialogOf("/skills", [cmd("skills")])).toBeUndefined();
    expect(dialogOf("/help", [cmd("help")])).toBeUndefined();
    expect(dialogOf("/help", [cmd("skills")])).toBe("skills");
    expect(dialogOf("/mcp", [cmd("mcp")])).toBe("mcp");
  });
  it("the picker lists /skills with the extension's description unless the CLI has it", () => {
    expect(withDialogCommands([cmd("init")]).map((r) => [r.name, r.description])).toEqual([["init", "init desc"], ["mcp", "Configure Model Context Protocol servers"], ["skills", "List available skills"], ["plugins", "Install, enable, or disable plugins"]]);
    expect(withDialogCommands([cmd("skills")]).map((r) => r.description)).toEqual(["skills desc", "Configure Model Context Protocol servers", "Install, enable, or disable plugins"]);
  });
});
