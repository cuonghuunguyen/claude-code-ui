import { defineConfig } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";
import { runDir } from "./support/paths.ts";

// Sets E2E_RUN_DIR once in the runner; the workers re-evaluate this file and inherit it.
runDir();

const testDir = defineBddConfig({ features: "features/*.feature", steps: ["steps/*.ts"] });

export default defineConfig({
  testDir,
  globalSetup: "./support/global-setup.ts",
  globalTeardown: "./support/global-teardown.ts",
  // One daemon, one subscription login. --workers=2 works (a daemon per worker) but is not the default.
  workers: 1,
  fullyParallel: false,
  retries: 1,
  // Real turns on Windows are slow: generous per-scenario timeout, explicit longer waits on turns.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
