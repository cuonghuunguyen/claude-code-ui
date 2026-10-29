// Docker side acceptance (GH-448): a fake `docker` CLI on the daemon's PATH, no real Docker. POSIX only (the shim is a sh script).
import { expect } from "@playwright/test";
import { runDir } from "../support/paths.ts";
import { writeFakeDocker, type FakeDockerConfig } from "../support/fake-docker.ts";
import { openApp } from "../support/flow.ts";
import { After, Given, Then, When } from "./fixtures.ts";

// A target the bundle covers, as the check script prints it.
const COVERED = ["arch=x86_64", "libc=glibc", "glibc=2.36", "cxxrt=1", "foundnode=0", "credentials=1", "writable=/tmp", "installed=none"].map((l) => `CLAUDE_UI_CHECK ${l}\n`).join("");
const PROBE_OK = COVERED.split("\n").slice(0, 4).join("\n") + "\n";

const config = (name: string, probe: FakeDockerConfig["probe"]): FakeDockerConfig => ({
  containers: [name],
  probe,
  check: { stdout: COVERED },
  // The npm path runs the setup script: it fails here (nothing is installed in a fake container), after the reason was shown.
  setup: { code: 1, stdout: "CLAUDE_UI_SETUP node_missing\n" },
});

async function startWith(daemon: { restart(o?: { pathPrefix?: string }): Promise<void> }, c: FakeDockerConfig) {
  await daemon.restart({ pathPrefix: writeFakeDocker(runDir(), c) });
}

Given("a fake Docker container {string} whose target probe fails with {string}", async ({ daemon, $test }, name: string, stderr: string) => {
  $test.skip(process.platform === "win32", "the fake docker is a sh script");
  await startWith(daemon, config(name, { code: 1, stdout: "", stderr }));
});

Given("a fake Docker container {string} on x86_64 glibc 2.36 with an empty part cache", async ({ daemon, $test }, name: string) => {
  $test.skip(process.platform === "win32", "the fake docker is a sh script");
  // The daemon's cache is <run>/cache (daemonEnv); a restart keeps it, so earlier scenarios could have filled it: nothing here fills it.
  await startWith(daemon, config(name, { code: 0, stdout: PROBE_OK, stderr: "" }));
});

When("I open the Docker container {string} from Open project", async ({ page, daemon }, name: string) => {
  await openApp(page, daemon);
  // A phone shows the sidebar as a drawer.
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await page.getByTestId("open-project").click();
  await expect(page.getByTestId("open-project-dialog")).toBeVisible();
  await page.getByTestId("side-kind").filter({ hasText: /docker/i }).click();
  await page.getByTestId("container-row").filter({ hasText: name }).click();
});

When("I click Install in the side panel", async ({ page }) => {
  // The check runs by itself once the container is chosen; Install appears when it says the side can be installed.
  await page.getByTestId("side-install").click({ timeout: 60_000 });
});

Then("the side panel says the install uses npm because the container did not answer the target probe", async ({ page }) => {
  const reason = page.locator('[data-testid="side-error"], [data-testid="side-fallback"]').first();
  await expect(reason).toContainText("did not answer the target probe", { timeout: 120_000 });
});

Then("the container row says the bundle needs the host to download the parts", async ({ page }) => {
  const row = page.getByTestId("side-check-row").filter({ hasText: "bundle" });
  await expect(row).toContainText("if the host can download the parts", { timeout: 60_000 });
});

// The worker's daemon outlives the scenario: take the fake docker off its PATH again.
After(async ({ daemon }) => {
  if (daemon.pathPrefix) await daemon.restart();
});
