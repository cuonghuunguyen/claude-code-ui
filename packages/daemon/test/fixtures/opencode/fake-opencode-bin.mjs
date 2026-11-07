// A fake `opencode` binary for the OpenCode engine tests: `--version` and `serve` (a small HTTP server with the routes of the OpenCode API the
// daemon uses, hand-built from packages/sdk/openapi.json). Run as `node <this file> ...` (no shebang needed).
// Env: FAKE_OPENCODE_VERSION, FAKE_OPENCODE_LOG (JSON lines of starts and requests), FAKE_OPENCODE_DATA (JSON {sessions, messages}), FAKE_OPENCODE_CRASH=1 (exit right after the listening line).
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

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

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const authed = req.headers.authorization === expected;
  log({ type: "request", method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authed });
  const json = (code, body) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
  if (!authed) return json(401, { error: "unauthorized" });
  const dir = url.searchParams.get("directory");
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
    const s = { id: `ses_fake${String(++counter).padStart(4, "0")}`, slug: `fake-${counter}`, projectID: "global", directory: dir ?? "/", title: "New session", version: "1.18.34", time: { created: now, updated: now } };
    sessions.push(s);
    return json(200, s);
  }
  const m = /^\/session\/([^/]+)(\/message)?$/.exec(url.pathname);
  const s = m && sessions.find((x) => x.id === m[1]);
  if (m && s && req.method === "GET") return json(200, m[2] ? (data.messages[s.id] ?? []) : s);
  return json(404, { name: "NotFoundError", data: { message: `no route ${req.method} ${url.pathname}` } });
});
server.listen(port, hostname, () => {
  log({ type: "start", pid: process.pid, argv: args, passwordSet: true, hostname });
  console.log(`opencode server listening on http://${hostname}:${server.address().port}`);
  if (process.env.FAKE_OPENCODE_CRASH === "1") (console.error("fake opencode crashed on purpose"), process.exit(1));
});
