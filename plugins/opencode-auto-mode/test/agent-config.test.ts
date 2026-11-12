import { describe, expect, it } from "vitest";
import { buildClassifierAgentConfig } from "../agent-config.ts";

describe("buildClassifierAgentConfig", () => {
  const cfg = buildClassifierAgentConfig({ allow: ["x"] });

  it("is a hidden subagent at temperature 0", () => {
    expect(cfg.mode).toBe("subagent");
    expect(cfg.hidden).toBe(true);
    expect(cfg.temperature).toBe(0);
  });

  it("denies every permission with a single last-wins wildcard (hides all tools, MCP included)", () => {
    expect(cfg.permission).toEqual({ "*": "deny" });
  });

  it("has no dead tools map", () => {
    expect(cfg).not.toHaveProperty("tools");
  });

  it("carries the policy prompt including user options", () => {
    expect(cfg.prompt).toContain("security reviewer");
    expect(cfg.prompt).toContain("- x");
  });
});
