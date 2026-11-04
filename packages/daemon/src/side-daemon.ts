// The Side Daemon of an SSH Side (ADR 0007): outlives the pipe of the Hub. It serves one attached pipe at a time (the newest attach takes
// over) and counts the Grace period while no pipe is attached and no turn runs.
import type { Readable, Writable } from "node:stream";
import type { PushPayload } from "@claude-ui/protocol";
import type { GitRunner } from "./git-runner.ts";
import { runSide, type SideSocket } from "./sides.ts";

export const DEFAULT_GRACE_MS = 30 * 60_000;
export const HEARTBEAT_MS = 15_000;

export function createSideDaemon(o: {
  accept: (ws: SideSocket) => void;
  git?: GitRunner;
  /** A turn runs. A turn that waits on a permission prompt or a question is idle. */
  busy: () => boolean;
  /** At expiry: stops the turns that are still open (they wait for the user), before `exit`. */
  stopIdle: () => Promise<void> | void;
  exit: () => void;
  graceMs?: number;
  heartbeatMs?: number;
  /** How often the Grace period is counted (default 1 s). */
  tickMs?: number;
}) {
  let graceMs = o.graceMs ?? DEFAULT_GRACE_MS;
  let pipe: ReturnType<typeof runSide> | undefined;
  let running = false;
  let idleMs = 0;
  let last = Date.now();
  let expired = false;
  const tick = setInterval(() => {
    const now = Date.now();
    const dt = now - last;
    last = now;
    // A running turn pauses the count; an attached Hub holds it at 0.
    if (pipe || o.busy() || expired) return;
    idleMs += dt;
    if (idleMs >= graceMs) {
      expired = true;
      void Promise.resolve(o.stopIdle()).catch(() => {}).finally(o.exit);
    }
  }, o.tickMs ?? 1000);
  tick.unref();
  return {
    /** The attach seam: the pipe of a Hub (ssh stdio through the bridge, or a stream pair in tests). */
    attach(input: Readable, output: Writable) {
      pipe?.end();
      idleMs = 0;
      const mine: ReturnType<typeof runSide> = (pipe = runSide({
        input,
        output,
        accept: o.accept,
        git: o.git,
        heartbeatMs: o.heartbeatMs ?? HEARTBEAT_MS,
        onGrace: (ms) => (graceMs = ms),
        onEnd: () => {
          if (pipe !== mine) return;
          pipe = undefined;
          idleMs = 0;
          last = Date.now();
        },
      }));
      mine.running(running);
    },
    push: (p: PushPayload) => pipe?.push(p),
    running(on: boolean) {
      running = on;
      pipe?.running(on);
    },
    close: () => (clearInterval(tick), pipe?.end()),
  };
}
