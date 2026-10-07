// Continue after a usage limit (docs/spec.md "Continue after a usage limit"): sends `continue` to a session its turn's limit stopped, once the limit resets.
import { MAX_TIMER_MS, RESET_GRACE_MS } from "./plan-usage.ts";

export const CONTINUE_PROMPT = "continue";
export const CONTINUE_GAP_MS = 5_000;
export const RETRY_MS = 60_000;
export const MAX_TRIES = 3;
/** A limit hit without a reset time within this long after a sent continue is the same limit again (the CLI throttles its rate_limit_event). */
export const REPEAT_WINDOW_MS = 10 * 60_000;

export function createAutoContinue(o: {
  enabled: () => boolean;
  /** Sends the prompt; false when the session cannot take it (gone, not live, not idle). `wanted()` turns false when the user cancelled meanwhile: send nothing. */
  send: (id: string, wanted: () => boolean) => Promise<boolean>;
  /** Shows (ms) or clears (null) the indicator of session `id`. */
  show: (id: string, at: number | null) => void;
  graceMs?: number;
  gapMs?: number;
  retryMs?: number;
}) {
  const grace = o.graceMs ?? RESET_GRACE_MS;
  const gap = o.gapMs ?? CONTINUE_GAP_MS;
  const retry = o.retryMs ?? RETRY_MS;
  const entries = new Map<string, number>(); // id -> at (ms); insertion order = stop order
  const pending = new Map<string, number>(); // id -> the reset time the schedule is for
  const sent = new Map<string, { resetsAt: number; n: number; at: number }>(); // continues sent per reset time
  const inflight = new Set<string>(); // taken off the schedule, send running
  let timer: NodeJS.Timeout | undefined;

  function arm() {
    clearTimeout(timer);
    if (!entries.size) return;
    const at = Math.min(...entries.values());
    timer = setTimeout(() => void fire(), Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_MS)).unref();
  }

  async function fire() {
    const now = Date.now();
    // Array.sort is stable: equal times keep stop order.
    const due = [...entries].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]);
    const first = due[0];
    if (first) {
      const id = first[0];
      entries.delete(id);
      o.show(id, null);
      for (const [other] of due.slice(1)) {
        entries.set(other, now + gap);
        o.show(other, now + gap);
      }
      arm(); // the others must not wait for the send
      if (o.enabled()) {
        // A try counts when its continue goes out, not when it is scheduled.
        const resetsAt = pending.get(id)!;
        pending.delete(id);
        const prev = sent.get(id);
        sent.set(id, { resetsAt, n: (prev?.resetsAt === resetsAt ? prev.n : 0) + 1, at: now });
        inflight.add(id);
        if (!(await o.send(id, () => inflight.has(id)).catch(() => false))) console.log(`session ${id}: continue after the usage limit not sent (session not idle, gone or cancelled)`);
        inflight.delete(id);
      }
    }
    arm();
  }

  return {
    /** `resetsAt` ms; undefined: the reset time of a continue sent a moment ago, else nothing. Setting off: nothing. */
    schedule(id: string, resetsAt: number | undefined) {
      if (!o.enabled()) return;
      const prev = sent.get(id);
      if (!resetsAt && prev && Date.now() - prev.at < REPEAT_WINDOW_MS) resetsAt = prev.resetsAt;
      if (!resetsAt) return void console.log(`session ${id}: stopped by the usage limit; no reset time known, not scheduled`);
      const repeat = prev?.resetsAt === resetsAt;
      if (repeat && prev.n >= MAX_TRIES) return void console.log(`session ${id}: usage limit still hit after ${MAX_TRIES} continues; giving up`);
      const now = Date.now();
      let at = resetsAt + grace;
      if (repeat) at = Math.max(at, now + retry);
      else if (at <= now) at = now + grace;
      pending.set(id, resetsAt);
      entries.set(id, at);
      o.show(id, at);
      arm();
      console.log(`session ${id}: stopped by the usage limit; continue at ${new Date(at).toISOString()}`);
    },
    /** The user acted (message, Cancel, delete, rewind): drop the schedule, a send still running, and the retry count. */
    cancel(id: string) {
      sent.delete(id);
      pending.delete(id);
      inflight.delete(id);
      if (entries.delete(id)) {
        o.show(id, null);
        arm();
      }
    },
    /** Setting turned off. */
    clear() {
      for (const id of [...entries.keys()]) this.cancel(id);
    },
    /** Test seam. */
    scheduled: () => new Map(entries),
  };
}
