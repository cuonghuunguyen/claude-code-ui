import { describe, expect, it } from "vitest";
import { followUp, followUpAlways } from "../src/denied-retry.ts";

describe("followUpAlways (GH-756)", () => {
  it("names the rule and the scope, then the call in a fence", () => {
    const input = { command: "git push --force origin main", description: "push" };
    expect(followUpAlways("Bash", input, "Bash(git push --force origin main)", "session")).toBe(
      "Auto mode denied your Bash call. I added the allow rule `Bash(git push --force origin main)` for this session. Run it again with the same input:\n```\ngit push --force origin main\n```",
    );
    expect(followUpAlways("Bash", input, "Bash(x)", "local")).toContain("for this project. Run it again");
  });
  it("keeps the follow-up of Allow and retry unchanged", () => {
    expect(followUp("Bash", { command: "ls" })).toBe("Auto mode denied your Bash call. I allow it once. Run it again with the same input:\n```\nls\n```");
  });
  it("uses a longer fence around a command with backticks", () => {
    expect(followUpAlways("Bash", { command: "echo ```x```" }, "R", "session")).toContain("````\necho ```x```\n````");
  });
});
