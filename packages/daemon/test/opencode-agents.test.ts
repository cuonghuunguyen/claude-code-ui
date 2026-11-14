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

  it("GH-684: an agent's own allow rules never reach the block (Ask before edits keeps asking); its denials, and the exceptions that follow a denial, do", () => {
    const perm = [r("*", "*", "allow"), r("bash", "*", "allow"), r("bash", "rm *", "deny"), r("edit", "*", "ask")];
    expect(denialsOf(perm)).toEqual([r("bash", "rm *", "deny")]);
    // Ask before edits: bash asks for everything, the agent's rm deny still wins; nothing of the agent's allow-all is appended.
    const block = modeBlock("default", [], denialsOf(perm), { agent: "ops" });
    expect(flat(block.filter((x) => x.permission === "bash"))).toEqual(["bash:*:ask", "bash:rm *:deny"]);
    expect(block.some((x) => x.action === "allow" && x.permission === "bash")).toBe(false);
    // A carve-out after a denial stays with it (plan may write its plan files).
    expect(denialsOf([r("edit", "*", "ask"), r("edit", "*", "deny"), r("edit", "plans/*.md", "allow"), r("webfetch", "*", "allow")])).toEqual([r("edit", "*", "deny"), r("edit", "plans/*.md", "allow")]);
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
      "claude-ui-*:*:deny",
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
