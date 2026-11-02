// Shake to locate (GH-517): a quick left-right mouse shake scrolls the active tab and sidebar row into view and rings them. Per browser.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePhone } from "./lib/use-narrow.ts";

export const SHAKE = { stroke: 40, reversals: 4, windowMs: 600, cooldownMs: 2000 };
export const RING_MS = 1500;
export type Move = { x: number; t: number; pointerType: string; buttons: number };

/** Feed every pointermove; true once per shake. Stroke = distance between two turning points, each >= SHAKE.stroke. */
export function createShakeDetector(o = SHAKE) {
  let pivot: number | undefined;
  let extreme = 0;
  let dir = 0;
  let times: number[] = [];
  let until = -Infinity;
  const reset = () => {
    pivot = undefined;
    dir = 0;
    times = [];
    return false;
  };
  return (m: Move): boolean => {
    if (m.pointerType !== "mouse" || m.buttons !== 0) return reset();
    if (pivot === undefined) {
      pivot = m.x;
      return false;
    }
    if (dir === 0) {
      if (Math.abs(m.x - pivot) >= o.stroke) {
        dir = Math.sign(m.x - pivot);
        extreme = m.x;
      }
      return false;
    }
    if ((m.x - extreme) * dir > 0) extreme = m.x; // same direction: the stroke grows
    else if ((extreme - m.x) * dir >= o.stroke) {
      // turned back by a full stroke
      times.push(m.t);
      pivot = extreme;
      extreme = m.x;
      dir = -dir;
    }
    times = times.filter((t) => m.t - t <= o.windowMs);
    if (times.length < o.reversals || m.t < until) return false;
    until = m.t + o.cooldownMs;
    reset();
    return true;
  };
}

const KEY = "claude-ui.shakeLocate";
const listeners = new Set<() => void>();
// Storage blocked: the choice lasts while the page is open.
let memory = true;

export function loadShakeLocate(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return memory;
  }
}

export function saveShakeLocate(on: boolean) {
  memory = on;
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "0");
  } catch {
    // See `memory`.
  }
  listeners.forEach((l) => l());
}

export function subscribeShakeLocate(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
export const useShakeLocate = (): boolean => useSyncExternalStore(subscribeShakeLocate, loadShakeLocate, () => true);

const subs = new Set<() => void>();
let detach: (() => void) | undefined;
export function onShake(l: () => void) {
  subs.add(l);
  if (!detach) {
    const detect = createShakeDetector();
    const h = (e: PointerEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return; // dialog or palette open
      if (detect({ x: e.clientX, t: e.timeStamp, pointerType: e.pointerType, buttons: e.buttons })) subs.forEach((s) => s());
    };
    window.addEventListener("pointermove", h, { passive: true });
    detach = () => window.removeEventListener("pointermove", h);
  }
  return () => {
    subs.delete(l);
    if (!subs.size) {
      detach?.();
      detach = undefined;
    }
  };
}

/** Subscribes while the setting is on and the screen is no phone. `fn` may change every render. */
export function useShakeToLocate(fn: () => void) {
  const on = useShakeLocate();
  const phone = usePhone();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => (on && !phone ? onShake(() => ref.current()) : undefined), [on, phone]);
}

const reduced = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** Scrolls `el` into view and rings it for RING_MS. Not rendered or hidden (display:none ancestor): nothing. */
export function ringLocate(el: HTMLElement | null | undefined) {
  if (!el || el.checkVisibility?.() === false) return;
  el.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: reduced() ? "auto" : "smooth" });
  el.setAttribute("data-locate", "");
  setTimeout(() => el.removeAttribute("data-locate"), RING_MS);
}
