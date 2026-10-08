// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPane } from "./App.tsx";
import { markAppScroll, resetScrollRest } from "./scroll-rest.ts";
import { resetUserCodePaint, SCROLL_REST } from "./user-code-paint.ts";
import { UserMarkdown } from "./user-markdown.tsx";
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

// Long blocks: plain DOM, colors painted with the CSS Custom Highlight API. jsdom has neither that nor IntersectionObserver.
class FakeHighlight extends Set<StaticRange> {}
let views: { cb: IntersectionObserverCallback; els: Set<Element> }[] = [];
class FakeIO {
  v = { cb: (() => {}) as IntersectionObserverCallback, els: new Set<Element>() };
  constructor(cb: IntersectionObserverCallback) {
    this.v.cb = cb;
    views.push(this.v);
  }
  observe(el: Element) {
    this.v.els.add(el);
  }
  unobserve(el: Element) {
    this.v.els.delete(el);
  }
  disconnect() {}
}
let highlights = new Map<string, FakeHighlight>();
/** Idle slots by hand: `slot()` runs the oldest idle callback the way the browser would (a generous deadline). */
let idle: ((d: IdleDeadline) => void)[] = [];
const slot = () => act(async () => void idle.shift()?.({ didTimeout: false, timeRemaining: () => 50 }));
function stubPaint() {
  views = [];
  idle = [];
  highlights = new Map();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("IntersectionObserver", FakeIO);
  vi.stubGlobal("CSS", { ...globalThis.CSS, escape: (s: string) => s, highlights });
  vi.stubGlobal("requestIdleCallback", (cb: (d: IdleDeadline) => void) => idle.push(cb));
}
/** The blocks come on screen (`on`) or leave it. */
const show = (blocks: Element[], on = true) =>
  act(async () => {
    for (const v of views) {
      const entries = blocks.filter((b) => v.els.has(b)).map((target) => ({ target, isIntersecting: on }) as unknown as IntersectionObserverEntry);
      if (entries.length) v.cb(entries, {} as IntersectionObserver);
    }
  });
/** Painted ranges over the text of `el`. */
const ranges = (el: Element) => [...highlights.values()].reduce((n, h) => n + [...h].filter((r) => el.contains(r.startContainer)).length, 0);
/** Runs idle slots until `done` holds (shiki loads asynchronously first). */
async function slotsUntil(done: () => boolean) {
  await vi.waitFor(
    async () => {
      await slot();
      expect(done()).toBe(true);
    },
    { timeout: 10_000, interval: 20 },
  );
}
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
const blocksOf = (el: Element) => [...el.querySelectorAll('[data-streamdown="code-block"]')];

const mounted: { unmount: () => void }[] = [];
async function mountMd(text: string) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<UserMarkdown text={text} />));
  await wait(0);
  const m = { el, unmount: () => (root.unmount(), el.remove()) };
  mounted.push(m);
  return m;
}
const timeline = () => {
  const log = document.createElement("div");
  log.setAttribute("role", "log");
  document.body.append(log);
  mounted.push({ unmount: () => log.remove() });
  return log;
};
afterEach(async () => {
  mounted.splice(0).forEach((m) => m.unmount());
  resetUserCodePaint();
  resetScrollRest();
  vi.unstubAllGlobals();
});

it("a long code block stays plain DOM; once on screen and idle its colors are painted over the same text nodes", async () => {
  stubPaint();
  const { bubble } = await render(fence(longCode(1)));
  const [block] = blocksOf(bubble);
  expect(block!.textContent).toContain("export const v1_0");
  const texts = () => [...block!.querySelectorAll("code > span")].map((l) => l.firstChild?.firstChild);
  const before = texts();
  await wait(300);
  await slot();
  // Not on screen yet: nothing painted, no colored spans.
  expect(ranges(block!)).toBe(0);
  await show([block!]);
  await slotsUntil(() => ranges(block!) > 40);
  expect(bubble.querySelectorAll(TOKENS)).toHaveLength(0);
  // Same text nodes: a selection inside the block does not move when the colors arrive.
  expect(texts().every((t, i) => t === before[i])).toBe(true);
});

it("a selection in a plain block stays the same when the block is painted", async () => {
  stubPaint();
  const a = await mountMd(fence(longCode(2)));
  const [block] = blocksOf(a.el);
  const lines = [...block!.querySelectorAll("code > span")];
  const sel = getSelection()!;
  const range = document.createRange();
  range.setStart(lines[2]!.firstChild!.firstChild!, 3);
  range.setEnd(lines[9]!.firstChild!.firstChild!, 7);
  sel.removeAllRanges();
  sel.addRange(range);
  const text = sel.toString();
  await show([block!]);
  await slotsUntil(() => ranges(block!) > 40);
  expect(sel.rangeCount).toBe(1);
  expect(sel.toString()).toBe(text);
  expect(sel.getRangeAt(0).startContainer).toBe(lines[2]!.firstChild!.firstChild);
  sel.removeAllRanges();
});

it("only the blocks on screen are painted, not the rows mounted around them (overscan)", async () => {
  stubPaint();
  const a = await mountMd(fence(longCode(11)));
  const b = await mountMd(fence(longCode(12)));
  const c = await mountMd(fence(longCode(13)));
  // All three rows are mounted; only the first is on screen. A queue in mount order (FIFO or newest first) paints b or c.
  await show(blocksOf(a.el));
  await slotsUntil(() => ranges(a.el) > 40);
  for (let i = 0; i < 10; i++) await slot();
  await wait(50);
  expect(ranges(b.el)).toBe(0);
  expect(ranges(c.el)).toBe(0);
  expect(idle).toHaveLength(0);
  // c scrolls into view: it is painted.
  await show(blocksOf(c.el));
  await slotsUntil(() => ranges(c.el) > 40);
  expect(ranges(b.el)).toBe(0);
});

it("the same long block twice in one message: both copies are painted", async () => {
  stubPaint();
  const a = await mountMd([fence(longCode(21)), "and again:", fence(longCode(21))].join("\n\n"));
  const both = blocksOf(a.el);
  expect(both).toHaveLength(2);
  await show(both);
  await slotsUntil(() => ranges(both[0]!) > 40 && ranges(both[1]!) > 40);
  expect(ranges(both[0]!)).toBe(ranges(both[1]!));
});

it("a block that leaves the screen drops its ranges after the scroll and is painted again from the cache when it comes back", async () => {
  stubPaint();
  const a = await mountMd(fence(longCode(25)));
  const blocks = blocksOf(a.el);
  await show(blocks);
  await slotsUntil(() => ranges(a.el) > 40);
  const n = ranges(a.el);
  await show(blocks, false);
  await slotsUntil(() => ranges(a.el) === 0);
  await show(blocks);
  await slot();
  expect(ranges(a.el)).toBe(n);
});

it("a message whose code changes is painted for the new code", async () => {
  stubPaint();
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  mounted.push({ unmount: () => (root.unmount(), el.remove()) });
  await act(async () => root.render(<UserMarkdown text={fence(longCode(26))} />));
  await wait(0);
  await show(blocksOf(el));
  await slotsUntil(() => ranges(el) > 40);
  await act(async () => root.render(<UserMarkdown text={fence(longCode(27) + "\nconst extra = 1;")} />));
  await wait(0);
  await show(blocksOf(el));
  await slotsUntil(() => [...highlights.values()].some((h) => [...h].some((r) => r.startContainer.isConnected && r.startContainer.textContent!.includes("extra"))));
});

it("a row that mounts again while the user scrolls renders no colored spans and is painted only after the scroll rests", async () => {
  stubPaint();
  const log = timeline();
  const a = await mountMd(fence(longCode(31)));
  await show(blocksOf(a.el));
  await slotsUntil(() => ranges(a.el) > 40);
  a.unmount();
  // The user scrolls the timeline (no wheel or key event: a scrollbar drag or a touch fling) and the row comes back.
  log.dispatchEvent(new Event("scroll"));
  const b = await mountMd(fence(longCode(31)));
  expect(b.el.querySelectorAll(TOKENS)).toHaveLength(0);
  await show(blocksOf(b.el));
  await slot();
  await wait(100);
  await slot();
  expect(ranges(b.el)).toBe(0);
  await wait(SCROLL_REST + 50);
  // From the cache: one slot paints it.
  await slot();
  expect(ranges(b.el)).toBeGreaterThan(40);
  // The gone row's ranges are dropped.
  expect(ranges(a.el)).toBe(0);
});

it("the app's own scroll (following a streaming turn) and typing do not hold the painting back", async () => {
  stubPaint();
  const log = timeline();
  const a = await mountMd(fence(longCode(41)));
  markAppScroll(log);
  log.dispatchEvent(new Event("scroll"));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  await show(blocksOf(a.el));
  await slotsUntil(() => ranges(a.el) > 40);
});

it("a scroll of another element (a code block's own scroll) does not count as scrolling the timeline", async () => {
  stubPaint();
  const a = await mountMd(fence(longCode(42)));
  blocksOf(a.el)[0]!.dispatchEvent(new Event("scroll"));
  await show(blocksOf(a.el));
  await slotsUntil(() => ranges(a.el) > 40);
});

it("a message colors the first 1200 characters of its code at once, the rest is painted", async () => {
  stubPaint();
  const small = (n: number) => fence(`${"x".repeat(5)}${n}\n` + "const a = 1;\n".repeat(80));
  const a = await mountMd([small(1), small(2), small(3)].join("\n\n"));
  const blocks = blocksOf(a.el);
  expect(blocks).toHaveLength(3);
  await vi.waitFor(() => expect(blocks[0]!.querySelectorAll('span[style*="--sdm-c: #"]').length).toBeGreaterThan(5), { timeout: 10_000 });
  expect(blocks[1]!.querySelectorAll('span[style*="--sdm-c: #"]')).toHaveLength(0);
  expect(blocks[2]!.querySelectorAll('span[style*="--sdm-c: #"]')).toHaveLength(0);
  await show(blocks);
  await slotsUntil(() => ranges(blocks[1]!) > 40 && ranges(blocks[2]!) > 40);
  expect(ranges(blocks[0]!)).toBe(0);
});

it("uploads and images are unaffected", async () => {
  const { el, bubble } = await render("see @/tmp/claude-ui-Ab12Cd/u-Xy34Ef/notes.txt and more", ["data:image/png;base64,iVBORw0KGgo="]);
  expect(bubble.querySelector("img")).not.toBeNull();
  expect(bubble.textContent).not.toContain("u-Xy34Ef");
  expect(el.querySelector('[data-testid="attachment"]')).not.toBeNull();
});
