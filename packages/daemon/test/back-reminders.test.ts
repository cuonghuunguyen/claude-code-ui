import { afterEach, expect, it, vi } from "vitest";
import { createBackReminders, due } from "../src/back-reminders.ts";

const m = (partId: string, extra: object = {}) => ({ partId, at: 1, title: "t", ...extra });
afterEach(() => vi.useRealTimers());

it("due picks marks with remindAt <= now and no remindedAt, oldest first", () => {
  const marks = { a: [m("p1", { remindAt: 50 }), m("p2", { remindAt: 10 }), m("p3", { remindAt: 500 }), m("p4", { remindAt: 5, remindedAt: 6 }), m("p5")] };
  expect(due(marks, 100).map((d) => d.mark.partId)).toEqual(["p2", "p1"]);
});

it("the runner fires on the first tick after start and then on each interval, never overlapping", async () => {
  vi.useFakeTimers();
  const marks = { a: [m("p1", { remindAt: 1 })] };
  const fire = vi.fn(async (items: { mark: { partId: string } }[]) => {
    for (const i of items) (marks.a[0] as any).remindedAt = 2, void i;
  });
  const r = createBackReminders({ marks: () => marks, fire, now: () => 100, everyMs: 1000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(fire).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(fire).toHaveBeenCalledTimes(1);
  r.stop();
});
