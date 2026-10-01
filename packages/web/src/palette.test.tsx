// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPalette, type PaletteItem } from "./palette.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const newSession = vi.fn();
const setModel = vi.fn();
const openTab = vi.fn();
const noop = () => {};
const ITEMS: PaletteItem[] = [
  { id: "new", group: "Commands", title: "New session", keys: "mod+shift+s", run: newSession },
  {
    id: "model",
    group: "Commands",
    title: "Change model",
    keys: "mod+'",
    page: {
      placeholder: "Choose model",
      items: [
        { id: "opus", group: "Models", title: "Opus", checked: true, run: () => setModel("opus") },
        { id: "sonnet", group: "Models", title: "Sonnet", run: () => setModel("sonnet") },
      ],
    },
  },
  { id: "s1", group: "Sessions", title: "Fix login", description: "api", run: openTab },
];

async function render(start?: string, items = ITEMS, files?: ComponentProps<typeof CommandPalette>["files"]) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onClose = vi.fn();
  await act(async () => root!.render(<CommandPalette items={items} start={start} files={files} onClose={onClose} />));
  const input = () => el.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
  const rows = () => [...el.querySelectorAll<HTMLElement>('[role="option"]')];
  const type = async (value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = async (k: string) => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    await act(async () => void input().dispatchEvent(e));
    return e;
  };
  return { el, input, rows, type, key, onClose };
}

it("lists commands with their shortcut chips and the sessions, grouped; the search box has focus", async () => {
  const { el, input, rows } = await render();
  expect(document.activeElement).toBe(input());
  expect([...el.querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label"))).toEqual(["Commands", "Sessions"]);
  expect(rows().map((r) => r.dataset.id)).toEqual(["new", "model", "s1"]);
  expect([...rows()[0]!.querySelectorAll('[data-testid="keybind"] span')].map((s) => s.textContent)).toEqual(["Ctrl", "Shift", "S"]);
});

it("typing filters by title or description; Enter runs the active item and closes", async () => {
  const { type, rows, key, onClose } = await render();
  await type("api");
  expect(rows().map((r) => r.dataset.id)).toEqual(["s1"]);
  await key("Enter");
  expect(onClose).toHaveBeenCalled();
  expect(openTab).toHaveBeenCalled();
});

it("an item with a page opens it; Backspace on an empty query goes back", async () => {
  const { rows, key, input } = await render();
  await key("ArrowDown");
  await key("Enter");
  expect(input().placeholder).toBe("Choose model");
  expect(rows().map((r) => r.dataset.id)).toEqual(["opus", "sonnet"]);
  expect(rows()[0]!.querySelector('[aria-label="current"]')).not.toBeNull();
  await key("Backspace");
  expect(rows().map((r) => r.dataset.id)).toEqual(["new", "model", "s1"]);
});

it("start opens a page directly; choosing runs it", async () => {
  const { rows, key } = await render("model");
  expect(rows().map((r) => r.dataset.id)).toEqual(["opus", "sonnet"]);
  await key("ArrowUp");
  await key("Enter");
  expect(setModel).toHaveBeenCalledWith("sonnet");
});

it("Esc closes and does not reach other listeners (Esc stops a turn)", async () => {
  const { key, onClose } = await render();
  const other = vi.fn();
  window.addEventListener("keydown", other);
  const e = await key("Escape");
  window.removeEventListener("keydown", other);
  expect(onClose).toHaveBeenCalled();
  expect(e.defaultPrevented).toBe(true);
  expect(other).not.toHaveBeenCalled();
});

it("no match shows No results", async () => {
  const { type, el } = await render();
  await type("zzz");
  expect(el.querySelector('[role="status"]')?.textContent).toBe("No results");
});

it("an option page starts on the current value, so Enter keeps it", async () => {
  const items: PaletteItem[] = [
    { id: "m", group: "Commands", title: "Change model", page: { placeholder: "Choose model", items: [{ id: "a", group: "Models", title: "A", run: noop }, { id: "b", group: "Models", title: "B", checked: true, run: () => setModel("b") }] } },
  ];
  const { rows } = await render("m", items);
  expect(rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]);
});

it("empty query lists commands and recent sessions only; a query also finds the older ones, at most 50 per group", async () => {
  const sessions: PaletteItem[] = Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, group: "Sessions", title: `Task ${i}`, searchOnly: i >= 5, run: noop }));
  const { rows, type } = await render(undefined, [ITEMS[0]!, ...sessions]);
  expect(rows().map((r) => r.dataset.id)).toEqual(["new", "s0", "s1", "s2", "s3", "s4"]);
  await type("task 7");
  expect(rows().map((r) => r.dataset.id)).toEqual(["s7", ...Array.from({ length: 10 }, (_, i) => `s${70 + i}`)]);
  await type("task");
  expect(rows()).toHaveLength(50);
});

it("a session row shows the project avatar, the open-tab marker and the relative time; a long title truncates with a tooltip", async () => {
  const title = "A very long session title that does not fit into one palette row at all";
  const { rows } = await render(undefined, [{ id: "s", group: "Sessions", title, description: "api", cwd: "/w/api", open: true, meta: "2m", run: noop }]);
  const row = rows()[0]!;
  expect(row.title).toBe(title);
  expect(row.querySelector('[data-testid="open-marker"]')).not.toBeNull();
  expect(row.querySelector("[aria-hidden]")?.textContent).toBe("A");
  expect(row.querySelector('[data-testid="palette-meta"]')?.textContent).toBe("2m");
  expect(row.querySelector('[data-testid="palette-title"]')!.className).toMatch(/\btruncate\b/);
});

it("a query also searches files of the shown session (Files group, folders left out); Enter opens the file", async () => {
  const open = vi.fn();
  const search = vi.fn(async (q: string) => (q ? ["src/", "src/login.ts"] : []));
  const { rows, type, key, el, input } = await render(undefined, ITEMS, { search, open });
  expect(input().placeholder).toBe("Search files, commands, and sessions");
  expect(search).not.toHaveBeenCalled();
  await type("ts");
  expect([...el.querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label"))).toEqual(["Files"]);
  expect(rows()[0]!.textContent).toBe("src/login.ts");
  await key("Enter");
  expect(open).toHaveBeenCalledWith("src/login.ts");
});
