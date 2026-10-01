import { describe, expect, it } from "vitest";
import { choose, matchCommands } from "./commands.ts";

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
});
