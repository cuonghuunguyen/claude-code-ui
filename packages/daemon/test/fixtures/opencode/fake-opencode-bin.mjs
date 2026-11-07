// A fake `opencode` binary for the OpenCode engine tests: `--version` and `serve` (a small HTTP server with the routes of the OpenCode API the
// daemon uses, hand-built from packages/sdk/openapi.json). Run as `node <this file> ...` (no shebang needed).
// Prompts replay scripted turns (turn-*.json, cut from a real OpenCode 1.18 recording): a node `{events, on?, abort?}`; `events` play on the
// event stream (`ses_ROOT` = the prompted session, the recorded user message id = the posted `messageID`); a node that ends at a
// permission.asked / question.asked waits for its reply, which plays `on[reply]` (`once`, `always`, `reject`, `reject:message`, `answer`).
// Test routes (no auth): POST /__script {files} queues turns, POST /__emit {directory?, events} sends payloads, POST /__drop closes the event streams.
// Env: FAKE_OPENCODE_SCRIPT (comma separated turn files), FAKE_OPENCODE_STREAM_DELAY_MS (the event stream answers late), FAKE_OPENCODE_VERSION, FAKE_OPENCODE_LOG (JSON lines of starts and requests), FAKE_OPENCODE_DATA (JSON {sessions, messages}), FAKE_OPENCODE_CRASH=1 (exit right after the listening line).
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const log = (o) => process.env.FAKE_OPENCODE_LOG && appendFileSync(process.env.FAKE_OPENCODE_LOG, `${JSON.stringify(o)}\n`);
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log(process.env.FAKE_OPENCODE_VERSION ?? "1.18.34");
  process.exit(0);
}
if (args[0] !== "serve") (console.error(`fake opencode: unknown command ${args[0]}`), process.exit(2));
const password = process.env.OPENCODE_SERVER_PASSWORD;
if (!password) (console.error("fake opencode: OPENCODE_SERVER_PASSWORD is not set"), process.exit(3));
const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const port = Number(args[args.indexOf("--port") + 1] ?? 0);
const hostname = args[args.indexOf("--hostname") + 1] ?? "127.0.0.1";

const data = process.env.FAKE_OPENCODE_DATA ? JSON.parse(readFileSync(process.env.FAKE_OPENCODE_DATA, "utf8")) : { sessions: [], messages: {} };
const sessions = data.sessions;
let counter = 0;
const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

const clients = new Set();
const scripts = (process.env.FAKE_OPENCODE_SCRIPT ?? "").split(",").filter(Boolean);
/** The node waiting for a reply or abort, the asks not answered yet, the sessions that are busy. */
let current;
let asks = data.asks ?? [];
const busy = new Set(data.busy ?? []);
let generation = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (directory, payload) => {
  for (const c of clients) c.write(`data: ${JSON.stringify({ directory, payload })}\n\n`);
};
const readBody = (req) =>
  new Promise((r) => {
    let t = "";
    req.on("data", (d) => (t += d));
    req.on("end", () => r(t ? JSON.parse(t) : {}));
  });

/** Plays a node's events one by one; an abort (or another turn) ends the playback. */
async function play(node, sessionId, directory, messageID, recorded) {
  const mine = ++generation;
  const userId = recorded ?? node.events.find((e) => e.type === "message.updated" && e.properties.info.role === "user")?.properties.info.id;
  current = Object.assign(node, { sessionId, directory, messageID, userId });
  let text = JSON.stringify(node.events).replaceAll("ses_ROOT", sessionId).replaceAll("ses_CHILD", `${sessionId}_child`);
  if (userId && messageID) text = text.replaceAll(userId, messageID);
  for (const e of JSON.parse(text)) {
    if (generation !== mine) return;
    await sleep(3);
    const p = e.properties;
    if (e.type === "session.status") p.status.type === "idle" ? busy.delete(p.sessionID) : busy.add(p.sessionID);
    if (e.type === "permission.asked" || e.type === "question.asked") asks.push({ type: e.type, ...p });
    if (e.type === "permission.replied" || e.type === "question.replied") asks = asks.filter((a) => a.id !== p.requestID);
    send(directory, e);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (code, body) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
  if (url.pathname.startsWith("/__")) {
    const body = await readBody(req);
    if (url.pathname === "/__script") scripts.push(...body.files);
    if (url.pathname === "/__emit") for (const e of body.events) send(body.directory, e);
    if (url.pathname === "/__drop") (clients.forEach((c) => c.end()), clients.clear());
    return json(200, { ok: true });
  }
  const authed = req.headers.authorization === expected;
  const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req) : undefined;
  log({ type: "request", method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authed, ...(body !== undefined && { body }) });
  if (!authed) return json(401, { error: "unauthorized" });
  const dir = url.searchParams.get("directory");
  const reply = (key) => {
    const node = current?.on?.[key];
    if (!node) return json(200, true);
    const { sessionId, directory, messageID, userId } = current;
    play(node, sessionId, directory, messageID, userId);
    return json(200, true);
  };
  if (url.pathname === "/global/event") {
    await sleep(Number(process.env.FAKE_OPENCODE_STREAM_DELAY_MS ?? 0));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`);
    clients.add(res);
    return res.on("close", () => clients.delete(res));
  }
  if (url.pathname === "/config/providers")
    return json(200, { providers: [{ id: "opencode", name: "OpenCode", models: { "big-pickle": { name: "Big Pickle" }, alpha: { name: "Alpha" } } }, { id: "acme", name: "Acme", models: { "x/y": { name: "Model X" } } }], default: { opencode: "big-pickle" } });
  if (url.pathname === "/agent") return json(200, [{ name: "build", permission: [] }, { name: "plan", permission: [{ permission: "edit", pattern: "*", action: "deny" }, { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" }] }]);
  if (url.pathname === "/session/status") return json(200, Object.fromEntries([...busy].map((id) => [id, { type: "busy" }])));
  if (url.pathname === "/permission") return json(200, asks.filter((a) => a.type === "permission.asked").map(({ type, ...a }) => a));
  if (url.pathname === "/question") return json(200, asks.filter((a) => a.type === "question.asked").map(({ type, ...a }) => a));
  let m2 = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
  if (m2 && req.method === "POST") return reply(body.reply === "reject" && body.message && current?.on?.["reject:message"] ? "reject:message" : body.reply);
  m2 = /^\/question\/([^/]+)\/(reply|reject)$/.exec(url.pathname);
  if (m2 && req.method === "POST") return reply(m2[2] === "reply" ? "answer" : "reject");
  if (url.pathname === "/global/health") return json(200, { healthy: true, version: process.env.FAKE_OPENCODE_VERSION ?? "1.18.34" });
  if (url.pathname === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.write('data: {"type":"server.connected","properties":{}}\n\n');
  }
  if (url.pathname === "/session" && req.method === "GET") {
    const roots = url.searchParams.get("roots") === "true";
    return json(200, sessions.filter((s) => (!dir || s.directory === dir) && (!roots || !s.parentID)));
  }
  if (url.pathname === "/session" && req.method === "POST") {
    const now = Date.now();
    const s = { id: `ses_fake${String(++counter).padStart(4, "0")}`, slug: `fake-${counter}`, projectID: "global", directory: dir ?? "/", title: "New session", version: "1.18.34", ...(body?.permission && { permission: body.permission }), time: { created: now, updated: now } };
    sessions.push(s);
    return json(200, s);
  }
  const m = /^\/session\/([^/]+)(\/message|\/prompt_async|\/abort)?$/.exec(url.pathname);
  const s = m && sessions.find((x) => x.id === m[1]);
  if (m && s && m[2] === "/prompt_async" && req.method === "POST") {
    const file = scripts.shift();
    if (file) play(JSON.parse(readFileSync(resolve(file), "utf8")), s.id, dir, body.messageID);
    res.writeHead(204);
    return res.end();
  }
  if (m && s && m[2] === "/abort" && req.method === "POST") {
    generation++;
    asks = [];
    busy.delete(s.id);
    const events = current?.abort ?? [{ type: "session.error", properties: { sessionID: "ses_ROOT", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } }, { type: "session.status", properties: { sessionID: "ses_ROOT", status: { type: "idle" } } }, { type: "session.idle", properties: { sessionID: "ses_ROOT" } }];
    for (const e of JSON.parse(JSON.stringify(events).replaceAll("ses_ROOT", s.id))) send(dir, e);
    return json(200, true);
  }
  if (m && s && !m[2] && req.method === "PATCH") {
    s.permission = [...(s.permission ?? []), ...(body.permission ?? [])];
    return json(200, s);
  }
  if (m && s && req.method === "GET") return json(200, m[2] ? (data.messages[s.id] ?? []) : s);
  return json(404, { name: "NotFoundError", data: { message: `no route ${req.method} ${url.pathname}` } });
});
server.listen(port, hostname, () => {
  log({ type: "start", pid: process.pid, argv: args, passwordSet: true, hostname, port: server.address().port });
  console.log(`opencode server listening on http://${hostname}:${server.address().port}`);
  if (process.env.FAKE_OPENCODE_CRASH === "1") (console.error("fake opencode crashed on purpose"), process.exit(1));
});
