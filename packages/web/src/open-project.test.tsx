// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { FsEntry, RecentProject } from "@claude-ui/protocol";
import { OpenProjectDialog } from "./open-project.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tree: Record<string, string[]> = { "/home/u": ["claude-ui", "api", ".git", "notes.txt"], "/home/u/claude-ui": ["packages", "docs"] };
const list = vi.fn(async (path?: string): Promise<FsEntry[]> => {
  if (!path) return [{ name: "/home/u", path: "/home/u", isDir: true }];
  const names = tree[path];
  if (!names) throw new Error("ENOENT");
  return names.map((name) => ({ name, path: `${path}/${name}`, isDir: !name.includes(".txt") }));
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => root?.unmount());

async function render(onPick = vi.fn(async () => {}), recent?: RecentProject[]) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<OpenProjectDialog open onOpenChange={() => {}} list={list} onPick={onPick} recent={recent} />));
  const input = () => document.querySelector<HTMLInputElement>('[data-testid="folder-input"]')!;
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="folder-row"]')].map((r) => r.textContent);
  const type = async (v: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input(), v);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = (k: string) => act(async () => void input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
  const recents = () => [...document.querySelectorAll<HTMLElement>('[data-testid="recent-row"]')];
  return { input, rows, type, key, onPick, recents };
}

// The first dialog render loads Base UI cold (~2 s alone); under the full parallel suite it took over the 5 s default.
it("starts inside the only root and lists its folders, no dot folders, no files", { timeout: 20_000 }, async () => {
  const { input, rows } = await render();
  expect(input().value).toBe("/home/u/");
  expect(rows()).toEqual(["claude-ui/", "api/"]);
});

it("type-ahead filters, Tab lists the highlighted folder's subfolders, Enter picks the listed folder", async () => {
  const { rows, type, key, input, onPick } = await render();
  await type("/home/u/cl");
  expect(rows()).toEqual(["claude-ui/"]);
  await key("Tab");
  expect(input().value).toBe("/home/u/claude-ui/");
  expect(rows()).toEqual(["packages/", "docs/"]);
  await key("Enter");
  expect(onPick).toHaveBeenCalledWith("/home/u/claude-ui");
});

it("Enter with a filter picks the best match; clicking a row lists its subfolders, Open picks the listed folder", async () => {
  const { rows, type, key, onPick } = await render();
  await type("/home/u/a");
  await key("Enter");
  expect(onPick).toHaveBeenLastCalledWith("/home/u/api");
  await type("/home/u/");
  await act(async () => document.querySelectorAll<HTMLElement>('[data-testid="folder-row"]')[0]!.click());
  expect(rows()).toEqual(["packages/", "docs/"]);
  await act(async () => document.querySelector<HTMLElement>('[data-testid="open-folder"]')!.click());
  expect(onPick).toHaveBeenLastCalledWith("/home/u/claude-ui");
});

it("shows the daemon's refusal and an empty match", async () => {
  const { type, key } = await render(vi.fn(async () => Promise.reject(new Error("outside the allowlisted roots"))));
  await type("/home/u/zzz");
  expect(document.body.textContent).toContain('No folder matches "zzz"');
  await type("/home/u/");
  await key("Enter");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("outside the allowlisted roots");
});

it("Tab and Shift+Tab wrap inside the dialog: focus never reaches the page behind it", async () => {
  const { input } = await render();
  const close = document.querySelector<HTMLElement>('[aria-label="Close"]')!;
  const openButton = document.querySelector<HTMLElement>('[data-testid="open-folder"]')!;
  const tab = (from: HTMLElement, shiftKey = false) =>
    act(async () => void from.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })));
  input().focus();
  await tab(input(), true);
  expect(document.activeElement).toBe(close);
  await tab(close, true);
  expect(document.activeElement).toBe(openButton);
  await tab(openButton);
  expect(document.activeElement).toBe(close);
  await tab(close);
  expect(document.activeElement).toBe(input());
});

it("closing without a pick gives the focus back to the opener; after a pick the focus goes to finalFocus", async () => {
  const trigger = document.createElement("button");
  const prompt = document.createElement("textarea");
  document.body.append(trigger, prompt);
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const show = (open: boolean, onPick = async () => {}) =>
    act(async () => root!.render(<OpenProjectDialog open={open} onOpenChange={() => {}} list={list} onPick={onPick} finalFocus={{ current: prompt }} />));
  trigger.focus();
  await show(true);
  await show(false);
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(document.activeElement).toBe(trigger);
  trigger.focus();
  await show(true);
  await act(async () => document.querySelector<HTMLElement>('[data-testid="open-folder"]')!.click());
  await show(false);
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(document.activeElement).toBe(prompt);
  trigger.remove(), prompt.remove();
});

const now = Date.now();
const recent: RecentProject[] = [
  { cwd: "/home/u/api", sessionCount: 3, lastActivity: now - 5 * 60_000 },
  { cwd: "/home/u/old-one", sessionCount: 1, lastActivity: now - 3 * 3_600_000 },
  ...["a", "b", "c", "d"].map((n, i) => ({ cwd: `/home/u/${n}-proj`, sessionCount: 2, lastActivity: now - (i + 5) * 86_400_000 })),
];

it("suggests the first 5 recent projects with session count and age; one click adds one", async () => {
  const { recents, onPick } = await render(undefined, recent);
  expect(document.body.textContent).toContain("Recent projects");
  expect(recents().map((r) => r.textContent)).toEqual([
    expect.stringMatching(/^api\/home\/u\/api3 sessions · 5m ago$/),
    expect.stringMatching(/^old-one\/home\/u\/old-one1 session · 3h ago$/),
    expect.stringContaining("a-proj"),
    expect.stringContaining("b-proj"),
    expect.stringContaining("c-proj"),
  ]);
  await act(async () => recents()[1]!.click());
  expect(onPick).toHaveBeenCalledWith("/home/u/old-one");
});

it("typing filters the recent projects by name and shows all matches; Enter picks the best match, a recent one first", async () => {
  const { recents, rows, type, key, onPick } = await render(undefined, recent);
  await type("/home/u/proj");
  expect(recents().map((r) => r.textContent)).toEqual([expect.stringContaining("a-proj"), expect.stringContaining("b-proj"), expect.stringContaining("c-proj"), expect.stringContaining("d-proj")]);
  await type("/home/u/ol");
  expect(recents()).toHaveLength(1);
  expect(rows()).toEqual([]);
  await key("Enter");
  expect(onPick).toHaveBeenCalledWith("/home/u/old-one");
});

it("without recent projects the dialog shows no recent section", async () => {
  await render(undefined, []);
  expect(document.body.textContent).not.toContain("Recent projects");
});
