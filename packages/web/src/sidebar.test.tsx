// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionListItem, SessionState } from "@claude-ui/protocol";
import { SessionList } from "./sidebar.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function render(projects = ["/home/u/web", "/home/u/api"]) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onOpen = vi.fn();
  const onNew = vi.fn();
  const onRemove = vi.fn();
  const onOpenProject = vi.fn();
  await act(async () =>
    root!.render(
      <SessionList
        list={LIST}
        projects={projects}
        state={(s) => s.state}
        unread={new Set(["c"])}
        activeId="a"
        onOpen={onOpen}
        onNew={onNew}
        onRemove={onRemove}
        onOpenProject={onOpenProject}
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
  return { el, groups, rows, toggle, search, onOpen, onNew, onRemove, onOpenProject };
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
  const { el, groups, onNew, onRemove, onOpenProject } = await render(["/home/u/empty", "/home/u/web", "/home/u/api"]);
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
  const { el, onOpenProject } = await render([]);
  expect(el.textContent).toContain("No projects yet");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="open-project"]')!.click());
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
