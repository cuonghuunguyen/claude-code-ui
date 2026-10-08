import { describe, expect, it } from "vitest";
import { adapt, chaptersOf, STEPS, stepById, stepsFor } from "./guide-steps.ts";

const ctx = { session: false, git: false, narrow: false };

describe("chapter Basics", () => {
  it("has six steps in order, welcome first and the end card last", () => {
    expect(stepsFor("basics", ctx).map((s) => s.id)).toEqual(["welcome", "project", "new-session", "sidebar", "palette", "basics-end"]);
  });
  it("has six steps at every width (a narrow screen swaps the sidebar anchor, it does not drop the step)", () => {
    expect(stepsFor("basics", { ...ctx, narrow: true })).toHaveLength(6);
  });
  it("shows the end card's Add project action", () => {
    expect(stepById("basics-end")!.action).toEqual({ label: "Add project", run: "openProject" });
  });
});

describe("adapt", () => {
  it("below md the project and sidebar steps point at the sessions menu and read as a tap", () => {
    const project = adapt(stepById("project")!, true);
    expect(project.anchors).toEqual(['[data-testid="open-drawer"]']);
    expect(project.body).toContain("Tap ☰, then **Add project**.");
    const sidebar = adapt(stepById("sidebar")!, true);
    expect(sidebar.anchors).toEqual(['[data-testid="open-drawer"]']);
    expect(sidebar.body).toBe("☰ opens projects and sessions.");
    expect(sidebar.keys).toEqual([]);
  });
  it("wide keeps the steps as written", () => {
    expect(adapt(stepById("sidebar")!, false)).toMatchObject({ anchors: ['[data-command="sidebar.toggle"]'], keys: ["sidebar.toggle"] });
  });
});

describe("step data", () => {
  it("has unique ids", () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
  });
  it("names keys by command id, never in the body", () => {
    for (const s of STEPS) expect(s.body).not.toMatch(/\b(Ctrl|Cmd|Alt|Shift)\b/);
    expect(stepById("palette")!.keys).toEqual(["palette.open"]);
    expect(adapt(stepById("welcome")!, false).keys).toEqual([]);
  });
  it("anchors are CSS selectors on data-command or data-testid", () => {
    for (const s of STEPS) for (const a of [...s.anchors, ...(s.alt?.anchors ?? [])]) expect(a).toMatch(/^\[data-(command|testid)="[\w.-]+"\]$/);
  });
});

describe("chapter Your session", () => {
  const withSession = { session: true, git: true, narrow: false };
  it("has six steps in a git work tree and five outside it (no git graph)", () => {
    expect(stepsFor("session", withSession).map((s) => s.id)).toEqual(["tabs", "files", "changes", "graph", "terminal", "replay"]);
    expect(stepsFor("session", { ...withSession, git: false }).map((s) => s.id)).toEqual(["tabs", "files", "changes", "terminal", "replay"]);
  });
  it("Basics with a session shown carries on into it without its end card: 11 steps, 10 outside git", () => {
    const ids = stepsFor("basics", withSession).map((s) => s.id);
    expect(ids).toHaveLength(11);
    expect(ids).not.toContain("basics-end");
    expect(ids.slice(0, 5)).toEqual(["welcome", "project", "new-session", "sidebar", "palette"]);
    expect(stepsFor("basics", { ...withSession, git: false })).toHaveLength(10);
    expect(chaptersOf(ids)).toEqual(["basics", "session"]);
    expect(chaptersOf(stepsFor("basics", ctx).map((s) => s.id))).toEqual(["basics"]);
  });
  it("the tab strip step points at the tab switcher below md", () => {
    expect(adapt(stepById("tabs")!, true)).toMatchObject({ anchors: ['[data-testid="tab-switcher"]'], keys: [] });
  });
  it("the panel steps fall back to the side panel toggle with its own body", () => {
    for (const id of ["files", "changes", "graph"]) expect(stepById(id)!.alt).toMatchObject({ anchors: ['[data-command="panel.toggle"]'], body: "Show the side panel to see files, changes and the git graph." });
  });
  it("the terminal step falls back to the pane row below lg, and has no side panel alternative (centered)", () => {
    expect(stepById("terminal")!.anchors).toEqual(['[data-command="terminal.toggle"]', '[data-testid="pane-terminal"]']);
    expect(stepById("terminal")!.alt).toBeUndefined();
  });
  it("keys: only commands the app has today", () => {
    expect(stepById("tabs")!.keys).toEqual(["tab.next", "tab.close"]);
    expect(stepById("files")!.keys).toEqual(["pane.files"]);
    expect(stepById("changes")!.keys).toEqual(["pane.changes"]);
  });
});
