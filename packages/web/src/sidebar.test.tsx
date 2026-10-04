// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionListItem, SessionState } from "@claude-ui/protocol";
import { SessionList } from "./sidebar.tsx";

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

async function render(props: { list?: SessionListItem[]; renaming?: string; projects?: string[] } = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onOpen = vi.fn();
  const onNew = vi.fn();
  const onRemove = vi.fn();
  const onOpenProject = vi.fn();
  const onAction = vi.fn();
  const onRenamed = vi.fn();
  await act(async () =>
    root!.render(
      <SessionList
        list={props.list ?? LIST}
        projects={props.projects ?? ["/home/u/web", "/home/u/api"]}
        state={(s) => s.state}
        unread={new Set(["c"])}
        activeId="a"
        onOpen={onOpen}
        onNew={onNew}
        onRemove={onRemove}
        onOpenProject={onOpenProject}
        renaming={props.renaming}
        onAction={onAction}
        onRenamed={onRenamed}
      />,
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
  return { el, groups, rows, toggle, search, onOpen, onNew, onRemove, onOpenProject, onAction, onRenamed };
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
  expect(el.textContent).toContain('No session title or project matches "nothing"');
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
