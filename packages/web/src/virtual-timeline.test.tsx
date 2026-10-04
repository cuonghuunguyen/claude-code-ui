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
const heights = new Map<number, number>();
let hidden = false;
const scrollTops = new WeakMap<Element, number>();
const isLog = (el: Element) => el.getAttribute("role") === "log";
const itemHeight = (el: HTMLElement) => (hidden ? 0 : (heights.get(Number(el.dataset.index)) ?? 100));
const logHeight = () => (hidden ? 0 : VIEWPORT);
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
