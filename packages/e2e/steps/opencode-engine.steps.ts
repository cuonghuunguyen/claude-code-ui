import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { freePort, ownerPorts, startDaemon, type Daemon } from "../support/daemon.ts";
import { openApp, openProject } from "../support/flow.ts";
import { fakeModelConfig, startFakeModel, type FakeModel } from "../support/fake-model.ts";
import { opencodeEnv, openCodeInfoFile } from "../support/opencode.ts";
import { configHome, runDir } from "../support/paths.ts";
import { openSettings } from "../support/ui.ts";
import { After, Given, When } from "./fixtures.ts";

/** The scenario's own daemon: OpenCode's data dir is inside the run folder. */
let own: Daemon | undefined;
const BIN = () => process.env.E2E_OPENCODE_BIN ?? "";

const chip = (page: Page) => page.getByTestId("engine-chip");

/** The OpenCode config of a scenario that needs an MCP server or a fake model (the run's config home is shared by its OpenCode scenarios: removed after). */
const slowConfig = () => join(configHome(runDir()), "opencode", "opencode.json");

Given("OpenCode is set up in a scratch project", async ({ page, project, $test, $testInfo }) => {
  $test.skip(!BIN(), "E2E_OPENCODE_BIN is not set: point it at a real opencode binary (1.18 or newer) to run the OpenCode engine scenarios");
  await setUp(page, project, $testInfo.workerIndex, BIN());
});

/** OpenCode 2 (ADR 0015) on a local fake model (support/fake-model.ts): no login, no provider. The run's OpenCode config names the model; removed after. */
let model: FakeModel | undefined;
Given("OpenCode 2 is set up in a scratch project with a local fake model", async ({ page, project, $test, $testInfo }) => {
  const bin = process.env.E2E_OPENCODE2_BIN ?? "";
  $test.skip(!bin, "E2E_OPENCODE2_BIN is not set: point it at a real OpenCode 2 binary (2.3.0 or newer) to run the OpenCode 2 scenarios");
  model = await startFakeModel();
  mkdirSync(dirname(slowConfig()), { recursive: true });
  writeFileSync(slowConfig(), JSON.stringify(fakeModelConfig(model.port), null, 2));
  await setUp(page, project, $testInfo.workerIndex, bin);
});

After({ name: "stop the fake model" }, async () => {
  if (!model) return;
  rmSync(slowConfig(), { force: true });
  await model.stop();
  model = undefined;
});

async function setUp(page: Page, project: { path: string; name: string }, worker: number, bin: string): Promise<void> {
  const run = runDir();
  mkdirSync(join(run, "opencode-data"), { recursive: true });
  // The run's OpenCode state is shared by its scenarios: a server stopped with an earlier scenario's daemon can leave its lock (a folder with a
  // heartbeat), and the next server waits about a minute for it to go stale. No OpenCode of this run is running here.
  rmSync(join(run, "opencode-state", "opencode", "locks"), { recursive: true, force: true });
  const port = await freePort(ownerPorts(), "");
  // The info file of an earlier scenario on this port names a server that is gone.
  rmSync(openCodeInfoFile(run, port), { force: true });
  own = await startDaemon(run, 2000 + worker, { port, env: opencodeEnv(run, port) });
  await openApp(page, own);
  // The binary path is a Settings value, set like a user does.
  await setOpenCodePath(page, bin);
  await expect(page.getByTestId("settings-opencode-status")).toContainText(/OpenCode \S+ · /);
  await page.keyboard.press("Escape");
  await openProject(page, project.path);
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  const projectChip = page.getByTestId("project-chip");
  await expect(async () => {
    if ((await projectChip.textContent())?.includes(project.name)) return;
    await projectChip.click();
    await page.getByRole("option", { name: project.name }).click({ timeout: 2_000 });
    await expect(projectChip).toContainText(project.name, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
}

async function setOpenCodePath(page: Page, path: string): Promise<void> {
  await openSettings(page);
  await page.getByTestId("settings-group-opencode").click();
  await expect(page.getByTestId("settings-opencode")).toBeVisible();
  const input = page.getByTestId("settings-opencode-path");
  await input.fill(path);
  await input.press("Enter");
  await expect(input).toHaveValue(path);
}

// The titlebar button, or on a phone the one inside the drawer (opened first, closed after).
When("I switch the theme mode to {string}", async ({ page }, mode: string) => {
  const drawer = page.getByTestId("open-drawer");
  const phone = await drawer.isVisible();
  if (phone) await drawer.click();
  const button = page.getByTestId(phone ? "drawer-theme" : "theme-toggle");
  for (let i = 0; i < 3 && !(await button.getAttribute("aria-label"))?.startsWith(`Theme: ${mode} `); i++) await button.click();
  await expect(button).toHaveAttribute("aria-label", new RegExp(`^Theme: ${mode} `));
  // The drawer closes on a tap of the overlay beside it.
  if (phone) await page.mouse.click(page.viewportSize()!.width - 5, 400);
  if (phone) await expect(page.getByTestId("sidebar")).not.toBeInViewport();
});

When("I choose the engine {string}", async ({ page }, name: string) => {
  await chip(page).click();
  await page.getByRole("option", { name }).click();
  await expect(chip(page)).toContainText(name);
});

After({ name: "remove the slow MCP config" }, async () => {
  rmSync(slowConfig(), { force: true });
});

After({ name: "stop the OpenCode scenario daemon" }, async () => {
  await own?.stop();
  own = undefined;
});
