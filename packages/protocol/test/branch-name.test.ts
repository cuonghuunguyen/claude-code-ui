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
