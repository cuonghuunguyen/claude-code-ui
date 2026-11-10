// A tree kill for `gitRunnerConfig.killCommand` that is as slow as the test wants: it kills the tree only after `release()`,
// marking `killed()` right before. Tests tell "the call waited for the kill" from "it did not" by `killed()`, and that the kill
// path ran at all by `invoked()` (the killer marks it when it starts).
// The kill is the product's own (taskkill /T on Windows, where git.exe is a wrapper that starts the real git as its child; a group SIGKILL elsewhere).
// A killer never released exits after 20 s without killing: a pid it would kill that late may belong to another process.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = `const fs = require("fs");
const { spawnSync } = require("child_process");
const [pid, invoked, go, started, done] = process.argv.slice(1);
fs.writeFileSync(invoked, "");
const t0 = Date.now();
const tick = () => {
  if (!fs.existsSync(go)) return void (Date.now() - t0 < 20000 ? setTimeout(tick, 20) : fs.writeFileSync(done, ""));
  fs.writeFileSync(started, "");
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { windowsHide: true });
    else process.kill(-Number(pid), "SIGKILL");
  } catch {}
  fs.writeFileSync(done, "");
};
tick();`;

const until = async (ok: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !ok() && Date.now() - t0 < ms; ) await new Promise((r) => setTimeout(r, 20));
  return ok();
};

export function slowKill() {
  const dir = mkdtempSync(join(tmpdir(), "slow-kill-"));
  const invoked = join(dir, "invoked");
  const go = join(dir, "go");
  const started = join(dir, "started");
  const done = join(dir, "done");
  const release = () => writeFileSync(go, "");
  return {
    command: { file: process.execPath, args: ["-e", SCRIPT, "{pid}", invoked, go, started, done] },
    killed: () => existsSync(started),
    /** True once the runner started the kill command (it starts a node process, so this follows the settle by some ms). */
    invoked: () => until(() => existsSync(invoked), 30_000),
    release,
    /** Releases a kill that was invoked and waits until it ran, so no killer outlives the test; without an invocation there is nothing to wait for. */
    async finish() {
      if (!existsSync(invoked)) return;
      release();
      await until(() => existsSync(done), 30_000);
    },
  };
}
