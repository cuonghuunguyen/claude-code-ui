// @vitest-environment jsdom
// GH-135: the tab grouping setting in the tab strip (project / worktree / none).
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TabsBar, useGroupedTabs, type TabInfo } from "./tabs-bar.tsx";
import { NEW_TAB } from "./tabs.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: Record<string, TabInfo> = {
  a: { title: "Fix login", cwd: "/home/u/web", state: "running", unread: false },
  b: { title: "Docs", cwd: "/home/u/docs", state: "needs_input", unread: true },
  c: { title: "Refactor", cwd: "/home/u/api", state: "idle", unread: true },
  d: { title: "Old", cwd: "/home/u/api", state: "closed", unread: false },
  [NEW_TAB]: { title: "New session", unread: false },
};
const W1: TabInfo = { title: "Registry", cwd: "/r/acme/.claude/worktrees/a", group: "/r/acme/.claude/worktrees/a", groupLabel: "a", groupSub: "acme · ACME-397-registry-adapt", groupColor: "/r/acme", state: "idle", unread: false };
const W2: TabInfo = { ...W1, title: "Adapter", cwd: "/r/acme/.claude/worktrees/b", group: "/r/acme/.claude/worktrees/b", groupLabel: "b", groupSub: "acme · ACME-400" };
const WINFO: Record<string, TabInfo> = { w1: W1, w2: W2, a: { ...INFO.a!, group: "/home/u/web" }, [NEW_TAB]: { title: "New session", unread: false } };

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const noop = { onSelect: () => {}, onClose: () => {}, onMove: () => {}, onMoveGroup: () => {}, onMoveGroupTo: () => {}, onNew: () => {}, onAction: () => {}, onRenamed: () => {} };
const mount = async (ui: React.ReactElement) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(ui));
  return el;
};
const chips = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="tab-group-chip"]')];
const chip = (el: HTMLElement, key: string) => el.querySelector<HTMLElement>(`[data-group-chip="${key}"]`)!;

it("by worktree: chips show the worktree name in the project color; details are in a tooltip, not a title", async () => {
  const el = await mount(<TabsBar {...noop} tabs={["w1", "w2", "a"]} activeId="a" info={(id) => WINFO[id]!} grouping="worktree" />);
  const c = chips(el);
  expect(c.length).toBe(3);
  expect(c.map((x) => x.textContent)).toEqual(["a1", "b1", "web1"]);
  expect(c[0]!.style.getPropertyValue("--av")).toBe(c[1]!.style.getPropertyValue("--av"));
  expect(c[0]!.getAttribute("aria-label")).toMatch(/^a \(acme · ACME-397-registry-adapt\), 1 tab/);
  expect(document.getElementById(c[0]!.getAttribute("aria-describedby")!)?.textContent).toBe("/r/acme/.claude/worktrees/a");
  for (const x of c) expect(x.hasAttribute("title")).toBe(false);
  // Keyboard focus opens the tooltip with "project · branch" and the path.
  await act(async () => c[0]!.focus());
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  const tip = document.querySelector('[data-slot="tooltip-content"]');
  expect(tip?.textContent).toContain("acme · ACME-397-registry-adapt");
  expect(tip?.textContent).toContain("/r/acme/.claude/worktrees/a");
});

it("hovering a chip opens the tooltip too", async () => {
  const el = await mount(<TabsBar {...noop} tabs={["w1", "a"]} activeId="a" info={(id) => WINFO[id]!} grouping="worktree" />);
  const c = chips(el)[0]!;
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
    await act(async () => void c.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, pointerType: "mouse" } as PointerEventInit)));
  }
  await act(async () => void new Promise((r) => setTimeout(r, 100)));
  expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain("acme · ACME-397-registry-adapt");
});

it("by project: the chip tooltip shows the project name and path", async () => {
  const el = await mount(<TabsBar {...noop} tabs={["a", "b"]} activeId="a" info={(id) => ({ ...INFO[id]!, group: INFO[id]!.cwd })} />);
  const c = chip(el, "/home/u/docs");
  expect(c.hasAttribute("title")).toBe(false);
  expect(c.getAttribute("aria-label")).toMatch(/^docs, 1 tab/);
  expect(document.getElementById(c.getAttribute("aria-describedby")!)?.textContent).toBe("/home/u/docs");
  await act(async () => c.focus());
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  const tip = document.querySelector('[data-slot="tooltip-content"]');
  expect(tip?.textContent).toContain("docs");
  expect(tip?.textContent).toContain("/home/u/docs");
});

it("no grouping: no chips, every tab shows its avatar, and tabs move across projects", async () => {
  localStorage.setItem("claude-ui.tab-groups-collapsed", '["/home/u/api"]');
  const onMove = vi.fn();
  const el = await mount(<TabsBar {...noop} onMove={onMove} tabs={["a", "b", "c", "d"]} activeId="c" info={(id) => ({ ...INFO[id]!, group: "" })} grouping="none" />);
  const tab = (id: string) => el.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
  expect(chips(el).length).toBe(0);
  expect(tab("c")).not.toBeNull();
  expect(tab("d")).not.toBeNull();
  expect(tab("d").textContent).toMatch(/^AOld/);
  await act(async () => void tab("a").querySelector('[role="tab"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true, bubbles: true })));
  expect(onMove).toHaveBeenCalledWith("a", "b");
  expect(tab("b").hasAttribute("data-first")).toBe(false);
});

it("switching the grouping regroups the open tabs at once and keeps every tab and the active one", async () => {
  type Mode = "project" | "worktree" | "none";
  const keyFn = (mode: Mode) => (id: string) => (mode === "none" ? "" : mode === "project" ? (id === "a" ? "/home/u/web" : "/r/acme") : WINFO[id]!.group);
  function Host() {
    const [mode, setMode] = useState<Mode>("project");
    const [tabs, setTabs] = useState(["w1", "a", "w2"]);
    useGroupedTabs(tabs, setTabs, keyFn(mode));
    return (
      <>
        <button data-testid="flip" onClick={() => setMode((m) => (m === "project" ? "worktree" : m === "worktree" ? "none" : "project"))} />
        <TabsBar {...noop} tabs={tabs} activeId="w2" grouping={mode} info={(id) => ({ ...WINFO[id]!, group: keyFn(mode)(id), groupSub: undefined, groupLabel: id === "a" ? "web" : "acme" })} />
      </>
    );
  }
  const el = await mount(<Host />);
  const ids = () => [...el.querySelectorAll<HTMLElement>("[data-tab-id]")].map((t) => t.dataset.tabId);
  const check = () => {
    expect([...ids()].sort()).toEqual(["a", "w1", "w2"]);
    expect(el.querySelector('[data-tab-id="w2"] [role="tab"]')!.getAttribute("aria-selected")).toBe("true");
  };
  expect(ids()).toEqual(["w1", "w2", "a"]);
  expect(chips(el).map((c) => c.textContent)).toEqual(["acme2", "web1"]);
  check();
  await act(async () => el.querySelector<HTMLElement>('[data-testid="flip"]')!.click());
  expect(chips(el).length).toBe(3);
  check();
  await act(async () => el.querySelector<HTMLElement>('[data-testid="flip"]')!.click());
  expect(chips(el).length).toBe(0);
  check();
});

it("collapsed state follows the grouping mode", async () => {
  const Host = ({ grouping }: { grouping: "project" | "worktree" }) => (
    <TabsBar {...noop} tabs={["w1", "w2", "a"]} activeId="a" grouping={grouping} info={(id) => (grouping === "project" && id !== "a" ? { ...WINFO[id]!, group: "/r/acme", groupSub: undefined } : WINFO[id]!)} />
  );
  const el = await mount(<Host grouping="project" />);
  const show = (g: "project" | "worktree") => act(async () => root!.render(<Host grouping={g} />));
  const expanded = () => chips(el).map((c) => c.getAttribute("aria-expanded"));
  await act(async () => chip(el, "/r/acme").click());
  expect(expanded()).toEqual(["false", "true"]);
  await show("worktree");
  expect(expanded()).toEqual(["true", "true", "true"]);
  await show("project");
  expect(expanded()).toEqual(["false", "true"]);
  expect(localStorage.getItem("claude-ui.tab-groups-collapsed.worktree")).toBeNull();
});
