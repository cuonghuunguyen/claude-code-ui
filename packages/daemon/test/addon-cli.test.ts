import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, expect, it } from "vitest";
import type { AddonInfo } from "@claude-ui/protocol";
import { parseCli, type Cli } from "../src/cli.ts";
import { request } from "../src/ctl/connect.ts";
import { runClient } from "../src/ctl/commands.ts";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const token = "t0ken-for-addon-cli-tests_abcdefghijklmnopqrstuvwxyz";
const dir = tmp("cu-acfg-");
writeFileSync(join(dir, "token"), token + "\n", { mode: 0o600 });
const webRoot = tmp("cu-aweb-");
const daemon = createDaemon({ webRoot, roots: [webRoot], query: fakeQuery as never, token, uploadDir: join(tmp("cu-aup-"), "u"), addonsDir: join(tmp("cu-aadd-"), "addons") });
await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
const port = (daemon.address() as AddressInfo).port;
afterAll(() => void daemon.close());

function run(argv: string[]) {
  const cli = parseCli(argv, {}, "/h") as Extract<Cli, { kind: "client" }>;
  const out: string[] = [];
  const err: string[] = [];
  return runClient(cli, { env: { PORT: String(port) }, dir, stdout: (s) => out.push(s), stderr: (s) => err.push(s), openUrl: async () => {} }).then((code) => ({ code, out: out.join(""), err: err.join("") }));
}
const folder = (name: string, extra: object = {}) => {
  const d = tmp("cu-addon-");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "addon.json"), JSON.stringify({ name, version: "1", ...extra }));
  return d;
};
const list = async () => (await request<{ addons: AddonInfo[] }>(port, token, { type: "addons.list" })).addons;

it("addon dev installs a local folder in Dev mode and enables it when it needs no approval; a second run reuses it", async () => {
  const d = folder("dev-theme");
  const first = await run(["addon", "dev", d]);
  expect(first).toMatchObject({ code: 0 });
  expect(first.out).toContain("dev-theme: watching the folder");
  // The URL of the preview page, without the token (the browser is paired already).
  expect(first.out).toContain(`preview: http://127.0.0.1:${port}/#/addon-preview`);
  expect(first.out).not.toContain("token");
  expect(await list()).toMatchObject([{ name: "dev-theme", state: "enabled", dev: true }]);
  expect((await run(["addon", "dev", d, "--json"])).out).toContain('"state": "enabled"');
  expect((await run(["addon", "dev", d, "--json"])).out).toContain(`"preview": "http://127.0.0.1:${port}/#/addon-preview"`);
  expect((await list()).length).toBe(1);
});

it("an addon with capabilities is installed in Dev mode but left for approval; a taken name of another folder is exit 1", async () => {
  const d = folder("dev-cap", { capabilities: ["ui.toast"] });
  const r = await run(["addon", "dev", d]);
  expect(r.out).toContain("approve its capabilities");
  expect((await list()).find((a) => a.name === "dev-cap")).toMatchObject({ state: "needs_approval", dev: true });
  const other = await run(["addon", "dev", folder("dev-cap")]);
  expect(other.code).toBe(1);
  expect(other.err).toContain("already installed");
});
