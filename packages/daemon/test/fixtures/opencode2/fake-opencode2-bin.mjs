// A fake OpenCode 2 `opencode` binary (2.3.0 API shape, recorded in development-docs spike): `--version` and `serve` with the two routes the daemon uses so far.
// `--version` prints `opencode v${FAKE_OPENCODE_VERSION ?? "2.3.0"}`. `serve` checks Basic auth, prints `server listening on http://…`.
// GET /api/info -> {version, pid, urls}; GET /api/event -> SSE (one server.connected event, then `: heartbeat` comments). There is no /global/health: it answers 404.
// FAKE_OPENCODE_LOG: JSON lines of `start` and `request` (method, path, authed).
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const log = (o) => process.env.FAKE_OPENCODE_LOG && appendFileSync(process.env.FAKE_OPENCODE_LOG, `${JSON.stringify(o)}\n`);
const args = process.argv.slice(2);
const version = process.env.FAKE_OPENCODE_VERSION ?? "2.3.0";

if (args.includes("--version")) {
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

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const authed = req.headers.authorization === expected;
  log({ type: "request", method: req.method, path: url.pathname, authed });
  if (!authed) return json(res, 401, { error: "unauthorized" });
  if (url.pathname === "/api/info") return json(res, 200, { version, pid: process.pid, urls: [`http://${hostname}:${server.address().port}`] });
  if (url.pathname === "/api/event") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "evt_1", created: Date.now(), type: "server.connected", data: {} })}\n\n`);
    const beat = setInterval(() => res.write(": heartbeat\n\n"), 1000);
    return res.on("close", () => clearInterval(beat));
  }
  return json(res, 404, { name: "NotFoundError", message: `no route ${req.method} ${url.pathname}` });
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
