// dist/launcher.js, the package's `claude-ui` bin (launcher.ts); dist/cli.js beside it is this package's daemon.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launch } from "./launcher.ts";
import { versionsDir } from "./update.ts";

const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "dev";
process.exitCode = await launch({ args: process.argv.slice(2), own: { cli: fileURLToPath(new URL("./cli.js", import.meta.url)), version }, dir: versionsDir() });
