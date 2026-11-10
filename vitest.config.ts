import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./packages/web/src", import.meta.url)) } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.{ts,tsx}"],
    setupFiles: ["vitest.env.ts", "packages/web/src/vitest.setup.ts"],
    // Default workers = all cores; with a second suite or other agents running, jsdom files starve and hit the 5 s default.
    // Windows: 10 workers on 20 cores (50%) saturated the machine in a full run together with the scoped runs of other agents: workers took 8 s on average to start
    // (one passed vitest's 90 s start limit), a worker exited with code 1 while starting, and plain `git init`/`git add` of test setups exited non-zero. 30% (6) does not.
    maxWorkers: process.platform === "win32" ? "30%" : "50%",
    // Windows starts a process several times slower: tests that spawn many git processes need more under a full suite.
    // Measured alone on Windows: git-heavy tests take 12-25 s (worktree-scan, git-repos 51 s); in the full suite, with every core busy, 3x that or more (up to 125 s seen).
    testTimeout: process.platform === "win32" ? 180_000 : 15_000,
    // The same for a beforeAll that builds a git repository (addons.test.ts: about ten git processes, 0.4-0.9 s each on Windows, over the 10 s default under load).
    hookTimeout: process.platform === "win32" ? 60_000 : 10_000,
  },
});
