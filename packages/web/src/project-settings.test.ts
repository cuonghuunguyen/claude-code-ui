import { describe, expect, it } from "vitest";
import type { ProjectOverrides } from "@claude-ui/protocol";
import { draftStart, overridesOf, setOverride } from "./project-settings.ts";

const map = (side: string, cwd: string, o: ProjectOverrides) => ({ [side]: { [cwd]: o } });

describe("overridesOf", () => {
  it("reads the entry of the Side of the cwd, `local` without a Side", () => {
    const all = { ...map("local", "/a", { model: "m1" }), ...map("wsl:Ubuntu", "/a", { model: "m2" }) };
    expect(overridesOf(all, {}, "/a")).toEqual({ model: "m1" });
    expect(overridesOf(all, { "/a": "wsl:Ubuntu" }, "/a")).toEqual({ model: "m2" });
    expect(overridesOf(all, {}, "/other")).toEqual({});
    expect(overridesOf(undefined, {}, "/a")).toEqual({});
  });
  it("a Worktree reads the entry of its Project, its own entry wins", () => {
    const worktrees = { "/a": [{ path: "/a-wt" }] } as never;
    expect(overridesOf(map("local", "/a", { effort: "high" }), {}, "/a-wt", worktrees)).toEqual({ effort: "high" });
    const both = { local: { "/a": { effort: "high" }, "/a-wt": { effort: "low" } } } as const;
    expect(overridesOf(both, {}, "/a-wt", worktrees)).toEqual({ effort: "low" });
  });
  it("does not read inherited keys", () => {
    expect(overridesOf({}, {}, "__proto__")).toEqual({});
    expect(overridesOf({}, { x: "constructor" }, "x")).toEqual({});
  });
});

describe("setOverride", () => {
  it("sets a field and keeps other Projects and Sides", () => {
    const all = { ...map("local", "/a", { model: "m" }), ...map("ssh:x", "/b", { effort: "low" }) };
    expect(setOverride(all, "local", "/a", { effort: "max" })).toEqual({ local: { "/a": { model: "m", effort: "max" } }, "ssh:x": { "/b": { effort: "low" } } });
  });
  it("unsetting the last field removes the Project and the empty Side", () => {
    expect(setOverride(map("local", "/a", { model: "m" }), "local", "/a", { model: undefined })).toEqual({});
    expect(setOverride({ local: { "/a": { model: "m" }, "/b": { effort: "low" } } }, "local", "/a", { model: undefined })).toEqual({ local: { "/b": { effort: "low" } } });
  });
  it("an emptied group is removed, a sibling field stays", () => {
    const o = { inlineTask: { model: "haiku", openCodeModel: "p/m" } };
    expect(setOverride(map("local", "/a", o), "local", "/a", { inlineTask: { openCodeModel: undefined } })).toEqual(map("local", "/a", { inlineTask: { model: "haiku" } }));
    expect(setOverride(map("local", "/a", { history: { enabled: false } }), "local", "/a", { history: { enabled: undefined } })).toEqual({});
  });
  it("does not change the input", () => {
    const all = map("local", "/a", { model: "m" });
    setOverride(all, "local", "/a", { model: undefined });
    expect(all).toEqual(map("local", "/a", { model: "m" }));
  });
});

describe("draftStart", () => {
  it("nothing set: the global Engine and Default model and effort", () => {
    expect(draftStart({}, "claude", {})).toEqual({ engine: "claude", model: "default", effort: "default" });
  });
  it("the Project sets Engine, model and effort", () => {
    expect(draftStart({ engine: "opencode", model: "p/m", effort: "high" }, "claude", {})).toEqual({ engine: "opencode", model: "p/m", effort: "high" });
  });
  it("model and effort apply when the global Engine is the Project's Engine", () => {
    expect(draftStart({ model: "opus", effort: "max" }, "claude", {})).toEqual({ engine: "claude", model: "opus", effort: "max" });
  });
  it("a picked Engine other than the Project's: the override model and effort are ignored", () => {
    expect(draftStart({ engine: "claude", model: "opus", effort: "max" }, "claude", { engine: "opencode" })).toEqual({ engine: "opencode", model: "default", effort: "default" });
  });
  it("a picked model or effort wins over the override", () => {
    expect(draftStart({ model: "opus", effort: "max" }, "claude", { model: "sonnet", effort: "low" })).toEqual({ engine: "claude", model: "sonnet", effort: "low" });
  });
});
