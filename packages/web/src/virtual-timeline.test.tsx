// @vitest-environment jsdom
import type { Part } from "@claude-ui/protocol";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionPane } from "./App.tsx";
import { VirtualTimeline } from "./virtual-timeline.tsx";
import { applyEvent, emptySession, type SessionView } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout: the scroll element (role="log") is 600px high, each timeline item 100px unless `heights` says
// otherwise; scrollHeight follows the rendered list height. A fake ResizeObserver reports sizes when the test resizes.
const VIEWPORT = 600;
let viewport = VIEWPORT;
const heights = new Map<number, number>();
let hidden = false;
const scrollTops = new WeakMap<Element, number>();
const isLog = (el: Element) => el.getAttribute("role") === "log";
const itemHeight = (el: HTMLElement) => (hidden ? 0 : (heights.get(Number(el.dataset.index)) ?? 100));
const logHeight = () => (hidden ? 0 : viewport);
const height = (el: HTMLElement) => (isLog(el) ? logHeight() : el.dataset.index !== undefined ? itemHeight(el) : 0);
const scrollHeight = (log: HTMLElement) => (hidden ? 0 : parseFloat((log.firstElementChild!.firstElementChild as HTMLElement).style.height) + 16);
const maxScroll = (log: HTMLElement) => Math.max(0, scrollHeight(log) - logHeight());
const scrollBehaviors: (string | undefined)[] = [];
const define = (name: string, get: (this: HTMLElement) => unknown) => Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get });
define("clientHeight", function () {
  return isLog(this) ? logHeight() : 0;
});
define("offsetHeight", function () {
  return height(this);
});
define("scrollHeight", function () {
  return isLog(this) ? scrollHeight(this) : 0;
});
Object.defineProperty(HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get() {
    return scrollTops.get(this) ?? 0;
  },
  // Clamped like a browser; a change fires scroll, async like a browser.
  set(v: number) {
    const top = isLog(this) ? Math.min(Math.max(0, v), maxScroll(this)) : v;
    if (top === (scrollTops.get(this) ?? 0)) return;
    scrollTops.set(this, top);
    setTimeout(() => this.dispatchEvent(new Event("scroll")));
  },
});
HTMLElement.prototype.getBoundingClientRect = function () {
  const h = height(this);
  return { x: 0, y: 0, top: 0, left: 0, bottom: h, right: 800, width: h ? 800 : 0, height: h, toJSON() {} };
};
HTMLElement.prototype.scrollTo = function (this: HTMLElement, opts?: ScrollToOptions | number) {
  const { top = 0, behavior } = typeof opts === "object" ? opts : {};
  scrollBehaviors.push(behavior);
  this.scrollTop = top;
} as never;
const observers = new Set<{ cb: ResizeObserverCallback; targets: Set<Element> }>();
globalThis.ResizeObserver = class {
  o: { cb: ResizeObserverCallback; targets: Set<Element> };
  constructor(cb: ResizeObserverCallback) {
    observers.add((this.o = { cb, targets: new Set() }));
  }
  observe(t: Element) {
    this.o.targets.add(t);
  }
  unobserve(t: Element) {
    this.o.targets.delete(t);
  }
  disconnect() {
    this.o.targets.clear();
  }
} as never;
/** The browser reports a new size of `target`. */
const resize = (target: HTMLElement) =>
  act(async () => {
    for (const o of observers)
      if (o.targets.has(target)) o.cb([{ target, borderBoxSize: [{ blockSize: height(target), inlineSize: 800 }] }] as never, null as never);
  });

const noop = () => {};
const user = (i: number): Part => ({ type: "user_text", id: `u${i}`, text: `message ${i}`, images: [] });
const answer = (i: number, text = `answer ${i}`, streaming = false): Part => ({ type: "assistant_text", id: `a${i}`, text, streaming });
const bash = (id: string): Part => ({ type: "tool_call", id, toolUseId: id, tool: "Bash", input: { command: "ls" }, status: "done" });
const view = (parts: Part[], from = emptySession()): SessionView =>
  parts.reduce((s, part) => applyEvent(s, { type: "event", sessionId: "s1", seq: s.lastSeq + 1, part }), from);
/** `n` turns: user message, then answer. */
const turns = (n: number) => Array.from({ length: n }, (_, i) => [user(i), answer(i)]).flat();

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
let props: ComponentProps<typeof SessionPane> | undefined;
beforeEach(() => {
  heights.clear();
  hidden = false;
  viewport = VIEWPORT;
  scrollBehaviors.length = 0;
});
afterEach(() => act(() => root.render(<></>)));

const defaults: ComponentProps<typeof SessionPane> = {
  scrollKey: 0,
  onInserted: noop,
  connected: true,
  session: { id: "s1", cwd: "/tmp", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [] },
  view: emptySession(),
  models: [],
  onModel: noop,
  onMode: noop,
  onEffort: noop,
  onUpload: async () => "",
  onPrompt: async () => {},
  onSearch: async () => [],
  onInterrupt: noop,
  onRewindPreview: async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false }),
  onRewind: async () => {},
  onRespond: noop,
  onAnswer: noop,
};
const render = (over: Partial<ComponentProps<typeof SessionPane>>) => {
  props = { ...defaults, ...props, ...over } as ComponentProps<typeof SessionPane>;
  const p = props;
  return act(async () => root.render(<SessionPane {...p} />));
};
const open = async (v: SessionView) => {
  props = undefined;
  await render({ view: v });
  await settle();
};
/** Lets the virtualizer finish its scroll (it re-aims on animation frames; scroll events are async): until the scroll position holds for 200 ms. */
const settle = async () => {
  for (let i = 0, last = NaN; i < 40; i++) {
    await act(() => new Promise((r) => setTimeout(r, 50)));
    const top = el.querySelector('[role="log"]')?.scrollTop ?? 0;
    if (top === last && i > 3) return;
    last = top;
  }
};
const log = () => el.querySelector<HTMLElement>('[role="log"]')!;
const text = () => log().textContent!;
const userScroll = async (top: number) => {
  await act(async () => log().scrollTo({ top }));
  await settle();
};
/** The scroll-to-bottom button while shown (hidden it stays mounted, inert, for its fade). */
const button = () => el.querySelector<HTMLButtonElement>('[data-testid="scroll-to-bottom"]:not([inert])');
const atBottom = () => log().scrollTop === maxScroll(log());
const lastItem = () => [...log().querySelectorAll<HTMLElement>("[data-index]")].at(-1)!;

it("a 500-item session opens at the bottom, with only the items near the viewport in the DOM, in the log", async () => {
  await open(view(turns(250)));
  expect(log().scrollTop).toBeGreaterThan(0);
  expect(atBottom()).toBe(true);
  expect(text()).toContain("answer 249");
  expect(text()).not.toContain("message 0");
  expect(text()).not.toContain("answer 100");
  expect(button()).toBeNull();
});

it("at the bottom, an appended item keeps the timeline at the bottom", async () => {
  await open(view(turns(100)));
  const before = log().scrollTop;
  await render({ view: view([user(100), answer(100)], props!.view) });
  await settle();
  expect(log().scrollTop).toBeGreaterThan(before);
  expect(atBottom()).toBe(true);
  expect(text()).toContain("answer 100");
});

it("at the bottom, the last item growing (streaming text) keeps the timeline at the bottom", async () => {
  await open(view([...turns(50), answer(50, "start", true)]));
  const before = log().scrollTop;
  await render({ view: view([answer(50, "start and more", true)], props!.view) });
  heights.set(100, 700);
  await resize(lastItem());
  await settle();
  // 600px more content below: the view moved down with it.
  expect(log().scrollTop).toBeGreaterThanOrEqual(before + 600);
  expect(atBottom()).toBe(true);
});

it("scrolled up, new output does not pull the view down; the scroll-to-bottom button takes it to the newest item", async () => {
  await open(view(turns(100)));
  await userScroll(1000);
  const top = log().scrollTop;
  expect(button()).not.toBeNull();
  expect(button()!.getAttribute("aria-label")).toBe("Jump to latest");
  await render({ view: view([user(100), answer(100, "newest")], props!.view) });
  await settle();
  expect(log().scrollTop).toBe(top);
  expect(text()).not.toContain("newest");
  await act(async () => button()!.click());
  await settle();
  expect(atBottom()).toBe(true);
  expect(text()).toContain("newest");
  expect(button()).toBeNull();
  expect(scrollBehaviors).toContain("smooth");
});

it("Jump to latest moves the focus to the prompt box, not to body, when the button turns inert", async () => {
  await open(view(turns(100)));
  await userScroll(1000);
  button()!.focus();
  expect(document.activeElement).toBe(button());
  await act(async () => button()!.click());
  await settle();
  expect(button()).toBeNull();
  expect(document.activeElement).toBe(el.querySelector('textarea[aria-label="Prompt"]'));
});

it("Jump to latest moves the focus to the permission panel's first action when the panel replaces the prompt box", async () => {
  const permission: Part = { type: "permission_request", id: "r1", requestId: "r1", toolUseId: "t1", tool: "Bash", input: { command: "ls" }, suggestions: [], settled: false };
  await open(view([...turns(100), bash("t1"), permission]));
  await userScroll(1000);
  button()!.focus();
  await act(async () => button()!.click());
  await settle();
  expect(button()).toBeNull();
  expect(el.querySelector('textarea[aria-label="Prompt"]')).toBeNull();
  expect(document.activeElement).toBe(el.querySelector('[data-testid="permission-panel"] button'));
});

it("Jump to latest moves the focus to the question panel's first option, not Dismiss (which stops the turn)", async () => {
  const question: Part = { type: "question", id: "q1", requestId: "q1", toolUseId: "t1", questions: [{ question: "Which?", header: "Which", options: [{ label: "npm", description: "" }, { label: "pnpm", description: "" }], multiSelect: false }], settled: false };
  await open(view([...turns(100), bash("t1"), question]));
  await userScroll(1000);
  button()!.focus();
  await act(async () => button()!.click());
  await settle();
  expect(el.querySelector('textarea[aria-label="Prompt"]')).toBeNull();
  expect(document.activeElement).toBe(el.querySelector('[data-testid="question-panel"] input'));
});

it("Jump to latest on a touch screen does not focus the prompt box: the soft keyboard stays closed", async () => {
  const mm = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q.includes("pointer: coarse"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  try {
    await open(view(turns(100)));
    await userScroll(1000);
    await act(async () => button()!.click());
    await settle();
    expect(button()).toBeNull();
    expect(document.activeElement).not.toBe(el.querySelector('textarea[aria-label="Prompt"]'));
  } finally {
    window.matchMedia = mm;
  }
});

it("at the bottom, a 20px scroll up leaves the bottom: new output and a growing last item do not pull the view down", async () => {
  await open(view([...turns(50), answer(50, "start", true)]));
  await userScroll(log().scrollTop - 20);
  const top = log().scrollTop;
  expect(button()).not.toBeNull();
  await render({ view: view([answer(50, "start and more", true)], props!.view) });
  heights.set(100, 700);
  await resize(lastItem());
  await settle();
  expect(log().scrollTop).toBe(top);
  await render({ view: view([user(51), answer(51, "newest")], props!.view) });
  await settle();
  expect(log().scrollTop).toBe(top);
  expect(button()).not.toBeNull();
});

it("the scroll-to-bottom button shows a keyboard focus ring and fades in and out (OpenCode), hidden it is inert", async () => {
  await open(view(turns(100)));
  const hiddenButton = el.querySelector<HTMLButtonElement>('[data-testid="scroll-to-bottom"]');
  expect(hiddenButton?.hasAttribute("inert")).toBe(true);
  expect(hiddenButton!.className).toContain("opacity-0");
  await userScroll(1000);
  expect(button()!.className).toContain("focus-visible:outline-solid");
  expect(button()!.className).toContain("transition-[opacity,scale,translate]");
  expect(button()!.className).toContain("motion-reduce:transition-none");
  expect(button()!.className).not.toContain("opacity-0");
});

it("with reduced motion the scroll-to-bottom button scrolls instantly", async () => {
  const mm = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  try {
    await open(view(turns(100)));
    await userScroll(0);
    scrollBehaviors.length = 0;
    await act(async () => button()!.click());
    await settle();
    expect(atBottom()).toBe(true);
    expect(scrollBehaviors).not.toContain("smooth");
  } finally {
    window.matchMedia = mm;
  }
});

it("a tool card expanded, scrolled out of the rendered window and back, is still expanded", async () => {
  await open(view([...turns(100), bash("b1")]));
  const card = () => el.querySelector<HTMLElement>('[data-testid="tool-card"]');
  await act(async () => card()!.querySelector("button")!.click());
  expect(card()!.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
  await userScroll(0);
  expect(card()).toBeNull();
  await userScroll(maxScroll(log()));
  expect(card()!.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
});

it("an opened compaction summary stays open after it leaves the rendered window", async () => {
  await open(view([{ type: "compaction", id: "c1", summary: "what happened" }, ...turns(100)]));
  await userScroll(0);
  const summary = () => el.querySelector<HTMLDetailsElement>('[data-testid="compaction-summary"]');
  await act(async () => {
    summary()!.open = true;
    summary()!.dispatchEvent(new Event("toggle"));
  });
  await userScroll(maxScroll(log()));
  expect(summary()).toBeNull();
  await userScroll(0);
  expect(summary()!.open).toBe(true);
});

it("palette Rewind on a message far up the timeline scrolls to it and opens its rewind panel", async () => {
  await open(view(turns(100)));
  expect(text()).not.toContain("message 3");
  await render({ rewindTo: "u3" });
  await settle();
  expect(text()).toContain("message 3");
  const panel = el.querySelector('[data-testid="rewind-panel"]')!;
  expect(panel.closest('[data-testid="user-message"]')!.textContent).toContain("message 3");
  const top = log().scrollTop;
  expect(top).toBeLessThan(1000);
  expect(button()).not.toBeNull();
  // New output does not scroll the open panel away.
  await render({ view: view([user(100), answer(100)], props!.view) });
  await settle();
  expect(log().scrollTop).toBe(top);
  expect(el.querySelector('[data-testid="rewind-panel"]')).not.toBeNull();
});

it("at the bottom, the timeline shrinking (a panel below grows: Edit content, a question, the prompt box) keeps it at the bottom (GH-99)", async () => {
  // A tall last item (the pending tool card): the viewport still ends in it, the rendered range does not change.
  heights.set(99, 1000);
  const items = Array.from({ length: 100 }, (_, i) => `item ${i}`);
  await act(async () => root.render(<VirtualTimeline items={items} itemKey={(i) => i} renderItem={(item) => <p>{item}</p>} />));
  await settle();
  await resize(lastItem());
  await settle();
  expect(atBottom()).toBe(true);
  // A shorter viewport is no clamp: the browser fires no scroll event.
  viewport = 197;
  await resize(log());
  await settle();
  expect(atBottom()).toBe(true);
  expect(button()).toBeNull();
});

it("scrolled up, the timeline shrinking leaves the scroll position as it is (GH-99)", async () => {
  await open(view(turns(100)));
  await userScroll(1000);
  viewport = 197;
  await resize(log());
  await settle();
  expect(log().scrollTop).toBe(1000);
  expect(button()).not.toBeNull();
});

it("a hidden tab keeps its measurements and gets its scroll position back when shown again", async () => {
  await open(view(turns(100)));
  await userScroll(2000);
  const before = log().scrollTop;
  const shownText = text();
  hidden = true;
  scrollTops.set(log(), 0); // display: none drops the scroll position, no scroll event
  await resize(log());
  await settle();
  hidden = false;
  await resize(log());
  await settle();
  expect(log().scrollTop).toBe(before);
  expect(text()).toBe(shownText);
});

it("a hidden tab that was at the bottom is at the bottom when shown again, also after new output", async () => {
  await open(view(turns(100)));
  hidden = true;
  await resize(log());
  await render({ view: view([user(100), answer(100, "while hidden")], props!.view) });
  await settle();
  hidden = false;
  await resize(log());
  await settle();
  expect(atBottom()).toBe(true);
  expect(text()).toContain("while hidden");
});

it("the Thinking row stays below the last item while a turn runs", async () => {
  await open(view([...turns(100), { type: "session_state", id: "st", state: "running" }]));
  const thinking = el.querySelector('[data-testid="thinking"]')!;
  expect(log().contains(thinking)).toBe(true);
  expect(lastItem().compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("a rewind that removes later items leaves the timeline at the bottom of what is left", async () => {
  await open(view(turns(100)));
  await render({ view: view([{ type: "rewind", id: "r1", userMessageId: "u60" }], props!.view) });
  // The browser clamps the scroll position to the shorter content and fires scroll.
  await act(async () => log().scrollTo({ top: log().scrollTop }));
  await settle();
  expect(atBottom()).toBe(true);
  expect(button()).toBeNull();
  expect(text()).toContain("answer 59");
  expect(text()).not.toContain("message 60");
});

it("the virtualizer's own re-renders (scroll start and end, a hidden tab shown again and scrolled back) render no item again (GH-51)", async () => {
  const items = Array.from({ length: 100 }, (_, i) => `item ${i}`);
  const rendered: string[] = [];
  const renderItem = (item: string) => (rendered.push(item), <p>{item}</p>);
  await act(async () => root.render(<VirtualTimeline items={items} itemKey={(i) => i} renderItem={renderItem} />));
  await settle();
  expect(rendered).toContain("item 99");
  rendered.length = 0;
  // A few pixels: the same items stay in the window; only the virtualizer re-renders (isScrolling on, then off).
  await userScroll(log().scrollTop - 30);
  expect(rendered).toEqual([]);
});

const sticky = () => el.querySelector<HTMLButtonElement>('[data-testid="sticky-message"]');

it("sticky user message: shows the prompt of the turn in view, switches at the turn boundary, hides at the prompt, click scrolls to it", async () => {
  for (let i = 0; i < 200; i++) heights.set(i, 80);
  await open(view(turns(100)));
  // Items are 80px, like the estimate (+16 padding): item i starts at 16 + 80 * i. Inside turn 40 (user 80, answer 81).
  await userScroll(16 + 80 * 81 + 20);
  expect(sticky()!.getAttribute("aria-label")).toBe("Go to message: message 40");
  // Turn boundary: item 82 is the next prompt.
  await userScroll(16 + 80 * 82 + 20);
  expect(sticky()!.getAttribute("aria-label")).toBe("Go to message: message 41");
  // Prompt itself at the top: nothing stuck.
  await userScroll(16 + 80 * 82);
  expect(sticky()).toBeNull();
  await userScroll(16 + 80 * 85 + 20);
  expect(sticky()!.getAttribute("aria-label")).toBe("Go to message: message 42");
  await act(async () => sticky()!.click());
  await settle();
  expect(log().scrollTop).toBe(16 + 80 * 84);
  expect(sticky()).toBeNull();
  expect(document.activeElement).toBe(log().querySelector('[data-index="84"]'));
  // The Jump to latest button stays separate.
  expect(button()).not.toBeNull();
});

it("sticky user message: none at the bottom, though a prompt is above the viewport (mobile: it covered the short view)", async () => {
  for (let i = 0; i < 200; i++) heights.set(i, 80);
  await open(view(turns(100)));
  expect(atBottom()).toBe(true);
  expect(sticky()).toBeNull();
});

it("sticky user message: hidden while a text field has the focus on a touch screen (on-screen keyboard)", async () => {
  for (let i = 0; i < 200; i++) heights.set(i, 80);
  const matchMedia = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q === "(pointer: coarse)" })) as never;
  const field = document.body.appendChild(document.createElement("textarea"));
  try {
    await open(view(turns(100)));
    await userScroll(16 + 80 * 81 + 20);
    expect(sticky()).not.toBeNull();
    await act(async () => field.focus());
    expect(sticky()).toBeNull();
    await act(async () => field.blur());
    expect(sticky()).not.toBeNull();
  } finally {
    field.remove();
    window.matchMedia = matchMedia;
  }
});

it("a reveal on a pinned timeline leaves the bottom: output arriving with it does not pull it back (palette Messages)", async () => {
  const items = Array.from({ length: 100 }, (_, i) => `item ${i}`);
  const draw = (list: string[], reveal?: { key: string }) =>
    act(async () => root.render(<VirtualTimeline items={list} itemKey={(i) => i} renderItem={(item) => <p>{item}</p>} reveal={reveal} />));
  await draw(items);
  await settle();
  expect(atBottom()).toBe(true);
  // A freshly opened session still replaying: the reveal and a new item arrive before any scroll event unpins the timeline.
  await draw([...items, "item 100"], { key: "item 30" });
  await settle();
  const top = log().scrollTop;
  expect(top).toBeLessThan(maxScroll(log()));
  expect(text()).toContain("item 30");
  await draw([...items, "item 100", "item 101"], { key: "item 30" });
  await settle();
  expect(log().scrollTop).toBe(top);
});

it("a reveal puts the item at the top, or below the sticky bar (56px) when the timeline has one", async () => {
  heights.clear();
  const items = Array.from({ length: 100 }, (_, i) => `item ${i}`);
  const draw = (reveal: { key: string }, withSticky: boolean) =>
    act(async () => root.render(<VirtualTimeline items={items} itemKey={(i) => i} renderItem={(item) => <p>{item}</p>} reveal={reveal} sticky={withSticky ? () => undefined : undefined} />));
  await draw({ key: "item 30" }, false);
  await settle();
  const start = (key: string) => parseFloat(log().querySelector<HTMLElement>(`[data-key="${key}"]`)!.style.transform.replace(/translateY\(|px\)/g, ""));
  expect(log().scrollTop).toBe(start("item 30"));
  await draw({ key: "item 40" }, true);
  await settle();
  expect(log().scrollTop).toBe(start("item 40") - 56);
});

it("the footer of an empty timeline has no top gap; after items it sits 12px below (mt-3)", async () => {
  const draw = (items: string[]) =>
    act(async () => root.render(<VirtualTimeline items={items} itemKey={(i) => i} renderItem={(item) => <p>{item}</p>} footer={<b data-testid="foot">pending</b>} />));
  await draw([]);
  expect(el.querySelector('[data-testid="foot"]')!.parentElement!.className).not.toContain("mt-3");
  await draw(["a", "b"]);
  expect(el.querySelector('[data-testid="foot"]')!.parentElement!.className).toContain("mt-3");
});

// Paging (GH-137): older pages load on scroll up and are prepended without moving the view.
const names = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `item ${from + i}`);
const drawPaged = (list: string[], over: Partial<ComponentProps<typeof VirtualTimeline<string>>> = {}) =>
  act(async () => root.render(<VirtualTimeline items={list} itemKey={(i) => i} renderItem={(item) => <p>{item}</p>} {...over} />));
const startOf = (key: string) => parseFloat(log().querySelector<HTMLElement>(`[data-key="${key}"]`)!.style.transform.replace(/translateY\(|px\)/g, ""));

it("scrolled within one viewport of the top, onReachTop is called; not at the bottom of a long list, and not without older pages", async () => {
  let calls = 0;
  const onReachTop = () => void calls++;
  await drawPaged(names(0, 100), { onReachTop });
  await settle();
  expect(calls).toBe(0);
  await userScroll(2000);
  expect(calls).toBe(0);
  await userScroll(300);
  expect(calls).toBeGreaterThan(0);
  const before = calls;
  await drawPaged(names(0, 100), { onReachTop: undefined });
  await userScroll(100);
  expect(calls).toBe(before);
});

it("onReachTop is not called while the timeline is hidden", async () => {
  let calls = 0;
  hidden = true;
  await drawPaged(names(0, 3), { onReachTop: () => void calls++ });
  await settle();
  expect(calls).toBe(0);
});

it("a page shorter than the viewport asks for the next page at once", async () => {
  let calls = 0;
  await drawPaged(names(0, 3), { onReachTop: () => void calls++ });
  await settle();
  expect(calls).toBeGreaterThan(0);
});

it("prepending 20 items keeps the item in view at the same screen position (no jump)", async () => {
  const onReachTop = () => {};
  await drawPaged(names(20, 70), { onReachTop });
  await userScroll(2000);
  const key = [...log().querySelectorAll<HTMLElement>("[data-key]")].map((n) => n.dataset.key!)[3]!;
  const screenY = startOf(key) - log().scrollTop;
  await drawPaged(names(0, 70), { onReachTop });
  await settle();
  expect(startOf(key) - log().scrollTop).toBe(screenY);
});

it("live output while scrolled up after a prepend does not move the view", async () => {
  const onReachTop = () => {};
  await drawPaged(names(20, 70), { onReachTop });
  await userScroll(2000);
  await drawPaged(names(0, 70), { onReachTop });
  await settle();
  const top = log().scrollTop;
  await drawPaged([...names(0, 70), "item 70"], { onReachTop });
  await settle();
  expect(log().scrollTop).toBe(top);
  expect(button()).not.toBeNull();
});

it("the loading indicator shows while older pages load and is announced politely", async () => {
  await drawPaged(names(0, 100), { loadingOlder: true });
  const status = el.querySelector('[data-testid="loading-older"]')!;
  expect(status.getAttribute("role")).toBe("status");
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(status.textContent).toContain("Loading earlier messages");
  await drawPaged(names(0, 100), { loadingOlder: false });
  expect(el.querySelector('[data-testid="loading-older"]')).toBeNull();
});

// Palette Messages reveal through older pages (GH-137).
const hit = { hit: { messageId: "u7", role: "user" as const, snippet: "" }, query: "message 7" };
it("a content search hit that is not loaded asks for older pages with until, and gives up after a page without it", async () => {
  const asked: ({ until?: string } | undefined)[] = [];
  let shown = 0;
  const older: SessionView = { ...view(turns(3)), older: { before: "u0", pos: 5 } };
  await open(older);
  await render({ revealHit: hit, onLoadOlder: (o) => void asked.push(o), onRevealShown: () => void shown++ });
  await settle();
  // (The short view also asks for its next page by scrolling, without `until`.)
  expect(asked.filter((o) => o?.until)).toEqual([{ until: "u7" }]);
  expect(shown).toBe(0);
  // The page came and still does not hold it: given up.
  await render({ view: { ...older, order: [...older.order] } });
  await settle();
  expect(asked.filter((o) => o?.until)).toHaveLength(1);
  expect(shown).toBe(1);
});

it("a content search hit that is loaded is revealed without asking for pages", async () => {
  const asked: unknown[] = [];
  let shown = 0;
  await open({ ...view(turns(10)), older: { before: "u0", pos: 5 } });
  await render({ revealHit: hit, onLoadOlder: (o) => void asked.push(o), onRevealShown: () => void shown++ });
  await settle();
  expect(asked).toEqual([]);
  expect(shown).toBe(1);
});

it("onReachTop says whether a user scroll caused it, so a failed page can be retried by scrolling", async () => {
  const calls: (boolean | undefined)[] = [];
  await drawPaged(names(0, 100), { onReachTop: (user) => void calls.push(user) });
  await settle();
  expect(calls.filter((c) => c === true)).toEqual([]);
  await userScroll(300);
  expect(calls).toContain(true);
});
