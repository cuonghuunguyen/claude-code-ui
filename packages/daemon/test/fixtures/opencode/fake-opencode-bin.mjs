// A fake `opencode` binary for the OpenCode engine tests: `--version` and `serve` (a small HTTP server with the routes of the OpenCode API the
// daemon uses, hand-built from packages/sdk/openapi.json). Run as `node <this file> ...` (no shebang needed).
// Prompts replay scripted turns (turn-*.json, cut from a real OpenCode 1.18 recording): a node `{events, on?, abort?}`; `events` play on the
// event stream (`ses_ROOT` = the prompted session, the recorded user message id = the posted `messageID`); a node that ends at a
// permission.asked / question.asked waits for its reply, which plays `on[reply]` (`once`, `always`, `reject`, `reject:message`, `answer`).
// POST /session/:id/summarize plays the next script like a prompt and answers at once.
// POST /session/:id/shell plays turn-shell.json (a bash command run without a model call) and answers when it is done.
// GET /command lists `init`, `review` and `fail`; POST /session/:id/command plays the next script (command `fail` answers 500).
// MCP: GET|POST /mcp and POST /mcp/:name/disconnect keep a status map per directory (POST connects, disconnect sets `disabled`).
// MCP load and OpenCode 1.19.5's broken state (GH-682): with FAKE_OPENCODE_MCP_LOAD_MS the first GET|POST /mcp or GET /command of a directory starts its "MCP load" (one shared wait per directory); those requests wait for it, and one whose connection closes before the load ends puts the directory into `broken` (OpenCode keeps the interruption as the folder's MCP state). A broken directory answers 499 (empty body) to GET|POST /mcp, GET /command and POST /mcp/:name/disconnect, and its prompt_async plays a turn OpenCode aborts on its own: assistant message `msg_selfabort_<n>` with MessageAbortedError, idle, NO session.error. POST /instance/dispose?directory= (authed) repairs it (and drops the directory's MCP servers and load).
// Fork, DELETE and PATCH {title|time} of a session. Revert: POST /session/:id/revert|unrevert set and clear `revert` of the row (session.updated); the next prompt_async removes the cut messages (message.removed) and clears it.
// Test routes (no auth): POST /__revert {sessionId, messageID} and /__unrevert {sessionId} (an unrevert from OpenCode's own UI), POST /__script {files} queues turns, POST /__emit {directory?, events} sends payloads, POST /__drop closes the event streams, POST /__fail {path} makes the next request to that path answer 500, POST /__break {directory} puts a directory into the broken MCP state, POST /__heal {directory} takes it out (OpenCode repaired itself).
// Env: FAKE_OPENCODE_SCRIPT (comma separated turn files), FAKE_OPENCODE_STREAM_DELAY_MS (the event stream answers late), FAKE_OPENCODE_VERSION, FAKE_OPENCODE_LOG (JSON lines of starts and requests), FAKE_OPENCODE_DATA (JSON {sessions, messages}), FAKE_OPENCODE_CRASH=1 (exit right after the listening line), FAKE_OPENCODE_HANG=1 (`serve` prints nothing and stays alive), FAKE_OPENCODE_BROKEN (comma separated directories that are broken from the start), FAKE_OPENCODE_MCP_LOAD_MS (see MCP load), FAKE_OPENCODE_PROMPT_DELAY_MS (POST /session/:id/prompt_async plays its turn at once but answers that late), FAKE_OPENCODE_DISCONNECT_DELAY_MS (POST /mcp/:name/disconnect answers that late; a client that leaves meanwhile breaks the directory like any cut-off MCP request), FAKE_OPENCODE_SESSION_DELAY_MS (the first GET /session and the first POST /session of a directory answer that late: a cold folder), FAKE_OPENCODE_MESSAGE_DELAY_MS (GET /session/:id/message answers that late; the session row does not), FAKE_OPENCODE_PROMPT_LATE_MS (prompt_async reaches the session that late: its turn plays after it), FAKE_OPENCODE_ABORT_DELAY_MS (an abort answers at once, the aborted turn ends that late; logged as `aborted`), FAKE_OPENCODE_ABORT_ANSWER_MS (the abort ends the turn at once, or nothing, and answers that late), FAKE_OPENCODE_PROVIDERS_DELAY_MS (GET /config/providers answers that late), FAKE_OPENCODE_PATCH_DELAY_MS (a PATCH of a session's permission block answers that late).
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
if (process.env.FAKE_OPENCODE_HANG === "1") (log({ type: "start", pid: process.pid, argv: args, hung: true }), setInterval(() => {}, 1e9), await new Promise(() => {}));
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
const failNext = new Set(data.fail ?? []);
/** GET /agent answers this when set (POST /__agents {agents}). */
let agents;
/** path -> ms: the next request to that path answers that much later (POST /__delay {path, ms}), like a folder whose state is still loading. */
const delays = new Map(Object.entries(data.delays ?? {}));
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
const updated = (s, directory) => send(directory, { type: "session.updated", properties: { sessionID: s.id, info: s } });
const readBody = (req) =>
  new Promise((r) => {
    let t = "";
    req.on("data", (d) => (t += d));
    req.on("end", () => r(t ? JSON.parse(t) : {}));
  });

// Provider login: `auth` is the credential store (provider id -> {type, ...}); an OAuth login waits for POST /__oauth {result}.
const auth = {};
const PROVIDERS = [
  { id: "opencode", name: "OpenCode", source: "custom", env: [], models: { "big-pickle": { name: "Big Pickle", cost: { input: 0 } } } },
  { id: "groq", name: "Groq", source: "env", env: ["GROQ_API_KEY"], models: { llama: { name: "Llama", cost: { input: 1 } } } },
  { id: "envprov", name: "Env Provider", source: "env", env: ["ENVPROV_KEY"], models: {} },
  { id: "cfgprov", name: "Config Provider", source: "config", env: [], models: {} },
  { id: "fakeprov", name: "Fake Provider", source: "custom", env: [], models: {} },
];
const AUTH_METHODS = {
  fakeprov: [
    { type: "oauth", label: "Fake browser login" },
    { type: "oauth", label: "Fake code login", prompts: [{ type: "text", key: "team", message: "Team name" }] },
    { type: "api", label: "API key", prompts: [{ type: "text", key: "region", message: "Region" }] },
  ],
};
const waiting = new Map(); // provider -> resolve of an auto callback
const mcp = {}; // directory -> MCP server name -> {status}
const broken = new Set((process.env.FAKE_OPENCODE_BROKEN ?? "").split(",").filter(Boolean)); // directories in OpenCode's broken MCP state
const MCP_LOAD_MS = Number(process.env.FAKE_OPENCODE_MCP_LOAD_MS ?? 0);
const loads = new Map(); // directory -> its MCP load (a wait)
let aborts = 0;
const warm = new Set();
let pendingOauth = {}; // provider -> method index of the last authorize

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

/** The turn of a broken folder: OpenCode aborts it at tool resolution, before the model call, and sends no session.error. */
const selfAbort = (n) => {
  const id = `msg_selfabort_${n}`;
  const user = { id: "msg_USER", sessionID: "ses_ROOT", role: "user", agent: "build", time: { created: 1 } };
  const assistant = { id, sessionID: "ses_ROOT", role: "assistant", parentID: "msg_USER", agent: "build", providerID: "opencode", modelID: "big-pickle", time: { created: 2 } };
  const event = (type, properties) => ({ type, properties });
  return {
    events: [
      event("message.updated", { sessionID: "ses_ROOT", info: user }),
      event("session.status", { sessionID: "ses_ROOT", status: { type: "busy" } }),
      event("message.updated", { sessionID: "ses_ROOT", info: assistant }),
      event("message.updated", { sessionID: "ses_ROOT", info: { ...assistant, time: { created: 2, completed: 3 }, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } }),
      event("session.status", { sessionID: "ses_ROOT", status: { type: "idle" } }),
      event("session.idle", { sessionID: "ses_ROOT" }),
    ],
  };
};

/** A request that waits for the folder's MCP load. False when it was answered 499 (broken folder) or its client left (that breaks the folder). */
async function mcpGate(dir, res) {
  const key = dir ?? "";
  if (!broken.has(key) && MCP_LOAD_MS) {
    if (!loads.has(key)) loads.set(key, sleep(MCP_LOAD_MS));
    const left = new Promise((r) => res.on("close", () => r(!res.writableEnded)));
    if (await Promise.race([loads.get(key).then(() => false), left])) return (broken.add(key), false);
  }
  if (!broken.has(key)) return true;
  return (res.writeHead(499), res.end(), false);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (code, body) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
  if (url.pathname.startsWith("/__")) {
    const body = await readBody(req);
    if (url.pathname === "/__script") scripts.push(...body.files);
    if (url.pathname === "/__emit")
      for (const e of body.events) {
        if (e.type === "session.status") e.properties.status.type === "idle" ? busy.delete(e.properties.sessionID) : busy.add(e.properties.sessionID);
        send(body.directory, e);
      }
    if (url.pathname === "/__oauth") for (const [id, done] of waiting) (waiting.delete(id), done(body.result));
    if (url.pathname === "/__revert") {
      const s = sessions.find((x) => x.id === body.sessionId);
      s.revert = { messageID: body.messageID };
      updated(s);
    }
    if (url.pathname === "/__unrevert") {
      const s = sessions.find((x) => x.id === body.sessionId);
      (delete s.revert, updated(s));
    }
    if (url.pathname === "/__break") broken.add(body.directory);
    if (url.pathname === "/__heal") broken.delete(body.directory);
    if (url.pathname === "/__fail") failNext.add(body.path);
    if (url.pathname === "/__agents") agents = body.agents;
    if (url.pathname === "/__delay") delays.set(body.path, body.ms);
    if (url.pathname === "/__drop") (clients.forEach((c) => c.end()), clients.clear());
    return json(200, { ok: true });
  }
  const authed = req.headers.authorization === expected;
  const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : undefined;
  log({ type: "request", method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authed, ...(body !== undefined && { body }) });
  if (!authed) return json(401, { error: "unauthorized" });
  if (delays.has(url.pathname)) {
    const ms = delays.get(url.pathname);
    delays.delete(url.pathname);
    await new Promise((r) => setTimeout(r, ms));
  }
  if (failNext.delete(url.pathname)) return json(500, { name: "UnknownError", data: { message: "failed on purpose" } });
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
  if (url.pathname === "/config/providers") await sleep(Number(process.env.FAKE_OPENCODE_PROVIDERS_DELAY_MS ?? 0));
  if (url.pathname === "/config/providers")
    return json(200, { providers: [{ id: "opencode", name: "OpenCode", models: { "big-pickle": { name: "Big Pickle", limit: { context: 200000, output: 8000 } }, alpha: { name: "Alpha" }, thinker: { name: "Thinker", variants: { none: {}, low: {}, high: {} } } } }, { id: "acme", name: "Acme", models: { "x/y": { name: "Model X" } } }], default: { opencode: "big-pickle" } });
  if (url.pathname === "/provider")
    return json(200, { all: PROVIDERS.map((p) => ({ ...p, source: auth[p.id] ? (auth[p.id].type === "api" ? "api" : "custom") : p.source })), connected: [...new Set([...PROVIDERS.filter((p) => ["env", "config"].includes(p.source) && p.id !== "groq").map((p) => p.id), ...Object.keys(auth)])], default: {} });
  if (url.pathname === "/provider/auth") return json(200, AUTH_METHODS);
  let m3 = /^\/auth\/([^/]+)$/.exec(url.pathname);
  if (m3 && req.method === "PUT") return ((auth[m3[1]] = body), json(200, true));
  if (m3 && req.method === "DELETE") return (delete auth[m3[1]], json(200, true));
  if (url.pathname === "/global/dispose" && req.method === "POST") return json(200, true);
  m3 = /^\/provider\/([^/]+)\/oauth\/(authorize|callback)$/.exec(url.pathname);
  if (m3 && req.method === "POST") {
    const [, id, step] = m3;
    const method = AUTH_METHODS[id]?.[body.method];
    if (!method) return json(500, { name: "UnknownError", data: { message: "no auth plugin" } });
    if (method.type !== "oauth") return json(200, null);
    const code = body.method === 1;
    if (step === "authorize") {
      if (code && body.inputs?.team === "bad") return json(400, { name: "ProviderAuthValidationFailed", data: { field: "team", message: "Team is not valid" } });
      pendingOauth[id] = body.method;
      return json(200, { url: `http://127.0.0.1/fake-login?provider=${id}`, method: code ? "code" : "auto", instructions: code ? "Paste the code" : "Code: ABCD-1234" });
    }
    if (pendingOauth[id] !== body.method) return json(400, { name: "ProviderAuthOauthMissing", data: { message: "no pending login" } });
    const ok = (type) => ((auth[id] = { type }), json(200, true));
    if (code) {
      if (!body.code) return json(400, { name: "ProviderAuthOauthCodeMissing", data: { message: "code" } });
      return body.code === "good" ? ok("oauth") : json(400, { name: "ProviderAuthOauthCallbackFailed", data: { message: "bad code" } });
    }
    const result = await new Promise((r) => (waiting.set(id, r), res.on("close", () => waiting.get(id) === r && waiting.delete(id))));
    return result === "success" ? ok("oauth") : json(400, { name: "ProviderAuthOauthCallbackFailed", data: { message: "failed" } });
  }
  if (url.pathname === "/instance/dispose" && req.method === "POST") return (broken.delete(dir ?? ""), loads.delete(dir ?? ""), delete mcp[dir ?? ""], json(200, true));
  if (url.pathname === "/mcp") {
    if (!(await mcpGate(dir, res))) return;
    const map = (mcp[dir ?? ""] ??= {});
    if (req.method === "POST") map[body.name] = { status: "connected" };
    return json(200, map);
  }
  m3 = /^\/mcp\/([^/]+)\/disconnect$/.exec(url.pathname);
  if (m3 && req.method === "POST" && process.env.FAKE_OPENCODE_DISCONNECT_DELAY_MS && (await mcpGate(dir, res))) {
    const left = new Promise((r) => res.on("close", () => r(!res.writableEnded)));
    if (await Promise.race([sleep(Number(process.env.FAKE_OPENCODE_DISCONNECT_DELAY_MS)).then(() => false), left])) return broken.add(dir ?? "");
  }
  if (m3 && req.method === "POST") return (await mcpGate(dir, res)) ? (((mcp[dir ?? ""] ??= {})[m3[1]] = { status: "disabled" }), json(200, true)) : undefined;
  if (url.pathname === "/command" && !(await mcpGate(dir, res))) return;
  if (url.pathname === "/command") return json(200, [{ name: "init", description: "guided AGENTS.md setup", source: "command", template: "t", hints: ["$ARGUMENTS"] }, { name: "review", source: "command", template: "t", hints: [] }, { name: "fail", source: "command", template: "t", hints: [] }]);
  if (url.pathname === "/agent") return json(200, agents ?? [{ name: "build", mode: "primary", permission: [] }, { name: "docs", mode: "primary", description: "Writes docs", permission: [{ permission: "edit", pattern: "*", action: "deny" }] }, { name: "general", mode: "subagent", permission: [] }, { name: "title", mode: "primary", hidden: true, permission: [] }, { name: "plan", mode: "primary", permission: [{ permission: "edit", pattern: "*", action: "deny" }, { permission: "edit", pattern: ".opencode/plans/*.md", action: "allow" }] }]);
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
  // A cold folder: only its first GET and its first POST /session answer late.
  if (url.pathname === "/session" && !warm.has(`${req.method} ${dir}`)) (warm.add(`${req.method} ${dir}`), await sleep(Number(process.env.FAKE_OPENCODE_SESSION_DELAY_MS ?? 0)));
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
  const m = /^\/session\/([^/]+)(\/message|\/command|\/summarize|\/shell|\/prompt_async|\/abort|\/revert|\/unrevert|\/fork)?$/.exec(url.pathname);
  const s = m && sessions.find((x) => x.id === m[1]);
  if (m && s && m[2] === "/revert" && req.method === "POST") {
    if (busy.has(s.id)) return json(400, { name: "SessionBusyError", data: { message: "busy" } });
    s.revert = { messageID: body.messageID, snapshot: "snap", diff: "" };
    send(dir, { type: "session.diff", properties: { sessionID: s.id, diff: [] } });
    updated(s, dir);
    return json(200, s);
  }
  // Fork: a copy with new ids of the messages before `messageID` (all when absent); the permission is not copied.
  if (m && s && m[2] === "/fork" && req.method === "POST") {
    const now = Date.now();
    const f = { id: `ses_fake${String(++counter).padStart(4, "0")}`, slug: `fake-${counter}`, projectID: "global", directory: s.directory, title: `${s.title} (fork #1)`, version: "1.18.34", time: { created: now, updated: now } };
    const list = data.messages[s.id] ?? [];
    const at = body.messageID ? list.findIndex((x) => x.info.id === body.messageID) : -1;
    sessions.push(f);
    data.messages[f.id] = (at < 0 ? list : list.slice(0, at)).map((x, i) => ({ ...x, info: { ...x.info, id: `${x.info.id}_f${counter}`, sessionID: f.id } }));
    return json(200, f);
  }
  if (m && s && !m[2] && req.method === "DELETE") {
    sessions.splice(sessions.indexOf(s), 1);
    delete data.messages[s.id];
    return json(200, true);
  }
  if (m && s && m[2] === "/unrevert" && req.method === "POST") {
    delete s.revert;
    updated(s, dir);
    return json(200, s);
  }
  // Slash commands: a command plays the next script like a prompt and answers at once (the real server answers when the turn ends); `fail` fails it.
  if (m && s && m[2] === "/command" && req.method === "POST") {
    if (body.command === "fail") return json(500, { name: "UnknownError", data: { message: "command failed" } });
    const file = scripts.shift();
    if (file) play(JSON.parse(readFileSync(resolve(file), "utf8")), s.id, dir, body.messageID);
    return json(200, {});
  }
  // Compaction: POST /session/:id/summarize {providerID, modelID} plays the next script (turn-compact.json) and answers at once (the real server answers when the loop ends).
  if (m && s && m[2] === "/summarize" && req.method === "POST") {
    const file = scripts.shift();
    if (file) play(JSON.parse(readFileSync(resolve(file), "utf8")), s.id, dir, undefined);
    return json(200, true);
  }
  // Bash mode: the canned shell run (turn-shell.json: no model call), answered when the command ended; a busy session is refused.
  if (m && s && m[2] === "/shell" && req.method === "POST") {
    if (busy.has(s.id)) return json(400, { name: "SessionBusyError", data: { message: "busy" } });
    await play(JSON.parse(readFileSync(new URL("./turn-shell.json", import.meta.url), "utf8")), s.id, dir, body.messageID, "msg_SHELLUSER");
    return json(200, { info: {}, parts: [] });
  }
  if (m && s && m[2] === "/prompt_async" && req.method === "POST") {
    // The next prompt removes the reverted messages for good.
    if (s.revert) {
      const list = data.messages[s.id] ?? [];
      const at = list.findIndex((x) => x.info.id === s.revert.messageID);
      for (const x of at < 0 ? [] : list.slice(at)) send(dir, { type: "message.removed", properties: { sessionID: s.id, messageID: x.info.id } });
      if (at >= 0) data.messages[s.id] = list.slice(0, at);
      delete s.revert;
      updated(s, dir);
    }
    // The prompt reaches the session that late (a request held before OpenCode's handler, e.g. by the folder's start): an abort sent meanwhile finds nothing to end.
    await sleep(Number(process.env.FAKE_OPENCODE_PROMPT_LATE_MS ?? 0));
    const file = broken.has(dir ?? "") ? undefined : scripts.shift();
    if (broken.has(dir ?? "")) play(selfAbort(++aborts), s.id, dir, body.messageID);
    else if (file) play(JSON.parse(readFileSync(resolve(file), "utf8")), s.id, dir, body.messageID);
    await sleep(Number(process.env.FAKE_OPENCODE_PROMPT_DELAY_MS ?? 0));
    res.writeHead(204);
    return res.end();
  }
  if (m && m[2] === "/abort" && req.method === "POST") {
    // Like OpenCode: aborting a session that runs nothing answers true and sends no event.
    // FAKE_OPENCODE_ABORT_ANSWER_MS: the abort's answer comes that late (whatever it ended, the loop ends at once).
    const answer = () => sleep(Number(process.env.FAKE_OPENCODE_ABORT_ANSWER_MS ?? 0)).then(() => json(200, true));
    if (!busy.has(m[1]) && !current?.on) return answer();
    // FAKE_OPENCODE_ABORT_DELAY_MS: the aborted loop ends that late (OpenCode answers the abort first, the loop unwinds after it).
    const end = () => {
      generation++;
      asks = [];
      busy.delete(m[1]);
      const events = current?.abort ?? [{ type: "session.error", properties: { sessionID: "ses_ROOT", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } }, { type: "session.status", properties: { sessionID: "ses_ROOT", status: { type: "idle" } } }, { type: "session.idle", properties: { sessionID: "ses_ROOT" } }];
      log({ type: "aborted", sessionId: m[1] });
      for (const e of JSON.parse(JSON.stringify(events).replaceAll("ses_ROOT", m[1]))) send(dir, e);
    };
    const late = Number(process.env.FAKE_OPENCODE_ABORT_DELAY_MS ?? 0);
    late ? setTimeout(end, late) : end();
    return answer();
  }
  if (m && s && !m[2] && req.method === "PATCH") {
    if (body.permission) await sleep(Number(process.env.FAKE_OPENCODE_PATCH_DELAY_MS ?? 0));
    s.permission = [...(s.permission ?? []), ...(body.permission ?? [])];
    if (body.title === "fail-title") return json(500, { name: "UnknownError", data: { message: "title refused" } });
    if (body.title) s.title = body.title;
    if (body.time) s.time = { ...s.time, ...body.time };
    return json(200, s);
  }
  if (m && s && m[2] === "/message" && req.method === "GET") await sleep(Number(process.env.FAKE_OPENCODE_MESSAGE_DELAY_MS ?? 0));
  if (m && s && req.method === "GET") return json(200, m[2] ? (data.messages[s.id] ?? []) : s);
  return json(404, { name: "NotFoundError", data: { message: `no route ${req.method} ${url.pathname}` } });
});
server.listen(port, hostname, () => {
  log({ type: "start", pid: process.pid, argv: args, passwordSet: true, hostname, port: server.address().port });
  console.log(`opencode server listening on http://${hostname}:${server.address().port}`);
  if (process.env.FAKE_OPENCODE_CRASH === "1") (console.error("fake opencode crashed on purpose"), process.exit(1));
});
