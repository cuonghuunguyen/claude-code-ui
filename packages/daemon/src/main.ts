import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { HELP, parseCli } from "./cli.ts";
import { createProjects } from "./projects.ts";
import { createPush } from "./push.ts";
import { createDaemon } from "./server.ts";
import { configDir, loadToken, pairingUrl } from "./token.ts";

const HOST = "127.0.0.1";
const cli = parseCli(process.argv.slice(2), process.env, homedir());
if (cli.kind === "help") (console.log(HELP), process.exit(0));
if (cli.kind === "version") {
  // The package.json next to dist/ (installed) or src/ (source checkout, no version: "dev").
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "dev");
  process.exit(0);
}
if (cli.kind === "error") (console.error(`claude-ui: ${cli.message}\n\n${HELP}`), process.exit(1));
const { port, roots, hostname, allowBypass } = cli;
// The installed package ships the web build as dist/web beside this file; a source checkout builds packages/web/dist.
const bundledWeb = new URL("./web", import.meta.url);
const webRoot = fileURLToPath(existsSync(bundledWeb) ? bundledWeb : new URL("../../web/dist", import.meta.url));
const token = loadToken();

createDaemon({ webRoot, token, roots, push: createPush(), allowBypass, settingsFile: join(configDir(), "sessions.json"), projects: createProjects({ file: join(configDir(), "projects.json") }), hostnames: hostname ? [hostname] : [] }).listen(port, HOST, async () => {
  const url = pairingUrl(hostname ? `https://${hostname}` : `http://${HOST}:${port}`, token);
  // The pairing URL is the one place the token is printed; keep it out of every other log line.
  console.log(`claude-ui daemon on http://${HOST}:${port}, roots: ${roots.join(delimiter)}\nPair a browser: open ${url}\n${await QRCode.toString(url, { type: "terminal", small: true })}`);
});
