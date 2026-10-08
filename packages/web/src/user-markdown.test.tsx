// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPane } from "./App.tsx";
import { resetIdleQueue, SCROLL_REST, UserMarkdown } from "./user-markdown.tsx";
import { applyEvent, emptySession } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

const noop = () => {};
let unmount = noop;
afterEach(() => unmount());

const user = (text: string, images: string[] = []) =>
  applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "user_text", id: "u1", text, images } });

async function render(text: string, images: string[] = []) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props: ComponentProps<typeof SessionPane> = {
    scrollKey: 0,
    onInserted: noop,
    session: { id: "s1", cwd: "/tmp", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"] },
    view: user(text, images),
    models: [],
    onModel: noop,
    onMode: noop,
    onEffort: noop,
    onUpload: async () => "/tmp/u/x.txt",
    onPrompt: async () => {},
    onSearch: async () => [],
    onInterrupt: noop,
    onRewindPreview: async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false }),
    onRewind: async () => {},
    onRespond: noop,
    onAnswer: noop,
    connected: true,
  };
  await act(async () => root.render(<SessionPane {...props} />));
  unmount = () => (root.unmount(), el.remove());
  return { el, bubble: el.querySelector<HTMLElement>('[data-testid="user-message"]')! };
}

it("user bubble renders markdown with the assistant renderer", async () => {
  const { bubble } = await render("**bold** and `code`\n\n```ts\nconst a = 1;\n```\n\n- a\n- b");
  expect(bubble.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold");
  expect(bubble.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe("code");
  expect(bubble.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
  expect(bubble.querySelectorAll("li")).toHaveLength(2);
});

it("typed HTML stays visible text", async () => {
  const a = await render("fix the <Button> component");
  expect(a.bubble.textContent).toContain("<Button>");
  unmount();
  const b = await render("<script>x</script>");
  expect(b.bubble.querySelector("script")).toBeNull();
  expect(b.bubble.textContent).toContain("<script>x</script>");
});

it("a single newline is a line break and the bubble does not use pre-wrap", async () => {
  const { bubble } = await render("one\ntwo");
  expect(bubble.querySelectorAll("br")).toHaveLength(1);
  expect(bubble.innerHTML).not.toContain("whitespace-pre-wrap");
});

it("a paragraph starting with a tag (HTML block) keeps its line breaks and shows as text", async () => {
  const a = await render(["<Button>", "a", "b"].join("\n"));
  expect(a.bubble.querySelectorAll("br")).toHaveLength(2);
  expect(a.bubble.textContent).toContain("<Button>");
  unmount();
  const b = await render(["<div> x", "y"].join("\n"));
  expect(b.bubble.querySelectorAll("br")).toHaveLength(1);
  expect(b.bubble.textContent).toContain("<div> x");
  unmount();
  const c = await render(["<script>alert(1)</script>", "z"].join("\n"));
  expect(c.bubble.querySelector("script")).toBeNull();
  expect(c.bubble.textContent).toContain("<script>alert(1)</script>");
  expect(c.bubble.textContent).toContain("z");
});

it("Copy copies the raw markdown", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const { el } = await render("**bold**");
  await act(async () => void el.querySelector<HTMLElement>('button[title="Copy"]')!.click());
  expect(writeText).toHaveBeenCalledWith("**bold**");
});

const TOKENS = '[data-streamdown="code-block"] span[style*="--sdm-c: #"]';
const longCode = (n: number) => Array.from({ length: 40 }, (_, i) => `export const v${n}_${i} = (x: number) => x + ${i}; // line ${i}`).join("\n");
const fence = (code: string) => ["```ts", code, "```"].join("\n");

it("a short code block in a user message is colored", async () => {
  const { bubble } = await render(fence("const a = 1;"));
  await vi.waitFor(() => expect(bubble.querySelectorAll(TOKENS).length).toBeGreaterThan(2), { timeout: 10_000 });
});

it("a long code block is plain first and gets its colors once the browser is idle", async () => {
  const idle: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => idle.push(cb));
  try {
    const { bubble } = await render(fence(longCode(1)));
    expect(bubble.querySelector('[data-streamdown="code-block"]')?.textContent).toContain("export const v1_0");
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    expect(idle.length).toBeGreaterThan(0);
    expect(bubble.querySelectorAll(TOKENS)).toHaveLength(0);
    // Idle: it colors, one block per idle slot.
    await vi.waitFor(async () => {
      await act(async () => idle.splice(0).forEach((f) => f()));
      expect(bubble.querySelectorAll(TOKENS).length).toBeGreaterThan(20);
    }, { timeout: 10_000 });
  } finally {
    vi.unstubAllGlobals();
  }
});

/** Idle slots by hand: `slot()` runs the oldest idle callback the way the browser would. */
function manualIdle() {
  const idle: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => idle.push(cb));
  return { idle, slot: () => act(async () => void idle.shift()?.()) };
}
const mounted: { unmount: () => void }[] = [];
async function mountMd(text: string) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<UserMarkdown text={text} />));
  const m = { el, unmount: () => (root.unmount(), el.remove()) };
  mounted.push(m);
  return m;
}
const colored = (el: Element) => el.querySelectorAll(TOKENS).length > 20;
afterEach(async () => {
  mounted.splice(0).forEach((m) => m.unmount());
  resetIdleQueue();
  vi.unstubAllGlobals();
});

it("rows that mounted and unmounted again do not delay the block on screen (newest first, cancelled on unmount)", async () => {
  const { idle, slot } = manualIdle();
  const a = await mountMd(fence(longCode(11)));
  const b = await mountMd(fence(longCode(12)));
  const c = await mountMd(fence(longCode(13)));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  a.unmount();
  b.unmount();
  // One idle slot is enough for the visible row: the two gone rows' jobs are cancelled, none runs first.
  await slot();
  await vi.waitFor(() => expect(colored(c.el)).toBe(true), { timeout: 10_000 });
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(idle).toHaveLength(0);
});

it("two rows with the same code share one job", async () => {
  const { idle, slot } = manualIdle();
  const a = await mountMd(fence(longCode(21)));
  const b = await mountMd(fence(longCode(21)));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  await slot();
  await vi.waitFor(() => expect(colored(a.el) && colored(b.el)).toBe(true), { timeout: 10_000 });
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(idle).toHaveLength(0);
});

it("coloring waits while the user is scrolling, also when the job is about to run", async () => {
  const { slot } = manualIdle();
  const a = await mountMd(fence(longCode(31)));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  // The idle slot comes, then the user scrolls: the job must not run inside this scroll.
  document.dispatchEvent(new Event("wheel", { bubbles: true }));
  await slot();
  await act(async () => new Promise((r) => setTimeout(r, 100)));
  expect(colored(a.el)).toBe(false);
  await act(async () => new Promise((r) => setTimeout(r, SCROLL_REST + 100)));
  await slot();
  await vi.waitFor(() => expect(colored(a.el)).toBe(true), { timeout: 10_000 });
});

it("a scroll no input started (streaming follows the output) does not hold the coloring back", async () => {
  const { slot } = manualIdle();
  const a = await mountMd(fence(longCode(41)));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  document.dispatchEvent(new Event("scroll", { bubbles: true }));
  await slot();
  await vi.waitFor(() => expect(colored(a.el)).toBe(true), { timeout: 10_000 });
});

it("a message colors the first 1200 characters of its code at once, the rest when idle", async () => {
  const { slot } = manualIdle();
  const small = (n: number) => fence(`${"x".repeat(5)}${n}\n` + "const a = 1;\n".repeat(80));
  const a = await mountMd([small(1), small(2), small(3)].join("\n\n"));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  const blocks = [...a.el.querySelectorAll('[data-streamdown="code-block"]')];
  expect(blocks).toHaveLength(3);
  await vi.waitFor(() => expect(blocks[0]!.querySelectorAll('span[style*="--sdm-c: #"]').length).toBeGreaterThan(5), { timeout: 10_000 });
  expect(blocks[1]!.querySelectorAll('span[style*="--sdm-c: #"]')).toHaveLength(0);
  expect(blocks[2]!.querySelectorAll('span[style*="--sdm-c: #"]')).toHaveLength(0);
  await slot();
  await slot();
  await vi.waitFor(() => expect(blocks[1]!.querySelectorAll('span[style*="--sdm-c: #"]').length).toBeGreaterThan(5), { timeout: 10_000 });
});

it("a block colored once is colored at once when its row mounts again (no plain flash)", async () => {
  const { slot } = manualIdle();
  const a = await mountMd(fence(longCode(51)));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  await slot();
  await vi.waitFor(() => expect(colored(a.el)).toBe(true), { timeout: 10_000 });
  a.unmount();
  const b = await mountMd(fence(longCode(51)));
  expect(colored(b.el)).toBe(true);
});

it("uploads and images are unaffected", async () => {
  const { el, bubble } = await render("see @/tmp/claude-ui-Ab12Cd/u-Xy34Ef/notes.txt and more", ["data:image/png;base64,iVBORw0KGgo="]);
  expect(bubble.querySelector("img")).not.toBeNull();
  expect(bubble.textContent).not.toContain("u-Xy34Ef");
  expect(el.querySelector('[data-testid="attachment"]')).not.toBeNull();
});
