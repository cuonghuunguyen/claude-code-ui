// Test-only launcher (GH-164 acceptance): a daemon over a fake SDK where a prompt starting with `limit` hits a usage limit
// that resets in LIMIT_IN_S seconds (default 60). Never imported by production code.
// Start: PORT=4316 ROOT=<project dir> LIMIT_IN_S=60 npx tsx packages/daemon/test/limit-daemon.ts (after `npm run build`).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "../src/server.ts";
import { createProjects } from "../src/projects.ts";
import { pairingUrl } from "../src/token.ts";
import { limitQuery, limitState } from "./fake-query.ts";

const token = "gh164-acceptance-token_abcdefghijklmnopqrstu";
const port = Number(process.env.PORT ?? 4316);
const root = process.env.ROOT;
if (!root) throw new Error("set ROOT to a project directory");
limitState.inSeconds = Number(process.env.LIMIT_IN_S ?? 60);
const claudeDir = join(root, "..", "claude-dir");
mkdirSync(claudeDir, { recursive: true });
const http = createDaemon({ claudeDir, projects: createProjects(), webRoot: fileURLToPath(new URL("../../web/dist", import.meta.url)), token, roots: [root], query: limitQuery as never, idleCloseMs: 0 });
http.listen(port, "127.0.0.1", () => console.log(`limit daemon on ${pairingUrl(`http://127.0.0.1:${port}`, token)}`));
