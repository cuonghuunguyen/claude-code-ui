// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPane } from "./App.tsx";
import { markAppScroll, resetScrollRest } from "./scroll-rest.ts";
import { cacheStats, CUT_RETRY_MS, isPainted, limitCache, skewClock, tickClock, pairOf, resetShiki, resetUserCodePaint, RETRY_MS, SCROLL_REST } from "./user-code-paint.ts";
import { UserMarkdown } from "./user-markdown.tsx";
import { applyEvent, emptySession } from "./store.ts";

// Shiki loads can be made to fail (once) to see the painting recover.
const flaky = vi.hoisted(() => ({ create: 0, language: 0, made: 0, cut: 0 }));
/** Only the painter's loads fail (streamdown loads shiki too, at any time). */
const ours = () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const mine = new Error().stack!.includes("user-code-paint");
  Error.stackTraceLimit = limit;
  return mine;
};
vi.mock("shiki", async (orig) => {
  const m = await orig<typeof import("shiki")>();
  return {
    ...m,
    createHighlighter: async (...a: Parameters<typeof m.createHighlighter>) => {
      if (ours() && flaky.create-- > 0) throw new Error("offline");
      if (ours()) flaky.made++;
      const h = await m.createHighlighter(...a);
      // `flaky.cut` grammar calls report that shiki stopped the line at its time limit.
      const get = h.getLanguage.bind(h);
      const seen = new WeakSet<object>();
      h.getLanguage = ((name: never) => {
        const g = get(name) as unknown as { tokenizeLine2: (...x: unknown[]) => { stoppedEarly?: boolean } };
        if (!seen.has(g)) {
          seen.add(g);
          const orig = g.tokenizeLine2.bind(g);
          g.tokenizeLine2 = (...x) => {
            const r = orig(...x);
            return ours() && flaky.cut-- > 0 ? { ...r, stoppedEarly: true } : r;
          };
        }
        return g;
      }) as never;
      const load = h.loadLanguage.bind(h);
      h.loadLanguage = (async (...l: never[]) => {
        if (ours() && flaky.language-- > 0) throw new Error("offline");
        return load(...l);
      }) as never;
      return h;
    },
  };
});

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
/** Completely painted (painting is sliced: a range count says little). */
const painted = (el: Element) => {
  const bs = el.matches('[data-streamdown="code-block"]') ? [el] : blocksOf(el);
  return bs.length > 0 && bs.every((b) => isPainted(b as HTMLElement));
};
const blocksOf = (el: Element) => [...el.querySelectorAll('[data-streamdown="code-block"]')];

const mounted: { unmount: () => void }[] = [];
async function mountMd(text: string) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<UserMarkdown text={text} />));
  await wait(0);
  // The code blocks render a moment later when the machine is busy.
  if (text.includes("```")) await vi.waitFor(() => expect(blocksOf(el).length).toBeGreaterThanOrEqual(text.split("```").length >> 1), { timeout: 10_000 });
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
  flaky.create = flaky.language = flaky.cut = 0;
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
  await slotsUntil(() => painted(block!));
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
  await slotsUntil(() => painted(block!));
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
  await slotsUntil(() => painted(a.el));
  for (let i = 0; i < 10; i++) await slot();
  await wait(50);
  expect(ranges(b.el)).toBe(0);
  expect(ranges(c.el)).toBe(0);
  expect(idle).toHaveLength(0);
  // c scrolls into view: it is painted.
  await show(blocksOf(c.el));
  await slotsUntil(() => painted(c.el));
  expect(ranges(b.el)).toBe(0);
});

it("the same long block twice in one message: both copies are painted", async () => {
  stubPaint();
  const a = await mountMd([fence(longCode(21)), "and again:", fence(longCode(21))].join("\n\n"));
  const both = blocksOf(a.el);
  expect(both).toHaveLength(2);
  await show(both);
  await slotsUntil(() => painted(both[0]!) && painted(both[1]!));
  expect(ranges(both[0]!)).toBe(ranges(both[1]!));
});

const SAMPLES: Record<string, string> = {
  ts: Array.from(
    { length: 6 },
    (_, i) =>
      `export async function handlerE${i}(req: Request<{ id: string }>, opts: Opts = {}): Promise<Result<number>> {\n  const items = await db.query("SELECT * FROM t WHERE id = ?", [req.id]); // row ${i}\n  /* a comment\n     over two lines */\n  return items.length + \`\${opts.x}\`.length;\n}`,
  ).join("\n\n"),
  python: Array.from({ length: 8 }, (_, i) => `class Foo${i}(Base):\n    """Doc\n    more"""\n    def run(self, x: int) -> int:\n        return [y for y in range(x) if y % ${i + 2}]\n\n@decorator\ndef bar${i}():\n    pass`).join("\n\n"),
  json: JSON.stringify(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, { n: i, s: `v${i}`, ok: i % 2 === 0, list: [1, null, "x"] }])), null, 2),
};

it.each(Object.keys(SAMPLES))("the painted colors of a long %s block are the colors of the whole block tokenized at once", async (lang) => {
  stubPaint();
  const code = SAMPLES[lang]!;
  const a = await mountMd(["```" + lang, code, "```"].join("\n"));
  const [block] = blocksOf(a.el);
  await show([block!]);
  await slotsUntil(() => painted(block!));
  const { createHighlighter } = await import("shiki");
  const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
  const h = await createHighlighter({ themes: ["github-light", "github-dark"], langs: [lang], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  const want = h.codeToTokens(code, { lang: lang as never, themes: { light: "github-light", dark: "github-dark" } }).tokens.map((line) =>
    line.flatMap((t) => [...t.content].map((ch) => (ch.trim() ? `${t.htmlStyle?.color}|${t.htmlStyle?.["--shiki-dark"]}` : ""))),
  );
  const lines = [...block!.querySelectorAll("code > span")];
  const got = lines.map((l) => [...(l.textContent === "\n" ? "" : l.textContent!)].map(() => ""));
  for (const hl of highlights.values())
    for (const r of hl) {
      const i = lines.findIndex((l) => l.contains(r.startContainer));
      if (i < 0) continue;
      for (let c = r.startOffset; c < r.endOffset; c++) got[i]![c] = pairOf(hl as never)!;
    }
  let chars = 0, same = 0;
  want.forEach((line, i) => line.forEach((pair, c) => pair && (chars++, got[i]![c] === pair && same++)));
  expect(`${same} of ${chars}`).toBe(`${chars} of ${chars}`);
});

it("a block that leaves the screen drops its ranges after the scroll and is painted again from the cache when it comes back", async () => {
  stubPaint();
  const a = await mountMd(fence(longCode(25)));
  const blocks = blocksOf(a.el);
  await show(blocks);
  await slotsUntil(() => painted(a.el));
  const n = ranges(a.el);
  await show(blocks, false);
  await slotsUntil(() => ranges(a.el) === 0);
  await show(blocks);
  await slotsUntil(() => painted(a.el));
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
  await slotsUntil(() => painted(el));
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
  await slotsUntil(() => painted(a.el));
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
  // From the cache.
  await slotsUntil(() => painted(b.el));
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
  await slotsUntil(() => painted(a.el));
});

it("a scroll of another element (a code block's own scroll) does not count as scrolling the timeline", async () => {
  stubPaint();
  const a = await mountMd(fence(longCode(42)));
  blocksOf(a.el)[0]!.dispatchEvent(new Event("scroll"));
  await show(blocksOf(a.el));
  await slotsUntil(() => painted(a.el));
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
  await slotsUntil(() => painted(blocks[1]!) && painted(blocks[2]!));
  expect(ranges(blocks[0]!)).toBe(0);
});

it("uploads and images are unaffected", async () => {
  const { el, bubble } = await render("see @/tmp/claude-ui-Ab12Cd/u-Xy34Ef/notes.txt and more", ["data:image/png;base64,iVBORw0KGgo="]);
  expect(bubble.querySelector("img")).not.toBeNull();
  expect(bubble.textContent).not.toContain("u-Xy34Ef");
  expect(el.querySelector('[data-testid="attachment"]')).not.toBeNull();
});

/** The lines (indexes) that hold painted ranges of `el`. */
const paintedLines = (el: Element) => {
  const lines = [...el.querySelectorAll("code > span")];
  return new Set([...highlights.values()].flatMap((h) => [...h].map((r) => lines.findIndex((l) => l.contains(r.startContainer))).filter((i) => i >= 0)));
};
const bigCode = (n: number, rows: number) => Array.from({ length: rows }, (_, i) => `export const v${n}_${i} = (x: number) => x + ${i}; // line ${i}`).join("\n");

it("a line that takes too long to tokenize leaves the rest of its block plain; the lines before keep their colors", async () => {
  stubPaint();
  const a = await mountMd(fence(longCode(51)));
  const [block] = blocksOf(a.el);
  await show([block!]);
  await slotsUntil(() => painted(block!));
  const all = paintedLines(block!).size;
  expect(all).toBe(40);
  // The same code in another message, tokenized from scratch, on a clock that makes every line slow after a while.
  resetUserCodePaint();
  const b = await mountMd(fence(longCode(51)));
  const [block2] = blocksOf(b.el);
  await show([block2!]);
  let calls = 0;
  let clock = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => (++calls > 60 ? (clock += 100) : clock));
  try {
    await slotsUntil(() => ranges(block2!) > 0);
    for (let i = 0; i < 20; i++) await slot();
  } finally {
    spy.mockRestore();
  }
  const got = [...paintedLines(block2!)].sort((x, y) => x - y);
  expect(got.length).toBeGreaterThan(0);
  expect(got.length).toBeLessThan(all);
  // The colored lines are the first ones, without a gap; the cut block is not tried again.
  expect(got).toEqual(got.map((_, i) => i));
  const n = ranges(block2!);
  for (let i = 0; i < 5; i++) await slot();
  expect(ranges(block2!)).toBe(n);
});

it("the block nearest the middle of the screen is painted first", async () => {
  stubPaint();
  const order: Node[] = [];
  vi.stubGlobal(
    "Highlight",
    class extends FakeHighlight {
      add(r: StaticRange) {
        order.push(r.startContainer);
        return super.add(r);
      }
    },
  );
  vi.stubGlobal("innerHeight", 1000);
  const a = await mountMd(fence(longCode(61)));
  const b = await mountMd(fence(longCode(62)));
  const c = await mountMd(fence(longCode(63)));
  const at = (m: { el: Element }, top: number) => {
    blocksOf(m.el)[0]!.getBoundingClientRect = () => ({ top, bottom: top + 100, height: 100, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} });
  };
  at(a, 0);
  at(b, 900);
  at(c, 440);
  await show([...blocksOf(a.el), ...blocksOf(b.el), ...blocksOf(c.el)]);
  await slotsUntil(() => painted(a.el) && painted(b.el) && painted(c.el));
  const firstOf = (m: { el: Element }) => order.findIndex((n) => m.el.contains(n));
  expect(firstOf(c)).toBe(0);
  expect(firstOf(a)).toBeGreaterThan(firstOf(c));
  expect(firstOf(b)).toBeGreaterThan(firstOf(a));
});

it("a block with many ranges is painted over several slots, not all at once", async () => {
  stubPaint();
  const a = await mountMd(fence(bigCode(71, 300)));
  const [block] = blocksOf(a.el);
  await show([block!]);
  await slotsUntil(() => painted(block!));
  const total = ranges(block!);
  await show([block!], false);
  await slotsUntil(() => ranges(block!) === 0);
  // From the cache, on a slow machine (every clock read 5 ms later): a slot adds some of the ranges.
  tickClock(5);
  try {
    await show([block!]);
    await slot();
    const first = ranges(block!);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(total);
    // Leaving in the middle of it: the half painted block drops its ranges and comes back whole.
    await show([block!], false);
    await show([block!]);
    await slotsUntil(() => ranges(block!) === total);
  } finally {
    tickClock(0);
  }
});

it("an exception while painting one block does not stop the painting of the others", async () => {
  stubPaint();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let thrown = 0;
  vi.stubGlobal(
    "Highlight",
    class extends FakeHighlight {
      add(r: StaticRange) {
        if (!thrown++) throw new Error("boom");
        return super.add(r);
      }
    },
  );
  const a = await mountMd(fence(longCode(81)));
  const b = await mountMd(fence(longCode(82)));
  await show([...blocksOf(a.el), ...blocksOf(b.el)]);
  await slotsUntil(() => painted(b.el));
  expect(log).toHaveBeenCalled();
  // Later slots still work: a third block that comes on screen is painted.
  const c = await mountMd(fence(longCode(83)));
  await show(blocksOf(c.el));
  await slotsUntil(() => painted(c.el));
  log.mockRestore();
});

it("the token cache is limited by its size, the newest entry stays", async () => {
  stubPaint();
  const a = await mountMd(fence(longCode(91)));
  await show(blocksOf(a.el));
  await slotsUntil(() => painted(a.el));
  const one = cacheStats();
  expect(one.entries).toBe(1);
  expect(one.bytes).toBeGreaterThan(longCode(91).length);
  limitCache(Math.floor(one.bytes * 1.5));
  const b = await mountMd(fence(longCode(92)));
  await show(blocksOf(b.el));
  await slotsUntil(() => painted(b.el));
  expect(cacheStats().entries).toBe(1);
  limitCache(1);
  const c = await mountMd(fence(longCode(93)));
  await show(blocksOf(c.el));
  await slotsUntil(() => painted(c.el));
  expect(cacheStats().entries).toBe(1);
});

/** Timers of the painter's retry waits (3 s and 30 s) are held, to be fired by hand; all others run. */
function holdTimers() {
  const held: (() => void)[] = [];
  const real = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", (fn: () => void, ms?: number, ...rest: unknown[]) => (ms && ms >= 2000 && ours() ? (held.push(fn), 0) : real(fn, ms, ...rest)));
  return held;
}
/** The painter's clock jumps `ms` ahead. */
const later = (ms: number) => {
  skewClock(ms);
  return { skip: skewClock, mockRestore() {} };
};
const fire = (held: (() => void)[]) => act(async () => void held.splice(0).forEach((f) => f()));
/** Like slotsUntil, and fires the held timers (a cold grammar can need a second try of its first line: CUT_RETRY_MS). */
const settle = (held: (() => void)[], clock: { skip: (ms: number) => void }, done: () => boolean) =>
  vi.waitFor(
    async () => {
      if (held.length) {
        clock.skip(CUT_RETRY_MS + 10);
        await fire(held);
      }
      await slot();
      expect(done()).toBe(true);
    },
    { timeout: 10_000, interval: 20 },
  );

it("a language that failed to load is tried again after the wait by its timer, and an early timer arms itself again", async () => {
  stubPaint();
  const held = holdTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  flaky.language = 1;
  const code = Array.from({ length: 40 }, (_, i) => `func f${i}(x int) int { return x + ${i} } // line ${i}`).join("\n");
  const a = await mountMd(["```go", code, "```"].join("\n"));
  const [block] = blocksOf(a.el);
  await show([block!]);
  await vi.waitFor(() => expect(log).toHaveBeenCalled(), { timeout: 10_000 });
  await wait(20);
  for (let i = 0; i < 5; i++) await slot();
  expect(ranges(block!)).toBe(0);
  // No busy retrying while it cools down; one timer waits.
  expect(idle).toHaveLength(0);
  expect(held).toHaveLength(1);
  // The timer fires early: nothing is tried, it waits again.
  await fire(held);
  expect(held).toHaveLength(1);
  expect(idle).toHaveLength(0);
  const spy = later(RETRY_MS + 10);
  try {
    await fire(held);
    await settle(held, spy, () => painted(block!));
    expect(ranges(block!)).toBeGreaterThan(40);
  } finally {
    spy.mockRestore();
    log.mockRestore();
  }
});

it("when shiki itself fails to load the blocks are colored once it loads again", async () => {
  stubPaint();
  const held = holdTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  resetShiki();
  flaky.create = 1;
  const code = Array.from({ length: 40 }, (_, i) => `fn f${i}(x: i32) -> i32 { x + ${i} } // line ${i}`).join("\n");
  const a = await mountMd(["```rust", code, "```"].join("\n"));
  const [block] = blocksOf(a.el);
  await show([block!]);
  await vi.waitFor(() => expect(log).toHaveBeenCalled(), { timeout: 10_000 });
  await wait(20);
  expect(ranges(block!)).toBe(0);
  const spy = later(RETRY_MS + 10);
  try {
    await fire(held);
    await settle(held, spy, () => painted(block!));
  } finally {
    spy.mockRestore();
    log.mockRestore();
  }
});

it("two languages that fail to load at once do not make two highlighters", async () => {
  stubPaint();
  const held = holdTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  resetShiki();
  flaky.made = 0;
  flaky.language = 2;
  const goCode = Array.from({ length: 40 }, (_, i) => `func f${i}(x int) int { return x + ${i} } // line ${i}`).join("\n");
  const rustCode = Array.from({ length: 40 }, (_, i) => `fn f${i}(x: i32) -> i32 { x + ${i} } // line ${i}`).join("\n");
  const a = await mountMd(["```go", goCode, "```", "", "```rust", rustCode, "```"].join("\n"));
  const both = blocksOf(a.el);
  expect(both).toHaveLength(2);
  await show(both);
  await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2), { timeout: 10_000 });
  await wait(20);
  const spy = later(RETRY_MS + 10);
  try {
    await fire(held);
    await settle(held, spy, () => painted(both[0]!) && painted(both[1]!));
    expect(flaky.made).toBe(1);
  } finally {
    spy.mockRestore();
    log.mockRestore();
  }
});

it("a first line that shiki cuts twice is tried again later (not cached as plain); a cut that the second attempt survives colors the block", async () => {
  stubPaint();
  const held = holdTimers();
  // Second attempt succeeds: only the first pass of line 0 is cut.
  flaky.cut = 1;
  const a = await mountMd(fence(longCode(101)));
  await show(blocksOf(a.el));
  await slotsUntil(() => painted(a.el));
  expect(paintedLines(a.el).size).toBe(40);
  expect(cacheStats().entries).toBe(1);
  await show(blocksOf(a.el), false);
  await slotsUntil(() => ranges(a.el) === 0);
  resetUserCodePaint();
  // Both attempts (two theme passes each) are cut: nothing is painted or cached, a timer comes back for it.
  flaky.cut = 4;
  const b = await mountMd(fence(longCode(102)));
  await show(blocksOf(b.el));
  for (let i = 0; i < 5; i++) await slot();
  expect(ranges(b.el)).toBe(0);
  expect(cacheStats().entries).toBe(0);
  expect(held).toHaveLength(1);
  const spy = later(CUT_RETRY_MS + 10);
  try {
    await fire(held);
    await slotsUntil(() => painted(b.el));
    expect(paintedLines(b.el).size).toBe(40);
    expect(cacheStats().entries).toBe(1);
  } finally {
    spy.mockRestore();
  }
});
