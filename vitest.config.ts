import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
const win = process.platform === "win32";
// Windows starts a process several times slower: tests that spawn many git processes need more under a full suite.
// Measured alone on Windows: git-heavy tests take 12-25 s (worktree-scan, git-repos 51 s); in the full suite, with every core busy, 3x that or more (up to 125 s seen).
const testTimeout = win ? 180_000 : 15_000;
// The same for a beforeAll that builds a git repository (addons.test.ts: about ten git processes, 0.4-0.9 s each on Windows, over the 10 s default under load).
const hookTimeout = win ? 60_000 : 10_000;
const shared = {
  setupFiles: ["vitest.env.ts", "packages/web/src/vitest.setup.ts"],
  testTimeout,
  hookTimeout,
};
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./packages/web/src", import.meta.url)) } },
  test: {
    // Default workers = all cores; with a second suite or other agents running, jsdom files starve and hit the 5 s default.
    maxWorkers: "50%",
    projects: [
      {
        extends: true,
        test: { ...shared, name: "node", include: ["packages/*/test/**/*.test.ts"] },
      },
      {
        extends: true,
        // The 223 web files (jsdom) run in worker threads, not one forked process each: on Windows a forked worker has to start within vitest's fixed 60 s, which a busy machine
        // missed for one web file in most full runs ("Failed to start forks worker ... Timeout waiting for worker to respond"; never a daemon file). Nothing in them needs a process of its own.
        test: { ...shared, name: "web", include: ["packages/*/src/**/*.test.{ts,tsx}"], pool: "threads" },
      },
    ],
  },
});
