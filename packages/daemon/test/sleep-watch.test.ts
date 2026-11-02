import { expect, it, vi } from "vitest";
import { createSleepWatch, SLEEP_GAP_MS } from "../src/sleep-watch.ts";

function setup(running = true) {
  let t = 1_000_000;
  let run = running;
  const onSleep = vi.fn();
  const w = createSleepWatch({ now: () => t, running: () => run, onSleep });
  return { w, onSleep, advance: (ms: number) => (t += ms), setRunning: (r: boolean) => (run = r) };
}

it("a gap over 60 s while running reports a sleep", () => {
  const s = setup();
  s.advance(SLEEP_GAP_MS + 1000);
  s.w.check();
  expect(s.onSleep).toHaveBeenCalledExactlyOnceWith({ at: 1_000_000 + SLEEP_GAP_MS + 1000, gapMs: SLEEP_GAP_MS + 1000 });
});

it("no report when nothing ran before the gap", () => {
  const s = setup(false);
  s.advance(10 * SLEEP_GAP_MS);
  s.w.check();
  expect(s.onSleep).not.toHaveBeenCalled();
});

it("60 s exactly is no sleep", () => {
  const s = setup();
  s.advance(SLEEP_GAP_MS);
  s.w.check();
  expect(s.onSleep).not.toHaveBeenCalled();
});

it("running after the gap alone does not count", () => {
  const s = setup(false);
  s.advance(SLEEP_GAP_MS + 1);
  s.setRunning(true);
  s.w.check();
  expect(s.onSleep).not.toHaveBeenCalled();
  // The next gap does: it ran at the previous check.
  s.advance(SLEEP_GAP_MS + 1);
  s.w.check();
  expect(s.onSleep).toHaveBeenCalledOnce();
});
