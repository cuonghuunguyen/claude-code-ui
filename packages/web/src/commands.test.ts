import { describe, expect, it } from "vitest";
import { activeCommand, choose, insertSlash, dialogArg, dialogOf, matchCommands, withDialogCommands } from "./commands.ts";

const cmd = (name: string, argumentHint = "") => ({ name, description: `${name} desc`, argumentHint });
const all = [cmd("review", "<pr>"), cmd("compact"), cmd("code-review"), cmd("init")];

describe("matchCommands", () => {
  it("is closed unless the text is a slash followed by a name without spaces", () => {
    expect(matchCommands(all, "")).toBeUndefined();
    expect(matchCommands(all, "a/b")).toBeUndefined();
    expect(matchCommands(all, "see https://x.y/re")).toBeUndefined();
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
  it("/resume, alone or with text, opens the session search; it wins over a CLI resume row", () => {
    expect(dialogOf("/resume")).toBe("resume");
    expect(dialogOf("/resume login bug")).toBe("resume");
    expect(dialogOf("/resume", [cmd("resume")])).toBe("resume");
    expect(dialogArg("/resume login  bug ")).toBe("login  bug");
    expect(dialogArg("/resume")).toBeUndefined();
    expect(dialogArg("/mcp x")).toBeUndefined();
    expect(withDialogCommands([cmd("resume")]).filter((c) => c.name === "resume")).toEqual([expect.objectContaining({ description: "Resume a previous session" })]);
  });

  it("/mcp alone opens the MCP servers dialog, with or without the CLI's own mcp row", () => {
    expect(dialogOf(" /mcp ")).toBe("mcp");
    expect(dialogOf("/mcp list")).toBeUndefined();
    expect(dialogOf("/mcpx")).toBeUndefined();
    const rows = withDialogCommands([cmd("mcp"), cmd("init")]);
    expect(rows.map((r) => [r.name, r.description])).toEqual([["init", "init desc"], ["mcp", "Configure Model Context Protocol servers"], ["skills", "List available skills"], ["plugins", "Install, enable, or disable plugins"], ["resume", "Resume a previous session"]]);
    expect(matchCommands(rows, "/mc")!.map((c) => c.name)).toEqual(["mcp"]);
  });

  it("/plugin, /plugins and /marketplace alone open Manage Plugins unless the session has a command of that name", () => {
    expect(["/plugin", "/plugins", " /marketplace "].map((t) => dialogOf(t))).toEqual(["plugins", "plugins", "plugins"]);
    expect(dialogOf("/plugins install x")).toBeUndefined();
    expect(dialogOf("/plugin", [cmd("plugin")])).toBeUndefined();
    expect(dialogOf("/plugins", [cmd("plugin")])).toBe("plugins");
    expect(dialogOf("/mcp", [cmd("mcp")])).toBe("mcp");
    expect(withDialogCommands([cmd("init")]).map((r) => r.name)).toEqual(["init", "mcp", "skills", "plugins", "resume"]);
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
    expect(withDialogCommands([cmd("init")]).map((r) => [r.name, r.description])).toEqual([["init", "init desc"], ["mcp", "Configure Model Context Protocol servers"], ["skills", "List available skills"], ["plugins", "Install, enable, or disable plugins"], ["resume", "Resume a previous session"]]);
    expect(withDialogCommands([cmd("skills")]).map((r) => r.description)).toEqual(["skills desc", "Configure Model Context Protocol servers", "Install, enable, or disable plugins", "Resume a previous session"]);
  });
});

describe("slash token at the caret", () => {
  it("is found at line start or after whitespace, anywhere in the text", () => {
    expect(activeCommand("fix it, then /rev", 17)).toEqual({ start: 13, query: "rev", end: 17, lead: false });
    expect(activeCommand("a\n/re", 5)).toEqual({ start: 2, query: "re", end: 5, lead: false });
    expect(activeCommand("/re", 3)).toEqual({ start: 0, query: "re", end: 3, lead: true });
  });
  it("is not found for a/b, a URL, or a token not under the caret", () => {
    expect(activeCommand("a/b", 3)).toBeUndefined();
    expect(activeCommand("see /re now", 11)).toBeUndefined();
    expect(activeCommand("/re now", 7)).toBeUndefined();
  });
  it("matches commands for a mid-message token only up to the caret", () => {
    expect(matchCommands(all, "please /re and more", 10)!.map((c) => c.name)).toEqual(["review", "code-review"]);
  });
  it("insertSlash replaces only the token with one space and puts the caret after it", () => {
    const t = activeCommand("do /re now", 6)!;
    expect(insertSlash("do /re now", t, "review")).toEqual({ text: "do /review now", caret: 11 });
    expect(insertSlash("do /re", activeCommand("do /re", 6)!, "review")).toEqual({ text: "do /review ", caret: 11 });
  });
  it("a caret inside the word replaces the whole word", () => {
    const text = "run /rv-skill now";
    const t = activeCommand(text, 7)!;
    expect(t).toMatchObject({ start: 4, query: "rv", end: 13, lead: false });
    expect(insertSlash(text, t, "rv-skill")).toEqual({ text: "run /rv-skill now", caret: 14 });
    expect(activeCommand("/re-x", 3)!.lead).toBe(true);
    expect(activeCommand("/re-x tail", 3)!.lead).toBe(false);
  });
});
