// Lifecycle attributes for addon themes (docs/site/features/addon-parts.md "Lifecycle", docs/spec.md "Addon themes and CSS"):
// data-phase, data-just-finished, data-focus-opened, <html data-motion>, <html data-page-hidden>. Derived on the client from the session view, so engine-neutral.
import { useEffect, useRef, useState } from "react";
import type { SessionView } from "./store.ts";

export type Phase = "thinking" | "waiting" | "idle";

/** How long `data-just-finished` and `data-focus-opened` stay: a CSS animation stops when its selector stops matching, so one frame is too short. */
export const HOLD_MS = 1200;

/** `running` (the OpenCode retry row included) is thinking, `needs_input` (permission or question) is waiting, everything else idle. */
export const phaseOf = (view?: Pick<SessionView, "state">): Phase => (view?.state === "running" ? "thinking" : view?.state === "needs_input" ? "waiting" : "idle");

/** True for HOLD_MS after `stamp` changes to a non-zero value; a new stamp restarts the hold. Already true on the first render when the stamp is set. */
export function useHold(stamp: number, ms = HOLD_MS): boolean {
  const [on, setOn] = useState(stamp > 0);
  useEffect(() => {
    if (!stamp) return setOn(false);
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [stamp, ms]);
  return on;
}

/** True for HOLD_MS after the shown session went thinking -> idle; cleared when it runs again. A change of the shown session is not a finish. */
export function useJustFinished(sessionId: string | undefined, phase: Phase): boolean {
  const prev = useRef({ sessionId, phase });
  const [done, setDone] = useState<{ id?: string; n: number }>({ n: 0 });
  useEffect(() => {
    const p = prev.current;
    prev.current = { sessionId, phase };
    if (p.sessionId === sessionId && p.phase === "thinking" && phase === "idle") setDone((d) => ({ id: sessionId, n: d.n + 1 }));
  }, [sessionId, phase]);
  return useHold(done.n) && done.id === sessionId && phase === "idle";
}

const ATTRS = ["data-phase", "data-motion", "data-page-hidden"];

/** `<html>`: data-phase of the shown session, data-motion on|off from prefers-reduced-motion (live), data-page-hidden while the tab is hidden. */
export function useRootLifecycle(phase: Phase) {
  useEffect(() => document.documentElement.setAttribute("data-phase", phase), [phase]);
  useEffect(() => {
    const html = document.documentElement;
    const mql = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
    const motion = () => html.setAttribute("data-motion", mql?.matches ? "off" : "on");
    const hidden = () => html.toggleAttribute("data-page-hidden", document.visibilityState === "hidden");
    motion();
    hidden();
    mql?.addEventListener("change", motion);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mql?.removeEventListener("change", motion);
      document.removeEventListener("visibilitychange", hidden);
      for (const a of ATTRS) html.removeAttribute(a);
    };
  }, []);
}
