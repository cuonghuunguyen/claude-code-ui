// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { FsEntry } from "@claude-ui/protocol";
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

async function render(onPick = vi.fn(async () => {})) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<OpenProjectDialog open onOpenChange={() => {}} list={list} onPick={onPick} />));
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
  return { input, rows, type, key, onPick };
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
