// GH-454: the orchestration plugin's manifests and agent files.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const plugin = join(root, "plugins/orchestration");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
/** A text file as LF: a Windows checkout with core.autocrlf has CRLF on disk. */
const lf = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const ROLES = { planner: "opus", implementer: "sonnet", "ui-tester": "sonnet", reviewer: "opus" } as const;

/** Frontmatter keys of an agent file (`key: value` lines between the --- fences) and its body. */
function agent(role: string) {
  const text = lf(join(plugin, "agents", `${role}.md`));
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  expect(m, `${role}.md has frontmatter`).toBeTruthy();
  const front = Object.fromEntries(m![1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  return { front, body: m![2]! };
}

describe("orchestration plugin", () => {
  it("marketplace and plugin manifests match", () => {
    const m = json(join(root, ".claude-plugin/marketplace.json"));
    const p = json(join(plugin, ".claude-plugin/plugin.json"));
    expect(m.name).toBe("claude-ui");
    expect(m.plugins.map((e: { name: string }) => e.name)).toEqual(["orchestration", "addons", "visualize"]);
    expect(m.plugins[0]).toMatchObject({ name: "orchestration", source: "./plugins/orchestration" });
    expect(p).toMatchObject({ name: "orchestration", license: "MIT", homepage: "https://github.com/cuonghuunguyen/claude-code-ui" });
    // GH-541: every listed plugin's manifest has its name and version.
    for (const e of m.plugins) expect(json(join(root, e.source, ".claude-plugin/plugin.json")), e.name).toMatchObject({ name: e.name, version: e.version, license: "MIT" });
    expect(lf(join(root, "plugins/addons/skills/write-addon/SKILL.md"))).toMatch(/^---\nname: write-addon\ndescription: /);
    expect(lf(join(root, "plugins/visualize/skills/visualize/SKILL.md"))).toMatch(/^---\nname: visualize\ndescription: /);
  });

  it("each agent type has name, description and model, and no tools list", () => {
    expect(readdirSync(join(plugin, "agents")).sort()).toEqual(Object.keys(ROLES).map((r) => `${r}.md`).sort());
    for (const [role, model] of Object.entries(ROLES)) {
      const { front } = agent(role);
      expect(front.name).toBe(role);
      expect(front.description?.length).toBeGreaterThan(20);
      expect(front.model).toBe(model);
      expect(front, `${role} must not declare tools: it would drop the orchestration MCP tools`).not.toHaveProperty("tools");
    }
  });

  it("the reviewer cannot edit", () => {
    const disallowed = agent("reviewer").front.disallowedTools!.split(",").map((s) => s.trim());
    expect(disallowed).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit"]));
  });

  it("only the implementer can start workers: the others have worker_start disallowed", () => {
    for (const role of ["planner", "reviewer", "ui-tester"]) expect(agent(role).front.disallowedTools!.split(",").map((s) => s.trim()), role).toContain("mcp__orchestration__worker_start");
    for (const role of ["implementer"]) expect(agent(role).front).not.toHaveProperty("disallowedTools");
  });

  it("no agent sets permissionMode", () => {
    for (const role of Object.keys(ROLES)) expect(agent(role).front).not.toHaveProperty("permissionMode");
  });
});
