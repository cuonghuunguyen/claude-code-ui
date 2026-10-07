// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPalette, type PaletteItem } from "./palette.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

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

async function render(start?: string, items = ITEMS, files?: ComponentProps<typeof CommandPalette>["files"], messages?: ComponentProps<typeof CommandPalette>["messages"]) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onClose = vi.fn();
  await act(async () => root!.render(<CommandPalette items={items} start={start} files={files} messages={messages} onClose={onClose} />));
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
  // OpenCode KeybindV2 fill: bg-layer-03 (theme.test.ts checks the token).
  expect(rows()[0]!.querySelector('[data-testid="keybind"] span')!.className).toContain("bg-kbd");
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

it("closes cleanly where scrollIntoView returns a Promise (current Chromium): no effect returns it as its cleanup", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => Promise.resolve() as never);
  const { key } = await render();
  await key("ArrowDown");
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => (errors.push(e.error), e.preventDefault());
  window.addEventListener("error", onError);
  act(() => root!.unmount());
  window.removeEventListener("error", onError);
  root = undefined;
  expect(errors).toEqual([]);
  scroll.mockRestore();
});

it("keeps the list it opened with: Stop stays when the turn ends while the palette is open", async () => {
  const stop = vi.fn();
  const items: PaletteItem[] = [ITEMS[0]!, { id: "stop", group: "Commands", title: "Stop", keys: "escape", run: stop }];
  const { rows, type, key, onClose } = await render(undefined, items);
  await type("Stop");
  await act(async () => root!.render(<CommandPalette items={[ITEMS[0]!]} onClose={onClose} />));
  expect(rows().map((r) => r.textContent)).toEqual(["StopEsc"]);
  await key("Enter");
  expect(stop).toHaveBeenCalled();
});

it("fetches the extra rows once the first query is typed and lists them before the sessions", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const open = vi.fn();
  const more = vi.fn(async (): Promise<PaletteItem[]> => [{ id: "mcp:ctx", group: "MCP servers", title: "ctx", description: "Open MCP server details", meta: "⚠ Needs Auth", searchOnly: true, run: open }]);
  await act(async () => root!.render(<CommandPalette items={ITEMS} more={more} onClose={noop} />));
  expect(more).not.toHaveBeenCalled();
  const input = el.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  for (const v of ["c", "i"])
    await act(async () => {
      set.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  expect(more).toHaveBeenCalledTimes(1);
  const row = [...el.querySelectorAll<HTMLElement>('[role="option"]')].find((r) => r.textContent?.includes("ctx"))!;
  expect(row.textContent).toBe("ctxOpen MCP server details⚠ Needs Auth");
  expect([...el.querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label"))).toEqual(["Commands", "MCP servers", "Sessions"]);
  await act(async () => row.click());
  expect(open).toHaveBeenCalled();
});

const HIT = { sessionId: "sx", cwd: "/proj", title: "Old chat", hits: [{ messageId: "m1", role: "assistant" as const, snippet: "…the Zebra crossing…" }] };
const DONE = { scannedFiles: 1, scannedBytes: 10, ms: 5 };
const settle = (ms = 300) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const msgSearch = () => {
  const calls: { q: string; cwd?: string; onResult: (r: typeof HIT) => void; done: (r: typeof DONE) => void }[] = [];
  const open = vi.fn();
  const search = vi.fn((q: string, cwd: string | undefined, onResult: (r: typeof HIT) => void) => new Promise<typeof DONE>((done) => calls.push({ q, cwd, onResult, done })));
  return { calls, open, search, messages: { cwd: "/proj", search, open } };
};

it("a query of 2+ chars searches the project's messages after 250 ms; hits list under Messages with the match highlighted", async () => {
  const m = msgSearch();
  const { el, rows, type } = await render(undefined, ITEMS, undefined, m.messages);
  await type("zebra");
  expect(m.search).not.toHaveBeenCalled();
  await settle();
  expect(m.search).toHaveBeenCalledTimes(1);
  expect(m.calls[0]).toMatchObject({ q: "zebra", cwd: "/proj" });
  await act(async () => (m.calls[0]!.onResult(HIT), m.calls[0]!.done(DONE)));
  const row = rows().find((r) => r.dataset.id === "msg:sx:m1")!;
  expect(row.querySelector('[data-testid="palette-title"]')!.textContent).toBe("Old chat");
  expect(row.querySelector("mark")!.textContent).toBe("Zebra");
  expect(el.querySelector('[role="group"][aria-label="Messages"]')).not.toBeNull();
});

it("Enter on a message hit closes the palette and opens the session at that hit", async () => {
  const m = msgSearch();
  const { type, key, onClose } = await render(undefined, ITEMS, undefined, m.messages);
  await type("zebra");
  await settle();
  await act(async () => (m.calls[0]!.onResult(HIT), m.calls[0]!.done(DONE)));
  await key("Enter");
  expect(m.open).toHaveBeenCalledWith("sx", HIT.hits[0], "zebra");
  expect(onClose).toHaveBeenCalled();
});

it("a newer query drops late results of the older one", async () => {
  const m = msgSearch();
  const { rows, type } = await render(undefined, ITEMS, undefined, m.messages);
  await type("zebra");
  await settle();
  await type("zebras");
  await settle();
  expect(m.calls.map((c) => c.q)).toEqual(["zebra", "zebras"]);
  await act(async () => m.calls[0]!.onResult(HIT));
  expect(rows().some((r) => r.dataset.id?.startsWith("msg:sx"))).toBe(false);
});

it('"Search messages in all projects" reruns without cwd and keeps the palette open', async () => {
  const m = msgSearch();
  const { rows, type, key, onClose } = await render(undefined, ITEMS, undefined, m.messages);
  await type("zebra");
  await settle();
  await act(async () => m.calls[0]!.done(DONE));
  const all = rows().findIndex((r) => r.dataset.id === "msg:all");
  for (let i = 0; i < all; i++) await key("ArrowDown");
  await key("Enter");
  expect(onClose).not.toHaveBeenCalled();
  await settle();
  expect(m.calls[1]).toMatchObject({ q: "zebra", cwd: undefined });
});

it("closing the palette cancels the running search", async () => {
  const m = msgSearch();
  const { type } = await render(undefined, ITEMS, undefined, m.messages);
  await type("zebra");
  await settle();
  act(() => root!.unmount());
  expect(m.search).toHaveBeenLastCalledWith("", undefined, expect.any(Function));
});

it("a one-char query and option pages do not search", async () => {
  const m = msgSearch();
  const { type, key } = await render(undefined, ITEMS, undefined, m.messages);
  await type("z");
  await settle();
  await type("");
  await type("model");
  await key("Enter");
  await type("op");
  await settle();
  expect(m.search).not.toHaveBeenCalled();
});

it("the search starts 250 ms after the last keystroke", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const m = msgSearch();
    const { type } = await render(undefined, ITEMS, undefined, m.messages);
    await type("zeb");
    await act(async () => void vi.advanceTimersByTime(200));
    await type("zebra");
    await act(async () => void vi.advanceTimersByTime(249));
    expect(m.search).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(1));
    expect(m.search).toHaveBeenCalledTimes(1);
    expect(m.calls[0]!.q).toBe("zebra");
  } finally {
    vi.useRealTimers();
  }
});

it("a message hit shows its snippet on its own line below the title", async () => {
  const m = msgSearch();
  const { rows, type } = await render(undefined, ITEMS, undefined, m.messages);
  await type("zebra");
  await settle();
  await act(async () => (m.calls[0]!.onResult(HIT), m.calls[0]!.done(DONE)));
  const row = rows().find((r) => r.dataset.id === "msg:sx:m1")!;
  const snippet = row.querySelector('[data-testid="palette-snippet"]')!;
  expect(snippet.parentElement).toBe(row.querySelector('[data-testid="palette-title"]')!.parentElement);
  expect(snippet.parentElement!.className).toContain("flex-col");
  expect(snippet.querySelector("mark")!.textContent).toBe("Zebra");
});

it("keys pressed while an input method composes in the search box (Enter, Esc) go to the IME", async () => {
  const { type, key, onClose, input } = await render();
  await type("tiê");
  const enter = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
  await act(async () => void input().dispatchEvent(enter));
  const esc = new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true });
  await act(async () => void input().dispatchEvent(esc));
  expect(enter.defaultPrevented).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  await key("Escape");
  expect(onClose).toHaveBeenCalled();
});
