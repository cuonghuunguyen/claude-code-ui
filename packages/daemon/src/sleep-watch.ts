// Sleep detection (GH-518, docs/spec.md "Sleep detection"): a wall-clock gap between two checks means the machine slept.
export const SLEEP_CHECK_MS = 15_000;
export const SLEEP_GAP_MS = 60_000;
/** A sleep older than this is not sent to a new connection (owner decision). */
export const SLEEP_KEEP_MS = 24 * 3600_000;
export type Slept = { at: number; gapMs: number };

export function createSleepWatch({ now = Date.now, running, onSleep }: { now?: () => number; running: () => boolean; onSleep: (s: Slept) => void }) {
  let last = now();
  let was = running();
  return {
    /** Timer tick and each new connection. `was` is the running state of the previous check (the state before the sleep). */
    check() {
      const t = now();
      if (t - last > SLEEP_GAP_MS && was) onSleep({ at: t, gapMs: t - last });
      last = t;
      was = running();
    },
  };
}
