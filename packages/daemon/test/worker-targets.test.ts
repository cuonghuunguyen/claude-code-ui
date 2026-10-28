import { describe, expect, it } from "vitest";
import type { Worktree } from "@claude-ui/protocol";
import { TargetError, checkShape, targetDir, listTargets, resolveTarget, targetLabel, type TargetDeps, type TargetInput } from "../src/worker-targets.ts";

const wt = (path: string, branch: string, extra: Partial<Worktree> = {}): Worktree => ({ path, branch, main: false, ...extra });
const main = (path: string): Worktree => ({ path, branch: "main", main: true });
const rows: Record<string, Worktree[] | undefined> = {
  "/r/a/app": [main("/r/a/app"), wt("/r/a/app/.claude/worktrees/feat", "feat"), wt("/r/a/app/.claude/worktrees/lk", "lk", { locked: true }), wt("/out/old", "old", { outsideRoots: true }), wt("/r/a/app/.claude/worktrees/gone", "gone")],
  "/r/b/app": [main("/r/b/app"), wt("/r/b/app/.claude/worktrees/feat", "feat")],
  "/r/tools": [main("/r/tools")],
  "/r/plain": undefined,
  "/side/x": [main("/side/x")],
};
const deps: TargetDeps = {
  projects: () => Object.keys(rows),
  worktrees: async (p) => rows[p],
  allowed: (p) => (p.startsWith("/r/") || p.startsWith("/side/") || p.startsWith("/out/") ? p : undefined),
  sideOf: (p) => (p.startsWith("/side/") ? "WSL: Ubuntu" : undefined),
  removing: (p) => p.includes("/gone"),
  isDir: () => true,
};
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof TargetError ? `${e.code}: ${e.message}` : String(e)));

describe("listTargets", () => {
  it("lists own-side projects and their worktrees inside the roots", async () => {
    const t = await listTargets(deps);
    expect(t.map((e) => e.path)).toEqual(["/r/a/app", "/r/a/app/.claude/worktrees/feat", "/r/a/app/.claude/worktrees/lk", "/r/b/app", "/r/b/app/.claude/worktrees/feat", "/r/tools", "/r/plain"]);
    expect(t[0]).toEqual({ project: "app", projectPath: "/r/a/app", path: "/r/a/app", branch: "main", main: true });
    expect(t[1]).toEqual({ project: "app", projectPath: "/r/a/app", worktree: "feat", path: "/r/a/app/.claude/worktrees/feat", branch: "feat", main: false });
    expect(t[2]!.locked).toBe(true);
    expect(t.at(-1)).toEqual({ project: "plain", projectPath: "/r/plain", path: "/r/plain", main: true });
  });
  it("filters by project name or path; an ambiguous name throws", async () => {
    expect((await listTargets(deps, { project: "tools" })).map((e) => e.path)).toEqual(["/r/tools"]);
    expect((await listTargets(deps, { project: "/r/b/app" })).length).toBe(2);
    expect(await code(listTargets(deps, { project: "app" }))).toMatch(/^ambiguous/);
  });
});

describe("checkShape", () => {
  it("refuses mixed or missing forms", () => {
    const table: [TargetInput, RegExp][] = [
      [{}, /^Give one target/],
      [{ cwd: "/r", project: "x" }, /^Give one target/],
      [{ cwd: "/r", worktree: "x" }, /^Give one target/],
      [{ repo: "a", project: "b" }, /^repo is an alias of project/],
      [{ worktree: "w", branch: "b" }, /^branch and base go with project/],
      [{ cwd: "/r", branch: "b" }, /^branch and base go with project/],
      [{ project: "p", base: "b" }, /^base needs branch/],
    ];
    for (const [input, re] of table) {
      try {
        checkShape(input);
        expect.unreachable(JSON.stringify(input));
      } catch (e) {
        expect(e).toBeInstanceOf(TargetError);
        expect((e as TargetError).code).toBe("shape");
        expect((e as Error).message).toMatch(re);
      }
    }
    expect(() => checkShape({ worktree: "w", project: "p" })).not.toThrow();
    expect(() => checkShape({ project: "p", branch: "b", base: "x" })).not.toThrow();
  });
});

describe("resolveTarget", () => {
  it("project name: main checkout; with branch: new; repo is an alias", async () => {
    expect(await resolveTarget({ project: "tools" }, deps)).toMatchObject({ kind: "main", cwd: "/r/tools" });
    expect(await resolveTarget({ project: "tools", branch: "b" }, deps)).toEqual({ kind: "new", project: "tools", projectPath: "/r/tools", branch: "b" });
    expect(await resolveTarget({ repo: "tools" }, deps)).toMatchObject({ kind: "main", cwd: "/r/tools" });
  });
  it("an ambiguous project name lists both paths", async () => {
    const m = await code(resolveTarget({ project: "app" }, deps));
    expect(m).toMatch(/^ambiguous/);
    expect(m).toContain("/r/a/app");
    expect(m).toContain("/r/b/app");
    expect(await resolveTarget({ project: "/r/a/app" }, deps)).toMatchObject({ kind: "main", cwd: "/r/a/app" });
  });
  it("an unknown project names the projects", async () => {
    const m = await code(resolveTarget({ project: "nope" }, deps));
    expect(m).toMatch(/^unknown/);
    expect(m).toContain("app, tools, plain");
    expect(m).not.toContain("x,");
  });
  it("worktree name, scoped and ambiguous", async () => {
    const m = await code(resolveTarget({ worktree: "feat" }, deps));
    expect(m).toMatch(/^ambiguous/);
    expect(m).toContain("/r/a/app/.claude/worktrees/feat");
    expect(m).toContain("/r/b/app/.claude/worktrees/feat");
    expect(await resolveTarget({ worktree: "feat", project: "/r/a/app" }, deps)).toMatchObject({ kind: "worktree", cwd: "/r/a/app/.claude/worktrees/feat" });
    expect(await resolveTarget({ worktree: "lk" }, deps)).toMatchObject({ kind: "worktree", cwd: "/r/a/app/.claude/worktrees/lk" });
    expect(await resolveTarget({ worktree: "/r/b/app/.claude/worktrees/feat" }, deps)).toMatchObject({ kind: "worktree" });
    expect(await code(resolveTarget({ worktree: "/r/b/app/.claude/worktrees/feat", project: "/r/a/app" }, deps))).toMatch(/^unknown: .*belongs to project app/);
    expect(await code(resolveTarget({ worktree: "nope", project: "tools" }, deps))).toMatch(/^unknown: No worktree named nope in project tools/);
  });
  it("refuses a worktree outside the roots or being removed", async () => {
    expect(await code(resolveTarget({ worktree: "old" }, deps))).toMatch(/^outside:.*outside the daemon's allowed roots/);
    expect(await code(resolveTarget({ worktree: "/out/old" }, deps))).toMatch(/^outside/);
    expect(await code(resolveTarget({ worktree: "gone", project: "/r/a/app" }, deps))).toMatch(/^removing:.*being removed/);
    expect(await code(resolveTarget({ worktree: "/r/a/app/.claude/worktrees/gone" }, deps))).toMatch(/^removing/);
  });
  it("refuses the main checkout as worktree and another side's paths", async () => {
    expect(await code(resolveTarget({ worktree: "/r/tools" }, deps))).toMatch(/use project/);
    expect(await code(resolveTarget({ project: "/side/x" }, deps))).toMatch(/^other_side:.*WSL: Ubuntu/);
    expect(await code(resolveTarget({ cwd: "/side/x" }, deps))).toMatch(/^other_side/);
    expect(await code(resolveTarget({ project: "x" }, deps))).toMatch(/^unknown/);
  });
  it("cwd takes the deepest listed entry", async () => {
    const r = await resolveTarget({ cwd: "/r/a/app/.claude/worktrees/feat" }, deps);
    expect(r).toMatchObject({ kind: "cwd", entry: { worktree: "feat" } });
    expect(targetLabel(r)).toBe(" in worktree feat of project app");
    expect(targetLabel(await resolveTarget({ cwd: "/r/tools" }, deps))).toBe(" in project tools");
    expect(targetLabel(await resolveTarget({ cwd: "/r/elsewhere" }, deps))).toBe(" in /r/elsewhere");
  });
});

describe("targetLabel", () => {
  it("has four forms", async () => {
    expect(targetLabel(await resolveTarget({ worktree: "lk" }, deps))).toBe(" in worktree lk of project app");
    expect(targetLabel(await resolveTarget({ project: "tools" }, deps))).toBe(" in project tools");
    expect(targetLabel(await resolveTarget({ project: "tools", branch: "nb" }, deps))).toBe(" in a new worktree nb of project tools");
    expect(targetLabel({ kind: "cwd", cwd: "/z" })).toBe(" in /z");
  });
});

describe("review fixes", () => {
  const mk = (r: Record<string, Worktree[] | undefined>, extra: Partial<TargetDeps> = {}): TargetDeps => ({ ...deps, projects: () => Object.keys(r), worktrees: async (p) => r[p], ...extra });

  it("a name lookup ignores worktrees outside the roots or being removed when a listed one matches", async () => {
    const d = mk({ "/r/p": [main("/r/p"), wt("/r/p/.claude/worktrees/fix", "fix"), wt("/out/fix", "fix2", { outsideRoots: true })], "/r/q": [main("/r/q"), wt("/r/q/.claude/worktrees/gone/fix", "fix3")] });
    expect(await resolveTarget({ worktree: "fix" }, d)).toMatchObject({ kind: "worktree", cwd: "/r/p/.claude/worktrees/fix" });
    // removing(): "/gone" paths
    expect(await resolveTarget({ worktree: "fix", project: "p" }, d)).toMatchObject({ kind: "worktree" });
  });
  it("a name that only an unlisted worktree has gives its outside or removing error", async () => {
    const d = mk({ "/r/p": [main("/r/p"), wt("/out/only", "only", { outsideRoots: true }), wt("/r/p/.claude/worktrees/gone", "gone")] });
    expect(await code(resolveTarget({ worktree: "only" }, d))).toMatch(/^outside:/);
    expect(await code(resolveTarget({ worktree: "gone" }, d))).toMatch(/^removing:/);
  });
  it("a project that is a linked worktree takes branch and locked from its own row", async () => {
    const d = mk({ "/r/lw": [main("/r/main"), wt("/r/lw", "lwb", { locked: true })] });
    expect((await listTargets(d))[0]).toMatchObject({ path: "/r/lw", branch: "lwb", locked: true, main: true });
    const d2 = mk({ "/r/lw": [main("/r/main"), wt("/r/lw", "lwb")] });
    expect((await listTargets(d2))[0]!.locked).toBeUndefined();
  });
  it("reads the worktree lists of all projects in parallel", async () => {
    let live = 0;
    let peak = 0;
    const d = mk({ "/r/a": undefined, "/r/b": undefined, "/r/c": undefined }, {
      worktrees: async () => {
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 10));
        live--;
        return undefined;
      },
    });
    expect((await listTargets(d)).length).toBe(3);
    expect(peak).toBe(3);
  });
});

describe("targetDir", () => {
  it("gives the cwd, or the project for a new branch", () => {
    expect(targetDir({ kind: "cwd", cwd: "/r/x" })).toBe("/r/x");
    expect(targetDir({ kind: "worktree", cwd: "/r/a/wt", entry: {} as never })).toBe("/r/a/wt");
    expect(targetDir({ kind: "new", project: "app", projectPath: "/r/a/app", branch: "f" })).toBe("/r/a/app");
  });
});
