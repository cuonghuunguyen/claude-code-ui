// "I'll be back" reminders (docs/spec.md): a 30 s tick over the Back marks; a mark with `remindAt <= now` and no `remindedAt` is due.
// An interval (not setTimeout) survives the 24.8-day timer cap, system sleep and edits with no rescheduling code.
import type { BackMark } from "@claude-ui/protocol";
import type { Marks } from "./back-marks.ts";

export const TICK_MS = 30_000;
export type Due = { sessionId: string; mark: BackMark };

/** Every mark whose reminder is due, oldest `remindAt` first. */
export function due(marks: Marks, now: number): Due[] {
  return Object.entries(marks)
    .flatMap(([sessionId, list]) => list.filter((m) => m.remindAt !== undefined && m.remindAt <= now && m.remindedAt === undefined).map((mark) => ({ sessionId, mark })))
    .sort((a, b) => a.mark.remindAt! - b.mark.remindAt!);
}

/** `fire` gets all marks due in one tick (one grouped push for several). A failing `fire` is logged; the marks are already marked as reminded by it. */
export function createBackReminders(o: { marks: () => Marks; fire: (items: Due[]) => Promise<void> | void; now?: () => number; everyMs?: number }) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    const items = due(o.marks(), (o.now ?? Date.now)());
    if (!items.length) return;
    busy = true;
    try {
      await o.fire(items);
    } catch (e) {
      console.error("back reminder failed:", e);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), o.everyMs ?? TICK_MS);
  timer.unref();
  // The first tick right after start fires reminders that came due while the daemon was down.
  queueMicrotask(() => void tick());
  return { tick, stop: () => clearInterval(timer) };
}
