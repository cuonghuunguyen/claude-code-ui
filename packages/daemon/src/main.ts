import { homedir } from "node:os";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { createPush } from "./push.ts";
import { createDaemon } from "./server.ts";
import { loadToken, pairingUrl } from "./token.ts";

const HOST = "127.0.0.1";
const port = Number(process.env.PORT ?? 4280);
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
const token = loadToken();
// Allowlisted roots, separated like PATH. Default: the home directory.
const roots = (process.env.CLAUDE_UI_ROOTS ?? homedir()).split(delimiter).filter(Boolean);

createDaemon({ webRoot, token, roots, push: createPush() }).listen(port, HOST, async () => {
  const url = pairingUrl(HOST, port, token);
  // The pairing URL is the one place the token is printed; keep it out of every other log line.
  console.log(`claude-ui daemon on http://${HOST}:${port}, roots: ${roots.join(delimiter)}\nPair a browser: open ${url}\n${await QRCode.toString(url, { type: "terminal", small: true })}`);
});
