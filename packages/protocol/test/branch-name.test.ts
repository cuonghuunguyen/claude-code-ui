import { describe, expect, it } from "vitest";
import { branchFolder, branchNameError, DEFAULT_BRANCH_TEMPLATE, jiraIsCloud, jiraKeyOf, normalizeBranchName, ticketBranchName } from "../src/branch-name.ts";

describe("normalizeBranchName (GH-447 Name rule)", () => {
  it.each([
    ["Fix Login Ü", "fix-login-u"],
    ["feat/x", "feat/x"],
    ["  Crème Brûlée  ", "creme-brulee"],
    ["a  b", "a-b"],
    ["a--b__c", "a-b__c"],
    ["a//b", "a/b"],
    ["a...b", "a.b"],
    ["a..b", "a.b"],
    ["-x-", "x"],
    ["/x/", "x"],
    [".x.", "x"],
    ["x.lock", "x"],
    ["feat/x.lock/y", "feat/x/y"],
    ["feat/.hidden", "feat/hidden"],
    ["feat/-x", "feat/x"],
    ["what?*:~^[\\]@{x}", "what-x"],
    ["Ünïcödé 中文", "unicode"],
    ["", ""],
    ["---", ""],
    ["///...", ""],
  ])("%j → %j", (input, want) => expect(normalizeBranchName(input)).toBe(want));

  it("cuts at 80 characters and drops a trailing separator the cut leaves", () => {
    expect(normalizeBranchName("a".repeat(100))).toBe("a".repeat(80));
    expect(normalizeBranchName(`${"a".repeat(79)}-bcd`)).toBe("a".repeat(79));
  });

  it("keeps the case of a ticket key when asked", () => {
    expect(normalizeBranchName("Feature/PRJ-12-Login", { keep: "PRJ-12" })).toBe("feature/PRJ-12-login");
    expect(normalizeBranchName("prj-12 again prj-12", { keep: "PRJ-12" })).toBe("PRJ-12-again-PRJ-12");
  });

  it.each([
    ["GH-464 Reuse container node", "GH-464-reuse-container-node"],
    ["feat/PRJ-12 login", "feat/PRJ-12-login"],
    ["PRJ_A-7 and GH-9", "PRJ_A-7-and-GH-9"],
    ["gh-464 fix", "gh-464-fix"],
    ["fix-123 V2-1", "fix-123-V2-1"],
    ["Fix-12 x", "fix-12-x"],
    ["xGH-1 y", "xgh-1-y"],
  ])("keeps the case of a key typed in upper case: %j → %j", (input, want) => expect(normalizeBranchName(input)).toBe(want));
});

describe("branchFolder", () => {
  it("replaces / with -", () => {
    expect(branchFolder("feat/x")).toBe("feat-x");
    expect(branchFolder("fix-login-u")).toBe("fix-login-u");
    expect(branchFolder("feature/PRJ-1/a")).toBe("feature-PRJ-1-a");
  });
});

describe("branchNameError", () => {
  it.each([[""], ["-x"], ["x".repeat(201)]])("refuses %j", (b) => expect(branchNameError(b)).toBeTruthy());
  it("accepts a normal branch", () => expect(branchNameError("feature/PRJ-1-x")).toBeUndefined());
  it("refuses a branch whose folder breaks the folder rule", () => expect(branchNameError(`a/${"b".repeat(70)}`)).toMatch(/Folder/));
});

describe("ticketBranchName (GH-447 template)", () => {
  const t = (type: string, summary = "Login fails on Safari!") => ({ key: "PRJ-123", type, summary });
  it.each([
    ["Bug", "bugfix/PRJ-123-login-fails-on-safari"],
    ["Story", "feature/PRJ-123-login-fails-on-safari"],
    ["Task", "feature/PRJ-123-login-fails-on-safari"],
    ["New Feature", "feature/PRJ-123-login-fails-on-safari"],
    ["Epic", "PRJ-123-login-fails-on-safari"],
  ])("default template, %s → %s", (type, want) => expect(ticketBranchName(DEFAULT_BRANCH_TEMPLATE, t(type))).toBe(want));

  it("cuts the summary to 50 characters", () => {
    const name = ticketBranchName("{summary}", t("Bug", "x".repeat(30) + " " + "y".repeat(40)));
    expect(name).toBe(`${"x".repeat(30)}-${"y".repeat(19)}`);
  });

  it("other templates: key only, type and key, literal text", () => {
    expect(ticketBranchName("{key}", t("Bug"))).toBe("PRJ-123");
    expect(ticketBranchName("{type}-{key}", t("Epic"))).toBe("PRJ-123");
    expect(ticketBranchName("users/me/{key}", t("Bug"))).toBe("users/me/PRJ-123");
  });
});

describe("jiraKeyOf", () => {
  it.each([
    ["PRJ-123", "PRJ-123"],
    ["prj-123", "PRJ-123"],
    [" AB_2-7 ", "AB_2-7"],
    ["https://acme.atlassian.net/browse/PRJ-123", "PRJ-123"],
    ["https://jira.acme.com/browse/prj-9?focusedCommentId=1", "PRJ-9"],
    ["https://acme.atlassian.net/jira/software/projects/PRJ/boards/1?selectedIssue=PRJ-77", "PRJ-77"],
  ])("%j → %j", (input, want) => expect(jiraKeyOf(input)).toBe(want));
  it.each([["login"], ["123"], ["PRJ-"], ["https://acme.atlassian.net/jira"], ["PRJ 123"]])("%j has no key", (input) => expect(jiraKeyOf(input)).toBeUndefined());
});

describe("jiraIsCloud", () => {
  it("*.atlassian.net is Cloud, anything else Data Center", () => {
    expect(jiraIsCloud("https://acme.atlassian.net")).toBe(true);
    expect(jiraIsCloud("https://acme.atlassian.net/")).toBe(true);
    expect(jiraIsCloud("https://jira.acme.com")).toBe(false);
    expect(jiraIsCloud("https://atlassian.net.evil.com")).toBe(false);
    expect(jiraIsCloud("not a url")).toBe(false);
  });
});

describe("GH-452 long names", () => {
  const ok = (r: string) => {
    expect(branchNameError(r)).toBeUndefined();
    expect(r.endsWith("-")).toBe(false);
  };
  it("ticketBranchName keeps the folder within 64 characters for long summaries, long keys, Bug and templates without {type}", () => {
    const long = "Support repo with client/server folder structure like the old monorepo layout for every service";
    ok(ticketBranchName(DEFAULT_BRANCH_TEMPLATE, { key: "PROJ-351", type: "Story", summary: long }));
    ok(ticketBranchName(DEFAULT_BRANCH_TEMPLATE, { key: "VERYLONGPROJECT-123456", type: "Story", summary: long }));
    ok(ticketBranchName(DEFAULT_BRANCH_TEMPLATE, { key: "PROJ-351", type: "Bug", summary: long }));
    ok(ticketBranchName("{key}-{summary}", { key: "PROJ-351", type: "Story", summary: long }));
    ok(ticketBranchName("{summary}", { key: "PROJ-351", type: "Story", summary: "x".repeat(60) }));
    const r = ticketBranchName(DEFAULT_BRANCH_TEMPLATE, { key: "PROJ-351", type: "Story", summary: long });
    expect(r).toBe("feature/PROJ-351-support-repo-with-client/server-folder");
    // Key and type alone over 64: only the summary goes.
    const key = "K".repeat(60) + "-1";
    expect(ticketBranchName(DEFAULT_BRANCH_TEMPLATE, { key, type: "Bug", summary: "abc" })).toBe(`bugfix/${key}`);
  });
  it("branchNameError refuses @{ and still refuses a typed name over 64 folder characters", () => {
    expect(branchNameError("a@{-1}")).toMatch(/@\{/);
    expect(branchNameError("a".repeat(65))).toBeTruthy();
  });
});
