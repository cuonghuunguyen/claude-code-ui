// @ts-check
// Tries to read or change things outside its canvas. Each attempt that is blocked is a green bar, each one that works a red bar.
// Expected in the app: all green (the frame is sandboxed, has no bridge requests and no network).
import { call, defineEffect } from "./claude-ui-addon.js";

/** @type {Record<string, boolean | undefined>} attempt -> blocked */
const blocked = {};
/** @param {string} name @param {() => unknown} fn */
const attempt = (name, fn) => {
  try {
    const r = fn();
    if (r instanceof Promise) r.then(() => (blocked[name] = false), () => (blocked[name] = true));
    else blocked[name] = false;
  } catch {
    blocked[name] = true;
  }
};
attempt("parent DOM", () => parent.document.body.textContent);
attempt("storage", () => localStorage.length);
attempt("cookie", () => document.cookie);
attempt("network", () => fetch("https://example.com/"));
attempt("session.read", () => call("session.read"));
attempt("prompt.insert", () => call("prompt.insert", { text: "probe" }));
attempt("toast", () => call("ui.toast", { text: "probe" }));

defineEffect({
  frame(ctx, fx) {
    const names = Object.keys(blocked);
    const w = fx.width / names.length;
    names.forEach((n, i) => {
      ctx.fillStyle = blocked[n] === undefined ? "#888" : blocked[n] ? "#1c9b4a" : "#d0213a";
      ctx.fillRect(i * w + 1, 0, w - 2, 3);
    });
  },
});
