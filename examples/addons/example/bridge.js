// The addon side of the claude-ui bridge (v1): every request carries an id, the host answers with the same id.
// Nothing else reaches the host: the frame has no token, cookie or storage.
const pending = new Map();
const handlers = new Map();
let n = 0;

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.v !== 1) return;
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    return m.ok ? resolve(m.result) : reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
  }
  handlers.get(m.type)?.(m);
});

/** Sends a request to the host; resolves with the result, rejects with `{code, message}` when refused. */
export function call(type, payload = {}) {
  const id = `r${++n}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ v: 1, id, type, ...payload }, "*"); // opaque origin: "*" is the only target
  });
}

/** Handles an event the host pushes: init, theme.changed, command.run, render, session.parts. */
export function on(type, fn) {
  handlers.set(type, fn);
}
