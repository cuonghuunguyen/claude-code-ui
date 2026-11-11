// A request to an OpenCode server that died before the daemon saw its exit: the server restarts once and the request is answered.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createOpenCodeServer } from "../src/opencode-server.ts";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));

// On Windows the pid is gone before the sockets of the dead server close, so a pooled keep-alive connection still looks open: the request
// was written into it and met a reset after the connect (`fetch failed`, read ECONNRESET), which request() must not take for a delivered request.
it("a server that died with its connections still open is restarted by the next request, which is answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-"));
  const log = join(dir, "log.jsonl");
  const server = createOpenCodeServer({ path: () => "", command: [process.execPath, BIN], env: () => ({ FAKE_OPENCODE_LOG: log }) });
  try {
    const first = await server.ensure();
    await server.request("/session");
    // `connection: close`: the test's own connection must not stay in the shared pool.
    await fetch(`${first.url}/__zombie`, { method: "POST", headers: { connection: "close" } });
    expect(await server.request("/session")).toEqual([]);
    const starts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type === "start");
    expect(starts).toHaveLength(2);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
