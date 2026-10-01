// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { QuickOpen, isQuickOpenKey } from "./quick-open.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const FILES: Record<string, string[]> = {
  "": ["README.md", "src/", "src/app.ts", "src/auth/login.ts"],
  a: ["src/app.ts", "src/auth/", "src/auth/login.ts"],
  au: ["src/auth/", "src/auth/login.ts"],
};

async function render(connected = true) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onSearch = vi.fn(async (q: string) => FILES[q] ?? []);
  const handlers = { onOpen: vi.fn(), onMention: vi.fn(), onClose: vi.fn() };
  const draw = (c: boolean) => act(async () => root!.render(<QuickOpen onSearch={onSearch} connected={c} {...handlers} />));
  await draw(connected);
  const input = el.querySelector<HTMLInputElement>('[data-testid="quick-open-input"]')!;
  const rows = () => [...el.querySelectorAll<HTMLElement>('[role="option"]')];
  const type = async (value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = async (k: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    await act(async () => void input.dispatchEvent(e));
    return e;
  };
  return { el, input, rows, type, key, onSearch, draw, ...handlers };
}

it("focuses the search box and lists files, not folders, for an empty query", async () => {
  const { input, rows } = await render();
  expect(document.activeElement).toBe(input);
  expect(rows().map((r) => r.dataset.path)).toEqual(["README.md", "src/app.ts", "src/auth/login.ts"]);
  expect(rows()[0]!.getAttribute("aria-selected")).toBe("true");
});

it("results update while typing, in the ranked order the daemon returns", async () => {
  const { type, rows, onSearch } = await render();
  await type("au");
  expect(onSearch).toHaveBeenLastCalledWith("au");
  expect(rows().map((r) => r.dataset.path)).toEqual(["src/auth/login.ts"]);
});

it("arrow keys move the active row, wrapping; Enter opens it", async () => {
  const { key, rows, onOpen, input } = await render();
  await key("ArrowDown");
  expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
  expect(input.getAttribute("aria-activedescendant")).toBe(rows()[1]!.id);
  await key("ArrowUp");
  await key("ArrowUp");
  expect(rows()[2]!.getAttribute("aria-selected")).toBe("true");
  await key("Enter");
  expect(onOpen).toHaveBeenCalledWith("src/auth/login.ts");
});

it("Ctrl+Enter or Cmd+Enter inserts the active path as a mention", async () => {
  const { key, onMention, onOpen } = await render();
  await key("Enter", { ctrlKey: true });
  expect(onMention).toHaveBeenCalledWith("README.md");
  await key("Enter", { metaKey: true });
  expect(onMention).toHaveBeenCalledTimes(2);
  expect(onOpen).not.toHaveBeenCalled();
});

it("Enter does nothing while results for the typed query have not arrived", async () => {
  const { el, key, type, onOpen, onSearch } = await render();
  onSearch.mockReturnValueOnce(new Promise(() => {}));
  await type("x");
  await key("Enter");
  expect(onOpen).not.toHaveBeenCalled();
  expect(el.textContent).toContain("README.md"); // the previous results stay shown meanwhile
});

it("tapping a row opens it; its @ button inserts the mention instead", async () => {
  const { rows, onOpen, onMention } = await render();
  await act(async () => rows()[1]!.click());
  expect(onOpen).toHaveBeenCalledWith("src/app.ts");
  await act(async () => rows()[2]!.querySelector<HTMLButtonElement>('[data-testid="quick-open-mention"]')!.click());
  expect(onMention).toHaveBeenCalledWith("src/auth/login.ts");
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("Escape and a tap on the backdrop close it; Escape does not reach other handlers", async () => {
  const { el, key, onClose } = await render();
  const e = await key("Escape");
  expect(e.defaultPrevented).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => el.querySelector<HTMLElement>('[data-testid="quick-open-backdrop"]')!.click());
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("says so when nothing matches", async () => {
  const { el, type } = await render();
  await type("zzz");
  expect(el.textContent).toContain("No files found");
});

it("Ctrl+P and Cmd+P are the shortcut, not Ctrl+Shift+P", () => {
  const k = (init: KeyboardEventInit) => isQuickOpenKey(new KeyboardEvent("keydown", init));
  expect(k({ key: "p", ctrlKey: true })).toBe(true);
  expect(k({ key: "p", metaKey: true })).toBe(true);
  expect(k({ key: "P", ctrlKey: true, shiftKey: true })).toBe(false);
  expect(k({ key: "p" })).toBe(false);
});

it("owns Escape and the arrow keys after a click moved focus off the search box", async () => {
  const { rows, onClose } = await render();
  const outside = vi.fn(); // like SessionPane's window Esc listener, which interrupts the turn
  window.addEventListener("keydown", outside);
  try {
    (document.activeElement as HTMLElement).blur();
    const press = async (k: string) => {
      const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      await act(async () => void document.body.dispatchEvent(e));
      return e;
    };
    await press("ArrowDown");
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    const e = await press("Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", outside);
  }
});

it("a click inside the dialog keeps focus in the search box", async () => {
  const { el, input } = await render();
  const title = el.querySelector<HTMLElement>("#quick-open-group")!;
  const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  await act(async () => void title.dispatchEvent(e));
  expect(e.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input);
});

it("has no footer key-hint bar (OpenCode has none)", async () => {
  const { el } = await render();
  expect(el.textContent).not.toContain("navigate");
});

it("shows the error when the search fails", async () => {
  const { el, type, onSearch } = await render();
  onSearch.mockRejectedValueOnce(new Error("Not connected"));
  await type("x");
  expect(el.textContent).toContain("Not connected");
});

it("a failed search offers Retry, which searches again", async () => {
  const { el, type, onSearch, rows } = await render();
  onSearch.mockRejectedValueOnce(new Error("timed out"));
  await type("a");
  const retry = [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
  await act(async () => retry.click());
  expect(onSearch).toHaveBeenLastCalledWith("a");
  expect(rows().map((r) => r.dataset.path)).toEqual(["src/app.ts", "src/auth/login.ts"]);
});

it("offline it says so instead of searching, and searches once the daemon reconnects", async () => {
  const { el, onSearch, rows, draw } = await render(false);
  expect(onSearch).not.toHaveBeenCalled();
  expect(el.textContent).toContain("Not connected to the daemon");
  await draw(true);
  expect(onSearch).toHaveBeenLastCalledWith("");
  expect(rows()).toHaveLength(3);
});
