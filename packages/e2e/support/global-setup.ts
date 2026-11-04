import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./daemon.ts";
import { assertIsolated } from "./isolation.ts";
import { configHome, evidenceDir, runDir } from "./paths.ts";

export default function globalSetup() {
  const run = runDir();
  mkdirSync(configHome(run), { recursive: true });
  mkdirSync(evidenceDir(run), { recursive: true });
  assertIsolated(run);
  // For stopping a paused run: `npm run e2e:stop -- <run>` reads this file. A Git Bash `$!` is an MSYS PID, not a Windows one.
  writeFileSync(join(run, "runner.pid"), String(process.pid));
  console.log(`e2e run folder: ${run}`);
  console.log(`e2e evidence:   ${evidenceDir(run)}`);
  if (process.env.E2E_SKIP_BUILD === "1") return;
  // The daemon serves packages/web/dist; build it once per run.
  const res = spawnSync("npm run build -w @claude-ui/web", { cwd: REPO_ROOT, shell: true, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`web build failed:\n${res.stdout}\n${res.stderr}`);
  // The Side features (SSH, Docker, WSL) install the claude-ui package into a host: without packages/claude-ui/dist (cli.js, side/) the hub reports "no complete build" and offers no Install.
  // shortcut: only a missing dist is built; a stale one is the owner's to rebuild (npm run build), as for npm start.
  if (["cli.js", "side/cli.js"].some((f) => !existsSync(join(REPO_ROOT, "packages", "claude-ui", "dist", f)))) {
    const pkg = spawnSync("npm run build -w claude-code-ui", { cwd: REPO_ROOT, shell: true, encoding: "utf8" });
    if (pkg.status !== 0) throw new Error(`claude-ui package build failed:\n${pkg.stdout}\n${pkg.stderr}`);
  }
}
