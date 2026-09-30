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
});

describe("choose", () => {
  it("sends a command without an argument hint right away", () => {
    expect(choose(cmd("compact"))).toEqual({ send: "/compact" });
  });

  it("puts a command with an argument hint in the prompt box for the arguments", () => {
    expect(choose(cmd("review", "<pr>"))).toEqual({ text: "/review " });
  });
});
