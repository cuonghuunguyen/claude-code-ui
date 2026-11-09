import { describe, expect, it } from "vitest";
import { agentOf, denialsOf, modeBlock, primaryAgents, type OpenCodeAgent, type Rule } from "../src/opencode-engine.ts";

const r = (permission: string, pattern: string, action: Rule["action"]): Rule => ({ permission, pattern, action });
const flat = (rules: Rule[]) => rules.map((x) => `${x.permission}:${x.pattern}:${x.action}`);

const plan: OpenCodeAgent = { name: "plan", mode: "primary", permission: [r("*", "*", "allow"), r("edit", "*", "deny"), r("edit", ".opencode/plans/*.md", "allow")] };
const build: OpenCodeAgent = { name: "build", mode: "primary", permission: [r("*", "*", "allow")] };
const review: OpenCodeAgent = { name: "review", mode: "primary", permission: [r("*", "*", "allow"), r("edit", "*", "deny"), r("bash", "*", "ask")] };

describe("OpenCode agents", () => {
  it("primaryAgents keeps build, plan and a custom primary agent; drops hidden and subagents", () => {
    const list: OpenCodeAgent[] = [
      build,
      { name: "compaction", mode: "primary", hidden: true, permission: [] },
      { name: "explore", mode: "subagent", permission: [] },
      { name: "general", mode: "subagent", permission: [] },
      plan,
      review,
      { name: "secret", mode: "primary", hidden: true, permission: [] },
      { name: "summary", mode: "primary", hidden: true, permission: [] },
      { name: "title", mode: "primary", hidden: true, permission: [] },
      { name: "helper", mode: "subagent", hidden: null, permission: [] },
      { name: "any", mode: "all", hidden: null, permission: [] },
    ];
    expect(primaryAgents(list).map((a) => a.name)).toEqual(["build", "plan", "review", "any"]);
  });

  it("denialsOf returns plan's edit rules in order and nothing for build", () => {
    expect(denialsOf(plan.permission)).toEqual([r("edit", "*", "deny"), r("edit", ".opencode/plans/*.md", "allow")]);
    expect(denialsOf(build.permission)).toEqual([]);
    expect(denialsOf(review.permission)).toEqual([r("edit", "*", "deny")]);
  });

  it("modeBlock puts the agent marker after the mode marker and the agent's denials after the mode rules", () => {
    expect(flat(modeBlock("acceptEdits", [], denialsOf(review.permission), { agent: "review" }))).toEqual([
      "claude-ui:mode:acceptEdits:allow",
      "claude-ui:agent:review:allow",
      "bash:*:ask",
      "edit:*:allow",
      "webfetch:*:ask",
      "websearch:*:ask",
      "edit:*:deny",
      "orchestration-*:*:deny",
      "claude-ui:always:allow",
    ]);
  });

  it("bypass keeps the plan agent's edit denial last for edit", () => {
    const rules = modeBlock("bypassPermissions", [], denialsOf(plan.permission), { agent: "plan" });
    const edits = rules.filter((x) => x.permission === "edit");
    expect(edits.map((x) => `${x.pattern}:${x.action}`)).toEqual(["*:allow", "*:deny", ".opencode/plans/*.md:allow"]);
  });

  it("agentOf reads the last agent marker; a block without one gives undefined", () => {
    const first = modeBlock("default", [], [], { agent: "build" });
    const second = modeBlock("default", [], [], { agent: "plan" });
    expect(agentOf([...first, ...second])).toBe("plan");
    expect(agentOf(first)).toBe("build");
    expect(agentOf(modeBlock("default", [], []))).toBeUndefined();
    expect(agentOf([])).toBeUndefined();
  });
});
