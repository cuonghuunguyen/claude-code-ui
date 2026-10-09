// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem, SessionState, Worktree } from "@claude-ui/protocol";
import { SessionList } from "./sidebar.tsx";
import { SideLabel } from "./sides.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// One actions menu per rendered row: counts the rows' renders by title.
const rowRenders = vi.hoisted(() => [] as string[]);
vi.mock("./session-actions.tsx", async (orig) => {
  const m = await orig<typeof import("./session-actions.tsx")>();
  return { ...m, SessionMenu: (p: Parameters<typeof m.SessionMenu>[0]) => (rowRenders.push(p.target.title), <m.SessionMenu {...p} />) };
});

const now = Date.now();
const item = (id: string, cwd: string, title: string, minutesAgo: number, state: SessionState = "closed"): SessionListItem => ({
  id,
  cwd,
  title,
  state,
  model: "default",
  permissionMode: "default",
  effort: "default",
  permissionModes: [],
  lastActivity: now - minutesAgo * 60_000,
  archived: false,
  transcript: true,
});
// Interleaved working directories, as the daemon's newest-first list gives them.
const LIST = [
  item("a", "/home/u/web", "Fix login", 1, "running"),
  item("b", "/home/u/api", "Docs pass", 5, "needs_input"),
  item("c", "/home/u/web", "Old idea", 120),
  item("d", "/home/u/api", "Refactor", 3000, "idle"),
];

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  root?.unmount();
  localStorage.clear();
});

async function render(props: { activeId?: string | null; list?: SessionListItem[]; renaming?: string; projects?: string[]; worktrees?: Record<string, Worktree[]>; side?: (cwd: string) => { label: string; short: string } | undefined } = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onOpen = vi.fn();
  const onNew = vi.fn();
  const onRemove = vi.fn();
  const onNewWorktree = vi.fn();
  const onRemoveWorktree = vi.fn();
  const onOpenProject = vi.fn();
  const onAction = vi.fn();
  const onRenamed = vi.fn();
  await act(async () =>
    root!.render(
      <SideLabel value={props.side ?? (() => undefined)}>
      <SessionList
        list={props.list ?? LIST}
        projects={props.projects ?? ["/home/u/web", "/home/u/api"]}
        worktrees={props.worktrees}
        state={(s) => s.state}
        unread={new Set(["c"])}
        activeId={props.activeId === null ? undefined : (props.activeId ?? "a")}
        onOpen={onOpen}
        onNew={onNew}
        onRemove={onRemove}
        onNewWorktree={onNewWorktree}
        onRemoveWorktree={onRemoveWorktree}
        onOpenProject={onOpenProject}
        renaming={props.renaming}
        onAction={onAction}
        onRenamed={onRenamed}
      />
      </SideLabel>,
    ),
  );
  const groups = () => [...el.querySelectorAll<HTMLElement>('[data-testid="session-group"]')];
  const rows = () => [...el.querySelectorAll<HTMLElement>('[data-testid="session-item"]')];
  const toggle = (cwd: string) => el.querySelector<HTMLElement>(`[data-cwd="${cwd}"] [data-testid="group-toggle"]`)!;
  const search = async (q: string) => {
    const input = el.querySelector<HTMLInputElement>('[data-testid="session-search"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, q);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return { el, groups, rows, toggle, search, onOpen, onNew, onRemove, onNewWorktree, onRemoveWorktree, onOpenProject, onAction, onRenamed };
}

it("one group per working directory with the project name as header and the full path only as tooltip", async () => {
  const { groups, toggle } = await render();
  expect(groups().map((g) => g.dataset.cwd)).toEqual(["/home/u/web", "/home/u/api"]);
  expect(toggle("/home/u/web").textContent).toBe("Wweb");
  expect(toggle("/home/u/web").title).toBe("/home/u/web");
  expect(groups()[0]!.textContent).not.toContain("/home/u");
});

it("rows show title and relative time; only running and needs input get a state, closed and idle none", async () => {
  const { rows, el, onOpen } = await render();
  expect(rows().map((r) => r.textContent)).toEqual(["Fix login1m", "Old idea2h", "Docs pass5m", "Refactor2d"]);
  expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual(["Fix login, running", "Old idea, unread", "Docs pass, needs input", "Refactor"]);
  expect(rows().map((r) => r.querySelectorAll("svg").length)).toEqual([1, 0, 1, 0]);
  expect(el.textContent).not.toMatch(/closed|idle/);
  expect(rows()[0]!.getAttribute("aria-current")).toBe("page");
  await act(async () => rows()[2]!.click());
  expect(onOpen).toHaveBeenCalledWith("b");
});

it("groups collapse and the collapsed state survives a reload", async () => {
  let r = await render();
  await act(async () => r.toggle("/home/u/web").click());
  expect(r.toggle("/home/u/web").getAttribute("aria-expanded")).toBe("false");
  expect(r.rows().map((x) => x.textContent?.slice(0, 4))).toEqual(["Docs", "Refa"]);
  root!.unmount();
  r = await render();
  expect(r.toggle("/home/u/web").getAttribute("aria-expanded")).toBe("false");
  expect(r.rows()).toHaveLength(2);
  await act(async () => r.toggle("/home/u/web").click());
  expect(r.rows()).toHaveLength(4);
});

it("search filters by session title and project name, also inside collapsed groups", async () => {
  const { toggle, rows, search, el } = await render();
  await act(async () => toggle("/home/u/api").click());
  await search("refac");
  expect(rows().map((r) => r.textContent?.slice(0, 8))).toEqual(["Refactor"]);
  await search("web");
  expect(rows()).toHaveLength(2);
  await search("nothing");
  expect(rows()).toHaveLength(0);
  expect(el.textContent).toContain('No session title, project or branch matches "nothing"');
  await search("");
  expect(rows()).toHaveLength(2);
});

it("a known project with no sessions still has a group; its New session and Remove act on that project", async () => {
  const { el, groups, onNew, onRemove, onOpenProject } = await render({ projects: ["/home/u/empty", "/home/u/web", "/home/u/api"] });
  expect(groups().map((g) => g.dataset.cwd)).toEqual(["/home/u/empty", "/home/u/web", "/home/u/api"]);
  expect(groups()[0]!.textContent).toContain("No sessions yet");
  const action = (cwd: string, id: string) => el.querySelector<HTMLElement>(`[data-cwd="${cwd}"] [data-testid="${id}"]`)!;
  expect(action("/home/u/empty", "project-new-session").getAttribute("aria-label")).toBe("New session in empty");
  await act(async () => action("/home/u/empty", "project-new-session").click());
  expect(onNew).toHaveBeenCalledWith("/home/u/empty");
  await act(async () => action("/home/u/api", "project-remove").click());
  expect(onRemove).toHaveBeenCalledWith("/home/u/api");
  // The action does not toggle the group.
  expect(el.querySelector('[data-cwd="/home/u/api"] [data-testid="group-toggle"]')!.getAttribute("aria-expanded")).toBe("true");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="open-project"]')!.click());
  expect(onOpenProject).toHaveBeenCalled();
});

it("with no projects it offers Open project", async () => {
  const { el, onOpenProject } = await render({ projects: [] });
  expect(el.textContent).toContain("No projects yet");
  // The empty state has its own action next to the header icon.
  await act(async () => el.querySelector<HTMLElement>('[data-testid="empty-open-project"]')!.click());
  expect(onOpenProject).toHaveBeenCalled();
});

it("project actions and Open project are visible and 44px on touch screens of any width (no hover there)", async () => {
  const { el } = await render();
  // jsdom has no media queries: the classes are the contract (same convention as quick-open, toolbar).
  const actions = el.querySelector<HTMLElement>('[data-cwd="/home/u/web"] [data-testid="project-new-session"]')!.parentElement!;
  expect(actions.className).toContain("pointer-coarse:opacity-100");
  for (const id of ["project-new-session", "project-remove", "open-project"])
    expect(el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.className).toContain("pointer-coarse:size-11");
});

it("archived sessions are hidden; the archived filter shows only them and offers Unarchive", async () => {
  const { el, rows, onAction } = await render({ list: [...LIST, { ...LIST[2]!, id: "z", title: "Shelved", archived: true }] });
  expect(rows().map((r) => r.textContent)).not.toContainEqual(expect.stringContaining("Shelved"));
  const filter = el.querySelector<HTMLElement>('[data-testid="archived-filter"]')!;
  await act(async () => filter.click());
  expect(filter.getAttribute("aria-pressed")).toBe("true");
  expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual(["Shelved"]);
  await act(async () => el.querySelector<HTMLElement>('[data-testid="session-menu"]')!.click());
  const archive = document.querySelector<HTMLElement>('[data-testid="action-archive"]')!;
  expect(archive.textContent).toBe("Unarchive");
  await act(async () => archive.click());
  expect(onAction).toHaveBeenLastCalledWith("z", "unarchive");
});

it("each row has an actions menu: Rename, Archive, Delete; Delete is disabled while the session runs or needs input", async () => {
  const { el, onAction } = await render();
  const menuOf = (title: string) => el.querySelector<HTMLElement>(`[data-testid="session-menu"][aria-label="Actions for ${title}"]`)!;
  await act(async () => menuOf("Old idea").click());
  expect(document.querySelector('[role="menu"]')!.textContent).toBe("RenameArchiveDelete…");
  await act(async () => document.querySelector<HTMLElement>('[data-testid="action-delete"]')!.click());
  expect(onAction).toHaveBeenLastCalledWith("c", "delete");
  for (const title of ["Fix login", "Docs pass"]) {
    await act(async () => menuOf(title).click());
    const del = [...document.querySelectorAll<HTMLElement>('[data-testid="action-delete"]')].at(-1)!;
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.textContent).toBe("Delete… (stop it first)");
    await act(async () => del.click());
    expect(onAction).not.toHaveBeenCalledWith(expect.anything(), "delete", expect.anything());
    expect(onAction).toHaveBeenCalledTimes(1);
  }
});

it("the renaming row edits the title in place: Enter saves the trimmed title, Escape cancels", async () => {
  const { el, onRenamed } = await render({ renaming: "c" });
  const input = el.querySelector<HTMLInputElement>('[data-testid="rename-input"]')!;
  expect(input.value).toBe("Old idea");
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onRenamed).toHaveBeenLastCalledWith("c", undefined);
});

it("below md the search box and the archived filter are 8px apart (touch-spacing)", async () => {
  const { el } = await render();
  expect(el.querySelector('[data-testid="archived-filter"]')!.parentElement!.className).toMatch(/\bmax-md:gap-2\b/);
});

it("a session with no transcript yet (never prompted) offers no Rename or Archive: the SDK has nothing to write to", async () => {
  const { el, onAction } = await render({ list: [...LIST, { ...LIST[2]!, id: "n", title: "New session", transcript: false }] });
  await act(async () => el.querySelector<HTMLElement>('[data-testid="session-menu"][aria-label="Actions for New session"]')!.click());
  for (const id of ["action-rename", "action-archive"]) {
    const item = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await act(async () => item.click());
  }
  expect(onAction).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="action-delete"]')!.getAttribute("aria-disabled")).toBeNull();
});

it("rows, the … trigger, the archived filter and the menu items show the pointer cursor; a disabled item shows not-allowed", async () => {
  const { el, rows } = await render();
  const pointer = (e: Element) => expect(e.className).toMatch(/(^|\s)cursor-pointer(\s|$)/);
  pointer(rows()[0]!);
  pointer(el.querySelector('[data-testid="archived-filter"]')!);
  const trigger = el.querySelector<HTMLElement>('[data-testid="session-menu"][aria-label="Actions for Fix login"]')!;
  pointer(trigger);
  await act(async () => trigger.click());
  for (const id of ["action-rename", "action-archive", "action-delete"]) {
    const item = document.querySelector(`[data-testid="${id}"]`)!;
    pointer(item);
    expect(item.className).not.toMatch(/\bcursor-default\b/);
  }
  // Delete is disabled: Fix login is running.
  expect(document.querySelector('[data-testid="action-delete"]')!.className).toMatch(/\bdata-disabled:cursor-not-allowed\b/);
});

it("the archived filter shows an \"Archived sessions\" caption above the list, so the mode is visible", async () => {
  const { el } = await render({ list: [...LIST, { ...LIST[2]!, id: "z", title: "Shelved", archived: true }] });
  expect(el.querySelector('[data-testid="archived-caption"]')).toBeNull();
  await act(async () => el.querySelector<HTMLElement>('[data-testid="archived-filter"]')!.click());
  expect(el.querySelector('[data-testid="archived-caption"]')!.textContent).toBe("Archived sessions");
});

it("each project splits its sessions under OpenCode's day headers", async () => {
  const { groups } = await render({ list: [item("a", "/home/u/web", "New", 0), item("b", "/home/u/web", "Old", 4 * 1440), item("c", "/home/u/api", "Older", 5 * 1440)] });
  const days = (g: HTMLElement) => [...g.querySelectorAll('[data-testid="day-header"]')].map((h) => h.textContent);
  expect(groups().map(days)).toEqual([["Today", "Older"], ["Recent sessions"]]);
});

it("read titles use the base text colour like OpenCode, not the muted one", async () => {
  const { rows } = await render();
  const title = rows()[3]!.querySelector("span")!;
  expect(title.className).toContain("text-foreground");
  expect(rows()[3]!.className).not.toContain("text-muted-foreground");
});

it("a tab switch re-renders only the rows that lose or get the active mark, not every row (GH-51)", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onOpen = vi.fn();
  // App passes new closures on every render.
  const show = (activeId: string) =>
    act(async () =>
      root!.render(
        <SessionList
          list={LIST}
          projects={["/home/u/web", "/home/u/api"]}
          state={(s) => s.state}
          unread={new Set()}
          activeId={activeId}
          onOpen={(id) => onOpen(id)}
          onNew={() => {}}
          onRemove={() => {}}
          onOpenProject={() => {}}
          onAction={() => {}}
          onRenamed={() => {}}
        />,
      ),
    );
  await show("a");
  rowRenders.length = 0;
  await show("b");
  expect(rowRenders.sort()).toEqual(["Docs pass", "Fix login"]);
  // A row that did not re-render opens with the latest handler.
  await act(async () => [...el.querySelectorAll<HTMLElement>("[data-testid=session-item]")].find((b) => b.textContent?.includes("Old idea"))!.click());
  expect(onOpen).toHaveBeenCalledWith("c");
});

it("relative times move on every minute without a list refresh; only rows whose label changed re-render", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now });
  try {
    const { rows } = await render();
    const ago = () => rows().map((r) => r.lastElementChild!.textContent);
    expect(ago()).toEqual(["1m", "2h", "5m", "2d"]);
    rowRenders.length = 0;
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(ago()).toEqual(["2m", "2h", "6m", "2d"]);
    expect(rowRenders.sort()).toEqual(["Docs pass", "Fix login"]);
  } finally {
    vi.useRealTimers();
  }
});

describe("worktrees", () => {
  const wts: Worktree[] = [
    { path: "/home/u/web", branch: "main", main: true },
    { path: "/home/u/orca/web/fix", branch: "fix-login", main: false },
    { path: "/srv/web-far", branch: "far", main: false, outsideRoots: true },
  ];
  const list = [item("a", "/home/u/web", "Fix login", 1), item("w", "/home/u/orca/web/fix", "Worktree job", 2)];
  // The linked worktree is also added as a project: still one group.
  const props = { list, projects: ["/home/u/orca/web/fix", "/home/u/web"], worktrees: { "/home/u/web": wts, "/home/u/orca/web/fix": wts } };
  const worktreeRows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="worktree-row"]')];
  const rowToggle = (el: HTMLElement, path: string) => el.querySelector<HTMLElement>(`[data-path="${path}"] [data-testid="worktree-toggle"]`)!;
  const titles = (row: HTMLElement) => [...row.querySelectorAll('[data-testid="session-item"]')].map((r) => r.getAttribute("title"));

  it("nest under one group per repository: local row first, then worktree rows by branch, each with its sessions, path as tooltip", async () => {
    const { el, groups } = await render(props);
    expect(groups().map((g) => g.dataset.cwd)).toEqual(["/home/u/web"]);
    const rows = worktreeRows(el);
    expect(rows.map((r) => r.querySelector('[data-testid="worktree-toggle"]')!.textContent)).toEqual(["local : main", "worktree : far(outside the allowed roots)", "worktree : fix-login"]);
    expect(rows.map(titles)).toEqual([["Fix login"], [], ["Worktree job"]]);
    expect(rowToggle(el, "/home/u/orca/web/fix").title).toBe("/home/u/orca/web/fix");
    expect(rows[1]!.textContent).toContain("No sessions yet");
  });

  it("Classic layout (GH-222): one merged newest-first list per project, no worktree rows, branch suffix and state text on every row", async () => {
    localStorage.setItem("claude-ui.sidebarView", JSON.stringify({ layout: "classic" }));
    const l = [item("a", "/home/u/web", "Fix login", 10, "idle"), item("w", "/home/u/orca/web/fix", "Worktree job", 2, "running"), item("n", "/home/u/web", "Newest", 1, "needs_input")];
    const { el, rows } = await render({ ...props, list: l });
    expect(worktreeRows(el)).toEqual([]);
    expect(rows().map((r) => r.dataset.sessionId)).toEqual(["n", "w", "a"]);
    expect(rows().map((r) => r.querySelector('[data-testid="session-state"]')!.textContent)).toEqual(["needs input", "running", "idle"]);
    expect(rows().map((r) => r.querySelector('[data-testid="session-branch"]')?.textContent)).toEqual([undefined, "fix-login", undefined]);
    expect(rows()[1]!.getAttribute("aria-label")).toBe("Worktree job, running, branch fix-login");
    expect(rows()[1]!.querySelector("svg.animate-spin")).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="day-header"]').length).toBe(1);
  });

  it("Classic layout keeps only-active and search; Default shows no state text; a stored view without layout is Default", async () => {
    localStorage.setItem("claude-ui.sidebarView", JSON.stringify({ onlyActive: true, layout: "classic" }));
    const l = [item("a", "/home/u/web", "Fix login", 10, "idle"), item("w", "/home/u/orca/web/fix", "Worktree job", 2, "running")];
    const c = await render({ ...props, list: l, activeId: null });
    expect(c.rows().map((r) => r.dataset.sessionId)).toEqual(["w"]);
    root!.unmount();
    localStorage.setItem("claude-ui.sidebarView", JSON.stringify({ onlyActive: false }));
    const d = await render({ ...props, list: l });
    expect(d.el.querySelector('[data-testid="session-state"]')).toBeNull();
    expect(worktreeRows(d.el).length).toBe(3);
  });

  it("a row collapses and stays collapsed after a reload, apart from its project group", async () => {
    let r = await render(props);
    await act(async () => rowToggle(r.el, "/home/u/web").click());
    expect(rowToggle(r.el, "/home/u/web").getAttribute("aria-expanded")).toBe("false");
    expect(r.toggle("/home/u/web").getAttribute("aria-expanded")).toBe("true");
    expect(r.rows().map((x) => x.getAttribute("title"))).toEqual(["Worktree job"]);
    root!.unmount();
    r = await render(props);
    expect(rowToggle(r.el, "/home/u/web").getAttribute("aria-expanded")).toBe("false");
    expect(r.rows()).toHaveLength(1);
  });

  it("search matches a branch", async () => {
    const { el, search, rows } = await render(props);
    await search("FIX-LOG");
    expect(worktreeRows(el).map((r) => r.dataset.path)).toEqual(["/home/u/orca/web/fix"]);
    expect(rows().map((x) => x.getAttribute("title"))).toEqual(["Worktree job"]);
  });

  it("a row's New session starts in that worktree; a row outside the roots has none and says why", async () => {
    const { el, onNew } = await render(props);
    const action = (path: string) => el.querySelector<HTMLElement>(`[data-path="${path}"] [data-testid="worktree-new-session"]`);
    expect(action("/home/u/orca/web/fix")!.getAttribute("aria-label")).toBe("New session in worktree : fix-login");
    await act(async () => action("/home/u/orca/web/fix")!.click());
    expect(onNew).toHaveBeenCalledWith("/home/u/orca/web/fix");
    expect(action("/srv/web-far")).toBeNull();
    expect(rowToggle(el, "/srv/web-far").title).toBe("/srv/web-far: Outside the allowed roots (--roots)");
    expect(el.querySelector('[data-path="/srv/web-far"] [data-testid="worktree-outside"]')).not.toBeNull();
    expect(rowToggle(el, "/srv/web-far").textContent).toBe("worktree : far(outside the allowed roots)");
    expect(el.querySelector('[data-path="/home/u/orca/web/fix"] [data-testid="worktree-outside"]')).toBeNull();
  });

  it("a git project has New worktree: click creates with a generated name, Shift+click asks for a name; a non-git project has none", async () => {
    const { el, onNewWorktree } = await render(props);
    const btn = () => el.querySelector<HTMLElement>('[data-testid="session-group"][data-cwd="/home/u/web"] [data-testid="project-new-worktree"]')!;
    expect(btn().getAttribute("aria-label")).toBe("New worktree in web (Shift+click to name it)");
    await act(async () => btn().click());
    expect(onNewWorktree).toHaveBeenLastCalledWith("/home/u/web", false);
    await act(async () => void btn().dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(onNewWorktree).toHaveBeenLastCalledWith("/home/u/web", true);
    const plain = await render({ worktrees: {} });
    expect(plain.el.querySelector('[data-testid="project-new-worktree"]')).toBeNull();
  });

  it("Remove shows only on worktrees under <repo>/.claude/worktrees: not on the local row, hand-made, nested or outside-roots ones", async () => {
    const managed = "/home/u/web/.claude/worktrees/fix";
    const all: Worktree[] = [
      ...wts,
      { path: managed, branch: "worktree-fix", main: false },
      { path: "/home/u/web/.claude/worktrees/a/b", branch: "nested", main: false },
      { path: "/home/u/web/.claude/other", branch: "other", main: false },
      { path: "/home/u/web/.claude/worktrees-x/y", branch: "lookalike", main: false },
    ];
    const { el, onRemoveWorktree } = await render({ list, projects: ["/home/u/web"], worktrees: { "/home/u/web": all } });
    const remove = (path: string) => el.querySelector<HTMLElement>(`[data-path="${path}"] [data-testid="worktree-remove"]`);
    expect(remove(managed)!.getAttribute("aria-label")).toBe("Remove worktree : worktree-fix");
    for (const p of ["/home/u/web", "/home/u/orca/web/fix", "/srv/web-far", "/home/u/web/.claude/worktrees/a/b", "/home/u/web/.claude/other", "/home/u/web/.claude/worktrees-x/y"]) expect(remove(p), p).toBeNull();
    await act(async () => remove(managed)!.click());
    expect(onRemoveWorktree).toHaveBeenCalledWith("/home/u/web", managed);
  });

  it("a repository without linked worktrees stays flat", async () => {
    const { el, rows } = await render({ worktrees: { "/home/u/web": [wts[0]!] } });
    expect(worktreeRows(el)).toEqual([]);
    expect(rows()).toHaveLength(4);
  });
});

describe("session limit", () => {
  const many = (n: number, cwd = "/home/u/web") => Array.from({ length: n }, (_, i) => item(`s${i}`, cwd, `Job ${i}`, i + 10));
  const more = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('[data-testid="load-more"]')];
  const only = { projects: ["/home/u/web"] };

  it("12 sessions: 5 rows and Load more; one click shows all 12 and the button is gone, focus on the first new row", async () => {
    const { el, rows } = await render({ ...only, list: many(12) });
    expect(rows()).toHaveLength(5);
    expect(more(el)).toHaveLength(1);
    expect(more(el)[0]!.tagName).toBe("BUTTON");
    await act(async () => more(el)[0]!.click());
    expect(rows()).toHaveLength(12);
    expect(more(el)).toHaveLength(0);
    expect(document.activeElement).toBe(rows()[5]);
  });

  it("Load more adds 10: 30 sessions show 15, then 25, then 30", async () => {
    const { el, rows } = await render({ ...only, list: many(30) });
    for (const n of [15, 25, 30]) {
      await act(async () => more(el)[0]!.click());
      expect(rows()).toHaveLength(n);
    }
    expect(more(el)).toHaveLength(0);
  });

  it("the active, running and needs-input sessions older than the limit still show", async () => {
    const list = [...many(8), item("a", "/home/u/web", "Active old", 900), item("r", "/home/u/web", "Running old", 901, "running"), item("n", "/home/u/web", "Input old", 902, "needs_input")];
    const { el, rows } = await render({ ...only, list });
    expect(rows().map((r) => r.title)).toEqual(["Job 0", "Job 1", "Job 2", "Job 3", "Job 4", "Active old", "Running old (running)", "Input old (needs input)"]);
    expect(more(el)).toHaveLength(1);
  });

  it("search shows every match without a button", async () => {
    const { el, rows, search } = await render({ ...only, list: many(12) });
    await search("job");
    expect(rows()).toHaveLength(12);
    expect(more(el)).toHaveLength(0);
  });

  it("the limit is per project and per worktree row", async () => {
    const wts: Worktree[] = [
      { path: "/home/u/web", branch: "main", main: true },
      { path: "/home/u/orca/web/fix", branch: "fix", main: false },
    ];
    const list = [...many(7), ...many(7, "/home/u/orca/web/fix").map((s) => ({ ...s, id: `w${s.id}` })), ...many(7, "/home/u/api").map((s) => ({ ...s, id: `x${s.id}` }))];
    const { el, rows } = await render({ list, projects: ["/home/u/web", "/home/u/api"], worktrees: { "/home/u/web": wts } });
    expect(rows()).toHaveLength(15);
    expect(more(el).map((b) => b.getAttribute("aria-label"))).toEqual(["Load more sessions in local : main", "Load more sessions in worktree : fix", "Load more sessions in api"]);
    await act(async () => more(el)[0]!.click());
    expect(rows()).toHaveLength(17);
    expect(more(el)).toHaveLength(2);
  });

  it("the archived view uses the same limit and expands apart from the normal view", async () => {
    const list = [...many(8), ...many(8).map((s) => ({ ...s, id: `z${s.id}`, archived: true }))];
    const { el, rows } = await render({ ...only, list });
    const toggle = async () => {
      el.querySelector<HTMLElement>('[data-testid="archived-filter"]')!.click();
      await act(async () => {});
    };
    await toggle();
    expect(rows()).toHaveLength(5);
    await act(async () => more(el)[0]!.click());
    expect(rows()).toHaveLength(8);
    await toggle();
    expect(rows()).toHaveLength(5);
  });
});

describe("workers", () => {
  const coord = { ...item("c", "/home/u/web", "Coordinate", 1), coordinator: true as const };
  const wk = (id: string, name: string, cwd: string, st: SessionState, min = 2): SessionListItem => ({ ...item(id, cwd, `${name} title`, min, st), coordinatorId: "c", workerName: name });
  const base = { list: [coord, wk("w1", "w1", "/home/u/api", "running"), wk("w2", "w2", "/home/u/api", "idle")] };
  const workerRows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[data-worker]")];
  const gtoggle = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="worker-group-toggle"]')!;

  it("workers show under their coordinator, not in their own project group; each row shows name, place and state as text", async () => {
    const { el, groups } = await render(base);
    const [web, api] = groups();
    expect(web!.querySelectorAll("[data-worker]")).toHaveLength(2);
    expect(api!.querySelectorAll("[data-worker]")).toHaveLength(0);
    expect(gtoggle(el).textContent).toContain("2 workers");
    expect(gtoggle(el).getAttribute("aria-label")).toBe("2 workers of Coordinate");
    const rows = workerRows(el);
    expect(rows.map((r) => r.textContent)).toEqual(["w1api · running", "w2api · idle"].map((t) => expect.stringContaining(t)));
    expect(rows[0]!.getAttribute("aria-label")).toBe("w1, worker, running, api");
  });

  it("the workers row collapses and stays collapsed after a reload; a worker needing input shows on the collapsed row as text", async () => {
    const list = [coord, wk("w1", "w1", "/home/u/api", "needs_input")];
    let r = await render({ list });
    await act(async () => gtoggle(r.el).click());
    expect(gtoggle(r.el).getAttribute("aria-expanded")).toBe("false");
    expect(workerRows(r.el)).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("claude-ui.collapsed")!)).toContain("coordinator:c");
    expect(gtoggle(r.el).dataset.needsInput).toBe("true");
    expect(gtoggle(r.el).textContent).toContain("needs input");
    root!.unmount();
    r = await render({ list });
    expect(gtoggle(r.el).getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking a worker row opens its session; worker rows and the workers toggle are 44px below md", async () => {
    const { el, onOpen } = await render(base);
    const row = workerRows(el)[0]!;
    expect(row.tagName).toBe("BUTTON");
    await act(async () => row.click());
    expect(onOpen).toHaveBeenCalledWith("w1");
    expect(row.className).toContain("max-md:h-11");
    expect(gtoggle(el).className).toContain("max-md:h-11");
  });

  it("a coordinator older than the limit stays shown while a worker runs or needs input", async () => {
    const many = Array.from({ length: 12 }, (_, i) => item(`m${i}`, "/home/u/web", `Job ${i}`, i + 1));
    const { rows } = await render({ list: [...many, { ...coord, lastActivity: now - 9000 * 60_000 }, wk("w1", "w1", "/home/u/api", "running")], projects: ["/home/u/web", "/home/u/api"] });
    expect(rows().map((r) => r.title)).toContain("Coordinate");
  });

  it("a coordinator in a worktree row nests its workers one level deeper", async () => {
    const wts: Worktree[] = [
      { path: "/home/u/web", branch: "main", main: true },
      { path: "/home/u/orca/web/fix", branch: "fix", main: false },
    ];
    const { el } = await render({ list: [{ ...coord, cwd: "/home/u/orca/web/fix" }, wk("w1", "w1", "/home/u/api", "idle")], projects: ["/home/u/web", "/home/u/api"], worktrees: { "/home/u/web": wts } });
    expect(el.querySelector("[data-worker]")!.className).toContain("pl-17");
    expect(el.querySelector<HTMLElement>('[data-session-id="c"]')!.className).toContain("pl-12");
  });
});

describe("project row below md (GH-132): name, chevron and New session inline; the rest in a ... menu", () => {
  const wts: Worktree[] = [{ path: "/home/u/web", branch: "main", main: true }];
  const mm = window.matchMedia;
  afterEach(() => {
    window.matchMedia = mm;
  });
  const narrow = (on: boolean) => {
    window.matchMedia = ((q: string) => ({ matches: on && q.includes("48rem"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  };
  const group = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="session-group"][data-cwd="/home/u/web"]')!;

  it("narrow: only New session stays inline, New worktree and Remove move into the menu and still work", async () => {
    narrow(true);
    const { el, onNew, onNewWorktree, onRemove } = await render({ worktrees: { "/home/u/web": wts } });
    const g = group(el);
    expect(g.querySelector('[data-testid="project-new-session"]')).not.toBeNull();
    expect(g.querySelector('[data-testid="project-new-worktree"]')).toBeNull();
    expect(g.querySelector('[data-testid="project-remove"]')).toBeNull();
    await act(async () => g.querySelector<HTMLElement>('[data-testid="project-new-session"]')!.click());
    expect(onNew).toHaveBeenCalledWith("/home/u/web");
    const trigger = g.querySelector<HTMLElement>('[data-testid="project-menu"]')!;
    expect(trigger.getAttribute("aria-label")).toBe("Actions for web");
    expect(trigger.className).toContain("max-md:size-11");
    await act(async () => trigger.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="project-menu-new-worktree"]')!.click());
    expect(onNewWorktree).toHaveBeenCalledWith("/home/u/web", false);
    await act(async () => g.querySelector<HTMLElement>('[data-testid="project-menu"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="project-menu-new-worktree-named"]')!.click());
    expect(onNewWorktree).toHaveBeenLastCalledWith("/home/u/web", true);
    await act(async () => g.querySelector<HTMLElement>('[data-testid="project-menu"]')!.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="project-menu-remove"]')!.click());
    expect(onRemove).toHaveBeenCalledWith("/home/u/web");
  });

  it("narrow: the name keeps room and a project without a git main has only Remove in the menu", async () => {
    narrow(true);
    const { el } = await render({ worktrees: {} });
    const g = group(el);
    expect(g.querySelector<HTMLElement>('[data-testid="group-toggle"]')!.className).toContain("max-md:pr-26");
    await act(async () => g.querySelector<HTMLElement>('[data-testid="project-menu"]')!.click());
    expect(document.querySelector('[data-testid="project-menu-new-worktree"]')).toBeNull();
    expect(document.querySelector('[data-testid="project-menu-remove"]')).not.toBeNull();
  });

  it("narrow: a removable worktree row keeps New session inline and Delete worktree moves into its menu; the others have no menu", async () => {
    narrow(true);
    const managed = "/home/u/web/.claude/worktrees/fix";
    const all: Worktree[] = [...wts, { path: managed, branch: "team/GH-1-fix", main: false }];
    const { el, onNew, onRemoveWorktree } = await render({ worktrees: { "/home/u/web": all } });
    const row = (p: string) => el.querySelector<HTMLElement>(`[data-path="${p}"]`)!;
    expect(row(managed).querySelector('[data-testid="worktree-remove"]')).toBeNull();
    // Only the part after the last "/" is visible; the full branch is the accessible name and the tooltip.
    const toggle = row(managed).querySelector<HTMLElement>('[data-testid="worktree-toggle"]')!;
    expect(toggle.textContent).toBe("GH-1-fix");
    expect(toggle.getAttribute("aria-label")).toBe("worktree : team/GH-1-fix");
    expect(toggle.title).toContain("team/GH-1-fix");
    await act(async () => row(managed).querySelector<HTMLElement>('[data-testid="worktree-new-session"]')!.click());
    expect(onNew).toHaveBeenCalledWith(managed);
    expect(row("/home/u/web").querySelector('[data-testid="worktree-menu"]')).toBeNull();
    const trigger = row(managed).querySelector<HTMLElement>('[data-testid="worktree-menu"]')!;
    expect(trigger.className).toContain("max-md:size-11");
    await act(async () => trigger.click());
    await act(async () => document.querySelector<HTMLElement>('[data-testid="worktree-menu-remove"]')!.click());
    expect(onRemoveWorktree).toHaveBeenCalledWith("/home/u/web", managed);
  });

  it("the side badge stays below md and the side is part of the project's accessible name", async () => {
    narrow(true);
    const { el } = await render({ side: (cwd) => (cwd === "/home/u/web" ? { label: "WSL: Ubuntu", short: "WSL" } : undefined) });
    const g = group(el);
    expect(g.querySelector('[data-testid="side-badge"]')!.textContent).toBe("WSL");
    expect(g.querySelector('[data-testid="group-toggle"]')!.getAttribute("aria-label")).toBe("web (WSL: Ubuntu)");
    expect(el.querySelector('[data-cwd="/home/u/api"] [data-testid="group-toggle"]')!.getAttribute("aria-label")).toBeNull();
  });

  it("worktree rows whose branch tails collide keep the full branch; the others show the tail", async () => {
    narrow(true);
    const all: Worktree[] = [
      ...wts,
      { path: "/home/u/web/.claude/worktrees/a", branch: "alice/fix", main: false },
      { path: "/home/u/web/.claude/worktrees/b", branch: "bob/fix", main: false },
      { path: "/home/u/web/.claude/worktrees/c", branch: "bob/other", main: false },
    ];
    const { el } = await render({ worktrees: { "/home/u/web": all } });
    const text = (p: string) => el.querySelector(`[data-path="${p}"] [data-testid="worktree-toggle"]`)!.textContent;
    expect(text("/home/u/web/.claude/worktrees/a")).toBe("alice/fix");
    expect(text("/home/u/web/.claude/worktrees/b")).toBe("bob/fix");
    expect(text("/home/u/web/.claude/worktrees/c")).toBe("other");
  });

  it("branch tails also split Windows paths (a detached row is named by its folder) and collisions ignore the search filter", async () => {
    narrow(true);
    const all: Worktree[] = [
      ...wts,
      { path: "C:\\repo\\.claude\\worktrees\\fix", main: false },
      { path: "/home/u/web/.claude/worktrees/b", branch: "bob/fix", main: false },
      { path: "/home/u/web/.claude/worktrees/c", branch: "alice/fix2", main: false },
    ];
    const { el, search } = await render({ worktrees: { "/home/u/web": all } });
    const text = (p: string) => el.querySelector(`[data-path="${p.replaceAll("\\", "\\\\")}"] [data-testid="worktree-toggle"]`)?.textContent;
    // "fix" (folder of the Windows path) and bob/fix share a tail: both keep the full name.
    expect(text("C:\\repo\\.claude\\worktrees\\fix")).toBe("fix");
    expect(text("/home/u/web/.claude/worktrees/b")).toBe("bob/fix");
    expect(text("/home/u/web/.claude/worktrees/c")).toBe("fix2");
    // Searching leaves only bob/fix on screen; its label does not change.
    await search("bob");
    expect(text("/home/u/web/.claude/worktrees/b")).toBe("bob/fix");
  });

  it("the row switches layout when the viewport crosses md", async () => {
    let on = true;
    const listeners = new Set<() => void>();
    window.matchMedia = (() => ({ get matches() { return on; }, media: "", addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) })) as never;
    const { el } = await render({ worktrees: { "/home/u/web": wts } });
    const g = group(el);
    expect(g.querySelector('[data-testid="project-menu"]')).not.toBeNull();
    expect(g.querySelector('[data-testid="project-remove"]')).toBeNull();
    on = false;
    await act(async () => listeners.forEach((f) => f()));
    expect(g.querySelector('[data-testid="project-menu"]')).toBeNull();
    expect(g.querySelector('[data-testid="project-remove"]')).not.toBeNull();
    on = true;
    await act(async () => listeners.forEach((f) => f()));
    expect(g.querySelector('[data-testid="project-menu"]')).not.toBeNull();
  });

  it("wide: unchanged, three inline buttons and no menu", async () => {
    narrow(false);
    const { el } = await render({ worktrees: { "/home/u/web": wts } });
    const g = group(el);
    for (const id of ["project-new-worktree", "project-new-session", "project-remove"]) expect(g.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    expect(g.querySelector('[data-testid="project-menu"]')).toBeNull();
  });
});

it("a search request (/resume) fills the box, focuses it with the caret at the end and filters by @project=; a new seq refocuses (GH-100)", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const show = (search: { text: string; seq: number }) =>
    act(async () =>
      root!.render(
        <SessionList list={LIST} projects={["/home/u/web", "/home/u/api"]} state={(s) => s.state} unread={new Set()} onOpen={() => {}} onNew={() => {}} onRemove={() => {}} onOpenProject={() => {}} onAction={() => {}} onRenamed={() => {}} search={search} />,
      ),
    );
  const input = () => el.querySelector<HTMLInputElement>('[data-testid="session-search"]')!;
  const groups = () => [...el.querySelectorAll<HTMLElement>('[data-testid="session-group"]')].map((g) => g.dataset.cwd);
  await show({ text: "@project=web ", seq: 1 });
  expect(input().value).toBe("@project=web ");
  expect(document.activeElement).toBe(input());
  expect(input().selectionStart).toBe(13);
  expect(groups()).toEqual(["/home/u/web"]);
  input().blur();
  await show({ text: "@project=web ", seq: 1 });
  expect(document.activeElement).not.toBe(input());
  await show({ text: "@project=api refactor", seq: 2 });
  expect(document.activeElement).toBe(input());
  expect(input().value).toBe("@project=api refactor");
  expect(el.querySelectorAll('[data-testid="session-item"]')).toHaveLength(1);
  await show({ text: "@project=api zzz", seq: 3 });
  expect(el.textContent).toContain('No session in api matches "zzz".');
  await show({ text: "@project=nope ", seq: 4 });
  expect(el.textContent).toContain('No project named "nope".');
});

describe("sidebar header actions (GH-152)", () => {
  const WT = "/home/u/web/.claude/worktrees/fix";
  const wts: Worktree[] = [
    { path: "/home/u/web", branch: "main", main: true },
    { path: WT, branch: "fix", main: false },
  ];
  const list = [
    item("a", "/home/u/web", "Fix login", 1, "idle"),
    item("w", WT, "In worktree", 2),
    { ...item("co", "/home/u/api", "Coordinator", 3), },
    { ...item("wk", "/home/u/api", "Worker title", 4), coordinatorId: "co", workerName: "alpha" },
    item("d", "/home/u/api", "Refactor", 3000, "idle"),
  ];
  const base = { list, worktrees: { "/home/u/web": wts } };
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  const expanded = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].map((e) => e.getAttribute("aria-expanded"));
  const scroll = vi.fn();
  // Earlier tests leave their (unmounted) containers in the body; `q` looks at the whole document.
  beforeEach(() => document.body.replaceChildren());
  const mm = window.matchMedia;
  afterEach(() => {
    window.matchMedia = mm;
    scroll.mockClear();
  });
  Element.prototype.scrollIntoView = scroll;

  it("Collapse all collapses every project, worktree row and worker group and stores the keys; Expand all opens them and clears the storage", async () => {
    await render(base);
    await act(async () => q("sidebar-collapse-all").click());
    expect(expanded('[data-testid="group-toggle"]')).toEqual(["false", "false"]);
    expect(JSON.parse(localStorage.getItem("claude-ui.collapsed")!)).toEqual(["/home/u/web", "worktree:/home/u/web", `worktree:${WT}`, "/home/u/api", "coordinator:co"]);
    await act(async () => q("sidebar-expand-all").click());
    expect(expanded('[data-testid="group-toggle"]')).toEqual(["true", "true"]);
    expect(expanded('[data-testid="worktree-toggle"]')).toEqual(["true", "true"]);
    expect(expanded('[data-testid="worker-group-toggle"]')).toEqual(["true"]);
    expect(JSON.parse(localStorage.getItem("claude-ui.collapsed")!)).toEqual([]);
  });

  it("Expand all and Collapse all are disabled while the search has text", async () => {
    const { search } = await render(base);
    await search("fix");
    expect(q("sidebar-collapse-all").getAttribute("aria-disabled")).toBe("true");
    await act(async () => q("sidebar-collapse-all").click());
    expect(localStorage.getItem("claude-ui.collapsed")).toBeNull();
    await search("");
    expect(q("sidebar-collapse-all").getAttribute("aria-disabled")).toBeNull();
  });

  it("Select active session opens the collapsed project and worktree row, scrolls to the row and focuses it", async () => {
    const { toggle } = await render({ ...base, activeId: "w" });
    await act(async () => q("sidebar-collapse-all").click());
    expect(document.querySelector('[data-session-id="w"]')).toBeNull();
    await act(async () => q("sidebar-select-active").click());
    const row = document.querySelector<HTMLElement>('[data-session-id="w"]')!;
    expect(row).not.toBeNull();
    expect(toggle("/home/u/web").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(row);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("Select active session opens a worker's group too", async () => {
    await render({ ...base, activeId: "wk" });
    await act(async () => q("sidebar-collapse-all").click());
    await act(async () => q("sidebar-select-active").click());
    expect(document.activeElement).toBe(document.querySelector('[data-session-id="wk"]'));
  });

  it("is disabled without an active session and does nothing", async () => {
    await render({ ...base, activeId: null });
    expect(q("sidebar-select-active").getAttribute("aria-disabled")).toBe("true");
    await act(async () => q("sidebar-select-active").click());
    expect(scroll).not.toHaveBeenCalled();
  });

  it("clears a search that hides the active session and leaves the archived view for the session's own", async () => {
    const { search, el } = await render({ ...base, activeId: "d", list: [...list.slice(0, 4), { ...list[4]!, archived: true }] });
    await search("Fix");
    await act(async () => q("sidebar-select-active").click());
    expect(el.querySelector<HTMLInputElement>('[data-testid="session-search"]')!.value).toBe("");
    expect(q("archived-filter").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(document.querySelector('[data-session-id="d"]'));
  });

  const open = async () => {
    await act(async () => q("sidebar-options").click());
    return (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  };

  it("options menu: checkbox and radio roles; Archived mirrors the Archive button", async () => {
    await render(base);
    const m = await open();
    expect(m("sidebar-opt-archived").getAttribute("role")).toBe("menuitemcheckbox");
    expect(m("sidebar-opt-sort-name").getAttribute("role")).toBe("menuitemradio");
    expect(m("sidebar-opt-sort-recent").getAttribute("aria-checked")).toBe("true");
    await act(async () => m("sidebar-opt-archived").click());
    expect(q("archived-filter").getAttribute("aria-pressed")).toBe("true");
  });

  it("Day headers off hides the headers; the choice survives a re-render", async () => {
    let r = await render(base);
    expect(r.el.querySelectorAll('[data-testid="day-header"]').length).toBeGreaterThan(0);
    const m = await open();
    await act(async () => m("sidebar-opt-day-headers").click());
    expect(r.el.querySelectorAll('[data-testid="day-header"]')).toHaveLength(0);
    root!.unmount();
    r = await render(base);
    expect(r.el.querySelectorAll('[data-testid="day-header"]')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem("claude-ui.sidebarView")!).dayHeaders).toBe(false);
  });

  it("Sort projects by name orders the groups A to Z", async () => {
    const r = await render(base);
    expect(r.groups().map((g) => g.dataset.cwd)).toEqual(["/home/u/web", "/home/u/api"]);
    const m = await open();
    await act(async () => m("sidebar-opt-sort-name").click());
    expect(r.groups().map((g) => g.dataset.cwd)).toEqual(["/home/u/api", "/home/u/web"]);
  });

  it("Only active sessions hides idle rows but keeps the active one", async () => {
    const r = await render({ ...base, list: [item("a", "/home/u/web", "Fix login", 1, "idle"), item("x", "/home/u/web", "Idle one", 2, "idle"), item("b", "/home/u/api", "Busy", 3, "running")] });
    const m = await open();
    await act(async () => m("sidebar-opt-only-active").click());
    expect(r.rows().map((x) => x.dataset.sessionId)).toEqual(["a", "b"]);
  });

  it("Always select active session reveals on a tab change without moving the focus and hides the locate button", async () => {
    localStorage.setItem("claude-ui.sidebarView", JSON.stringify({ alwaysSelect: true }));
    localStorage.setItem("claude-ui.collapsed", JSON.stringify(["/home/u/api"]));
    await render({ ...base, activeId: "d" });
    expect(q("sidebar-select-active")).toBeNull();
    expect(document.querySelector('[data-session-id="d"]')).not.toBeNull();
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(document.activeElement).toBe(document.body);
  });

  it("below md only Open project, Select active and Options are inline; Expand all and Collapse all are menu items", async () => {
    window.matchMedia = ((qs: string) => ({ matches: qs.includes("48rem"), media: qs, addEventListener() {}, removeEventListener() {} })) as never;
    await render(base);
    expect(q("sidebar-expand-all")).toBeNull();
    expect(q("sidebar-collapse-all")).toBeNull();
    expect(q("sidebar-select-active")).not.toBeNull();
    const m = await open();
    await act(async () => m("sidebar-menu-collapse-all").click());
    expect(expanded('[data-testid="group-toggle"]')).toEqual(["false", "false"]);
  });
  it("Select active session finds a worker whose coordinator is beyond Load more", async () => {
    const many = [
      item("co", "/home/u/api", "Old coordinator", 500),
      { ...item("wk", "/home/u/api", "W", 501), coordinatorId: "co", workerName: "alpha" },
      ...[1, 2, 3, 4, 5, 6].map((n) => item(`n${n}`, "/home/u/api", `New ${n}`, n)),
    ];
    await render({ list: many, projects: ["/home/u/api"], activeId: "wk" });
    expect(document.querySelector('[data-session-id="wk"]')).not.toBeNull();
    await act(async () => q("sidebar-collapse-all").click());
    await act(async () => q("sidebar-select-active").click());
    expect(document.activeElement).toBe(document.querySelector('[data-session-id="wk"]'));
  });

  it("is disabled when the sidebar does not list the active session", async () => {
    await render({ ...base, activeId: "unknown" });
    expect(q("sidebar-select-active").getAttribute("aria-disabled")).toBe("true");
  });

  it("the Sort radio closes the menu, a checkbox keeps it open", async () => {
    await render(base);
    const m = await open();
    await act(async () => m("sidebar-opt-day-headers").click());
    expect(document.querySelector('[data-testid="sidebar-options-menu"]')).not.toBeNull();
    await act(async () => m("sidebar-opt-sort-name").click());
    expect(document.querySelector('[data-testid="sidebar-options-menu"]')).toBeNull();
  });

  it("Only active sessions lists just the qualifying workers, hides a project with nothing active and counts the idle ones", async () => {
    const l = [
      item("co", "/home/u/api", "Coord", 3),
      { ...item("w1", "/home/u/api", "W1", 4, "running"), coordinatorId: "co", workerName: "run" },
      { ...item("w2", "/home/u/api", "W2", 5), coordinatorId: "co", workerName: "idle" },
      item("x", "/home/u/web", "Idle", 9),
    ];
    const r = await render({ ...base, list: l, activeId: "none" });
    const m = await open();
    await act(async () => m("sidebar-opt-only-active").click());
    expect(r.rows().map((x) => x.dataset.sessionId)).toEqual(["co", "w1"]);
    expect(r.groups().map((g) => g.dataset.cwd)).toEqual(["/home/u/api"]);
    expect(q("active-only-chip")!.textContent).toBe("Active only · 2 idle hiddenShow all");
    expect(q("idle-count")!.textContent).toBe("+1 idle");
  });

  it("Active only: search still finds an idle session, Show all turns the setting off, the archived view is not filtered", async () => {
    const l = [item("a", "/home/u/web", "Fix login", 1, "running"), item("x", "/home/u/web", "Idle one", 2, "idle"), item("z", "/home/u/api", "Idle two", 1, "idle")];
    localStorage.setItem("claude-ui.sidebarView", JSON.stringify({ onlyActive: true }));
    const r = await render({ ...base, list: l, activeId: "none" });
    expect(r.rows().map((x) => x.dataset.sessionId)).toEqual(["a"]);
    expect(q("active-only-chip")!.textContent).toContain("2 idle hidden");
    await r.search("idle one");
    expect(r.rows().map((x) => x.dataset.sessionId)).toEqual(["x"]);
    expect(q("active-only-chip")).toBeNull();
    await r.search("");
    await act(async () => q("active-only-show-all")!.click());
    expect(r.rows().map((x) => x.dataset.sessionId).sort()).toEqual(["a", "x", "z"]);
    expect(q("active-only-chip")).toBeNull();
    expect(JSON.parse(localStorage.getItem("claude-ui.sidebarView")!).onlyActive).toBe(false);
  });

  it("Expand all keeps the other view's worker group keys", async () => {
    localStorage.setItem("claude-ui.collapsed", JSON.stringify(["/home/u/web", "coordinator:co", "archived:coordinator:zz"]));
    await render(base);
    await act(async () => q("sidebar-expand-all").click());
    expect(JSON.parse(localStorage.getItem("claude-ui.collapsed")!)).toEqual(["archived:coordinator:zz"]);
  });

  it("below md the greyed Expand all item says why", async () => {
    window.matchMedia = ((qs: string) => ({ matches: qs.includes("48rem"), media: qs, addEventListener() {}, removeEventListener() {} })) as never;
    const { search } = await render(base);
    await search("fix");
    const m = await open();
    expect(m("sidebar-menu-expand-all").textContent).toBe("Expand all (clear the search first)");
  });

  it("Collapse all under Only active sessions also collapses a coordinator whose workers are all idle", async () => {
    const l = [
      item("co", "/home/u/api", "Coord", 3, "running"),
      { ...item("w2", "/home/u/api", "W2", 5), coordinatorId: "co", workerName: "idle" },
    ];
    await render({ ...base, list: l, activeId: "none" });
    const m = await open();
    await act(async () => m("sidebar-opt-only-active").click());
    await act(async () => q("sidebar-collapse-all").click());
    expect(JSON.parse(localStorage.getItem("claude-ui.collapsed")!)).toContain("coordinator:co");
  });

});
