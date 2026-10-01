// @vitest-environment jsdom
import { act } from "react";
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

async function render(start?: string) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onClose = vi.fn();
  await act(async () => root!.render(<CommandPalette items={ITEMS} start={start} onClose={onClose} />));
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
