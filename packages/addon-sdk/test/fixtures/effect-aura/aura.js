// @ts-check
// A billowing flame around the target box: 140 points on the rounded outline, pushed outwards by layered sine noise; 3 paths per frame
// (outer glow, body, core). Typing (input pulses) raises the flame for a moment.
import { defineEffect } from "./claude-ui-addon.js";

const POINTS = 140;
const RADIUS = 12;
let boost = 0;

/** @typedef {[x: number, y: number, nx: number, ny: number]} Point */
/**
 * The point at `u` (0..1) along a rounded rectangle, with its outward normal.
 * @param {number} u @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r
 * @returns {Point}
 */
function outline(u, x, y, w, h, r) {
  const straight = 2 * (w - 2 * r) + 2 * (h - 2 * r);
  const arc = (Math.PI / 2) * r;
  let d = u * (straight + 4 * arc);
  /** @type {[number, (s: number) => Point][]} */
  const segs = [
    [w - 2 * r, (s) => [x + r + s, y, 0, -1]],
    [arc, (s) => corner(x + w - r, y + r, -Math.PI / 2 + s / r)],
    [h - 2 * r, (s) => [x + w, y + r + s, 1, 0]],
    [arc, (s) => corner(x + w - r, y + h - r, s / r)],
    [w - 2 * r, (s) => [x + w - r - s, y + h, 0, 1]],
    [arc, (s) => corner(x + r, y + h - r, Math.PI / 2 + s / r)],
    [h - 2 * r, (s) => [x, y + h - r - s, -1, 0]],
    [arc, (s) => corner(x + r, y + r, Math.PI + s / r)],
  ];
  for (const [len, at] of segs) {
    if (d <= len) return at(d);
    d -= len;
  }
  return segs[0][1](0);
  /** @param {number} cx @param {number} cy @param {number} a @returns {Point} */
  function corner(cx, cy, a) {
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.cos(a), Math.sin(a)];
  }
}

/** @param {number} u @param {number} t */
const noise = (u, t) => 0.5 + 0.25 * Math.sin(u * 37 + t * 3.1) + 0.15 * Math.sin(u * 91 - t * 5.3) + 0.1 * Math.sin(u * 173 + t * 8.7);

defineEffect({
  pulse(name) {
    if (name === "input") boost = Math.min(1, boost + 0.25);
  },
  frame(ctx, fx) {
    boost = Math.max(0, boost - fx.dt * 1.5);
    const { bleed: b, rect, time: t } = fx;
    const r = Math.min(RADIUS, rect.w / 2, rect.h / 2);
    const reach = (b - 4) * (0.55 + 0.45 * boost);
    const layers = [
      { k: 1, alpha: 0.18, blur: 14 },
      { k: 0.7, alpha: 0.35, blur: 6 },
      { k: 0.35, alpha: 0.8, blur: 0 },
    ];
    ctx.globalCompositeOperation = "lighter";
    for (const { k, alpha, blur } of layers) {
      ctx.beginPath();
      for (let i = 0; i <= POINTS; i++) {
        const u = i / POINTS;
        const [px, py, nx, ny] = outline(u, b, b, rect.w, rect.h, r);
        const lift = reach * k * noise(u, t + k);
        i ? ctx.lineTo(px + nx * lift, py + ny * lift) : ctx.moveTo(px + nx * lift, py + ny * lift);
      }
      ctx.closePath();
      ctx.shadowColor = fx.colors.primary;
      ctx.shadowBlur = blur;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fx.colors.primary;
      ctx.fill();
    }
    // Cut the target box out: the flame stays outside the prompt box.
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.roundRect(b, b, rect.w, rect.h, r);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  },
});
