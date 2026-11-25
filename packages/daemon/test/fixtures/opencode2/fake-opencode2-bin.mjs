// A fake OpenCode 2 `opencode` binary (2.3.0 API shape, recorded in development-docs spike and checked against a real 2.3.0): `--version`, `serve`, the session routes of the
// adapter and scripted turns. `--version` prints `opencode v${FAKE_OPENCODE_VERSION ?? "2.3.0"}`. `serve` checks Basic auth, prints `server listening on http://…`.
// GET /api/info -> {version, pid, urls}; GET /api/event -> SSE (`server.connected`, the turns' events, `: heartbeat` comments). There is no /global/health: it answers 404.
// Routes: GET /api/model, /api/model/default, /api/session, /api/session/active, /api/session/:id, /api/session/:id/message, /api/session/:id/message/:mid, /api/permission/request;
// POST /api/session, /api/session/:id/prompt, /api/session/:id/model, /api/session/:id/interrupt, /api/session/:id/permission/:rid/reply, /api/session/:id/fork;
// PATCH /api/session/:id (permissions, title, archived, metadata); DELETE /api/session/:id.
// Revert (as 2.3.0): POST …/revert/stage {messageID, files?} (stored messages stay listed; `session.revert` marks the cut), POST …/revert/commit, DELETE …/revert
// (clear: `session.revert.cleared`, then an empty `execution.started`/`succeeded`, as 2.3.0 sends; FAKE_OPENCODE2_CLEAR_ACTIVE_MS: the session active that long meanwhile; FAKE_OPENCODE2_CLEAR_DELAY_MS: it starts that late, a prompt posted meanwhile runs after it), a prompt while staged commits first. A prompt's turn sends `session.inbox.delivered` after its `execution.started`. GET …/diff?from=&to= sums the
// fake `diff` lists ([{file, additions, deletions}]) of the user messages from `from` up to `to` (excluded; default the next user message).
// POST …/compact: a compaction turn (`summary` stored; a session without messages fails "Nothing to compact yet"). POST …/shell {id, command}: answers when the
// command ends (FAKE_OPENCODE2_SHELL_START_MS delays `session.shell.started`); output `out:<command>`, `exit <n>` in the command = that exit code, `sleep` in it runs until DELETE /api/shell/:sh (killed). GET /api/shell/:sh/output.
// Forms: GET …/form, GET /api/form, POST …/form/:fid/reply {answer}, DELETE …/form/:fid (cancel: the turn ends interrupted, as 2.3.0).
// Agents and commands (as 2.3.0): GET /api/agent (FAKE_OPENCODE2_COLD_AGENTS: the first n reads list none, a folder not loaded yet), GET /api/command, GET /api/config
// (the config documents: `data.config`), POST …/agent {agent} (`session.agent.selected`; an unknown agent is taken too), POST …/command {name, text}: the
// command's template is stored as the user prompt and runs a turn (a command `fail` answers 500 CommandExecutionError, `noturn` runs none, an unknown one 404
// CommandNotFoundError; FAKE_OPENCODE2_COMMAND_MS delays it). FAKE_OPENCODE2_COMMAND_LIST_MS delays GET /api/command.
// PUT /api/experimental/session/:id/instructions/entries/:key {value}. POST /__agent/<sid>/<agent>: an agent chosen in OpenCode's own app; POST /__lists: the
// agents and commands changed (`agent.updated`, `command.updated`; `data.commands2` and `data.agents2` replace them).
// MCP (as 2.3.0): GET /api/mcp (the folder's servers and status), PUT /api/experimental/mcp/:server {config} (added and connected), DELETE /api/experimental/mcp/:server
// (404 when absent). POST /__mcp_drop: every server is gone (an OpenCode restart); POST /__mcp_fail: the next adds answer 500. Turn strings `$ORCH` and `$CUI` are the
// session's orchestration and claude-ui server names (`orchestration-<last 10 of its id>`).
// FAKE_OPENCODE2_PROJECT_CONFIG=1 (the config dialogs, GH-864): the project's opencode.json(c) files (and the user's `$XDG_CONFIG_HOME/opencode/opencode.json`) are read at the first request of a folder
// and again only by POST /api/location/reload (as 2.3.0 never re-reads a file by itself), normalised as 2.3.0 does (`mcp.<n>` + `enabled` -> `mcp.servers.<n>` + `disabled`, `permission.skill`
// -> `permissions`, `plugin` -> `plugins`; an entry of `mcp.servers` that is only `{disabled}` is dropped). They feed GET /api/config (documents), GET /api/mcp (a command
// `/nonexistent-bin` fails, a remote url with `oauth` needs auth), POST/DELETE/connect/disconnect of /api/experimental/mcp/:server, GET /api/skill (the folder's `.opencode/skills/*/SKILL.md`)
// and GET /api/plugin (a spec with `broken` fails to load) and the permissions of GET /api/agent (config rules after the base rules).
// FAKE_OPENCODE2_FAIL: see the session route.
// FAKE_OPENCODE2_DATA: JSON `{sessions: [{id, directory, title, time, permissions?, parentID?}], messages: {<id>: [v2 messages]}, models?, default?}`.
// FAKE_OPENCODE2_SCRIPT: comma-separated turn files, one per prompt in order (a prompt after the last one gets a plain "pong" turn). A turn is a JSON list of steps:
//   {event, data}   emits the event (`$SESSION`, `$USER`, `$A1`..`$A9` (assistant message ids), `$PERM` (a permission id) are replaced)
//   {wait: "permission"}  holds the turn until `…/permission/:rid/reply` came; {when: "once"|"always"|"reject"|"allowed"} on a step skips it unless that was the reply (`allowed` = once or always); `$REJECT` is the reply's message
//   {hold: true}    holds the turn until `…/interrupt`, which then ends it as the user's stop (`step.failed` aborted, `execution.interrupted`)
//   {sleep: ms}
//   {form: {fields, title?, sessionID?, kind?}}  asks a question form (of `sessionID`, default the turn's) (`form.created`, metadata kind question, tool `$A1`/`$CALL`); {wait: "form"} holds until it is answered ("replied")
//     or cancelled ("cancelled": the call fails aborted and the turn ends interrupted); `$ANSWER` is the answer
// FAKE_OPENCODE2_MODEL_DELAY / _PROMPT_DELAY / _MESSAGE_DELAY: ms the model routes / the prompt route / the message read wait. FAKE_OPENCODE2_SWALLOW_STOP: an interrupt sends no end events. POST /__drop ends the event streams; POST /__forget/<id> drops a session; POST /__stage/<id>/<message id> and /__clear/<id> revert as OpenCode's own app.
// POST …/synthetic {text}: stored as a `synthetic` message, no turn. Instruction entries: PUT/DELETE …/instructions/entries/:key and GET …/entries.
// Provider login (GH-879, as 2.3.0): GET /api/integration (per folder; FAKE_OPENCODE2_COLD_INTEGRATIONS: the first n reads list none, a folder not loaded yet), POST /api/integration/:id/connect/key
// {key, answer?} (a credential), POST …/connect/oauth {methodID, answer?} -> an attempt (`browser`: auto, ended by POST /__oauth {result: "success"|"failed"}; `code`: mode code, an answer
// `team: bad` answers 400), GET/DELETE …/connect/oauth/:attempt, POST …/connect/oauth/:attempt/complete {code} (`good` connects, else 400); GET /api/credential, DELETE /api/credential/:id.
// `envprov` is connected by an environment variable.
// MCP sign-in (as 2.3.0; project config mode): a remote server whose url has `oauth` is needs_auth with `integrationID: mcp-<name>` until that integration has a credential; its OAuth
// attempt (mode auto) completes on its second status read. Plugin update: a package spec with `outdated` lists `package.outdated` until POST /api/plugin/update {targets} (204).
// Background shells of the model (GH-922, as 2.3.0): the turn step `{shell: {command, output}}` starts one for the turn's session (`shell.created`, `$SHELL1`..`$SHELL2` name them; the shell's own
// session in `metadata.sessionID`); `data.shells` [{id, command, sessionID}] are running at start. GET /api/shell lists the running ones of the folder; DELETE /api/shell/:id kills one (the synthetic inbox item
// `state: error`, `shell.exited` killed, `shell.deleted`; its output is gone: 404 as 2.3.0); POST /__shell_exit {id, exit, output} ends one as a command that finished (`shell.exited`, then the synthetic
// inbox item `state: completed` with the output).
// Local history (GH-885): `debug paths` prints FAKE_OPENCODE_DATA_DIR as the data folder; GET /api/project lists a project per `projectID` of the sessions (`canonical` = the folder of the first);
// the turn variable `$SNAP` is FAKE_OPENCODE2_SNAPSHOT (a tree hash of the test's snapshot store, the `snapshot` of a `step.started`).
// FAKE_OPENCODE_LOG: JSON lines of `start`, `request` (method, path, authed, body of a write) and `version`.
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const log = (o) => process.env.FAKE_OPENCODE_LOG && appendFileSync(process.env.FAKE_OPENCODE_LOG, `${JSON.stringify(o)}\n`);
const args = process.argv.slice(2);
const version = process.env.FAKE_OPENCODE_VERSION ?? "2.3.0";

if (args.includes("--version")) {
  log({ type: "version" });
  console.log(`opencode v${version}`);
  process.exit(0);
}
// `debug paths`: FAKE_OPENCODE_DATA_DIR is the `data` folder (none: the line is left out).
if (args[0] === "debug" && args[1] === "paths") {
  console.log(`home        /fake/home\n${process.env.FAKE_OPENCODE_DATA_DIR ? `data        ${process.env.FAKE_OPENCODE_DATA_DIR}\n` : ""}cache       /fake/cache`);
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
const rule = (action, effect, resource = "*") => ({ action, resource, effect });
const base = [rule("*", "allow"), rule("read", "ask", "*.env"), rule("question", "allow")];
let agents = data.agents ?? [
  { id: "plan", name: "Plan", description: "Read-only agent", mode: "primary", hidden: false, permissions: [...base, rule("edit", "deny"), rule("edit", "allow", "/plans/*"), rule("browser", "deny")] },
  { id: "build", name: "Build", description: "The default agent", mode: "primary", hidden: false, permissions: [...base, rule("browser", "deny")] },
  { id: "general", name: "General", mode: "subagent", hidden: false, permissions: base },
  { id: "title", name: "Title", mode: "primary", hidden: true, permissions: [] },
];
let commands = data.commands ?? [{ name: "init", description: "guided AGENTS.md setup" }, { name: "review", description: "review changes" }, { name: "hello", description: "Say hello" }];
let agentReads = 0;
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
/** The instruction entries of each session. */
const instructions = new Map();
/** Open permission requests by id. */
const asked = new Map();
/** Open forms by id: `{form, turn}`. */
const forms = new Map();
/** Running shells by id: `{kill()}`. */
const shells = new Map();
const shellOut = new Map();
for (const x of data.shells ?? []) {
  const sh = { id: x.id, status: "running", command: x.command, cwd: sessions.get(x.sessionID)?.directory, shell: "/bin/sh", metadata: { sessionID: x.sessionID }, time: { started: 1 } };
  // Kill and exit act as those of a started shell (`agentShell`); they run after start, when `emit` exists.
  shells.set(x.id, {
    command: x.command,
    info: sh,
    kill: () => (shells.delete(x.id), synthetic(x.sessionID, x.id, x.command, "error", "Shell.NotFoundError", {}, sh.cwd), emit("shell.exited", { id: x.id, status: "killed" }, sh.cwd), emit("shell.deleted", { id: x.id }, sh.cwd), shellOut.delete(x.id)),
    exit: (exit, output) => (shellOut.set(x.id, output), emit("shell.exited", { id: x.id, status: "exited", exit }, sh.cwd), synthetic(x.sessionID, x.id, x.command, "completed", output, { truncated: false, exit }, sh.cwd), shells.delete(x.id)),
  });
  shellOut.set(x.id, x.output ?? "");
}
let nextTurn = 0;
/** MCP servers by `<directory>\0<name>`: their config. */
const mcps = new Map();
let mcpFail = false;
const integrations = [
  { id: "groq", name: "Groq", methods: [{ type: "key" }, { type: "env", names: ["GROQ_API_KEY"] }] },
  { id: "envprov", name: "Env Provider", methods: [{ type: "key" }, { type: "env", names: ["ENVPROV_API_KEY"] }] },
  { id: "anthropic", name: "Anthropic", methods: [{ type: "key" }, { type: "env", names: ["ANTHROPIC_API_KEY"] }] },
  {
    id: "fakeprov",
    name: "Fake Provider",
    methods: [
      { id: "browser", type: "oauth", label: "Fake browser login" },
      { id: "code", type: "oauth", label: "Fake code login", form: [{ key: "team", title: "Team", required: true, type: "string", placeholder: "acme" }] },
      { id: "cli", type: "command", label: "Fake CLI", command: ["fake", "login"] },
      { type: "key", label: "API key", form: [{ key: "region", title: "Region", type: "string", options: [{ value: "us", label: "US" }, { value: "eu", label: "EU", description: "Europe" }] }, { key: "host", title: "Host", type: "string", when: [{ key: "region", op: "eq", value: "eu" }] }, { key: "server", hidden: true, type: "string", default: "https://example.com" }] },
    ],
  },
  { id: "cliprov", name: "CLI Provider", methods: [{ id: "cli", type: "command", label: "Log in with the CLI", command: ["cli", "login"] }, { id: "count", type: "oauth", label: "Counted login", form: [{ key: "n", title: "N", type: "number" }] }, { type: "env", names: ["CLIPROV_TOKEN"] }] },
];
/** Credentials by id: `{id, integrationID, method}`. OAuth attempts by id: `{integrationID, methodID, mode, status}`. */
const credentials = new Map();
const attempts = new Map();
let integrationReads = 0;
const connectionsOf = (i) => [...[...credentials.values()].filter((c) => c.integrationID === i.id).map((c) => ({ type: "credential", id: c.id, label: i.name, method: c.method })), ...(i.id === "envprov" ? [{ type: "env", name: "ENVPROV_API_KEY" }] : [])];
const credit = (integrationID, method) => {
  const c = { id: id("cred"), integrationID, method };
  credentials.set(c.id, c);
};

const projectMode = process.env.FAKE_OPENCODE2_PROJECT_CONFIG === "1";
/** Folder -> what the config files said when it was loaded (a reload reads them again). */
const loaded = new Map();
let reloadEmptyUntil = 0;
const mcpState = new Map();
const updatedPlugins = new Set();
const mcpGone = new Set();
const jsonc = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
const normalize = (raw) => {
  const servers = { ...(raw.mcp?.servers ?? {}) };
  for (const [k, v] of Object.entries(raw.mcp ?? {})) if (k !== "servers" && k !== "timeout" && v && typeof v === "object") servers[k] = { ...Object.fromEntries(Object.entries(v).filter(([x]) => x !== "enabled")), ...(v.enabled === false && { disabled: true }) };
  for (const [k, v] of Object.entries(servers)) if (!v.type) delete servers[k];
  const permissions = [...(raw.permissions ?? []), ...Object.entries(raw.permission?.skill ?? {}).map(([resource, effect]) => ({ action: "skill", resource, effect }))];
  const plugins = [...(raw.plugins ?? []), ...(raw.plugin ?? [])].map((x) => (Array.isArray(x) ? x[0] : typeof x === "object" ? x.package : x));
  return { mcp: { servers }, permissions, plugins };
};
const snapshotOf = (dir) => {
  const docs = [];
  for (const file of [join(process.env.XDG_CONFIG_HOME ?? "/nonexistent", "opencode", "opencode.json"), ...["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"].map((f) => join(dir, f))])
    if (existsSync(file)) docs.push({ type: "document", path: file, info: normalize(jsonc(readFileSync(file, "utf8"))) });
  const servers = Object.assign({}, ...docs.map((d) => d.info.mcp.servers));
  return { docs, servers, permissions: docs.flatMap((d) => d.info.permissions), plugins: [...new Set(docs.flatMap((d) => d.info.plugins))] };
};
const snap = (dir) => loaded.get(dir) ?? (loaded.set(dir, snapshotOf(dir)), loaded.get(dir));
const signedIn = (integrationID) => [...credentials.values()].some((c) => c.integrationID === integrationID);
/** The integration of each remote MCP server whose url has `oauth` (as 2.3.0: a server that needs auth carries an `integrationID`): one OAuth method, ended by the attempt's second status read. */
const mcpIntegrations = (dir) => (projectMode ? Object.keys(snap(dir).servers) : []).filter((n) => snap(dir).servers[n].url?.includes("oauth")).map((n) => ({ id: `mcp-${n}`, name: n, methods: [{ id: "oauth", type: "oauth", label: "Sign in" }] }));
const mcpRows = (dir) => {
  const all = new Map(Object.entries(snap(dir).servers).filter(([n]) => !mcpGone.has(`${dir}\0${n}`)));
  for (const [k, c] of mcps) if (k.startsWith(`${dir}\0`)) all.set(k.split("\0")[1], c);
  return [...all].map(([name, c]) => {
    const state = mcpState.get(`${dir}\0${name}`);
    const status = state === "disconnected" || (c.disabled && state !== "connected") ? { status: "disabled" } : c.command?.[0] === "/nonexistent-bin" ? { status: "failed", error: "spawn /nonexistent-bin ENOENT" } : c.url?.includes("oauth") && !signedIn(`mcp-${name}`) ? { status: "needs_auth", error: "needs sign-in" } : { status: "connected" };
    return { name, status, ...(c.url?.includes("oauth") && { integrationID: `mcp-${name}` }) };
  });
};
const skillsOf = (dir) => {
  const root = join(dir, ".opencode", "skills");
  const own = existsSync(root) ? readdirSync(root).filter((n) => existsSync(join(root, n, "SKILL.md"))) : [];
  return [...(data.skills ?? []), ...own.map((n) => ({ id: `skl_${n}`, name: n, description: `${n} skill`, path: join(root, n, "SKILL.md"), content: "" }))];
};
const fill = (v, vars) => (typeof v === "string" ? vars[v] ?? v.replace(/\$ORCH|\$CUI|\$SHELL\d/g, (k) => vars[k]) : Array.isArray(v) ? v.map((x) => fill(x, vars)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)])) : v);
const synthetic = (sid, sh, command, state, text, extra, dir) =>
  emit("session.inbox.enqueued", { inboxID: id("msg"), sessionID: sid, item: { type: "synthetic", payload: { text: `<shell id="${sh}" state="${state}" command="${command}">\n${text}\n</shell>`, metadata: { source: "shell", shellID: sh, jobID: sh, state, ...extra } }, delivery: "steer" } }, dir);
/** A background shell of the model's command (`shell` tool with `background: true`): running until it is killed or POST /__shell_exit ends it. */
function agentShell(sid, spec, dir) {
  const sh = spec.id;
  const info = { id: sh, status: "running", command: spec.command, cwd: dir, shell: "/bin/sh", metadata: { sessionID: sid }, time: { started: Date.now() } };
  shellOut.set(sh, spec.output ?? "");
  // 2.3.0 sends the synthetic inbox item after `shell.exited` for a finished command, before it for a killed one.
  shells.set(sh, {
    command: spec.command,
    info,
    kill: () => (shells.delete(sh), synthetic(sid, sh, spec.command, "error", "Shell.NotFoundError", {}, dir), emit("shell.exited", { id: sh, status: "killed" }, dir), emit("shell.deleted", { id: sh }, dir), shellOut.delete(sh)),
    exit: (exit, output) => (shellOut.set(sh, output), emit("shell.exited", { id: sh, status: "exited", exit }, dir), synthetic(sid, sh, spec.command, "completed", output, { truncated: false, exit }, dir), shells.delete(sh)),
  });
  emit("shell.created", { info }, dir);
}
async function runTurn(sid, userId, steps) {
  const dir = sessions.get(sid).directory;
  const vars = { $SESSION: sid, $USER: userId, $DIR: dir, ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`$A${n}`, id("msg")])), $PERM: id("per"), $FORM: id("frm"), $CALL: id("call"), $SNAP: process.env.FAKE_OPENCODE2_SNAPSHOT, $SHELL1: id("sh"), $SHELL2: id("sh"), $ORCH: `orchestration-${sid.slice(-10)}`, $CUI: `claude-ui-${sid.slice(-10)}` };
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
    else if (step.shell) agentShell(sid, fill(step.shell, vars), dir);
    else if (step.wait === "permission") {
      last = await Promise.race([new Promise((r) => (reply = r)), stop]);
      if (turn.stopped) break;
      emit("permission.replied", { sessionID: sid, requestID: vars.$PERM, reply: last }, dir);
      asked.delete(vars.$PERM);
    } else if (step.form) {
      const form = { id: vars.$FORM, sessionID: step.form.sessionID ?? sid, title: step.form.title ?? "Questions", metadata: step.form.kind ? { kind: step.form.kind } : { kind: "question", tool: { messageID: vars.$A1, id: vars.$CALL } }, fields: step.form.fields };
      forms.set(form.id, { form, turn, dir });
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
      // 2.3.0 delivers the prompt (its message id) right after the execution started.
      if (step.event === "session.execution.started" && userId) emit("session.inbox.delivered", { sessionID: sid, inboxID: userId }, dir);
    }
  }
  log({ type: "turn", end: turn.stopped ? "interrupted" : "done" });
  if (running.get(sid) === turn) running.delete(sid);
}

/** The prompt is stored, its turn starts (registered at once, so an interrupt after the answer finds it) and the request is answered. */
function takePrompt(s, body, res, command = false) {
  if (s.revert) commitRevert(s);
  const userId = body.id ?? id("msg");
  const user = { id: userId, time: { created: Date.now() }, text: body.text, ...(body.files && { files: body.files.map((f) => ({ data: f.uri.split(",")[1], mime: /^data:([^;,]+)/.exec(f.uri)?.[1], source: f.source, name: f.name })) }), type: "user" };
  messages.get(s.id).push(user);
  s.time.updated = Date.now();
  const file = scripts[nextTurn++];
  const steps = file ? JSON.parse(readFileSync(file, "utf8")) : pongTurn;
  emit("session.inbox.enqueued", { inboxID: userId, sessionID: s.id, item: { type: "user", payload: { text: body.text }, delivery: "steer" } }, s.directory);
  // A clear's empty execution that has not run yet runs first (one execution at a time).
  void (s.clearing ?? Promise.resolve()).then(() => runTurn(s.id, userId, steps));
  if (command) return (res.writeHead(204), res.end());
  json(res, 200, { data: { id: userId, sessionID: s.id, time: user.time, type: "user", payload: { text: body.text } } });
}

/**
 * The empty execution 2.3.0 runs after a revert clear. FAKE_OPENCODE2_CLEAR_ACTIVE_MS: it runs that long, the session listed as active meanwhile.
 * FAKE_OPENCODE2_CLEAR_DELAY_MS: it starts that late; a prompt posted meanwhile runs after it.
 */
function clearExecution(s) {
  const delay = Number(process.env.FAKE_OPENCODE2_CLEAR_DELAY_MS ?? 0);
  if (delay) {
    const done = (s.clearing = new Promise((r) => setTimeout(() => (emptyExecution(s), r()), delay)));
    return void done.then(() => s.clearing === done && delete s.clearing);
  }
  emptyExecution(s);
}
function emptyExecution(s) {
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
    if (url.pathname.startsWith("/__agent/")) {
      const [sid, agent] = url.pathname.slice(9).split("/");
      const s = sessions.get(sid);
      emit("session.agent.selected", { sessionID: sid, agent, previous: s.agent }, s.directory);
      s.agent = agent;
      return json(res, 200, {});
    }
    // POST /__lists[?dir=<folder>]: the events name that folder (OpenCode names a folder by its real path).
    if (url.pathname === "/__lists") {
      if (data.commands2) commands = data.commands2;
      if (data.agents2) agents = data.agents2;
      const where = url.searchParams.get("dir") ?? undefined;
      emit("agent.updated", {}, where);
      emit("command.updated", {}, where);
      return json(res, 200, {});
    }
    // POST /__oauth {result}: the browser ended every pending auto OAuth attempt.
    if (url.pathname === "/__oauth") {
      for (const a of attempts.values()) if (a.mode === "auto" && a.status === "pending") (a.status = body.result === "success" ? "complete" : "failed"), a.status === "complete" && credit(a.integrationID, "oauth");
      return json(res, 200, {});
    }
    // POST /__shell_exit {id, exit, output}: a background shell's command finished (a test seam like /__drop).
    if (url.pathname === "/__shell_exit") return (shells.get(body.id)?.exit(body.exit ?? 0, body.output ?? ""), json(res, 200, {}));
    if (url.pathname === "/__mcp_drop") return (mcps.clear(), json(res, 200, {}));
    if (url.pathname === "/__mcp_fail") return ((mcpFail = true), json(res, 200, {}));
    if (url.pathname.startsWith("/__clear/")) {
      const s = sessions.get(url.pathname.slice(9));
      delete s.revert;
      emit("session.revert.cleared", { sessionID: s.id }, s.directory);
      // ?empty=0: the clear's empty execution never comes (another OpenCode version).
      if (url.searchParams.get("empty") !== "0") clearExecution(s);
      return json(res, 200, {});
    }
    // /__run/:id: a turn started in OpenCode's own app (no prompt of ours): its execution, one step with a text, its end.
    if (url.pathname.startsWith("/__run/")) {
      const s = sessions.get(url.pathname.slice(7));
      const sid = s.id;
      const base = { sessionID: sid, assistantMessageID: "msg_ext" };
      emit("session.execution.started", { sessionID: sid }, s.directory);
      emit("session.step.started", { ...base, agent: "build", model: { id: "m", providerID: "fake" } }, s.directory);
      emit("session.text.started", { ...base, ordinal: 0 }, s.directory);
      emit("session.text.delta", { ...base, ordinal: 0, delta: "own app" }, s.directory);
      emit("session.text.ended", { ...base, ordinal: 0, text: "own app" }, s.directory);
      emit("session.step.ended", { ...base, finish: "stop", rawFinish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, files: [] }, s.directory);
      emit("session.execution.succeeded", { sessionID: sid }, s.directory);
      return json(res, 200, {});
    }
    log({ type: "request", method: req.method, path: url.pathname, authed, ...(url.search && { query: Object.fromEntries(url.searchParams) }), ...(body !== undefined && { body }) });
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

    // FAKE_OPENCODE2_PARTIAL_AGENTS: the next n reads (after the cold ones) list all but the last agent, as 2.3.0 lists a folder's built-ins before its own agents.
    if (projectMode && p === "/api/location/reload" && req.method === "POST") {
      for (const k of loaded.keys()) loaded.set(k, snapshotOf(k));
      reloadEmptyUntil = Date.now() + Number(process.env.FAKE_OPENCODE2_RELOAD_EMPTY_MS ?? 0);
      mcps.clear();
      mcpState.clear();
      mcpGone.clear();
      return (res.writeHead(204), res.end());
    }
    // FAKE_OPENCODE2_RELOAD_EMPTY_MS: after a location reload the skill, plugin and agent lists are empty for this long (2.3.0 rebuilds the locations for 1-3 s).
    const rebuilding = Date.now() < reloadEmptyUntil;
    if (projectMode && p === "/api/skill") return json(res, 200, { location: { directory: dir }, data: rebuilding ? [] : skillsOf(dir) });
    // POST /api/plugin/update {targets} (204): the packages are no longer outdated.
    if (projectMode && p === "/api/plugin/update" && req.method === "POST") return (body.targets.forEach((t) => updatedPlugins.add(t)), res.writeHead(204), res.end());
    if (projectMode && p === "/api/plugin" && rebuilding) return json(res, 200, { location: { directory: dir }, data: [] });
    if (projectMode && p === "/api/plugin") {
      const own = snap(dir).plugins.map((spec) => ({ id: undefined, source: spec.startsWith("file://") ? { type: "local", path: spec.slice(7) } : { type: "package", target: spec, version: "1.0.0", ...(/outdated/.test(spec) && !updatedPlugins.has(spec) && { outdated: true }) }, features: { server: true }, state: /broken/.test(spec) ? { status: "failed", error: "Plugin failed to load", ref: "err_1" } : { status: "active" } }));
      return json(res, 200, { location: { directory: dir }, data: [{ id: "opencode.agent", source: { type: "builtin" }, features: { server: true }, state: { status: "active" } }, ...own.map(({ id, ...x }) => x)] });
    }
    if (p === "/api/agent" && rebuilding) return json(res, 200, { location: { directory: dir }, data: [] });
    if (p === "/api/agent") {
      const n = ++agentReads - Number(process.env.FAKE_OPENCODE2_COLD_AGENTS ?? 0);
      return json(res, 200, { location: { directory: dir }, data: (n <= 0 ? [] : n <= Number(process.env.FAKE_OPENCODE2_PARTIAL_AGENTS ?? 0) ? agents.slice(0, -1) : agents).map((a) => (projectMode ? { ...a, permissions: [...base, ...snap(dir).permissions, ...a.permissions.slice(base.length)] } : a)) });
    }
    if (projectMode && p === "/api/mcp") return json(res, 200, { location: { directory: dir }, data: mcpRows(dir) });
    if (projectMode && (m = /^\/api\/experimental\/mcp\/([^/]+)\/(connect|disconnect)$/.exec(p))) return (mcpState.set(`${dir}\0${m[1]}`, m[2] === "connect" ? "connected" : "disconnected"), res.writeHead(204), res.end());
    if (p === "/api/mcp") return json(res, 200, { location: { directory: dir }, data: [...mcps.keys()].filter((k) => k.startsWith(`${dir}\0`)).map((k) => ({ name: k.split("\0")[1], status: { status: "connected" } })) });
    if ((m = /^\/api\/experimental\/mcp\/([^/]+)$/.exec(p))) {
      const key = `${dir}\0${m[1]}`;
      if (req.method === "PUT") {
        if (mcpFail) return json(res, 500, { message: "MCP server failed to connect" });
        mcps.set(key, body.config);
        mcpState.set(key, "connected");
        mcpGone.delete(key);
        emit("mcp.status.changed", { server: m[1] }, dir);
        return (res.writeHead(204), res.end());
      }
      if (projectMode && req.method === "DELETE" && !mcps.has(key) && snap(dir).servers[m[1]]) return (mcpGone.add(key), res.writeHead(204), res.end());
      if (req.method === "DELETE") return mcps.delete(key) ? (res.writeHead(204), res.end()) : json(res, 404, { _tag: "McpServerNotFoundError", message: `MCP server not found: ${m[1]}` });
    }
    // FAKE_OPENCODE2_COMMAND_LIST_MS: ms the command list waits (a folder OpenCode is still loading).
    if (p === "/api/command") return void setTimeout(() => json(res, 200, { location: { directory: dir }, data: commands }), Number(process.env.FAKE_OPENCODE2_COMMAND_LIST_MS ?? 0));
    if (p === "/api/config") return json(res, 200, projectMode ? snap(dir).docs : (data.config ?? []));
    // Instruction entries of a session: PUT {value}, DELETE and GET (the list) of …/instructions/entries[/:key].
    if ((m = /^\/api\/experimental\/session\/([^/]+)\/instructions\/entries(?:\/([^/]+))?$/.exec(p))) {
      const entries = (instructions.get(m[1]) ?? instructions.set(m[1], new Map()).get(m[1]));
      if (!m[2] && req.method === "GET") return json(res, 200, { data: [...entries].map(([key, value]) => ({ key, value })) });
      if (m[2] && req.method === "PUT") return (entries.set(m[2], body.value), res.writeHead(204), res.end());
      if (m[2] && req.method === "DELETE") return (entries.delete(m[2]), res.writeHead(204), res.end());
    }
    if (p === "/api/form") return json(res, 200, { location: { directory: dir }, data: [...forms.values()].map((f) => f.form).filter((f) => sessions.get(f.sessionID)?.directory === dir || !dir || (f.sessionID === "global" && forms.get(f.id)?.dir === dir)) });
    if (p === "/api/project") return json(res, 200, [...new Set([...sessions.values()].map((x) => x.projectID))].map((pid) => ({ id: pid, canonical: [...sessions.values()].find((x) => x.projectID === pid).directory, vcs: "git", time: { created: 1, updated: 1 }, sandboxes: [] })));
    if (p === "/api/shell" && req.method === "GET") return json(res, 200, { location: { directory: dir }, data: [...shells.values()].filter((x) => x.info && x.info.cwd === dir).map((x) => x.info) });
    if ((m = /^\/api\/shell\/([^/]+)(\/output)?$/.exec(p))) {
      if (m[2]) return shellOut.has(m[1]) ? json(res, 200, { location: { directory: dir }, data: { output: shellOut.get(m[1]), cursor: 0, size: 0, truncated: false } }) : json(res, 404, { message: "shell not found" });
      if (req.method === "DELETE") return (shells.get(m[1])?.kill(), res.writeHead(204), res.end());
    }
    if (p === "/api/integration") {
      const cold = ++integrationReads <= Number(process.env.FAKE_OPENCODE2_COLD_INTEGRATIONS ?? 0);
      return json(res, 200, { location: { directory: dir }, data: cold || !dir ? [] : [...integrations, ...mcpIntegrations(dir)].map((i) => ({ ...i, connections: connectionsOf(i) })) });
    }
    if ((m = /^\/api\/integration\/([^/]+)\/connect\/(key|oauth)(?:\/([^/]+))?(\/complete)?$/.exec(p))) {
      const [, iid, kind, aid, complete] = m;
      if (![...integrations, ...mcpIntegrations(dir)].some((i) => i.id === iid)) return json(res, 404, { _tag: "IntegrationNotFoundError", integrationID: iid, message: `Integration not found: ${iid}` });
      if (kind === "key") return (credit(iid, "key"), res.writeHead(204), res.end());
      if (!aid) {
        if (body.answer?.team === "bad") return json(res, 400, { _tag: "InvalidRequestError", message: "Team is not valid" });
        const a = { attemptID: id("con"), integrationID: iid, methodID: body.methodID, mode: body.methodID === "code" ? "code" : "auto", status: "pending", polls: 0 };
        attempts.set(a.attemptID, a);
        const time = { created: Date.now(), expires: Date.now() + 600_000 };
        return json(res, 200, { location: { directory: dir }, data: { attemptID: a.attemptID, url: `https://example.com/fake-login?provider=${iid}`, instructions: a.mode === "code" ? "Paste the code" : "Code: ABCD-1234", mode: a.mode, time } });
      }
      const a = attempts.get(aid);
      const missing = () => json(res, 404, { _tag: "IntegrationAttemptNotFoundError", message: `OAuth attempt not found: ${aid}` });
      if (req.method === "DELETE") return (attempts.delete(aid), res.writeHead(204), res.end());
      if (!a) return missing();
      if (complete) {
        if (body?.code !== "good") return json(res, 400, { _tag: "InvalidRequestError", message: "The code is not valid" });
        attempts.delete(aid);
        return (credit(iid, "oauth"), res.writeHead(204), res.end());
      }
      if (iid.startsWith("mcp-") && a.status === "pending" && ++a.polls >= 2) (a.status = "complete"), credit(iid, "oauth");
      return json(res, 200, { location: { directory: dir }, data: { status: a.status, ...(a.status === "failed" && { message: "The browser login failed" }), time: { created: 0, expires: 1 } } });
    }
    if (p === "/api/credential") return json(res, 200, { data: [...credentials.values()].map((c) => ({ id: c.id, integrationID: c.integrationID, label: c.integrationID, active: true, value: { type: c.method, key: "x" } })) });
    if ((m = /^\/api\/credential\/([^/]+)$/.exec(p)) && req.method === "DELETE") return (credentials.delete(m[1]), res.writeHead(204), res.end());
    if (p === "/api/permission/request") return json(res, 200, { location: { directory: dir }, data: [...asked.values()].filter((a) => sessions.get(a.sessionID)?.directory === dir || !dir).map(({ turn, ...a }) => a) });
    if (p === "/api/session/active" && req.method === "GET") return json(res, 200, { data: Object.fromEntries([...running.keys()].map((k) => [k, { type: "running" }])) });
    if (p === "/api/session" && req.method === "POST") {
      const sid = id("ses");
      const now = Date.now();
      const s = { id: sid, projectID: "global", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now, updated: now }, permissions: body.permissions ?? [], location: { directory: body.location.directory }, directory: body.location.directory, ...(body.agent && { agent: body.agent }), ...(body.model && { model: body.model }), ...(body.title && { title: body.title }), ...(body.metadata && { metadata: body.metadata }) };
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
    // A form of session "global" (an MCP elicitation, as 2.3.0 creates it): answered by `POST|DELETE /api/session/global/form/:id[/reply]` with the folder in `x-opencode-directory`; without it, or for another folder: 404.
    if ((m = /^\/api\/session\/global\/form\/([^/]+)(\/reply)?$/.exec(p))) {
      const f = forms.get(m[1]);
      if (!f || f.form.sessionID !== "global" || req.headers["x-opencode-directory"] !== encodeURIComponent(f.dir)) return json(res, 404, { message: `Form not found: ${m[1]}` });
      f.turn.form(m[2] ? { answer: body.answer } : { cancel: true });
      return (res.writeHead(204), res.end());
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
        Object.assign(s, body.permissions !== undefined && { permissions: body.permissions }, body.title !== undefined && { title: body.title }, body.metadata !== undefined && { metadata: { ...s.metadata, ...body.metadata } });
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
        // As 2.3.0: the fork has no revert, no metadata and no parent.
        delete f.revert;
        delete f.metadata;
        sessions.set(fid, f);
        messages.set(fid, (cut < 0 ? list : list.slice(0, cut)).map((x) => ({ ...x, id: id("msg") })));
        return json(res, 200, { data: f });
      }
      // A hidden message for the model (`resume: false` starts no turn); stored as OpenCode 2.3.0 does (type synthetic).
      if (sub === "synthetic") {
        const msg = { id: body.id ?? id("msg"), time: { created: Date.now() }, text: body.text, type: "synthetic" };
        messages.get(s.id).push(msg);
        return json(res, 200, { data: { id: msg.id, sessionID: s.id, time: msg.time, type: "synthetic", payload: { text: body.text }, delivery: body.delivery ?? "steer" } });
      }
      if (sub === "model") return (s.model = body.model, res.writeHead(204), res.end());
      if (sub === "agent") {
        emit("session.agent.selected", { sessionID: s.id, agent: body.agent, previous: s.agent }, s.directory);
        s.agent = body.agent;
        return (res.writeHead(204), res.end());
      }
      if (sub === "command") {
        if (body.name === "fail") return json(res, 500, { _tag: "CommandExecutionError", command: body.name, message: "Usage: /fail <what>" });
        if (!commands.some((c) => c.name === body.name)) return json(res, 404, { _tag: "CommandNotFoundError", command: body.name, message: `Command not found: ${body.name}` });
        // A command that runs no turn (as `/goal pause`).
        if (body.name === "noturn") return (res.writeHead(204), res.end());
        // FAKE_OPENCODE2_COMMAND_MS: ms before OpenCode takes the command (its turn starts then).
        return void setTimeout(() => takePrompt(s, { text: `Run ${body.name}: ${body.text}`, files: body.files }, res, true), Number(process.env.FAKE_OPENCODE2_COMMAND_MS ?? 0));
      }
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
  log({ type: "start", pid: process.pid, argv: args, passwordSet: true, configFile: process.env.OPENCODE_CONFIG, config: process.env.OPENCODE_CONFIG && existsSync(process.env.OPENCODE_CONFIG) ? JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, "utf8")) : undefined, hostname, port: server.address().port });
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
