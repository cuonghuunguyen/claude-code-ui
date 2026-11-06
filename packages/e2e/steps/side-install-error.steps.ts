// GH-617, GH-618 acceptance: a failed side install. A fake `docker` CLI whose setup script says `CLAUDE_UI_SETUP install_failed <npm text>`. POSIX only.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { writeFakeDocker, type FakeDockerConfig } from "../support/fake-docker.ts";
import { runDir } from "../support/paths.ts";
import { After, Given, Then, When } from "./fixtures.ts";

const NPM = "npm ERR! code E403 npm ERR! 403 Forbidden - GET https://registry.example.com/claude-ui";
const COVERED = ["arch=x86_64", "libc=glibc", "glibc=2.36", "cxxrt=1", "foundnode=0", "credentials=1", "writable=/tmp", "tar=1", "gzip=1", "git=1", "npm=1", "installed=none"].map((l) => `CLAUDE_UI_CHECK ${l}\n`).join("");
const PROBE_FAILS = { code: 1, stdout: "", stderr: "probe not answered" };

let tmpRoot: string | undefined;

const config = (name: string, probe: FakeDockerConfig["probe"]): FakeDockerConfig => ({
  containers: [name],
  probe,
  check: { stdout: COVERED },
  setup: { code: 1, stdout: `CLAUDE_UI_SETUP install_failed ${NPM}\n` },
});

/** The shim sleeps in the check exec while <run>/slow exists, so the checking state stays visible. */
function slowCheck(bin: string) {
  const file = join(bin, "docker");
  const slow = join(runDir(), "slow");
  writeFileSync(file, readFileSync(file, "utf8").replace("*installed*) ", `*installed*) [ -f '${slow}' ] && sleep 8; `));
  return slow;
}

Given("a fake Docker container {string} whose install fails, with the cached projects {string} and {string}", async ({ daemon, $test }, name: string, a: string, b: string) => {
  $test.skip(process.platform === "win32", "the fake docker is a sh script");
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "claude-ui-e2e-install-")));
  const paths = [a, b].map((p) => join(tmpRoot!, p));
  for (const p of paths) mkdirSync(p, { recursive: true });
  // A side that never ran under this hub: its projects come from the cached list; another build key = the hub offers an update.
  writeFileSync(join(daemon.configDir, "side-lists.json"), JSON.stringify({ [`docker:${name}`]: { sessions: [], projects: paths, recentProjects: [] } }));
  writeFileSync(join(daemon.configDir, "sides.json"), JSON.stringify({ sides: [{ id: `docker:${name}`, key: "old" }] }));
  await daemon.restart({ pathPrefix: writeFakeDocker(runDir(), config(name, PROBE_FAILS)) });
});

Given("a fake Docker container {string} whose install fails and whose check is slow", async ({ daemon, $test }, name: string) => {
  $test.skip(process.platform === "win32", "the fake docker is a sh script");
  const bin = writeFakeDocker(runDir(), config(name, { code: 0, stdout: COVERED.split("\n").slice(0, 4).join("\n") + "\n", stderr: "" }));
  slowCheck(bin);
  rmSync(join(runDir(), "slow"), { force: true });
  await daemon.restart({ pathPrefix: bin });
});

const group = (page: Page, project: string) => page.getByTestId("session-group").filter({ has: page.locator(`[data-testid="group-toggle"][title$="${project}"]`) });
const openSidebar = async (page: Page) => {
  const opener = page.getByTestId("open-drawer");
  if (!(await opener.isVisible())) return;
  const covered = await opener.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && !e.contains(top);
  });
  if (!covered) await opener.click();
};

When("I press Update in the sidebar status of {string}", async ({ page }, project: string) => {
  await openSidebar(page);
  await group(page, project).getByTestId("sidebar-side-action").click({ timeout: 60_000 });
});

Then("the sidebar shows one install failed summary with one Retry under {string}", async ({ page }, project: string) => {
  await openSidebar(page);
  await expect(group(page, project).getByTestId("sidebar-side-status")).toContainText("Installing claude-ui in", { timeout: 120_000 });
  await expect(page.getByTestId("sidebar-side-status")).toHaveCount(1);
  await expect(page.getByTestId("sidebar-side-action")).toHaveCount(1);
  await expect(page.getByTestId("sidebar-side-action")).toHaveText("Retry");
  await expect(page.getByTestId("sidebar-side-status")).not.toContainText("npm ERR!");
});

Then("the sidebar has no side status under {string}", async ({ page }, project: string) => {
  await expect(group(page, project).getByTestId("sidebar-side-status")).toHaveCount(0);
});

// The auto start at hub start can still be running (Starting…, then the error): retry until the error and its open Details hold for a moment.
When("I open the Details of the sidebar status", async ({ page }) => {
  await expect(async () => {
    const toggle = page.getByTestId("session-list").getByRole("button", { name: "Details" });
    if ((await toggle.getAttribute("aria-expanded", { timeout: 2_000 })) !== "true") await toggle.click({ timeout: 2_000 });
    await expect(page.getByTestId("sidebar-side-details")).toBeVisible({ timeout: 1_000 });
    await page.waitForTimeout(1_000); // + the 500 ms of the capture step
    await expect(page.getByTestId("sidebar-side-details")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
});

When("I wait {int} seconds without a click", async ({ page }, n: number) => {
  // Records every text the status line shows from now on.
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] };
    w.__seen = [];
    const t0 = Date.now();
    const rec = () => w.__seen.push(`${Math.round((Date.now() - t0) / 1000)}s ` + (document.querySelector('[data-testid="sidebar-side-status"]')?.textContent ?? ""));
    new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, characterData: true });
    rec();
  });
  await page.waitForTimeout(n * 1000);
});

Then("the sidebar status never showed Starting and the Details are open", async ({ page }) => {
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  expect(seen.filter((t) => /Starting/.test(t)), JSON.stringify(seen)).toEqual([]);
  await expect(page.getByTestId("sidebar-side-details")).toBeVisible();
});

When("I press Retry in the sidebar status", async ({ page }) => {
  await page.evaluate(() => ((window as unknown as { __seen: string[] }).__seen = []));
  await page.getByTestId("sidebar-side-action").click();
});

Then("the error is back with the Details open after the Retry", async ({ page }) => {
  await expect(page.getByTestId("sidebar-side-details")).toContainText("403 Forbidden", { timeout: 60_000 });
  await expect(page.getByTestId("sidebar-side-status")).toContainText("Installing claude-ui in");
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  // The fake fails at once, so Starting… may be too short to see: the hold on the open Details is the check.
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("sidebar-side-details")).toBeVisible();
  console.log("retry seen: " + JSON.stringify(seen));
});

Then("the Details show the npm text", async ({ page }) => {
  await expect(page.getByTestId("sidebar-side-details")).toContainText("403 Forbidden");
  await expect(page.getByTestId("sidebar-side-status")).toHaveCount(1);
});

Then("the side panel shows the install error with one primary {string} and {string}", async ({ page }, primary: string, again: string) => {
  await expect(page.getByTestId("side-error")).toContainText("Installing claude-ui in", { timeout: 120_000 });
  const buttons = page.getByTestId("side-status").getByRole("button");
  await expect(page.getByTestId("side-retry")).toHaveText(primary);
  await expect(page.getByTestId("side-check-again")).toHaveText(again);
  await expect(page.getByTestId("side-retry")).toHaveCount(1);
  // The Details toggle is a button too: the action row is the two others.
  await expect(buttons.filter({ hasNotText: "Details" })).toHaveCount(2);
  await expect(page.getByTestId("side-install")).toHaveCount(0);
  // A phone dialog scrolls: both buttons in the evidence.
  await page.getByTestId("side-check-again").scrollIntoViewIfNeeded();
});

When("I press Check again in the side panel", async ({ page }) => {
  writeFileSync(join(runDir(), "slow"), "");
  await page.getByTestId("side-check-again").click();
});

Then("the side panel shows a spinner and no buttons", async ({ page }) => {
  await expect(page.getByTestId("side-status").getByText(/^Checking /)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("side-status").getByRole("button").filter({ hasNotText: "Details" })).toHaveCount(0);
});

After(async ({ daemon }) => {
  rmSync(join(runDir(), "slow"), { force: true });
  // The cached side must not leak into the next scenario (the daemon outlives it).
  if (tmpRoot) {
    rmSync(join(daemon.configDir, "side-lists.json"), { force: true });
    rmSync(join(daemon.configDir, "sides.json"), { force: true });
    await daemon.restart();
  }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});
