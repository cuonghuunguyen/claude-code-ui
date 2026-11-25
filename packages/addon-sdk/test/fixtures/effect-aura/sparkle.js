// @ts-check
// Full-window layer while a turn runs (`data-phase="thinking"`): drifting sparks. Clicks, scroll and typing must keep working underneath.
import { defineEffect } from "./claude-ui-addon.js";

const SPARKS = 60;
const seeds = Array.from({ length: SPARKS }, (_, i) => ({ x: (i * 0.618) % 1, y: (i * 0.377) % 1, s: 0.3 + ((i * 0.29) % 1) * 0.7 }));

defineEffect({
  frame(ctx, fx) {
    ctx.fillStyle = fx.colors.primary;
    for (const p of seeds) {
      const y = (p.y - fx.time * 0.05 * p.s + 1) % 1;
      ctx.globalAlpha = 0.25 + 0.5 * p.s;
      ctx.beginPath();
      ctx.arc(p.x * fx.width, y * fx.height, 1.5 * p.s + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  },
});
