// A tree kill for `gitRunnerConfig.killCommand` that is as slow as the test wants: it kills the tree only after `release()`
// (at most 20 s later), marking `killed()` right before. Tests tell "the call waited for the kill" from "it did not" by `killed()`.
// The kill is the product's own (taskkill /T on Windows, where git.exe is a wrapper that starts the real git as its child; a group SIGKILL elsewhere).
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = `const fs = require("fs");
const { spawnSync } = require("child_process");
const [pid, go, started, done] = process.argv.slice(1);
const t0 = Date.now();
const tick = () => {
  if (!fs.existsSync(go) && Date.now() - t0 < 20000) return void setTimeout(tick, 20);
  fs.writeFileSync(started, "");
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { windowsHide: true });
    else process.kill(-Number(pid), "SIGKILL");
  } catch {}
  fs.writeFileSync(done, "");
};
tick();`;

export function slowKill() {
  const dir = mkdtempSync(join(tmpdir(), "slow-kill-"));
  const go = join(dir, "go");
  const started = join(dir, "started");
  const done = join(dir, "done");
  const release = () => writeFileSync(go, "");
  return {
    command: { file: process.execPath, args: ["-e", SCRIPT, "{pid}", go, started, done] },
    killed: () => existsSync(started),
    release,
    /** Releases the kill and waits until it ran, so no killer outlives the test. */
    async finish() {
      release();
      for (const t0 = Date.now(); !existsSync(done) && Date.now() - t0 < 30_000; ) await new Promise((r) => setTimeout(r, 20));
    },
  };
}
