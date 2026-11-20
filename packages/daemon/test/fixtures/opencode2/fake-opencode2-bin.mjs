// A fake OpenCode 2 `opencode` binary (2.3.0 API shape, recorded in development-docs spike and checked against a real 2.3.0): `--version`, `serve`, the session routes of the
// adapter and scripted turns. `--version` prints `opencode v${FAKE_OPENCODE_VERSION ?? "2.3.0"}`. `serve` checks Basic auth, prints `server listening on http://…`.
// GET /api/info -> {version, pid, urls}; GET /api/event -> SSE (`server.connected`, the turns' events, `: heartbeat` comments). There is no /global/health: it answers 404.
// Routes: GET /api/model, /api/model/default, /api/session, /api/session/active, /api/session/:id, /api/session/:id/message, /api/permission/request;
// POST /api/session, /api/session/:id/prompt, /api/session/:id/model, /api/session/:id/interrupt, /api/session/:id/permission/:rid/reply; PATCH /api/session/:id.
// FAKE_OPENCODE2_FAIL: see the session route.
// FAKE_OPENCODE2_DATA: JSON `{sessions: [{id, directory, title, time, permissions?, parentID?}], messages: {<id>: [v2 messages]}, models?, default?}`.
// FAKE_OPENCODE2_SCRIPT: comma-separated turn files, one per prompt in order (a prompt after the last one gets a plain "pong" turn). A turn is a JSON list of steps:
//   {event, data}   emits the event (`$SESSION`, `$USER`, `$A1`..`$A9` (assistant message ids), `$PERM` (a permission id) are replaced)
//   {wait: "permission"}  holds the turn until `…/permission/:rid/reply` came; {when: "once"|"always"|"reject"|"allowed"} on a step skips it unless that was the reply (`allowed` = once or always); `$REJECT` is the reply's message
//   {hold: true}    holds the turn until `…/interrupt`, which then ends it as the user's stop (`step.failed` aborted, `execution.interrupted`)
//   {sleep: ms}
// FAKE_OPENCODE2_MODEL_DELAY / _PROMPT_DELAY / _MESSAGE_DELAY: ms the model routes / the prompt route / the message read wait. FAKE_OPENCODE2_SWALLOW_STOP: an interrupt sends no end events. POST /__drop ends the event streams.
// FAKE_OPENCODE_LOG: JSON lines of `start`, `request` (method, path, authed, body of a write) and `version`.
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

const log = (o) => process.env.FAKE_OPENCODE_LOG && appendFileSync(process.env.FAKE_OPENCODE_LOG, `${JSON.stringify(o)}\n`);
const args = process.argv.slice(2);
const version = process.env.FAKE_OPENCODE_VERSION ?? "2.3.0";

if (args.includes("--version")) {
  log({ type: "version" });
  console.log(`opencode v${version}`);
  process.exit(0);
}
if (args[0] !== "serve") (console.error(`fake opencode2: unknown command ${args[0]}`), process.exit(2));
const password = process.env.OPENCODE_SERVER_PASSWORD;
if (!password) (console.error("fake opencode2: OPENCODE_SERVER_PASSWORD is not set"), process.exit(3));
const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const port = Number(args[args.indexOf("--port") + 1] ?? 0);
const hostname = args[args.indexOf("--hostname") + 1] ?? "127.0.0.1";
const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const json = (res, status, body) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));

const data = process.env.FAKE_OPENCODE2_DATA ? JSON.parse(readFileSync(process.env.FAKE_OPENCODE2_DATA, "utf8")) : {};
const sessions = new Map((data.sessions ?? []).map((s) => [s.id, { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, projectID: "global", ...s, location: { directory: s.directory } }]));
const messages = new Map(Object.entries(data.messages ?? {}));
const model = (id, name, extra = {}) => ({ id, modelID: id, providerID: "fake", type: "chat", name, capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], enabled: true, status: "active", limit: { context: 1000, output: 100 }, ...extra });
const models = data.models ?? [model("m", "Fake M", { variants: [{ id: "low" }, { id: "high" }] }), model("n", "Fake N")];
const defaultModel = data.default ?? models[0];
const scripts = (process.env.FAKE_OPENCODE2_SCRIPT ?? "").split(",").filter(Boolean);
const pongTurn = [
  { event: "session.execution.started", data: { sessionID: "$SESSION" } },
  { event: "session.step.started", data: { sessionID: "$SESSION", agent: "build", model: { id: "m", providerID: "fake" }, assistantMessageID: "$A1" } },
  { event: "session.text.started", data: { sessionID: "$SESSION", assistantMessageID: "$A1", ordinal: 0 } },
  { event: "session.text.delta", data: { sessionID: "$SESSION", assistantMessageID: "$A1", ordinal: 0, delta: "pong" } },
  { event: "session.text.ended", data: { sessionID: "$SESSION", assistantMessageID: "$A1", ordinal: 0, text: "pong" } },
  { event: "session.step.ended", data: { sessionID: "$SESSION", assistantMessageID: "$A1", finish: "stop", rawFinish: "stop", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, files: [] } },
  { event: "session.execution.succeeded", data: { sessionID: "$SESSION" } },
];

let seq = 0;
const id = (prefix) => `${prefix}_${Date.now().toString(16).padStart(11, "0")}${String(++seq).padStart(3, "0")}Fake${Math.random().toString(36).slice(2, 12).padEnd(10, "x")}`;
const clients = new Set();
const emit = (type, d, directory) => {
  const e = { id: id("evt"), created: Date.now(), type, ...(directory && { location: { directory } }), data: d };
  for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`);
};
/** The running turn per session: `{interrupt(), reply(decision)}`. */
const failed = {};
const running = new Map();
/** Open permission requests by id. */
const asked = new Map();
let nextTurn = 0;

const fill = (v, vars) => (typeof v === "string" ? vars[v] ?? v : Array.isArray(v) ? v.map((x) => fill(x, vars)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)])) : v);
async function runTurn(sid, userId, steps) {
  const dir = sessions.get(sid).directory;
  const vars = { $SESSION: sid, $USER: userId, $DIR: dir, ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`$A${n}`, id("msg")])), $PERM: id("per") };
  let reply;
  let interrupt;
  const stop = new Promise((r) => (interrupt = r));
  const turn = { stopped: false, interrupt: () => ((turn.stopped = true), interrupt()), reply: (decision, message) => ((vars.$REJECT = message ?? "The user rejected this tool call"), reply?.(decision)) };
  running.set(sid, turn);
  const sleep = (ms) => Promise.race([new Promise((r) => setTimeout(r, ms)), stop]);
  let last;
  for (const step of steps) {
    if (turn.stopped) break;
    if (step.when && !(step.when === last || (step.when === "allowed" && (last === "once" || last === "always")))) continue;
    if (step.sleep) await sleep(step.sleep);
    else if (step.hold) await stop;
    else if (step.wait === "permission") {
      last = await Promise.race([new Promise((r) => (reply = r)), stop]);
      if (turn.stopped) break;
      emit("permission.replied", { sessionID: sid, requestID: vars.$PERM, reply: last }, dir);
      asked.delete(vars.$PERM);
    } else if (step.event) {
      const d = fill(step.data, vars);
      if (step.event === "permission.asked") asked.set(d.id, { sessionID: sid, ...d, turn });
      emit(step.event, d, step.event.startsWith("session.execution.") || step.event === "session.usage.updated" ? undefined : dir);
    }
  }
  log({ type: "turn", end: turn.stopped ? "interrupted" : "done" });
  if (running.get(sid) === turn) running.delete(sid);
}

/** The prompt is stored, its turn starts (registered at once, so an interrupt after the answer finds it) and the request is answered. */
function takePrompt(s, body, res) {
  const userId = body.id ?? id("msg");
  const user = { id: userId, time: { created: Date.now() }, text: body.text, ...(body.files && { files: body.files.map((f) => ({ data: f.uri.split(",")[1], mime: /^data:([^;,]+)/.exec(f.uri)?.[1], source: f.source, name: f.name })) }), type: "user" };
  messages.get(s.id).push(user);
  s.time.updated = Date.now();
  const file = scripts[nextTurn++];
  const steps = file ? JSON.parse(readFileSync(file, "utf8")) : pongTurn;
  emit("session.inbox.enqueued", { inboxID: userId, sessionID: s.id, item: { type: "user", payload: { text: body.text }, delivery: "steer" } }, s.directory);
  void runTurn(s.id, userId, steps);
  json(res, 200, { data: { id: userId, sessionID: s.id, time: user.time, type: "user", payload: { text: body.text } } });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const authed = req.headers.authorization === expected;
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    // POST /__drop: ends every event stream (the daemon reconnects and reads the sessions again). A test seam: no authentication, no log line.
    if (url.pathname === "/__drop") return (clients.forEach((c) => c.end()), json(res, 200, {}));
    log({ type: "request", method: req.method, path: url.pathname, authed, ...(body !== undefined && { body }) });
    if (!authed) return json(res, 401, { error: "unauthorized" });
    const p = url.pathname;
    let m;
    if (p === "/api/info") return json(res, 200, { version, pid: process.pid, urls: [`http://${hostname}:${server.address().port}`] });
    if (p === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "evt_1", created: Date.now(), type: "server.connected", data: {} })}\n\n`);
      clients.add(res);
      const beat = setInterval(() => res.write(": heartbeat\n\n"), 1000);
      return res.on("close", () => (clearInterval(beat), clients.delete(res)));
    }
    const dir = url.searchParams.get("location[directory]") ?? "";
    // FAKE_OPENCODE2_MODEL_DELAY: ms the model routes wait (a prompt is being prepared while they run).
    const later = (f) => setTimeout(f, Number(process.env.FAKE_OPENCODE2_MODEL_DELAY ?? 0));
    if (p === "/api/model") return later(() => json(res, 200, { location: { directory: dir }, data: models }));
    if (p === "/api/model/default") return later(() => json(res, 200, { location: { directory: dir }, data: defaultModel }));

    if (p === "/api/permission/request") return json(res, 200, { location: { directory: dir }, data: [...asked.values()].filter((a) => sessions.get(a.sessionID)?.directory === dir || !dir).map(({ turn, ...a }) => a) });
    if (p === "/api/session/active" && req.method === "GET") return json(res, 200, { data: Object.fromEntries([...running.keys()].map((k) => [k, { type: "running" }])) });
    if (p === "/api/session" && req.method === "POST") {
      const sid = id("ses");
      const now = Date.now();
      const s = { id: sid, projectID: "global", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now, updated: now }, permissions: body.permissions ?? [], location: { directory: body.location.directory }, directory: body.location.directory };
      sessions.set(sid, s);
      messages.set(sid, []);
      return json(res, 200, { data: s });
    }
    if (p === "/api/session" && req.method === "GET") {
      const d = url.searchParams.get("directory");
      const roots = url.searchParams.get("parentID") === "null";
      const list = [...sessions.values()].filter((s) => (!d || s.directory === d) && (!roots || !s.parentID)).sort((a, b) => b.time.updated - a.time.updated);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, { data: list.slice(0, limit), cursor: { previous: null, next: null } });
    }
    if ((m = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(p))) {
      // FAKE_OPENCODE2_FAIL: JSON `{<session id>: n}`: the first n reads of that session (GET /api/session/:id) answer 500.
      const failing = JSON.parse(process.env.FAKE_OPENCODE2_FAIL ?? "{}");
      if (!m[2] && req.method === "GET" && (failing[m[1]] ?? 0) > (failed[m[1]] ?? 0)) return (failed[m[1]] = (failed[m[1]] ?? 0) + 1, json(res, 500, { message: "storage busy" }));
      const s = sessions.get(m[1]);
      if (!s) return json(res, 404, { _tag: "SessionNotFoundError", message: `Session not found: ${m[1]}` });
      const sub = m[2];
      if (!sub && req.method === "GET") return json(res, 200, { data: s });
      if (!sub && req.method === "PATCH") return (Object.assign(s, body.permissions !== undefined && { permissions: body.permissions }), res.writeHead(204), res.end());
      if (sub === "model") return (s.model = body.model, res.writeHead(204), res.end());
      if (sub === "message") {
        const list = messages.get(s.id) ?? [];
        const limit = Number(url.searchParams.get("limit") ?? 100);
        // FAKE_OPENCODE2_MESSAGE_DELAY: ms a message read waits (its answer is as of the time it was asked).
        if (process.env.FAKE_OPENCODE2_MESSAGE_DELAY) return setTimeout(() => json(res, 200, { data: list.slice(0, limit), cursor: { previous: null, next: null } }), Number(process.env.FAKE_OPENCODE2_MESSAGE_DELAY));
        return json(res, 200, { data: list.slice(0, limit), cursor: { previous: null, next: list.length >= limit ? "next" : null } });
      }
      if (sub === "interrupt") {
        const t = running.get(s.id);
        if (!t) return json(res, 200, { interrupted: false });
        t.interrupt();
        // The turn ends as the user's stop, after the events it had in flight.
        // FAKE_OPENCODE2_SWALLOW_STOP: the interrupt is accepted but its end events never come (a stream that dropped meanwhile).
        if (process.env.FAKE_OPENCODE2_SWALLOW_STOP) return (running.delete(s.id), json(res, 200, { interrupted: true }));
        setTimeout(() => {
          emit("session.step.failed", { sessionID: s.id, assistantMessageID: id("msg"), error: { type: "aborted", message: "Step interrupted" } }, s.directory);
          emit("session.execution.interrupted", { sessionID: s.id, reason: "user" });
          if (running.get(s.id) === t) running.delete(s.id);
        }, 20);
        return json(res, 200, { interrupted: true });
      }
      // FAKE_OPENCODE2_PROMPT_DELAY: ms before the prompt is taken and answered: an interrupt that comes meanwhile finds no turn.
      if (sub === "prompt") return setTimeout(() => takePrompt(s, body, res), Number(process.env.FAKE_OPENCODE2_PROMPT_DELAY ?? 0));
      const pm = /^permission\/([^/]+)\/reply$/.exec(sub ?? "");
      if (pm) {
        const a = asked.get(pm[1]);
        if (!a) return json(res, 404, { _tag: "PermissionNotFoundError", requestID: pm[1], message: `Permission request not found: ${pm[1]}` });
        a.turn.reply(body.decision, body.message);
        return (res.writeHead(204), res.end());
      }
    }
    return json(res, 404, { name: "NotFoundError", message: `no route ${req.method} ${p}` });
  });
});
server.listen(port, hostname, () => {
  log({ type: "start", pid: process.pid, argv: args, passwordSet: true, hostname, port: server.address().port });
  console.log(`server listening on http://${hostname}:${server.address().port}`);
  // Dies with its parent: a killed test run must not leave fakes behind.
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 2000).unref();
});
