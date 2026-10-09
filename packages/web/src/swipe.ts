// Swipe gestures (docs: development-docs/GH-209/plan.md): a pure state machine with no DOM, fed with pointer samples.
// A row of the phone tab switcher closes on a LEFT swipe (iOS Safari's tab overview); the switcher button moves to the previous/next tab on a vertical swipe.
// One touch locks to one axis after ~10 px and never changes it, so it never both closes and switches.

export type Sample = { x: number; y: number; t: number };

export type SwipeConfig = {
  /** Movement before the direction locks (px). */
  slop: number;
  /** One component must beat the other by this factor to lock; a diagonal in between waits until 2x slop. */
  lockRatio: number;
  /** Commit when the offset passes this share of the element's size, but at least `commitMin` px. */
  commitFraction: number;
  commitMin: number;
  /** Or commit on a flick: speed over the last 80 ms (px/ms) and a minimum distance (px). */
  flickVelocity: number;
  flickMin: number;
  /** The axis the element reacts to; the other one is left to the browser. */
  axis: "x" | "y";
  /** Which offset signs may commit; the other side rubber-bands and never commits. */
  allow: "negative" | "positive" | "both" | "none";
  /** Largest shown offset on a blocked side (px). */
  rubberLimit: number;
};

export const ROW_SWIPE: SwipeConfig = { slop: 10, lockRatio: 1.2, commitFraction: 0.4, commitMin: 64, flickVelocity: 0.5, flickMin: 24, axis: "x", allow: "negative", rubberLimit: 16 };

/** Right-to-left layouts mirror the horizontal close direction (iOS mirrors swipe actions). */
export const mirror = (a: SwipeConfig["allow"]): SwipeConfig["allow"] => (a === "negative" ? "positive" : a === "positive" ? "negative" : a);

/** A blocked side follows the finger by less and less, up to `limit` (px). */
export const rubber = (offset: number, limit: number) => (offset === 0 ? 0 : Math.sign(offset) * limit * (1 - 1 / (Math.abs(offset) / limit + 1)));

/** The content fades to half while it leaves. */
export const opacityFor = (offset: number, size: number) => 1 - 0.5 * Math.min(1, Math.abs(offset) / (size || 1));

export type SwipeState =
  | { phase: "idle" }
  | { phase: "pending"; start: Sample; samples: Sample[] }
  /** The touch went the other way (vertical on a row): the browser has it. */
  | { phase: "ignored"; start: Sample }
  /** `offset` is what to draw (rubber-banded on a blocked side); `raw` the finger's distance past the slop. */
  | { phase: "dragging"; start: Sample; samples: Sample[]; raw: number; offset: number; blocked: boolean }
  | { phase: "tap" }
  | { phase: "cancelled" }
  | { phase: "settling" }
  | { phase: "committed"; dir: -1 | 1 };

export type SwipeAction = { type: "down"; p: Sample } | { type: "move"; p: Sample } | { type: "up"; p: Sample } | { type: "cancel" };

const TAP_MS = 500;
const VELOCITY_WINDOW_MS = 80;

const allowed = (cfg: SwipeConfig, sign: number) => cfg.allow === "both" || (cfg.allow === "negative" && sign < 0) || (cfg.allow === "positive" && sign > 0);
const along = (cfg: SwipeConfig, from: Sample, p: Sample) => (cfg.axis === "x" ? p.x - from.x : p.y - from.y);

function drag(cfg: SwipeConfig, start: Sample, samples: Sample[], p: Sample): SwipeState {
  const d = along(cfg, start, p);
  const raw = Math.abs(d) > cfg.slop ? d - Math.sign(d) * cfg.slop : 0;
  const blocked = raw !== 0 && !allowed(cfg, raw);
  return { phase: "dragging", start, samples: [...samples, p], raw, offset: blocked ? rubber(raw, cfg.rubberLimit) : raw, blocked };
}

/** Speed along the axis over the last 80 ms of samples (px/ms, signed). */
function velocity(cfg: SwipeConfig, samples: Sample[]) {
  const last = samples.at(-1)!;
  const first = samples.find((s) => last.t - s.t <= VELOCITY_WINDOW_MS) ?? last;
  return last.t > first.t ? (along(cfg, first, last)) / (last.t - first.t) : 0;
}

export function swipe(state: SwipeState, a: SwipeAction, cfg: SwipeConfig, size: number): SwipeState {
  if (a.type === "down") return { phase: "pending", start: a.p, samples: [a.p] };
  if (a.type === "cancel") return state.phase === "idle" ? state : { phase: "settling" };
  if (a.type === "move") {
    if (state.phase === "pending") {
      const dx = a.p.x - state.start.x;
      const dy = a.p.y - state.start.y;
      const [ax, ay] = [Math.abs(dx), Math.abs(dy)];
      const big = Math.max(ax, ay);
      if (big < cfg.slop) return { ...state, samples: [...state.samples, a.p] };
      const lock = ax >= cfg.lockRatio * ay ? "x" : ay >= cfg.lockRatio * ax ? "y" : big < 2 * cfg.slop ? undefined : ax > ay ? "x" : "y";
      if (!lock) return { ...state, samples: [...state.samples, a.p] };
      return lock === cfg.axis ? drag(cfg, state.start, state.samples, a.p) : { phase: "ignored", start: state.start };
    }
    if (state.phase === "dragging") return drag(cfg, state.start, state.samples, a.p);
    return state;
  }
  // up
  if (state.phase === "pending") return { phase: a.p.t - state.start.t < TAP_MS ? "tap" : "cancelled" } as SwipeState;
  if (state.phase === "ignored") return { phase: "cancelled" };
  if (state.phase !== "dragging") return state;
  const end = drag(cfg, state.start, state.samples, a.p);
  if (end.phase !== "dragging" || end.blocked || end.raw === 0) return { phase: "settling" };
  const sign = Math.sign(end.raw) as -1 | 1;
  const far = Math.abs(end.raw) >= Math.max(cfg.commitMin, cfg.commitFraction * size);
  const v = velocity(cfg, end.samples);
  const flick = Math.abs(v) >= cfg.flickVelocity && Math.sign(v) === sign && Math.abs(end.raw) >= cfg.flickMin;
  return far || flick ? { phase: "committed", dir: sign } : { phase: "settling" };
}
