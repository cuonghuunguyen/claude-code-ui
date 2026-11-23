import { describe, expect, it } from "vitest";
import type { ProjectOverrides } from "@claude-ui/protocol";
import { accountKeyOf, accountScopeOf, draftStart, jiraOf, jiraOriginOf, jiraTokenFor, overridesOf, overridesRequest, setOverride } from "./project-settings.ts";

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

describe("overridesRequest (GH-903)", () => {
  const all = { local: { "/a": { mode: "plan" as const }, "/b": { effort: "high" as const } }, "ssh:x": { "/a": { model: "opus" } } };
  it("a daemon with the per-Project patch gets only this Project's entry, the others are not sent", () => {
    expect(overridesRequest(all, "local", "/a", { model: "haiku" }, true)).toEqual({ type: "settings.project", side: "local", cwd: "/a", overrides: { mode: "plan", model: "haiku" } });
  });
  it("unsetting the last field sends null", () => {
    expect(overridesRequest(all, "local", "/a", { mode: undefined }, true)).toEqual({ type: "settings.project", side: "local", cwd: "/a", overrides: null });
  });
  it("an older daemon gets the whole map", () => {
    expect(overridesRequest(all, "local", "/a", { mode: undefined }, undefined)).toEqual({ type: "settings.set", patch: { projects: { overrides: { local: { "/b": { effort: "high" } }, "ssh:x": { "/a": { model: "opus" } } } } } });
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

describe("Jira of a Project", () => {
  const global = { url: "https://acme.atlassian.net", email: "ann@example.com", template: "{key}", jql: "project = G" };
  it("each field the Project sets replaces the global one; the Side and the Project's own folder pick the entry", () => {
    const all = { ...map("local", "/a", { jira: { url: "https://jira.example.com", jql: "project = A" } }), ...map("ssh:x", "/a", { jira: { email: "bob@example.com" } }) };
    expect(jiraOf(all, "local", "/a", global)).toEqual({ ...global, url: "https://jira.example.com", jql: "project = A" });
    expect(jiraOf(all, "ssh:x", "/a", global)).toEqual({ ...global, email: "bob@example.com" });
    expect(jiraOf(all, "local", "/b", global)).toEqual(global);
    expect(jiraOf(undefined, "local", "/a", global)).toEqual(global);
    expect(jiraOf(all, "__proto__", "constructor", global)).toEqual(global);
  });
  it("a token belongs to an origin: path and trailing slash do not matter, another host or port does", () => {
    expect(jiraOriginOf("https://jira.example.com/path/")).toBe("https://jira.example.com");
    expect(jiraOriginOf("https://jira.example.com:8443")).toBe("https://jira.example.com:8443");
    expect(jiraOriginOf("")).toBe("");
    expect(jiraOriginOf("not a url")).toBe("");
    const r = { jiraToken: true, jiraTokens: ["https://jira.example.com"] };
    expect(jiraTokenFor(r, "https://jira.example.com/x")).toBe(true);
    expect(jiraTokenFor(r, "https://acme.atlassian.net")).toBe(false);
    expect(jiraTokenFor(r, "")).toBe(false);
    // An older daemon reports the one global token only.
    expect(jiraTokenFor({ jiraToken: true }, "https://acme.atlassian.net")).toBe(true);
    expect(jiraTokenFor({ jiraToken: false }, "https://acme.atlassian.net")).toBe(false);
  });
});

describe("accountKeyOf (GH-900)", () => {
  const view = (overrides: Parameters<typeof accountKeyOf>[0]["overrides"], extra: Partial<Parameters<typeof accountKeyOf>[0]> = {}) => ({ overrides, cwdSides: {}, account: "a1", accounts: [{ id: "a1" }, { id: "b2" }], ...extra });
  it("the Project's account, else the global one", () => {
    const v = view(map("local", "/p", { account: "b2" }));
    expect(accountScopeOf(v, "/p")).toEqual({ key: "b2", project: "/p" });
    expect(accountScopeOf(v, "/q")).toEqual({ key: "a1" });
    expect(accountKeyOf(v, undefined)).toBe("a1");
  });
  it("a Worktree takes its Project's account and names the Project", () => {
    const worktrees = { "/p": [{ path: "/p-wt" }] } as never;
    expect(accountScopeOf(view(map("local", "/p", { account: "b2" }), { worktrees }), "/p-wt")).toEqual({ key: "b2", project: "/p" });
  });
  it("a Side Session keeps the global account, whatever the entry says", () => {
    expect(accountScopeOf(view(map("wsl:U", "/p", { account: "b2" }), { cwdSides: { "/p": "wsl:U" } }), "/p")).toEqual({ key: "a1" });
  });
  it("the raw value is the key: Default and CLI login stay apart, an unknown id counts as Default", () => {
    expect(accountKeyOf(view(map("local", "/p", { account: "" })), "/p")).toBe("");
    expect(accountKeyOf(view(map("local", "/p", { account: "cli" }), { account: "" }), "/p")).toBe("cli");
    expect(accountKeyOf(view(map("local", "/p", { account: "gone" })), "/p")).toBe("");
    expect(accountKeyOf(view({}, { account: "gone" }), "/p")).toBe("");
  });
});
