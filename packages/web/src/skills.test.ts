import { describe, expect, it } from "vitest";
import type { SkillRow } from "@claude-ui/protocol";
import { buildRows, lockText, nextState, skillMeta, STATE_HINT, STATE_LABEL, tokenText } from "./skills.ts";

const skill = (name: string, over: Partial<SkillRow> = {}): SkillRow => ({ name, displayName: name, description: `${name} desc`, source: "user", tokens: 100, state: "on", advertised: true, handles: {}, ...over });
const cmd = (name: string, over: object = {}) => ({ name, description: `${name} cmd`, argumentHint: "", ...over });

describe("state", () => {
  it("cycles on → name-only → user-invocable-only → off → on", () => {
    expect(["on", "name-only", "user-invocable-only", "off", "on"].slice(0, 4).map(nextState)).toEqual(["name-only", "user-invocable-only", "off", "on"]);
  });
  it("labels and hints are the extension's", () => {
    expect(STATE_LABEL).toEqual({ on: "On", "name-only": "Name only", "user-invocable-only": "User only", off: "Off" });
    expect(STATE_HINT["user-invocable-only"]).toBe("Yours to invoke; Claude does not see it");
    expect(STATE_HINT.off).toBe("Hidden from Claude and from the command list");
  });
  it("lock reasons", () => {
    expect(lockText("plugin")).toBe("Managed with its plugin");
    expect(lockText("author")).toBe("Set in the skill's own file");
    expect(lockText("policy")).toBe("Set by a higher-priority configuration");
    expect(lockText("flag")).toBe("Set by a higher-priority configuration");
    expect(lockText("reserved-name")).toBe("Settings can't store an entry with this name; rename the skill's folder or file to configure it");
    expect(lockText("other")).toBe("Set by a higher-priority configuration");
  });
});

describe("meta text", () => {
  it("shows ~N tokens, '< 20' for small ones", () => {
    expect(tokenText(19)).toBe("< 20");
    expect(tokenText(20)).toBe("~20");
    expect(skillMeta(skill("a", { source: "plugin", tokens: 281 }))).toBe("plugin · ~281 tokens");
    expect(skillMeta(skill("a", { source: "project", tokens: 3 }))).toBe("project · < 20 tokens");
  });
});

describe("buildRows", () => {
  it("joins a command with its skill by name, by a qualified alias, or by the unqualified display name", () => {
    const skills = [skill("probe", { source: "project" }), skill("ponytail:ponytail", { source: "plugin", handles: { aliases: ["ponytail"] } }), skill("anthropic-skills:docs", { displayName: "docs", source: "claude.ai sync", handles: { aliases: ["docs"] } })];
    const rows = buildRows([cmd("probe"), cmd("ponytail:ponytail"), cmd("docs"), cmd("compact")], skills);
    expect(rows.map((r) => [r.label, r.skill?.name])).toEqual([
      ["/compact", undefined],
      ["/docs", "anthropic-skills:docs"],
      ["/ponytail:ponytail", "ponytail:ponytail"],
      ["/probe", "probe"],
    ]);
  });
  it("orders by source, then name; commands without a skill first", () => {
    const skills = [skill("z", { source: "user" }), skill("b", { source: "project" }), skill("a", { source: "user" })];
    expect(buildRows([cmd("z"), cmd("b"), cmd("a"), cmd("init")], skills).map((r) => r.label)).toEqual(["/init", "/b", "/a", "/z"]);
  });
  it("appends skills that are no command as inert rows, with the full name when display names clash", () => {
    const skills = [skill("kept"), skill("off1", { state: "off", advertised: false }), skill("p:x", { displayName: "x", source: "plugin", advertised: false }), skill("q:x", { displayName: "x", source: "plugin", advertised: false })];
    const rows = buildRows([cmd("kept")], skills);
    expect(rows.map((r) => [r.label, !!r.command])).toEqual([["/kept", true], ["/p:x", false], ["/q:x", false], ["/off1", false]]);
    expect(buildRows([cmd("kept")], [skill("kept"), skill("p:x", { displayName: "x", advertised: false })]).at(-1)!.label).toBe("/x");
  });
  it("an advertised-false skill never joins a command", () => {
    expect(buildRows([cmd("probe")], [skill("probe", { advertised: false, state: "off" })]).map((r) => [r.label, !!r.command, !!r.skill])).toEqual([["/probe", true, false], ["/probe", false, true]]);
  });
  it("no commands: every skill is an inert row; nothing at all: no rows", () => {
    expect(buildRows([], [skill("a")]).map((r) => r.command)).toEqual([undefined]);
    expect(buildRows([], [])).toEqual([]);
  });
  it("filters by name, description and source, ignoring a leading slash and case", () => {
    const skills = [skill("probe", { source: "project", description: "Probe things" }), skill("other", { source: "user" })];
    const all = [cmd("probe"), cmd("other"), cmd("compact", { description: "Shrink the transcript" })];
    expect(buildRows(all, skills, "/PRO").map((r) => r.label)).toEqual(["/probe"]);
    expect(buildRows(all, skills, "shrink").map((r) => r.label)).toEqual(["/compact"]);
    expect(buildRows(all, skills, "project").map((r) => r.label)).toEqual(["/probe"]);
    expect(buildRows(all, skills, "zzz")).toEqual([]);
  });
});
