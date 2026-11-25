// claude-ui addon SDK, bridge v1 (docs/site/features/addons.md). MIT license.
// Copy this file and claude-ui-addon.d.ts into your addon folder and import it from your view's script. No build.
// Types: add `// @ts-check` to your script; the editor reads claude-ui-addon.d.ts next to this file.
// Every request carries an id and the host answers with the same id. The frame has no token, cookie or storage.

const pending = new Map();
const handlers = new Map();
let n = 0;

/** A refused or invalid request. `code`: "refused" (capability not approved or not available here), "bad_request", "unknown" (no such request). */
export class AddonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AddonError";
    this.code = code;
  }
}

addEventListener("message", (e) => {
  // Only the host: any other frame of the page (another addon, an Artifact preview) can post here too.
  if (e.source !== parent) return;
  const m = e.data;
  if (!m || m.v !== 1) return;
  if (typeof m.id === "string" && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    return m.ok ? resolve(m.result) : reject(new AddonError(m.error?.code ?? "unknown", m.error?.message ?? "request failed"));
  }
  // Native form controls and scrollbars follow the app's light or dark mode.
  if (m.type === "init" || m.type === "theme.changed") document.documentElement.style.colorScheme = m.mode;
  for (const fn of handlers.get(m.type) ?? []) fn(m);
});

/** Sends a request to the host. Resolves with its result; rejects with an AddonError. */
export function call(type, payload = {}) {
  const id = `r${++n}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ ...payload, v: 1, id, type }, "*"); // opaque origin: "*" is the only target
  });
}

/** Handles an event the host pushes. Returns a function that removes the handler. */
export function on(type, fn) {
  const set = handlers.get(type) ?? new Set();
  handlers.set(type, set.add(fn));
  return () => void set.delete(fn);
}

/** Tells the host the frame height (band, renderer). No capability. */
export const ready = (height) => call("ui.ready", height === undefined ? {} : { height });
/** The parts of the session the frame is shown in. Needs `session.read`. */
export const readSession = () => call("session.read").then((r) => r.parts);
/** Puts text in the prompt box; never sends it. Needs `prompt.insert`. */
export const insertPrompt = (text) => call("prompt.insert", { text });
/** Sets this addon's status bar text for the session; `null` clears it. Needs `ui.status`. */
export const setStatus = (text) => call("ui.status", { text });
/** Shows a toast `<addon>: <text>`. Needs `ui.toast`. */
export const toast = (text) => call("ui.toast", { text });
/** Writes a line to this addon's log in the Addons dialog; `level` "info" (default), "warn" or "error". Needs `log`. */
export const log = (text, level = "info") => call("log", { level, text });

/** Posts an effect message (`effect.ready`, `effect.done`, `effect.frameCost`) to the host. Not a request: no id, no reply. */
const effectPost = (type, payload = {}) => parent.postMessage({ ...payload, v: 1, type }, "*");

/**
 * Runs an effect (capability `ui.effect`): a canvas over the whole frame, sized to the target plus its bleed at the host's pixel ratio.
 * `frame(ctx, fx)` draws one frame in CSS pixels (the target box is at `fx.bleed`, `fx.bleed`, size `fx.rect`). It runs every animation frame,
 * stops while the host pauses the effect, and runs once per change when `fx.motion` is false (reduced motion). Reports the mean cost per frame every 2 s.
 * `fade` (optional, may return a promise): the host is about to remove the frame; the default fades the canvas out in 300 ms. Returns a function that stops it.
 */
export function defineEffect(hooks) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;display:block";
  document.documentElement.style.background = "transparent";
  document.body.style.margin = "0";
  document.body.style.background = "transparent";
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  const fx = { width: 0, height: 0, bleed: 0, rect: { w: 0, h: 0 }, dpr: 1, theme: "dark", colors: {}, motion: true, state: { "focus-within": false, hover: false, attrs: {} }, time: 0, dt: 0 };
  let started = false;
  let paused = false;
  let fading = false;
  let raf = 0;
  let last = 0;
  let t0 = 0;
  let cost = 0;
  let frames = 0;
  let reported = 0;
  const size = () => {
    fx.width = fx.rect.w + 2 * fx.bleed;
    fx.height = fx.rect.h + 2 * fx.bleed;
    canvas.width = Math.max(1, Math.round(fx.width * fx.dpr));
    canvas.height = Math.max(1, Math.round(fx.height * fx.dpr));
  };
  const draw = (now) => {
    fx.time = (now - t0) / 1000;
    fx.dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    const start = performance.now();
    ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
    ctx.clearRect(0, 0, fx.width, fx.height);
    hooks.frame(ctx, fx);
    cost += performance.now() - start;
    frames++;
    if (now - reported >= 2000) {
      if (frames) effectPost("effect.frameCost", { ms: cost / frames });
      cost = 0;
      frames = 0;
      reported = now;
    }
  };
  const tick = (now) => {
    raf = 0;
    draw(now);
    schedule();
  };
  const schedule = () => {
    if (started && !paused && fx.motion && !raf) raf = requestAnimationFrame(tick);
  };
  const stop = () => (raf && cancelAnimationFrame(raf), (raf = 0));
  // Reduced motion: one static frame per change.
  const still = () => started && !fx.motion && draw(performance.now());
  const offs = [
    on("effect.init", (m) => {
      Object.assign(fx, { rect: m.rect, bleed: m.bleed, dpr: m.dpr, theme: m.theme, colors: m.colors, motion: m.motion });
      document.documentElement.style.colorScheme = m.theme;
      size();
      t0 = reported = performance.now();
      started = true;
      hooks.init?.(fx);
      effectPost("effect.ready");
      still();
      schedule();
    }),
    on("effect.state", (m) => {
      fx.state = m.state;
      hooks.state?.(m.state, fx);
      still();
    }),
    on("effect.pulse", (m) => {
      hooks.pulse?.(m.name, fx);
      still();
    }),
    on("effect.rect", (m) => {
      fx.rect = m.rect;
      if (m.dpr > 0) fx.dpr = m.dpr;
      size();
      hooks.rect?.(fx);
      still();
    }),
    on("effect.pause", (m) => {
      paused = m.paused;
      paused ? stop() : ((last = 0), schedule());
    }),
    on("effect.fade", async () => {
      if (fading) return;
      fading = true;
      try {
        if (hooks.fade) await hooks.fade(fx);
        else if (fx.motion) {
          canvas.style.transition = "opacity 300ms";
          canvas.style.opacity = "0";
          await new Promise((r) => setTimeout(r, 300));
        }
      } finally {
        stop();
        started = false;
        effectPost("effect.done");
      }
    }),
  ];
  return () => (stop(), (started = false), offs.forEach((off) => off()), canvas.remove());
}

/** The page height including the body margins (scrollHeight alone leaves them out and clips the content). */
const contentHeight = () => Math.ceil(document.body.getBoundingClientRect().bottom + parseFloat(getComputedStyle(document.body).marginBottom));

/** Sends the content height now and whenever the body resizes (a band or a renderer). Returns a function that stops it. */
export function autoHeight() {
  const send = () => void ready(contentHeight()).catch(() => {});
  const ro = new ResizeObserver(send);
  ro.observe(document.body);
  send();
  return () => ro.disconnect();
}

/**
 * Calls `fn` with all parts of the session after `init`, then again with the full list whenever parts are added or change.
 * Needs `session.read`. Register it before the frame loads (at the top level of the module). Returns a function that stops it.
 */
export function watchSession(fn) {
  const parts = new Map();
  let read = false;
  const offInit = on("init", async () => {
    parts.clear();
    for (const p of await readSession()) parts.set(p.id, p);
    read = true;
    fn([...parts.values()]);
  });
  const offParts = on("session.parts", (m) => {
    if (!read) return;
    for (const p of m.parts) parts.set(p.id, p);
    fn([...parts.values()]);
  });
  return () => (offInit(), offParts());
}
