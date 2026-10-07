// Composer → bubble flight (GH-133): a ghost of the new user bubble flies from the prompt box to the bubble (FLIP, Web Animations API).
import { useLayoutEffect, type RefObject } from "react";

/** `rows`: the bubbles hidden for this flight (the first one it lands on, and copies that mount while it flies). */
type Flight = { text: string; from: DOMRect; at: number; anim?: Animation; rows: HTMLElement[] };
let flight: Flight | undefined;
const MAX_AGE = 1000;
export const FLIGHT_MS = 320;

/** PromptBox: a prompt was sent from this box. */
export function launchFlight(text: string, from: DOMRect | undefined) {
  flight = from ? { text, from, at: performance.now(), rows: [] } : undefined;
}
/** The flight ended or was cancelled: every hidden bubble shows again. */
function release(f: Flight) {
  for (const r of f.rows) r.style.opacity = "";
  f.rows = [];
  if (flight === f) flight = undefined;
}

/** The prompt was not taken (its text went back into the box), or the view changed. `text`: only the flight of that prompt (a late rejection of an older one leaves a newer flight). */
export function cancelFlight(text?: string) {
  const f = flight;
  if (!f || (text !== undefined && f.text !== text)) return;
  f.anim?.cancel();
  release(f);
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Lands the pending flight on `el` (a user message row) when its text matches. Exported for tests. */
export function land(el: HTMLElement | null, text: string) {
  const f = flight;
  if (!el || !f || f.text !== text) return;
  if (performance.now() - f.at > MAX_AGE && !f.rows.length) return void (flight = undefined);
  if (f.rows.length) {
    // Already claimed by an earlier copy of this bubble (in the same commit, or pending → echoed, starting → session tab): show this one when it lands.
    el.style.opacity = "0";
    f.rows.push(el);
    return;
  }
  if (reduced() || typeof el.animate !== "function") return void (flight = undefined);
  el.style.opacity = "0";
  f.rows.push(el);
  // After the commit's other layout effects (the timeline's follow-to-bottom scroll), before paint.
  queueMicrotask(() => {
    if (flight !== f) return void release(f);
    const row = el.querySelector<HTMLElement>(".is-user") ?? el;
    const bubble = row.firstElementChild instanceof HTMLElement ? row.firstElementChild : row;
    const r = row.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "timeline"; // timeline font and size
    ghost.dataset.flight = "";
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, margin: "0", pointerEvents: "none", zIndex: "50", color: getComputedStyle(el).color });
    const copy = row.cloneNode(true) as HTMLElement;
    // The clone must not double the testids that tests and the page count.
    for (const n of [copy, ...copy.querySelectorAll("[data-testid]")]) n.removeAttribute("data-testid");
    ghost.append(copy);
    document.body.append(ghost);
    const dx = f.from.left - b.left;
    const dy = f.from.top - b.top;
    const anim = (f.anim = ghost.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: 0.6 }, { transform: "none", opacity: 1 }], {
      duration: FLIGHT_MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    }));
    void anim.finished.catch(() => {}).finally(() => {
      ghost.remove();
      release(f);
    });
  });
}

/** In a user message row: the row a just-sent prompt lands in. */
export function useLanding(ref: RefObject<HTMLElement | null>, text: string) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only
  useLayoutEffect(() => land(ref.current, text), []);
}
