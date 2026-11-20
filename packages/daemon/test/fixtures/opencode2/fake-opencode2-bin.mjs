// A fake OpenCode 2 `opencode` binary (2.3.0 API shape, recorded in development-docs spike and checked against a real 2.3.0): `--version`, `serve`, the session routes of the
// adapter and scripted turns. `--version` prints `opencode v${FAKE_OPENCODE_VERSION ?? "2.3.0"}`. `serve` checks Basic auth, prints `server listening on http://…`.
// GET /api/info -> {version, pid, urls}; GET /api/event -> SSE (`server.connected`, the turns' events, `: heartbeat` comments). There is no /global/health: it answers 404.
// Routes: GET /api/model, /api/model/default, /api/session, /api/session/active, /api/session/:id, /api/session/:id/message, /api/session/:id/message/:mid, /api/permission/request;
// POST /api/session, /api/session/:id/prompt, /api/session/:id/model, /api/session/:id/interrupt, /api/session/:id/permission/:rid/reply, /api/session/:id/fork;
// PATCH /api/session/:id (permissions, title, archived); DELETE /api/session/:id.
// Revert (as 2.3.0): POST …/revert/stage {messageID, files?} (stored messages stay listed; `session.revert` marks the cut), POST …/revert/commit, DELETE …/revert
// (clear: `session.revert.cleared`, then an empty `execution.started`/`succeeded`, as 2.3.0 sends; FAKE_OPENCODE2_CLEAR_ACTIVE_MS: the session active that long meanwhile), a prompt while staged commits first. GET …/diff?from=&to= sums the
// fake `diff` lists ([{file, additions, deletions}]) of the user messages from `from` up to `to` (excluded; default the next user message).
// POST …/compact: a compaction turn (`summary` stored; a session without messages fails "Nothing to compact yet"). POST …/shell {id, command}: answers when the
// command ends (FAKE_OPENCODE2_SHELL_START_MS delays `session.shell.started`); output `out:<command>`, `exit <n>` in the command = that exit code, `sleep` in it runs until DELETE /api/shell/:sh (killed). GET /api/shell/:sh/output.
// Forms: GET …/form, GET /api/form, POST …/form/:fid/reply {answer}, DELETE …/form/:fid (cancel: the turn ends interrupted, as 2.3.0).
// FAKE_OPENCODE2_FAIL: see the session route.
// FAKE_OPENCODE2_DATA: JSON `{sessions: [{id, directory, title, time, permissions?, parentID?}], messages: {<id>: [v2 messages]}, models?, default?}`.
// FAKE_OPENCODE2_SCRIPT: comma-separated turn files, one per prompt in order (a prompt after the last one gets a plain "pong" turn). A turn is a JSON list of steps:
//   {event, data}   emits the event (`$SESSION`, `$USER`, `$A1`..`$A9` (assistant message ids), `$PERM` (a permission id) are replaced)
//   {wait: "permission"}  holds the turn until `…/permission/:rid/reply` came; {when: "once"|"always"|"reject"|"allowed"} on a step skips it unless that was the reply (`allowed` = once or always); `$REJECT` is the reply's message
//   {hold: true}    holds the turn until `…/interrupt`, which then ends it as the user's stop (`step.failed` aborted, `execution.interrupted`)
//   {sleep: ms}
//   {form: {fields, title?, sessionID?}}  asks a question form (of `sessionID`, default the turn's) (`form.created`, metadata kind question, tool `$A1`/`$CALL`); {wait: "form"} holds until it is answered ("replied")
//     or cancelled ("cancelled": the call fails aborted and the turn ends interrupted); `$ANSWER` is the answer
// FAKE_OPENCODE2_MODEL_DELAY / _PROMPT_DELAY / _MESSAGE_DELAY: ms the model routes / the prompt route / the message read wait. FAKE_OPENCODE2_SWALLOW_STOP: an interrupt sends no end events. POST /__drop ends the event streams; POST /__forget/<id> drops a session; POST /__stage/<id>/<message id> and /__clear/<id> revert as OpenCode's own app.
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
/** Open forms by id: `{form, turn}`. */
const forms = new Map();
/** Running shells by id: `{kill()}`. */
const shells = new Map();
const shellOut = new Map();
let nextTurn = 0;

const fill = (v, vars) => (typeof v === "string" ? vars[v] ?? v : Array.isArray(v) ? v.map((x) => fill(x, vars)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)])) : v);
async function runTurn(sid, userId, steps) {
  const dir = sessions.get(sid).directory;
  const vars = { $SESSION: sid, $USER: userId, $DIR: dir, ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`$A${n}`, id("msg")])), $PERM: id("per"), $FORM: id("frm"), $CALL: id("call") };
  let reply;
  let formDone;
  let interrupt;
  const stop = new Promise((r) => (interrupt = r));
  const turn = { stopped: false, interrupt: () => ((turn.stopped = true), interrupt()), reply: (decision, message) => ((vars.$REJECT = message ?? "The user rejected this tool call"), reply?.(decision)), form: (r) => formDone?.(r) };
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
    } else if (step.form) {
      const form = { id: vars.$FORM, sessionID: step.form.sessionID ?? sid, title: step.form.title ?? "Questions", metadata: { kind: "question", tool: { messageID: vars.$A1, id: vars.$CALL } }, fields: step.form.fields };
      forms.set(form.id, { form, turn });
      emit("form.created", { form }, dir);
    } else if (step.wait === "form") {
      const r = await Promise.race([new Promise((x) => (formDone = x)), stop]);
      if (turn.stopped) break;
      forms.delete(vars.$FORM);
      last = r.cancel ? "cancelled" : "replied";
      vars.$ANSWER = r.answer;
      if (r.cancel) {
        emit("form.cancelled", { id: vars.$FORM, sessionID: sid }, dir);
        emit("session.tool.failed", { sessionID: sid, assistantMessageID: vars.$A1, id: vars.$CALL, error: { type: "aborted", message: "The user dismissed this question" } }, dir);
        emit("session.execution.interrupted", { sessionID: sid, reason: "shutdown" });
        break;
      }
      emit("form.replied", { id: vars.$FORM, sessionID: sid, answer: r.answer }, dir);
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
  if (s.revert) commitRevert(s);
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

/** The empty execution 2.3.0 runs after a revert clear. FAKE_OPENCODE2_CLEAR_ACTIVE_MS: it runs that long, the session listed as active meanwhile. */
function clearExecution(s) {
  emit("session.execution.started", { sessionID: s.id });
  const ms = Number(process.env.FAKE_OPENCODE2_CLEAR_ACTIVE_MS ?? 0);
  if (!ms) return emit("session.execution.succeeded", { sessionID: s.id });
  const t = { interrupt() {}, reply() {}, form() {} };
  running.set(s.id, t);
  setTimeout(() => (running.get(s.id) === t && running.delete(s.id), emit("session.execution.succeeded", { sessionID: s.id })), ms);
}
/** Drops the messages from the revert point on (`session.revert.committed`). */
function commitRevert(s) {
  const list = messages.get(s.id) ?? [];
  const at = list.findIndex((x) => x.id === s.revert.messageID);
  if (at >= 0) list.splice(at);
  emit("session.revert.committed", { sessionID: s.id, to: s.revert.messageID }, s.directory);
  delete s.revert;
}
/** The fake `diff` lists of the user messages from `from` to `to` (excluded; default: the next user message), summed per file. */
function diffOf(s, from, to) {
  const list = messages.get(s.id) ?? [];
  const start = list.findIndex((x) => x.id === from);
  if (start < 0) return undefined;
  const users = list.filter((x) => x.type === "user");
  const end = to ? list.findIndex((x) => x.id === to) : list.findIndex((x, i) => i > start && x.type === "user");
  const out = new Map();
  for (const u of users) {
    const i = list.indexOf(u);
    if (i < start || (end >= 0 && i >= end)) continue;
    for (const d of u.diff ?? []) {
      const o = out.get(d.file) ?? { file: d.file, patch: "", additions: 0, deletions: 0, status: "modified" };
      out.set(d.file, { ...o, additions: o.additions + d.additions, deletions: o.deletions + d.deletions });
    }
  }
  return [...out.values()];
}
function compact(s, body, res) {
  const inputID = body?.id ?? id("msg");
  const list = messages.get(s.id);
  emit("session.inbox.enqueued", { inboxID: inputID, sessionID: s.id, item: { type: "compaction", payload: {}, delivery: "steer" } }, s.directory);
  json(res, 200, { data: { id: inputID, sessionID: s.id, time: { created: Date.now() }, type: "compaction", payload: {}, delivery: "steer" } });
  setTimeout(() => {
    emit("session.execution.started", { sessionID: s.id });
    emit("session.compaction.started", { sessionID: s.id, reason: "manual", inputID }, s.directory);
    if (!list.length) emit("session.compaction.failed", { sessionID: s.id, reason: "manual", inputID, error: { type: "compaction.unavailable", message: "Nothing to compact yet" } }, s.directory);
    else {
      const summary = "## Objective\n- the fake summary";
      list.push({ type: "compaction", id: inputID, time: { created: Date.now() }, status: "completed", reason: "manual", summary });
      emit("session.compaction.ended", { sessionID: s.id, reason: "manual", model: { id: "m", providerID: "fake" }, text: summary, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }, s.directory);
    }
    emit("session.execution.succeeded", { sessionID: s.id });
  }, 30);
}
function shell(s, body, res) {
  const sh = id("sh");
  const msg = { id: body.id ?? id("msg"), metadata: { background: true }, time: { created: Date.now() }, type: "shell", shellID: sh, command: body.command, status: "running" };
  messages.get(s.id).push(msg);
  const info = (status, extra = {}) => ({ id: sh, status, command: body.command, cwd: s.directory, shell: "/bin/sh", ...extra });
  // FAKE_OPENCODE2_SHELL_START_MS: ms before OpenCode names the shell (`session.shell.started`).
  const started = () => (emit("shell.created", { info: info("running") }, s.directory), emit("session.shell.started", { sessionID: s.id, shell: info("running") }, s.directory));
  const delay = Number(process.env.FAKE_OPENCODE2_SHELL_START_MS ?? 0);
  if (delay) setTimeout(started, delay);
  else started();
  shellOut.set(sh, `out:${body.command}\n`);
  const end = (status, exit) => {
    shells.delete(sh);
    Object.assign(msg, { status, ...(exit !== undefined && { exit }), time: { ...msg.time, completed: Date.now() }, output: { output: shellOut.get(sh), cursor: 0, size: 0, truncated: false } });
    emit("shell.exited", { id: sh, status, ...(exit !== undefined && { exit }) }, s.directory);
    emit("session.shell.ended", { sessionID: s.id, shell: info(status, exit !== undefined ? { exit } : {}) }, s.directory);
    res.writeHead(204);
    res.end();
  };
  if (/sleep/.test(body.command)) return shells.set(sh, { kill: () => (shellOut.set(sh, "Shell command output is no longer available."), end("killed")) });
  setTimeout(() => end("exited", Number(/exit (\d+)/.exec(body.command)?.[1] ?? 0)), 50);
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
    // POST /__forget/<session id>: the session is gone, as if deleted in OpenCode's own app (a test seam like /__drop).
    if (url.pathname.startsWith("/__forget/")) return (sessions.delete(url.pathname.slice(10)), json(res, 200, {}));
    // POST /__stage/<session id>/<message id>, POST /__clear/<session id>: a revert staged or cleared in OpenCode's own app (test seams like /__drop).
    if (url.pathname.startsWith("/__stage/")) {
      const [sid, mid] = url.pathname.slice(9).split("/");
      const s = sessions.get(sid);
      s.revert = { messageID: mid, files: [] };
      emit("session.revert.staged", { sessionID: sid, revert: s.revert }, s.directory);
      return json(res, 200, {});
    }
    if (url.pathname.startsWith("/__clear/")) {
      const s = sessions.get(url.pathname.slice(9));
      delete s.revert;
      emit("session.revert.cleared", { sessionID: s.id }, s.directory);
      clearExecution(s);
      return json(res, 200, {});
    }
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

    if (p === "/api/form") return json(res, 200, { location: { directory: dir }, data: [...forms.values()].map((f) => f.form).filter((f) => sessions.get(f.sessionID)?.directory === dir || !dir) });
    if ((m = /^\/api\/shell\/([^/]+)(\/output)?$/.exec(p))) {
      if (m[2]) return shellOut.has(m[1]) ? json(res, 200, { location: { directory: dir }, data: { output: shellOut.get(m[1]), cursor: 0, size: 0, truncated: false } }) : json(res, 404, { message: "shell not found" });
      if (req.method === "DELETE") return (shells.get(m[1])?.kill(), res.writeHead(204), res.end());
    }
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
      if (!sub && req.method === "PATCH") {
        // A title "fail-title" answers 500 (a failed rename).
        if (body.title === "fail-title") return json(res, 500, { message: "rename failed" });
        Object.assign(s, body.permissions !== undefined && { permissions: body.permissions }, body.title !== undefined && { title: body.title });
        if (body.archived === true) s.time.archived = Date.now();
        if (body.archived === false) delete s.time.archived;
        return (res.writeHead(204), res.end());
      }
      if (!sub && req.method === "DELETE") return (sessions.delete(s.id), messages.delete(s.id), res.writeHead(204), res.end());
      if (sub === "fork" && req.method === "POST") {
        // The history before `before` (all of it without), copied with new message ids; an empty session cannot be forked (as 2.3.0).
        const list = messages.get(s.id) ?? [];
        if (!list.length) return json(res, 400, { _tag: "InvalidRequestError", message: `Cannot fork empty session: ${s.id}` });
        const cut = body?.before ? list.findIndex((x) => x.id === body.before) : -1;
        const fid = id("ses");
        const now = Date.now();
        const f = { ...s, id: fid, title: `${s.title ?? "New session"} (fork #1)`, fork: { sessionID: s.id }, time: { created: now, updated: now } };
        delete f.revert;
        sessions.set(fid, f);
        messages.set(fid, (cut < 0 ? list : list.slice(0, cut)).map((x) => ({ ...x, id: id("msg") })));
        return json(res, 200, { data: f });
      }
      if (sub === "model") return (s.model = body.model, res.writeHead(204), res.end());
      if (sub === "revert/stage") {
        const list = messages.get(s.id) ?? [];
        if (!list.some((x) => x.id === body.messageID)) return json(res, 404, { _tag: "MessageNotFoundError", message: `Message not found: ${body.messageID}` });
        s.revert = { messageID: body.messageID, files: body.files === false ? [] : (diffOf(s, body.messageID, "none") ?? []) };
        emit("session.revert.staged", { sessionID: s.id, revert: s.revert }, s.directory);
        return json(res, 200, { data: s.revert });
      }
      if (sub === "revert/commit") return (s.revert && commitRevert(s), res.writeHead(204), res.end());
      if (sub === "revert" && req.method === "DELETE") {
        delete s.revert;
        emit("session.revert.cleared", { sessionID: s.id }, s.directory);
        clearExecution(s);
        return (res.writeHead(204), res.end());
      }
      if (sub === "diff") {
        const d = diffOf(s, url.searchParams.get("from"), url.searchParams.get("to") ?? undefined);
        return d ? json(res, 200, { data: d }) : json(res, 404, { _tag: "MessageNotFoundError", message: "Message not found" });
      }
      if (sub === "compact") return compact(s, body, res);
      if (sub === "shell") return shell(s, body, res);
      if (sub === "form") return json(res, 200, { data: [...forms.values()].map((f) => f.form).filter((f) => f.sessionID === s.id) });
      const fm = /^form\/([^/]+)(\/reply)?$/.exec(sub ?? "");
      if (fm) {
        const f = forms.get(fm[1]);
        if (!f) return json(res, 404, { message: `Form not found: ${fm[1]}` });
        f.turn.form(fm[2] ? { answer: body.answer } : { cancel: true });
        return (res.writeHead(204), res.end());
      }
      const mm = /^message\/([^/]+)$/.exec(sub ?? "");
      if (mm) {
        const one = (messages.get(s.id) ?? []).find((x) => x.id === mm[1]);
        return one ? json(res, 200, { data: one }) : json(res, 404, { _tag: "MessageNotFoundError", message: `Message not found: ${mm[1]}` });
      }
      if (sub === "message") {
        let list = messages.get(s.id) ?? [];
        const limit = Number(url.searchParams.get("limit") ?? 100);
        // Stored oldest first; `order=desc` reads newest first (OpenCode's default order).
        if (url.searchParams.get("order") === "desc") list = [...list].reverse();
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
