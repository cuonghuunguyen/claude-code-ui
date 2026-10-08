import { describe, expect, it } from "vitest";
import { adapt, STEPS, stepById, stepsFor } from "./guide-steps.ts";

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
