import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "./daemon.ts";
import { assertIsolated } from "./isolation.ts";
import { evidenceDir, runDir } from "./paths.ts";

export default function globalTeardown() {
  const run = runDir();
  // Fallback when a worker died before its fixture teardown: kill any daemon PID still on disk.
  if (existsSync(run))
    for (const f of readdirSync(run).filter((n) => /^daemon-w\d+\.pid$/.test(n))) {
      const pid = Number(readFileSync(join(run, f), "utf8"));
      if (pid) killTree(pid);
      rmSync(join(run, f), { force: true });
    }
  assertIsolated(run);
  if (!existsSync(join(run, "ui-config", "claude-ui", "token"))) {
    throw new Error(`the daemon never wrote its config under ${run}/ui-config: it ran on another config dir`);
  }
  console.log(`e2e isolation: ok, nothing of ${run} in the real claude-ui config dirs`);
  // steps/fixtures.ts leaves a marker when a scenario failed (an attempt that a retry saved counts: the folder is kept for the log).
  const passed = !existsSync(join(run, "failed.marker"));
  if (!passed || process.env.E2E_KEEP) {
    console.log(`e2e run folder kept: ${run}`);
    return;
  }
  // The run passed: drop its scratch (config, projects, logs). Evidence stays when it lives inside the run folder.
  // Best effort: Windows may still hold a project folder for a moment after a process of the run ended (EBUSY); a leftover folder is not a failed run.
  const ev = evidenceDir(run);
  const inside = ev.startsWith(run);
  const drop = (path: string) => {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
    } catch (e) {
      console.warn(`e2e: could not remove ${path}: ${(e as Error).message}`);
    }
  };
  for (const name of existsSync(run) ? readdirSync(run) : []) {
    if (inside && join(run, name) === ev) continue;
    drop(join(run, name));
  }
  if (!inside) drop(run);
  console.log(`e2e run folder cleaned; evidence: ${ev}`);
}
