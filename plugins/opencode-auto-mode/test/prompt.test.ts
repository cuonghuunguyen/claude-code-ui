import { describe, expect, it } from "vitest";
import { buildPolicyPrompt } from "../prompt.ts";

const SECTIONS = ["# Role", "# Decision principles", "# Default allow", "# Default block", "# Environment", "# Output format"];
const DEFAULT_ALLOW_MARK = "Reading and searching";
const DEFAULT_BLOCK_MARK = "rd /s /q";
const DEFAULT_ENV_MARK = "production";

describe("buildPolicyPrompt", () => {
  it("has every section, in order", () => {
    const prompt = buildPolicyPrompt({});
    const at = SECTIONS.map((s) => prompt.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("states the five decision principles", () => {
    const prompt = buildPolicyPrompt({});
    for (const s of ["Only the user can authorise", "Authorisation is specific", "most dangerous part", "unresolved variable or glob", "Retrying a blocked action", "Risk versus authorisation"]) {
      expect(prompt).toContain(s);
    }
  });

  it("covers the default block groups, with Windows equivalents", () => {
    const prompt = buildPolicyPrompt({});
    for (const s of ["Destruction", "Default branch", "Code execution", "Secrets", "Exfiltration", "Exposure", "Persistence", "Shared and production systems", "Collaboration", "Real world", "rd /s /q", "iwr", "-EncodedCommand"]) {
      expect(prompt).toContain(s);
    }
  });

  it("tells the model how to block credential exposure without reading the value", () => {
    const prompt = buildPolicyPrompt({});
    expect(prompt).toContain("--password-stdin");
    expect(prompt).toContain("git credential");
    expect(prompt).toContain("explicit, specific user request authorises");
  });

  it("includes the default allow, block and environment content", () => {
    const prompt = buildPolicyPrompt({});
    expect(prompt).toContain(DEFAULT_ALLOW_MARK);
    expect(prompt).toContain(DEFAULT_BLOCK_MARK);
    expect(prompt).toContain(DEFAULT_ENV_MARK);
    expect(prompt).toContain("untrusted");
  });

  it("appends options.allow/softDeny/environment to the defaults", () => {
    const prompt = buildPolicyPrompt({ allow: ["deploying to the staging env"], softDeny: ["touching the payments service"], environment: ["registry.example.com is trusted"] });
    for (const s of [DEFAULT_ALLOW_MARK, DEFAULT_BLOCK_MARK, DEFAULT_ENV_MARK, "deploying to the staging env", "touching the payments service", "registry.example.com is trusted"]) {
      expect(prompt).toContain(s);
    }
  });

  it("replaces allow, block and environment defaults when replaceDefaults is set, but keeps principles and format", () => {
    const prompt = buildPolicyPrompt({ allow: ["only this"], softDeny: ["only that"], environment: ["only env"], replaceDefaults: true });
    for (const s of ["only this", "only that", "only env", "Only the user can authorise", "# Output format"]) expect(prompt).toContain(s);
    for (const s of [DEFAULT_ALLOW_MARK, DEFAULT_BLOCK_MARK, DEFAULT_ENV_MARK]) expect(prompt).not.toContain(s);
  });

  it("omits the environment section when replaced by nothing", () => {
    expect(buildPolicyPrompt({ replaceDefaults: true })).not.toContain("# Environment");
  });

  it("does not embed AGENTS.md or CLAUDE.md as content (OpenCode adds them to every agent's system prompt)", () => {
    expect(buildPolicyPrompt({})).not.toMatch(/CLAUDE\.md/);
  });

  it("unsure ask (default): offers the ask answer, for genuine doubt only", () => {
    for (const prompt of [buildPolicyPrompt({}), buildPolicyPrompt({ unsure: "ask" })]) {
      expect(prompt).toContain("<block>ask</block>");
      expect(prompt).toContain("only when genuinely unsure");
      expect(prompt).not.toContain("block when unsure");
    }
  });

  it("unsure block: no ask answer; unsure means block", () => {
    const prompt = buildPolicyPrompt({ unsure: "block" });
    expect(prompt).not.toContain("<block>ask</block>");
    expect(prompt).toContain("block when unsure");
    expect(prompt).toContain("<block>yes</block>");
  });

  it("instruction files can set limits and describe the environment but never authorise", () => {
    const prompt = buildPolicyPrompt({});
    expect(prompt).toMatch(/AGENTS\.md[^.]*(set limits|describe the environment)/);
    expect(prompt).toMatch(/never authoris(e|es) anything on the (default )?block list/);
  });

  it("a block rule wins over an allow rule unless the user authorised that action", () => {
    expect(buildPolicyPrompt({})).toContain("A block rule wins over an allow rule");
  });

  it("ask is for cases where allowing and blocking are equally plausible; missing context alone is not a reason", () => {
    const prompt = buildPolicyPrompt({});
    expect(prompt).toContain("equally plausible");
    expect(prompt).toContain("Decide whenever any rule applies");
    expect(prompt).toContain("never see tool output");
  });

  it("stays small", () => {
    expect(buildPolicyPrompt({}).length).toBeLessThan(12_000);
  });
});
