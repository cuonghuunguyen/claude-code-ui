import { expect, it } from "vitest";
import { NEAR_END, SCROLL_START, SLOP, scrolled, type Scroll } from "./hide-on-scroll.ts";

const run = (steps: [top: number, toEnd?: number, keep?: boolean][], from: Scroll = SCROLL_START) => steps.reduce((s, [top, toEnd = 1000, keep = false]) => scrolled(s, top, toEnd, keep), from);

it("scrolling up past the slop hides the dock; a small wobble does not", () => {
  expect(run([[500], [500 - SLOP + 1]]).hidden).toBe(false);
  expect(run([[500], [500 - SLOP]]).hidden).toBe(true);
});

it("scrolling down past the slop brings it back; a small nudge down keeps it hidden", () => {
  const hidden = run([[500], [400]]);
  expect(hidden.hidden).toBe(true);
  expect(run([[400 + SLOP - 1]], hidden).hidden).toBe(true);
  expect(run([[400 + SLOP]], hidden).hidden).toBe(false);
});

it("a change of direction starts counting again from where it turned", () => {
  // Up 100 (hidden), down 10 (still hidden), up again: stays hidden; down 30 from the turn shows it.
  let s = run([[500], [400], [410], [390]]);
  expect(s.hidden).toBe(true);
  s = run([[420], [450]], s);
  expect(s.hidden).toBe(false);
});

it("within NEAR_END of the end, or when kept, the dock is shown whatever the direction", () => {
  const hidden = run([[500], [300]]);
  expect(run([[290, NEAR_END - 1]], hidden).hidden).toBe(false);
  expect(run([[280, 1000, true]], hidden).hidden).toBe(false);
});
