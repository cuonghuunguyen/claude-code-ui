// GH-454: the orchestration plugin's manifests, agent files and the moved skill.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const plugin = join(root, "plugins/orchestration");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const ROLES = { planner: "opus", implementer: "sonnet", "ui-tester": "sonnet", reviewer: "opus" } as const;

/** Frontmatter keys of an agent file (`key: value` lines between the --- fences) and its body. */
function agent(role: string) {
  const text = readFileSync(join(plugin, "agents", `${role}.md`), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  expect(m, `${role}.md has frontmatter`).toBeTruthy();
  const front = Object.fromEntries(m![1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  return { front, body: m![2]! };
}
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

describe("orchestration plugin", () => {
  it("marketplace and plugin manifests match", () => {
    const m = json(join(root, ".claude-plugin/marketplace.json"));
    const p = json(join(plugin, ".claude-plugin/plugin.json"));
    expect(m.name).toBe("claude-ui");
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]).toMatchObject({ name: "orchestration", source: "./plugins/orchestration" });
    expect(p).toMatchObject({ name: "orchestration", license: "MIT", homepage: "https://github.com/cuonghuunguyen/claude-code-ui" });
    expect(m.plugins[0].version).toBe(p.version);
    expect(json(join(root, ".claude/settings.json")).enabledPlugins["orchestration@claude-ui"]).toBe(true);
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

  it("no agent sets permissionMode", () => {
    for (const role of Object.keys(ROLES)) expect(agent(role).front).not.toHaveProperty("permissionMode");
  });

  it("every role prompt carries HANDOFF, RESULT and the FORBIDDEN rule", () => {
    for (const role of Object.keys(ROLES)) {
      const { body } = agent(role);
      expect(body, role).toMatch(/HANDOFF/);
      expect(body, role).toMatch(/RESULT: succeeded \| failed \| blocked/);
      expect(body, role).toMatch(/## FORBIDDEN/);
      expect(body, role).toMatch(/Do NOT add, edit or reply to comments/);
    }
  });

  it("the verifiers run the mechanical gate first and state the commit checked", () => {
    for (const role of ["ui-tester", "reviewer"]) {
      const { body } = agent(role);
      expect(body, role).toMatch(/## Gate first/);
      expect(body, role).toMatch(/COMMIT: <sha/);
    }
    expect(agent("implementer").body).toMatch(/Join: continue only when both are green on the same SHA/);
  });

  it("the skill moved: no copy under .claude/skills and no stale path", () => {
    expect(existsSync(join(root, ".claude/skills/orchestrate-tickets"))).toBe(false);
    expect(existsSync(join(plugin, "skills/orchestrate-tickets/SKILL.md"))).toBe(true);
    for (const f of ["handoff.md", "tree-flow.md"]) expect(existsSync(join(plugin, "skills/orchestrate-tickets/references", f))).toBe(true);
    const stale = [...walk(plugin), join(root, "CLAUDE.md")].filter((f) => f.endsWith(".md")).filter((f) => readFileSync(f, "utf8").includes(".claude/skills/orchestrate-tickets"));
    expect(stale).toEqual([]);
  });

  it("the handoff block in the skill is the one the roles read", () => {
    const h = readFileSync(join(plugin, "skills/orchestrate-tickets/references/handoff.md"), "utf8");
    for (const field of ["role:", "ticket:", "worktree:", "branch:", "commit:", "coordinator:", "attempts:", "report-dir:"]) expect(h).toContain(field);
  });
});
