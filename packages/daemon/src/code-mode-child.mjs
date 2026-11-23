// Code mode child (docs/code-mode-spec.md, POC). Runs the model's script in a vm context that has only the API below.
// No env, no fs, no child_process (started with --permission); every effect is a request to the daemon over the IPC pipe.
// The only main-realm function the script can reach is `bridge`, kept in a closure of the bootstrap: the context-realm
// functions have a context-realm Function constructor, and code generation from strings is off in the context.
import vm from "node:vm";

let seq = 0;
const pending = new Map();
process.on("message", (m) => {
  if (m.type === "reply") {
    const cb = pending.get(m.id);
    pending.delete(m.id);
    cb?.(m);
  } else if (m.type === "run") void run(m.code);
});

// Never throws: a main-realm error object in the context would hand out the main-realm Function constructor
// (probe: overriding JSON.stringify made JSON.parse here throw a SyntaxError -> process). Takes and returns strings only.
const bridge = (op, argsJson, cb) => {
  try {
    if (typeof op !== "string" || typeof argsJson !== "string" || typeof cb !== "function") return "bad call";
    let args;
    try { args = JSON.parse(argsJson); } catch { return "arguments are not JSON"; }
    if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
    const id = ++seq;
    pending.set(id, (m) => { try { cb(m.ok === true, m.ok ? JSON.stringify(m.value ?? null) : String(m.error)); } catch { /* script callback threw */ } });
    process.send({ type: "call", id, op, args });
    return "";
  } catch {
    return "call failed";
  }
};
const log = (text) => process.send({ type: "log", text: String(text) });

const BOOT = `(function (bridge, log) {
  // Captured before the script runs, so a script that replaces JSON or Error does not change the bridge traffic.
  const { stringify, parse } = JSON;
  const E = Error;
  const call = (op, args) => new Promise((res, rej) => {
    let err;
    // The catch is in this (context) realm: any error, also a stack overflow inside bridge, becomes a context-realm error.
    try { err = bridge(op, stringify(args ?? {}), (ok, v) => (ok ? res(parse(v)) : rej(new E(v)))); } catch { err = "call failed"; }
    if (err) rej(new E(err));
  });
  const quote = (v) => (Array.isArray(v) ? v.map(quote).join(" ") : "'" + String(v).replace(/'/g, "'\\\\''") + "'");
  const shell = (cmd) => {
    let nothrow = false;
    let p;
    const go = () => (p ??= call("sh", { cmd }).then((r) => {
      if (r.exitCode !== 0 && !nothrow) throw Object.assign(new Error("exit " + r.exitCode + ": " + r.stderr), r);
      return r;
    }));
    const h = {
      nothrow() { nothrow = true; return h; },
      quiet() { return h; },
      text() { return go().then((r) => r.stdout); },
      json() { return go().then((r) => JSON.parse(r.stdout)); },
      then(a, b) { return go().then(a, b); },
      catch(b) { return go().catch(b); },
    };
    return h;
  };
  const $ = (s, ...v) => shell(s.reduce((a, x, i) => a + x + (i < v.length ? quote(v[i]) : ""), ""));
  const fmt = (a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  Object.defineProperties(globalThis, {
    $: { value: $ },
    sh: { value: (cmd) => shell(cmd) },
    read: { value: (path, o) => call("read", { path, ...o }) },
    grep: { value: (pattern, o) => call("grep", { pattern, ...o }) },
    glob: { value: (pattern, o) => call("glob", { pattern, ...o }) },
    edit: { value: (path, oldText, newText, o) => call("edit", { path, oldText, newText, ...o }) },
    write: { value: (path, content) => call("write", { path, content }) },
    console: { value: { log: (...a) => log(fmt(a)), error: (...a) => log(fmt(a)), warn: (...a) => log(fmt(a)) } },
  });
})`;

async function run(code) {
  const done = (m) => process.send({ type: "done", ...m });
  try {
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(BOOT, ctx)(bridge, log);
    // An expression is the result; otherwise the script is a function body and `return` gives the result.
    let fn;
    try {
      fn = new vm.Script(`(async () => (\n${code}\n))`, { filename: "run_code" }).runInContext(ctx);
    } catch {
      fn = new vm.Script(`(async () => {\n${code}\n})`, { filename: "run_code" }).runInContext(ctx);
    }
    const value = await fn();
    done({ ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
  } catch (e) {
    done({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
