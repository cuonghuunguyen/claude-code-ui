import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { REPO_ROOT } from "./daemon.ts";
import { assertIsolated } from "./isolation.ts";
import { configHome, evidenceDir, runDir } from "./paths.ts";

export default function globalSetup() {
  const run = runDir();
  mkdirSync(configHome(run), { recursive: true });
  mkdirSync(evidenceDir(run), { recursive: true });
  assertIsolated(run);
  console.log(`e2e run folder: ${run}`);
  console.log(`e2e evidence:   ${evidenceDir(run)}`);
  if (process.env.E2E_SKIP_BUILD === "1") return;
  // The daemon serves packages/web/dist; build it once per run.
  const res = spawnSync("npm run build -w @claude-ui/web", { cwd: REPO_ROOT, shell: true, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`web build failed:\n${res.stdout}\n${res.stderr}`);
}
