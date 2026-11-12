import { describe, expect, it } from "vitest";
import { buildPolicyPrompt } from "../prompt.ts";

describe("buildPolicyPrompt", () => {
  it("includes the default allow and block sections", () => {
    const prompt = buildPolicyPrompt({});
    expect(prompt).toContain("Reading, building, testing, and linting the project.");
    expect(prompt).toContain("force-push");
    expect(prompt).toContain("<block>yes</block>");
  });

  it("appends options.allow/softDeny/environment to the defaults", () => {
    const prompt = buildPolicyPrompt({ allow: ["deploying to the staging env"], softDeny: ["touching the payments service"], environment: ["this is a fintech project"] });
    expect(prompt).toContain("Reading, building, testing, and linting the project.");
    expect(prompt).toContain("deploying to the staging env");
    expect(prompt).toContain("force-push");
    expect(prompt).toContain("touching the payments service");
    expect(prompt).toContain("this is a fintech project");
  });

  it("replaces the defaults when replaceDefaults is set", () => {
    const prompt = buildPolicyPrompt({ allow: ["only this"], softDeny: ["only that"], replaceDefaults: true });
    expect(prompt).toContain("only this");
    expect(prompt).not.toContain("Reading, building, testing, and linting the project.");
    expect(prompt).toContain("only that");
    expect(prompt).not.toContain("force-push");
  });

  it("does not embed AGENTS.md or CLAUDE.md (OpenCode adds them to every agent's system prompt)", () => {
    expect(buildPolicyPrompt({})).not.toContain("AGENTS.md");
  });
});
