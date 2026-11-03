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
