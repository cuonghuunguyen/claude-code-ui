import { describe, expect, it } from "vitest";
import { isRemoteOf, jiraKeyInBranch, pullRequestOf, remoteRepoOf } from "../src/pull-request.ts";

describe("pullRequestOf", () => {
  it("Bitbucket Server: overview, commits and diff pages, any context path, personal repos", () => {
    const bb = "https://bitbucket.example.com/projects";
    expect(pullRequestOf(`${bb}/PROJ/repos/web-app/pull-requests/318/overview`)).toEqual({ host: "bitbucket.example.com", repo: "proj/web-app", number: 318, refs: ["refs/pull-requests/318/from"] });
    expect(pullRequestOf(`${bb}/TEAM/repos/core-lib/pull-requests/439/commits`)?.repo).toBe("team/core-lib");
    expect(pullRequestOf(`${bb}/TEAM/repos/core-lib/pull-requests/439/diff#corelib%2Fsrc%2FX.java`)?.number).toBe(439);
    expect(pullRequestOf("https://host.example/bitbucket/projects/P/repos/r/pull-requests/7")?.repo).toBe("p/r");
    expect(pullRequestOf("https://host.example/users/ann/repos/dots/pull-requests/2/overview")?.repo).toBe("~ann/dots");
  });
  it("GitHub, GitLab (subgroups), Bitbucket Cloud (no refs)", () => {
    expect(pullRequestOf("https://github.com/cuonghuunguyen/claude-code-ui/pull/160/files")).toEqual({ host: "github.com", repo: "cuonghuunguyen/claude-code-ui", number: 160, refs: ["refs/pull/160/head"] });
    expect(pullRequestOf("https://gitlab.example.com/grp/sub/app/-/merge_requests/12/diffs")).toEqual({ host: "gitlab.example.com", repo: "grp/sub/app", number: 12, refs: ["refs/merge-requests/12/head"] });
    expect(pullRequestOf("https://bitbucket.org/ws/app/pull-requests/3")).toEqual({ host: "bitbucket.org", repo: "ws/app", number: 3, refs: [] });
  });
  it("other text is no link", () => {
    for (const t of ["PRJ-1", "fix login", "https://jira.example.com/browse/PRJ-1", "https://github.com/o/r/issues/4", "https://github.com/o/r/pull/x", "ftp://github.com/o/r/pull/1"]) expect(pullRequestOf(t)).toBeUndefined();
  });
});

describe("remoteRepoOf / isRemoteOf", () => {
  it("https, ssh:// with port, scp-like; Bitbucket scm/ and ~user", () => {
    expect(remoteRepoOf("https://github.com/Cuonghuunguyen/claude-code-ui.git")).toEqual({ host: "github.com", path: "cuonghuunguyen/claude-code-ui" });
    expect(remoteRepoOf("git@github.com:o/r.git")).toEqual({ host: "github.com", path: "o/r" });
    expect(remoteRepoOf("ssh://git@bitbucket.example.com:7999/proj/web-app.git")).toEqual({ host: "bitbucket.example.com", path: "proj/web-app" });
    expect(remoteRepoOf("https://ann@bitbucket.example.com/scm/team/core-lib.git")).toEqual({ host: "bitbucket.example.com", path: "team/core-lib" });
    expect(remoteRepoOf("https://host.example/bitbucket/scm/~ann/dots.git")).toEqual({ host: "host.example", path: "~ann/dots" });
    expect(remoteRepoOf("/srv/git/o.git")).toBeUndefined();
  });
  it("same host and repository only", () => {
    const pr = pullRequestOf("https://bitbucket.example.com/projects/TEAM/repos/core-lib/pull-requests/439/overview")!;
    expect(isRemoteOf(pr, "ssh://git@bitbucket.example.com:7999/team/core-lib.git")).toBe(true);
    expect(isRemoteOf(pr, "https://bitbucket.example.com/scm/TEAM/core-lib.git")).toBe(true);
    expect(isRemoteOf(pr, "ssh://git@bitbucket.example.com:7999/team/other-repo.git")).toBe(false);
    expect(isRemoteOf(pr, "https://other.example/scm/team/core-lib.git")).toBe(false);
  });
});

it("jiraKeyInBranch: a whole-word key, upper case", () => {
  expect(jiraKeyInBranch("feature/esaca-138-trim-ticket")).toBe("ESACA-138");
  expect(jiraKeyInBranch("bugfix/PRJ-12")).toBe("PRJ-12");
  expect(jiraKeyInBranch("main")).toBeUndefined();
  expect(jiraKeyInBranch("release-0.7.1")).toBeUndefined();
});
