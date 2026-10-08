// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { activeOnly, collapseKeys, loadSidebarView, revealKeys, saveSidebarView, sortGroups, byDay, groupByCwd, inProject, loadCollapsed, nestWorkers, parseSessionQuery, patchSession, resumeSearchText, projectOf, removeWorktreeText, repoOf, saveCollapsed, timeAgo, worktreeName } from "./sessions.ts";

const item = (id: string, cwd: string, lastActivity: number, title = id, archived = false): SessionListItem => ({
  id,
  cwd,
  state: "idle",
  model: "default",
  permissionMode: "default",
  effort: "default",
  permissionModes: [],
  title,
  lastActivity,
  archived,
  transcript: true,
});

describe("patchSession", () => {
  it("changes only the given session, so an archive shows at once instead of after the list refetch", () => {
    const list = [item("a", "/p/x", 2), item("b", "/p/x", 1)];
    const next = patchSession(list, "b", { archived: true });
    expect(next.map((s) => s.archived)).toEqual([false, true]);
    expect(next[0]).toBe(list[0]);
    expect(groupByCwd(next).flatMap((g) => g.sessions.map((s) => s.id))).toEqual(["a"]);
  });
});

describe("groupByCwd", () => {
  it("groups sessions by working directory, most recent group first, keeping order inside a group", () => {
    const groups = groupByCwd([item("a", "/p/x", 30), item("b", "/p/y", 20), item("c", "/p/x", 10)]);
    expect(groups.map((g) => [g.cwd, g.sessions.map((s) => s.id)])).toEqual([
      ["/p/x", ["a", "c"]],
      ["/p/y", ["b"]],
    ]);
  });

  it("makes exactly one group per working directory whatever the input order, sessions newest first", () => {
    const groups = groupByCwd([item("a", "/p/x", 10), item("b", "/p/y", 40), item("c", "/p/x/", 30), item("d", "/p/y", 5), item("e", "/p/x", 20)]);
    expect(groups.map((g) => [g.cwd, g.sessions.map((s) => s.id)])).toEqual([
      ["/p/y", ["b", "d"]],
      ["/p/x", ["c", "e", "a"]],
    ]);
  });

  it("hides archived sessions; the archived filter shows only them", () => {
    const list = [item("a", "/p/x", 3), item("b", "/p/x", 2, "b", true), item("c", "/p/y", 1, "c", true)];
    const ids = (archived: boolean) => groupByCwd(list, "", undefined, archived).flatMap((g) => g.sessions.map((s) => s.id));
    expect(ids(false)).toEqual(["a"]);
    expect(ids(true)).toEqual(["b", "c"]);
  });

  it("filters by session title or project name, case-insensitive", () => {
    const list = [item("a", "/p/web", 3, "Fix login"), item("b", "/p/api", 2, "Docs"), item("c", "/p/api", 1, "Add LOGIN test")];
    const ids = (q: string) => groupByCwd(list, q).map((g) => [g.cwd, g.sessions.map((s) => s.id)]);
    expect(ids("login")).toEqual([
      ["/p/web", ["a"]],
      ["/p/api", ["c"]],
    ]);
    expect(ids(" API ")).toEqual([["/p/api", ["b", "c"]]]);
    expect(ids("p/")).toEqual([]);
    expect(ids("")).toHaveLength(2);
  });
});

describe("groupByCwd with projects", () => {
  it("one group per project in the daemon's order, empty projects too; sessions outside the projects are dropped", () => {
    const groups = groupByCwd([item("a", "/p/x", 30), item("b", "/p/gone", 20)], "", ["/p/new", "/p/x"]);
    expect(groups.map((g) => [g.cwd, g.sessions.map((s) => s.id)])).toEqual([
      ["/p/new", []],
      ["/p/x", ["a"]],
    ]);
  });

  it("a search keeps an empty project only when its name matches", () => {
    const groups = (q: string) => groupByCwd([item("a", "/p/x", 30, "login")], q, ["/p/new", "/p/x"]).map((g) => g.cwd);
    expect(groups("new")).toEqual(["/p/new"]);
    expect(groups("login")).toEqual(["/p/x"]);
  });
});

describe("parseSessionQuery", () => {
  it("takes @project=<name> from anywhere; quotes allow spaces; the rest is the text", () => {
    expect(parseSessionQuery("@project=foo bar")).toEqual({ project: "foo", text: "bar" });
    expect(parseSessionQuery("bar @project=foo baz")).toEqual({ project: "foo", text: "bar baz" });
    expect(parseSessionQuery('@project="my app" x')).toEqual({ project: "my app", text: "x" });
    expect(parseSessionQuery("@project=foo ")).toEqual({ project: "foo", text: "" });
    expect(parseSessionQuery("plain")).toEqual({ text: "plain" });
  });
  it("ignores an empty value and a token inside a word", () => {
    expect(parseSessionQuery("@project= x")).toEqual({ text: "@project= x" });
    expect(parseSessionQuery('@project="" x')).toEqual({ text: '@project="" x' });
    expect(parseSessionQuery("a@project=foo")).toEqual({ text: "a@project=foo" });
  });
});

describe("resumeSearchText", () => {
  it("quotes a name with spaces so parseSessionQuery reads it back; text follows", () => {
    expect(resumeSearchText("foo")).toBe("@project=foo ");
    expect(resumeSearchText("my app")).toBe('@project="my app" ');
    expect(resumeSearchText("my app", "login")).toBe('@project="my app" login');
    expect(parseSessionQuery(resumeSearchText("my app", "login"))).toEqual({ project: "my app", text: "login" });
    expect(parseSessionQuery(resumeSearchText('a"b'))).toEqual({ project: 'a"b', text: "" });
  });
  it("falls back to plain text for a name the syntax cannot write, and gives only the text for an empty name", () => {
    expect(resumeSearchText('"odd', "x")).toBe("odd x");
    expect(parseSessionQuery(resumeSearchText('"odd')).project).toBeUndefined();
    expect(resumeSearchText('my "x" app')).toBe("my x app ");
    expect(resumeSearchText("", "login")).toBe("login");
    expect(resumeSearchText("")).toBe("");
    expect(resumeSearchText("  ", "x")).toBe("x");
  });
});

describe("groupByCwd with @project=", () => {
  const list = [item("a", "/p/foo", 30, "Fix login"), item("b", "/p/bar", 20, "Fix login"), item("c", "/p/foo-wt", 10, "Deploy"), item("d", "/p/foo", 5, "Docs"), item("e", "/p/foo", 4, "Old", true)];
  const worktrees = { "/p/foo": [{ path: "/p/foo", branch: "main", main: true }, { path: "/p/foo-wt", branch: "feat", main: false }] } as never;
  const ids = (q: string, archived = false) => groupByCwd(list, q, ["/p/foo", "/p/bar"], archived, worktrees).flatMap((g) => [...g.sessions, ...g.worktrees.flatMap((r) => r.sessions)].map((s) => s.id).sort());
  it("keeps the project's whole repository group, worktree rows included, case-insensitively", () => {
    expect(ids("@project=foo")).toEqual(["a", "c", "d"]);
    expect(ids("@project=FOO")).toEqual(["a", "c", "d"]);
  });
  it("filters the project's sessions by the rest of the query", () => {
    expect(ids("@project=foo login")).toEqual(["a"]);
    expect(ids("deploy @project=foo")).toEqual(["c"]);
  });
  it("a worktree added as its own project matches next to the main checkout; the group lists (F1)", () => {
    const rows = [{ path: "/p/foo", branch: "main", main: true }, { path: "/p/feat", branch: "feat", main: false }];
    const wt = { "/p/foo": rows, "/p/feat": rows } as never;
    const g = groupByCwd(list, "@project=feat", ["/p/foo", "/p/feat", "/p/bar"], false, wt);
    expect(g.map((x) => x.cwd)).toEqual(["/p/foo"]);
    expect(g[0]!.sessions.length + g[0]!.worktrees.flatMap((r) => r.sessions).length).toBe(2);
  });
  it("with two tokens the first one counts, the second stays plain text", () => {
    expect(parseSessionQuery("@project=foo @project=bar")).toEqual({ project: "foo", text: "@project=bar" });
  });
  it("an unknown project gives no group; archived still shows only archived", () => {
    expect(groupByCwd(list, "@project=nope", ["/p/foo", "/p/bar"], false, worktrees)).toEqual([]);
    expect(ids("@project=foo", true)).toEqual(["e"]);
  });
});

describe("collapsed groups", () => {
  afterEach(() => localStorage.clear());
  it("persist across reloads", () => {
    expect(loadCollapsed()).toEqual(new Set());
    saveCollapsed(new Set(["/p/x"]));
    expect(loadCollapsed()).toEqual(new Set(["/p/x"]));
    localStorage.setItem("claude-ui.collapsed", "{bad");
    expect(loadCollapsed()).toEqual(new Set());
  });
});

describe("timeAgo", () => {
  const now = 1_000_000_000;
  it("formats last activity relative to now", () => {
    expect(timeAgo(now - 10_000, now)).toBe("now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h");
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe("2d");
  });
});

it("inProject matches a session cwd with a trailing slash, like its group (Remove closes its tab)", () => {
  expect(inProject("/p/x")(item("a", "/p/x/", 1))).toBe(true);
  expect(inProject("/p/x")(item("b", "/p/xy", 1))).toBe(false);
});

describe("byDay", () => {
  const now = new Date(2026, 9, 1, 9).getTime();
  const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
  const titles = (s: SessionListItem[]) => byDay(s, now).map((g) => [g.title, g.sessions.map((x) => x.id)]);
  it("splits newest-first sessions into Today, Yesterday and Older by calendar day, as OpenCode", () => {
    expect(titles([item("a", "/p", at(1, 0)), item("b", "/p", at(0, 23)), item("c", "/p", at(0, 1)), item("d", "/p", at(-10, 12))])).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b", "c"]],
      ["Older", ["d"]],
    ]);
  });
  it("drops empty days and names a lone older group Recent sessions", () => {
    expect(titles([item("a", "/p", at(1, 8))])).toEqual([["Today", ["a"]]]);
    expect(titles([item("d", "/p", at(-10, 12))])).toEqual([["Recent sessions", ["d"]]]);
  });
});

describe("groupByCwd with worktrees", () => {
  const wts = [
    { path: "/r/main", branch: "main", main: true },
    { path: "/wt/zed", branch: "zed", main: false },
    { path: "/wt/abc", branch: "abc", main: false, outsideRoots: true },
  ];
  // The main checkout and one linked worktree are both added: one repository, one group.
  const worktrees = { "/r/main": wts, "/wt/zed": wts, "/p/plain": [{ path: "/p/plain", branch: "main", main: true }] };
  const list = [item("a", "/wt/zed", 30, "Zed work"), item("b", "/r/main", 20, "Main work"), item("c", "/p/plain", 10), item("d", "/wt/zed", 5)];
  const shape = (groups: ReturnType<typeof groupByCwd>) =>
    groups.map((g) => [g.cwd, g.sessions.map((s) => s.id), g.worktrees.map((r) => [r.branch, r.sessions.map((s) => s.id)])]);

  it("one group per repository named after the main checkout; rows main first then by branch, each with its sessions; a repo without linked worktrees stays flat", () => {
    const groups = groupByCwd(list, "", ["/wt/zed", "/p/plain", "/r/main"], false, worktrees);
    expect(shape(groups)).toEqual([
      ["/r/main", [], [["main", ["b"]], ["abc", []], ["zed", ["a", "d"]]]],
      ["/p/plain", ["c"], []],
    ]);
    expect(groups[0].members).toEqual(["/wt/zed", "/r/main"]);
  });

  it("a query matching a branch keeps that row and its sessions; archived shows only rows with archived sessions", () => {
    expect(shape(groupByCwd(list, "ZED", ["/r/main"], false, worktrees))).toEqual([["/r/main", [], [["zed", ["a", "d"]]]]]);
    expect(shape(groupByCwd(list, "main work", ["/r/main"], false, worktrees))).toEqual([["/r/main", [], [["main", ["b"]]]]]);
    const archived = [...list, item("e", "/wt/zed", 1, "old", true)];
    expect(shape(groupByCwd(archived, "", ["/r/main", "/p/plain"], true, worktrees))).toEqual([["/r/main", [], [["zed", ["e"]]]]]);
  });

  it("subfolder projects of one repository (no worktrees entry from the daemon) stay separate groups", () => {
    const groups = groupByCwd([item("a", "/mono/pa", 2), item("b", "/mono/pb", 1)], "", ["/mono/pa", "/mono/pb"], false, {});
    expect(shape(groups)).toEqual([
      ["/mono/pa", ["a"], []],
      ["/mono/pb", ["b"], []],
    ]);
    expect([repoOf("/mono/pa", {}), repoOf("/mono/pb", {})]).toEqual(["/mono/pa", "/mono/pb"]);
  });

  it("repoOf: the main worktree of a project, else the project", () => {
    expect([repoOf("/wt/zed", worktrees), repoOf("/x", worktrees)]).toEqual(["/r/main", "/x"]);
  });
});

describe("worktreeName and projectOf", () => {
  const worktrees = {
    "/p/a": [
      { path: "/p/a", branch: "main", main: true },
      { path: "/p/a-wt", branch: "feature-x", main: false },
      { path: "/p/a-d", branch: "abc1234", main: false },
      { path: "/p/a-nb", main: false },
    ],
  };
  it("names a linked worktree '<project> · <branch>' after the main checkout; the main checkout, a non-git cwd and an unknown path have none", () => {
    expect(worktreeName("/p/a-wt", worktrees)).toBe("a · feature-x");
    expect(worktreeName("/p/a", worktrees)).toBeUndefined();
    expect(worktreeName("/p/b", worktrees)).toBeUndefined();
    expect(worktreeName("/p/a-d", worktrees)).toBe("a · abc1234");
    expect(worktreeName("/p/a-nb", worktrees)).toBe("a · a-nb");
  });
  it("projectOf finds the added project that lists a worktree path, else returns the cwd", () => {
    expect(projectOf("/p/a-wt", worktrees)).toBe("/p/a");
    expect(projectOf("/p/a", worktrees)).toBe("/p/a");
    expect(projectOf("/p/b", worktrees)).toBe("/p/b");
  });
});

describe("workers", () => {
  const w = (id: string, coordinatorId: string, workerName: string, archived = false): SessionListItem => ({ ...item(id, "/p/api", 1, id, archived), coordinatorId, workerName });
  it("nestWorkers moves workers under a coordinator of the same view, by name; orphans and other-view workers stay on top", () => {
    const coord = { ...item("c", "/p/web", 9), coordinator: true as const };
    const items = [coord, w("wb", "c", "b"), w("wa", "c", "a"), w("orphan", "gone", "o"), w("arch", "c", "z", true)];
    const { top, workers } = nestWorkers(items, false);
    expect(workers.get("c")!.map((x) => x.id)).toEqual(["wa", "wb"]);
    expect(top.map((x) => x.id)).toEqual(["c", "orphan", "arch"]);
  });

  it("groupByCwd keeps a coordinator whose worker's name or title matches the search", () => {
    const coord = { ...item("c", "/p/web", 9, "Plan"), coordinator: true as const };
    const wk = w("w1", "c", "builder");
    const { top, workers } = nestWorkers([coord, wk], false);
    expect(groupByCwd(top, "build", ["/p/web"], false, {}, workers).flatMap((g) => g.sessions.map((s) => s.id))).toEqual(["c"]);
    expect(groupByCwd(top, "nothing", ["/p/web"], false, {}, workers).flatMap((g) => g.sessions)).toEqual([]);
  });
});

it("removeWorktreeText: counts in the CLI wording, singular and plural; a clean worktree only cleans up", () => {
  expect(removeWorktreeText({ uncommitted: 2, commits: 3, branch: "worktree-x" })).toBe("You have 2 uncommitted files and 3 commits on worktree-x. All will be lost if you remove.");
  expect(removeWorktreeText({ uncommitted: 1, commits: 0, branch: "worktree-x" })).toBe("You have 1 uncommitted file on worktree-x. All will be lost if you remove.");
  expect(removeWorktreeText({ uncommitted: 0, commits: 1, branch: "worktree-x" })).toBe("You have 1 commit on worktree-x. All will be lost if you remove.");
  expect(removeWorktreeText({ uncommitted: 0, commits: 0, branch: "worktree-x" })).toBe("Clean up the worktree directory.");
});

describe("sidebar actions (GH-152)", () => {
  const wts = [
    { path: "/r", branch: "main", main: true },
    { path: "/r/.claude/worktrees/wt", branch: "wt", main: false },
  ];
  const list = [item("c1", "/r", 9), { ...item("w1", "/r/.claude/worktrees/wt", 8), coordinatorId: "c1" }, item("s2", "/r/.claude/worktrees/wt", 7), item("p1", "/zeta", 6)];
  const view = (archived = false) => {
    const { top, workers } = nestWorkers(list, archived);
    return { groups: groupByCwd(top, "", ["/r", "/zeta"], archived, { "/r": wts }, workers), workers };
  };

  it("collapseKeys: every project group, worktree row and worker group", () => {
    const { groups, workers } = view();
    expect(collapseKeys(groups, workers, false)).toEqual(["/r", "worktree:/r", "worktree:/r/.claude/worktrees/wt", "/zeta", "coordinator:c1"]);
    expect(collapseKeys(groups, workers, true).at(-1)).toBe("archived:coordinator:c1");
  });

  it("revealKeys: the keys that hide a session, undefined for an unknown one", () => {
    const { groups, workers } = view();
    expect(revealKeys("p1", groups, workers, false)).toEqual(["/zeta"]);
    expect(revealKeys("s2", groups, workers, false)).toEqual(["/r", "worktree:/r/.claude/worktrees/wt"]);
    expect(revealKeys("c1", groups, workers, false)).toEqual(["/r", "worktree:/r"]);
    expect(revealKeys("w1", groups, workers, false)).toEqual(["/r", "worktree:/r", "coordinator:c1"]);
    expect(revealKeys("nope", groups, workers, false)).toBeUndefined();
  });

  it("sortGroups: recent keeps the order, name sorts case-insensitively without touching the input", () => {
    const g = (cwd: string) => ({ cwd, members: [cwd], sessions: [], worktrees: [] });
    const groups = [g("/b/zed"), g("/a/Beta"), g("/c/alpha")];
    expect(sortGroups(groups, "recent")).toBe(groups);
    expect(sortGroups(groups, "name").map((x) => x.cwd)).toEqual(["/c/alpha", "/a/Beta", "/b/zed"]);
    expect(groups[0]!.cwd).toBe("/b/zed");
  });

  it("activeOnly: keeps sessions that hold or have a worker that holds, drops the rest, keeps empty projects", () => {
    const { groups, workers } = view();
    const out = activeOnly(groups, workers, (s) => s.id === "w1");
    expect(out.flatMap((g) => [...g.sessions, ...g.worktrees.flatMap((r) => r.sessions)]).map((s) => s.id)).toEqual(["c1"]);
    expect(out.map((g) => g.cwd)).toEqual(["/r", "/zeta"]);
  });

  describe("sidebar view settings", () => {
    afterEach(() => localStorage.clear());
    const def = { alwaysSelect: false, dayHeaders: true, onlyActive: false, sort: "recent" };
    it("defaults when missing, corrupt or of the wrong type", () => {
      expect(loadSidebarView()).toEqual(def);
      localStorage.setItem("claude-ui.sidebarView", "{nope");
      expect(loadSidebarView()).toEqual(def);
      localStorage.setItem("claude-ui.sidebarView", JSON.stringify({ alwaysSelect: "yes", dayHeaders: 0, sort: 3 }));
      expect(loadSidebarView()).toEqual(def);
    });
    it("round-trips", () => {
      const v = { alwaysSelect: true, dayHeaders: false, onlyActive: true, sort: "name" as const };
      saveSidebarView(v);
      expect(loadSidebarView()).toEqual(v);
    });
  });
});
