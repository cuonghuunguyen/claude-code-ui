// OpenCode keeps a request cut off during a folder's MCP load as the folder's state (GH-682): a request's timeout stops the caller waiting, it never aborts the request.
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createOpenCodeServer } from "../src/opencode-server.ts";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

it("a request that times out is left running: the caller gets a TimeoutError, the folder is not broken, a later read gets its answer", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocr-")));
  const logFile = join(root, "fake.log");
  const server = createOpenCodeServer({ path: () => "", command: [process.execPath, BIN], env: () => ({ FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_MCP_LOAD_MS: "1500" }) });
  cleanups.push(() => server.close());
  const cut = await server.request("/command", { directory: root, timeoutMs: 300 }).catch((err: Error) => err);
  expect(cut).toMatchObject({ name: "TimeoutError", message: expect.stringMatching(/GET \/command did not answer in 300 ms/) });
  // The fake breaks a folder whose waiting request is cut off (like OpenCode 1.19.5): this one is still waiting, so the read works.
  expect(await server.request<{ name: string }[]>("/command", { directory: root })).toEqual(expect.arrayContaining([expect.objectContaining({ name: "init" })]));
  expect(await server.request("/mcp", { directory: root })).toEqual({});
  const paths = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "request").map((l) => l.path);
  expect(paths.filter((p: string) => p === "/command")).toHaveLength(2);
}, 20_000);
