// GH-458 acceptance: saved Docker sides come back with the hub. A fake `docker` CLI (support/fake-docker.ts) whose setup exec runs a real
// side process (`main.ts --side`) under <run>/side-home; the side's project lives in tmp, outside the daemon's roots and home. POSIX only.
// Written, not run in GH-458. Everything stays in the run folder or in a tmp folder of its own (never the owner's config or cache).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { REPO_ROOT } from "../support/daemon.ts";
import { writeFakeDocker, type FakeDockerConfig } from "../support/fake-docker.ts";
import { openApp } from "../support/flow.ts";
import { runDir } from "../support/paths.ts";
import { waitConnected } from "../support/ui.ts";
import { After, Given, Then, When } from "./fixtures.ts";

type Fake = { name: string; listed: boolean; mode: "side" | "fails" | "not_installed"; project: string; home: string; log: string };
let fake: Fake | undefined;

const probeFails = { code: 1, stdout: "", stderr: "probe not answered" };
function configOf(f: Fake): FakeDockerConfig {
  return {
    containers: f.listed ? [f.name] : [],
    probe: probeFails,
    check: { stdout: "CLAUDE_UI_CHECK installed=none\n" },
    setup: f.mode === "fails" ? { code: 1, stdout: "CLAUDE_UI_SETUP node_missing\n" } : { code: 3, stdout: "CLAUDE_UI_SETUP not_installed\n" },
    log: f.log,
    ...(f.mode === "side" && { side: { home: f.home, repo: REPO_ROOT, projects: join(f.project, "..") } }),
  };
}
/** Rewrites the shim (it is read on every call) and returns its folder. */
const write = () => writeFakeDocker(runDir(), configOf(fake!));
const sideFile = (daemon: { configDir: string }) => join(daemon.configDir, "sides.json");
const logLines = () => (existsSync(fake!.log) ? readFileSync(fake!.log, "utf8").split("\n").filter(Boolean) : []);
const setups = () => logLines().filter((l) => l === "setup").length;
const sidePid = () => Number(readFileSync(join(fake!.home, "side.pid"), "utf8"));
const killSide = () => {
  try {
    process.kill(sidePid(), "SIGKILL");
  } catch {
    // Already gone.
  }
};
const group = (page: Page, project: string) => page.getByTestId("session-group").filter({ has: page.locator(`[data-testid="group-toggle"][title$="${project}"]`) });
const status = (page: Page, project: string) => group(page, project).getByTestId("sidebar-side-status");
const openSidebar = async (page: Page) => {
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
};

/** A container "dev" listed by the fake docker, a side saved for it, and the project the side lists. */
function setUp(name: string, project: string, mode: Fake["mode"], saved: { key?: string; update?: false }) {
  const run = runDir();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-ui-e2e-side-")));
  const path = join(root, project);
  const home = join(run, `side-home-${name}`);
  mkdirSync(path, { recursive: true });
  // The side's own project list (its config dir), so the project is in its list at once.
  mkdirSync(join(home, ".config", "claude-ui"), { recursive: true });
  writeFileSync(join(home, ".config", "claude-ui", "projects.json"), JSON.stringify({ opened: { [path]: Date.now() }, removed: {}, seeded: true }));
  fake = { name, listed: true, mode, project: path, home, log: join(run, "fake-docker.log") };
  writeFileSync(fake.log, "");
  return saved;
}

Given("a fake Docker container {string} that runs a claude-ui side with the project {string}", async ({ daemon, $test }, name: string, project: string) => {
  $test.skip(process.platform === "win32", "the fake docker is a sh script");
  // `update: false`: the side starts with setup never whatever the build key is (a saved side of this very build).
  const saved = setUp(name, project, "side", { update: false });
  writeFileSync(sideFile(daemon), JSON.stringify({ sides: [{ id: `docker:${name}`, ...saved, update: false }] }));
  await daemon.restart({ pathPrefix: write() });
});

Given("a fake Docker container {string} saved by an older claude-ui whose bundle is not usable", async ({ daemon, $test }, name: string) => {
  $test.skip(process.platform === "win32", "the fake docker is a sh script");
  setUp(name, "older", "not_installed", {});
  // The side never ran under this hub: its project comes from the cached list (what an earlier run left).
  writeFileSync(join(daemon.configDir, "side-lists.json"), JSON.stringify({ [`docker:${name}`]: { sessions: [], projects: [fake!.project], recentProjects: [] } }));
  // Another build key and no `update: false`: the hub updates it from the bundle only; the probe fails, so nothing is installed.
  writeFileSync(sideFile(daemon), JSON.stringify({ sides: [{ id: `docker:${name}`, key: "old" }] }));
  await daemon.restart({ pathPrefix: write() });
});

When("I open the app", async ({ page, daemon }) => {
  await openApp(page, daemon);
});

When("I restart the daemon with the fake Docker", async ({ daemon, page }) => {
  const lost = expect(page.getByTestId("connection-status").first()).not.toHaveText(/^\s*connected\s*$/, { timeout: 30_000 });
  const [restarted, seen] = await Promise.allSettled([daemon.restart({ pathPrefix: write() }), lost]);
  if (restarted.status === "rejected") throw restarted.reason;
  if (seen.status === "rejected") throw seen.reason;
  await waitConnected(page);
});

When("I kill the side process of {string}", async ({}, _name: string) => {
  killSide();
});

When("the container {string} stops", async ({}, _name: string) => {
  fake!.listed = false;
  write();
  killSide();
});

When("the container {string} runs again", async ({}, _name: string) => {
  fake!.listed = true;
  write();
});

When("the container {string} cannot start its side any more", async ({}, _name: string) => {
  fake!.mode = "fails";
  write();
});

When("I turn {string} for {string} in Settings", async ({ page }, state: string, name: string) => {
  await openSidebar(page);
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-sides").click();
  const sw = page.getByTestId(`settings-side-start-docker:${name}`);
  const want = state === "on";
  if ((await sw.getAttribute("aria-checked")) !== String(want)) await sw.click();
  await expect(page.getByTestId(`settings-side-start-docker:${name}`)).toHaveAttribute("aria-checked", String(want));
});

When("I open Settings › Sides", async ({ page }) => {
  await openSidebar(page);
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-sides").click();
  await expect(page.getByTestId("settings-sides")).toBeVisible();
});

Then("the side {string} is ready within {int} seconds", async ({ page }, _name: string, seconds: number) => {
  await openSidebar(page);
  const g = group(page, basename(fake!.project));
  await expect(g).toBeVisible({ timeout: seconds * 1000 });
  await expect(status(page, basename(fake!.project))).toHaveCount(0, { timeout: seconds * 1000 });
});

Then("the sidebar shows the project {string} of {string} as starting or failed", async ({ page }, project: string, _name: string) => {
  await openSidebar(page);
  await expect(group(page, project)).toBeVisible({ timeout: 60_000 });
  await expect(status(page, project)).toBeVisible({ timeout: 60_000 });
});

Then("the sidebar shows {string} for the project {string}", async ({ page }, text: string, project: string) => {
  await openSidebar(page);
  await expect(status(page, project)).toContainText(text, { timeout: 60_000 });
});

Then("the sidebar row of {string} says it needs an update with an Update action", async ({ page }, project: string) => {
  await openSidebar(page);
  await expect(status(page, project)).toContainText("Needs an update", { timeout: 120_000 });
  await expect(group(page, project).getByTestId("sidebar-side-action")).toHaveText("Update");
});

Then("the sidebar shows the project {string} with a Retry action", async ({ page }, project: string) => {
  await openSidebar(page);
  await expect(group(page, project).getByTestId("sidebar-side-action")).toHaveText("Retry", { timeout: 120_000 });
});

Then("the project {string} is not in the sidebar", async ({ page }, project: string) => {
  await openSidebar(page);
  // Settled: the side row of Settings says what the hub does now; the list was fetched after the restart.
  await expect(group(page, project)).toHaveCount(0, { timeout: 30_000 });
});

Then("the side {string} was not started again for {int} seconds", async ({}, _name: string, seconds: number) => {
  const before = setups();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  expect(setups()).toBe(before);
});

Then("the fake Docker log has no docker cp", async () => {
  expect(logLines()).not.toContain("cp");
});

Then("the Settings row of {string} says Start with Claude UI is {string}", async ({ page }, name: string, state: string) => {
  await expect(page.getByTestId(`settings-side-start-docker:${name}`)).toHaveAttribute("aria-checked", state === "on" ? "true" : "false");
});

// The worker's daemon outlives the scenario: its fake side process and the side's project go.
After(async () => {
  if (!fake) return;
  killSide();
  rmSync(join(fake.project, ".."), { recursive: true, force: true });
  fake = undefined;
});
