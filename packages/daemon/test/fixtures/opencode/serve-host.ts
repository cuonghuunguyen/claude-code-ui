// A stand-in daemon for opencode-server.test.ts: starts the OpenCode server on the fake binary, prints "up", then waits to be killed.
import { fileURLToPath } from "node:url";
import { createOpenCodeServer } from "../../../src/opencode-server.ts";

const server = createOpenCodeServer({ path: () => "", command: [process.execPath, fileURLToPath(new URL("./fake-opencode-bin.mjs", import.meta.url))] });
await server.ensure();
console.log("up");
setInterval(() => {}, 1e9);
