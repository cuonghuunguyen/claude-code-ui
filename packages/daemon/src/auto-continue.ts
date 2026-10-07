// Continue after a usage limit (docs/spec.md "Continue after a usage limit"): sends `continue` to a session its turn's limit stopped, once the limit resets.
import { MAX_TIMER_MS, RESET_GRACE_MS } from "./plan-usage.ts";

export const CONTINUE_PROMPT = "continue";
export const CONTINUE_GAP_MS = 5_000;
export const RETRY_MS = 60_000;
export const MAX_TRIES = 3;

export function createAutoContinue(o: {
  enabled: () => boolean;
  /** Sends the prompt; false when the session cannot take it (gone, not live, not idle). */
  send: (id: string) => Promise<boolean>;
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
  const tries = new Map<string, { resetsAt: number; n: number }>();
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
      entries.delete(first[0]);
      o.show(first[0], null);
      for (const [id] of due.slice(1)) {
        entries.set(id, now + gap);
        o.show(id, now + gap);
      }
      arm(); // the others must not wait for the send
      if (o.enabled() && !(await o.send(first[0]).catch(() => false))) console.log(`session ${first[0]}: continue after the usage limit not sent (session not idle or gone)`);
    }
    arm();
  }

  return {
    /** `resetsAt` ms; undefined or setting off: nothing. */
    schedule(id: string, resetsAt: number | undefined) {
      if (!o.enabled()) return;
      if (!resetsAt) return void console.log(`session ${id}: stopped by the usage limit; no reset time known, not scheduled`);
      const prev = tries.get(id);
      const repeat = prev?.resetsAt === resetsAt;
      const n = repeat ? prev.n + 1 : 1;
      if (n > MAX_TRIES) return void console.log(`session ${id}: usage limit still hit after ${MAX_TRIES} continues; giving up`);
      tries.set(id, { resetsAt, n });
      const now = Date.now();
      let at = resetsAt + grace;
      if (repeat) at = Math.max(at, now + retry);
      else if (at <= now) at = now + grace;
      entries.set(id, at);
      o.show(id, at);
      arm();
      console.log(`session ${id}: stopped by the usage limit; continue at ${new Date(at).toISOString()}`);
    },
    /** The user acted (message, Cancel, delete): drop the schedule and the retry count. */
    cancel(id: string) {
      tries.delete(id);
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
