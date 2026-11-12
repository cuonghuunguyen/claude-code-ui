import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
const win = process.platform === "win32";
// Windows starts a process several times slower: tests that spawn many git processes need more under a full suite (files that need more than this say so themselves).
const testTimeout = win ? 60_000 : 15_000;
const shared = {
  setupFiles: ["vitest.env.ts", "packages/web/src/vitest.setup.ts"],
  testTimeout,
};
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./packages/web/src", import.meta.url)) } },
  test: {
    // Default workers = all cores; with a second suite or other agents running, jsdom files starve and hit the 5 s default.
    // VITEST_MAX_WORKERS (a count or a percentage) overrides it, e.g. on a machine that fails to start processes under load.
    maxWorkers: process.env.VITEST_MAX_WORKERS ?? "50%",
    // One run-scoped temp root for everything the tests create, removed at the end.
    globalSetup: ["vitest.global.ts"],
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
