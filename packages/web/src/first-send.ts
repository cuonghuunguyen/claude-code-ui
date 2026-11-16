// First send of the new-session tab (docs/spec.md "New-session first send"): the timeout of its requests, the timing marks and
// which failures leave the first message possibly taken by the daemon.
import type { PerfClientMark } from "@claude-ui/protocol";

/** Per request of the first send (create, each setting, prompt or command). A false timeout is safe: the retry is idempotent on the daemon. */
export const FIRST_SEND_TIMEOUT_MS = 15_000;

/** Milliseconds since creation (send pressed) of the first time each mark is set. */
export function firstSendMarks(now: () => number = () => performance.now()) {
  const t0 = now();
  const got: Partial<Record<PerfClientMark, number>> = {};
  return {
    mark(name: PerfClientMark) {
      got[name] ??= Math.max(0, Math.round(now() - t0));
    },
    marks: (): Partial<Record<PerfClientMark, number>> => ({ ...got }),
  };
}
export type FirstSendMarks = ReturnType<typeof firstSendMarks>;

/** The request may have reached the daemon: only silence or a dropped socket says nothing. A daemon `error` reply means not taken. */
export const maybeTaken = (e: unknown) => e instanceof Error && (e.message === "timed out" || e.message === "disconnected");
