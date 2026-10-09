// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { markAppScroll, resetScrollRest, sinceUserScroll } from "./scroll-rest.ts";

const log = () => {
  const el = document.createElement("div");
  el.setAttribute("role", "log");
  document.body.append(el);
  return el;
};
const scrollTo = (el: Element, top: number) => {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
};
afterEach(() => {
  resetScrollRest();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("a user scroll counts, an instant app scroll that lands where marked does not", () => {
  const el = log();
  markAppScroll(el, 500);
  scrollTo(el, 500);
  expect(sinceUserScroll()).toBe(Infinity);
  scrollTo(el, 200);
  expect(sinceUserScroll()).toBeLessThan(1000);
});

it("the events on the way of a smooth app scroll (Jump to latest) are not user scrolls", () => {
  const el = log();
  markAppScroll(el, 1000, true);
  for (const top of [100, 400, 800, 1000]) scrollTo(el, top);
  expect(sinceUserScroll()).toBe(Infinity);
  // Arrived: the next scroll is the user's.
  scrollTo(el, 600);
  expect(sinceUserScroll()).toBeLessThan(1000);
});

it("the user taking over a smooth app scroll counts from then on", () => {
  const el = log();
  markAppScroll(el, 1000, true);
  scrollTo(el, 300);
  expect(sinceUserScroll()).toBe(Infinity);
  el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  scrollTo(el, 350);
  expect(sinceUserScroll()).toBeLessThan(1000);
});

it("a smooth scroll that never arrives is over after a while", () => {
  const el = log();
  const now = performance.now();
  markAppScroll(el, 1000, true);
  vi.spyOn(performance, "now").mockReturnValue(now + 5000);
  scrollTo(el, 300);
  expect(sinceUserScroll()).toBe(0);
});

const key = (target: Element, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

it("a scrolling key outside a text field ends a smooth app scroll", () => {
  const el = log();
  markAppScroll(el, 1000, true);
  key(document.body, "PageDown");
  scrollTo(el, 300);
  expect(sinceUserScroll()).toBeLessThan(1000);
});

it("typing, or a scrolling key inside a text field, does not end a smooth app scroll", () => {
  const el = log();
  const input = document.createElement("textarea");
  document.body.append(input);
  markAppScroll(el, 1000, true);
  key(input, "ArrowDown");
  key(document.body, "a");
  scrollTo(el, 300);
  expect(sinceUserScroll()).toBe(Infinity);
});
