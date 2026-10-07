import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./packages/web/src", import.meta.url)) } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.{ts,tsx}"],
    setupFiles: ["packages/web/src/vitest.setup.ts"],
    // Default workers = all cores; with a second suite or other agents running, jsdom files starve and hit the 5 s default.
    maxWorkers: "50%",
    testTimeout: 15_000,
  },
});
