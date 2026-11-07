import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { freePort, ownerPorts, startDaemon, type Daemon } from "../support/daemon.ts";
import { openApp, openProject } from "../support/flow.ts";
import { createOpenCodeSession, opencodeEnv } from "../support/opencode.ts";
import { runDir } from "../support/paths.ts";
import { openSettings } from "../support/ui.ts";
import { After, Given, Then, When } from "./fixtures.ts";

/** The scenario's own daemon: OpenCode's data dir is inside the run folder. */
let own: Daemon | undefined;
const BIN = () => process.env.E2E_OPENCODE_BIN ?? "";

const chip = (page: Page) => page.getByTestId("engine-chip");
const sidebarRow = (page: Page, title?: string) => {
  const rows = page.getByTestId("session-item");
  return title ? rows.filter({ hasText: title }) : rows;
};
/** The tag in the session header: every tag that is not inside a sidebar row. */
const headerTag = (page: Page) => page.locator('[data-testid="engine-tag"]:not([data-testid="session-item"] *)');
/** A phone keeps the sidebar in a drawer. */
const openDrawer = async (page: Page) => {
  const drawer = page.getByTestId("open-drawer");
  if ((await drawer.isVisible()) && !(await page.getByTestId("sidebar").isVisible().then((v) => v && page.getByTestId("sidebar").evaluate((e) => e.getBoundingClientRect().right > 0)))) await drawer.click();
};

Given("OpenCode is set up in a scratch project", async ({ page, project, $test, $testInfo }) => {
  $test.skip(!BIN(), "E2E_OPENCODE_BIN is not set: point it at a real opencode binary (1.18 or newer) to run the OpenCode engine scenarios");
  const run = runDir();
  mkdirSync(join(run, "opencode-data"), { recursive: true });
  own = await startDaemon(run, 2000 + $testInfo.workerIndex, { port: await freePort(ownerPorts(), ""), env: opencodeEnv(run) });
  await openApp(page, own);
  // The binary path is a Settings value, set like a user does.
  await setOpenCodePath(page, BIN());
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
});

async function setOpenCodePath(page: Page, path: string): Promise<void> {
  await openSettings(page);
  await page.getByTestId("settings-group-opencode").click();
  await expect(page.getByTestId("settings-opencode")).toBeVisible();
  const input = page.getByTestId("settings-opencode-path");
  await input.fill(path);
  await input.press("Enter");
  await expect(input).toHaveValue(path);
}

Then("the engine selector is labelled {string}", async ({ page }, label: string) => {
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toHaveAttribute("aria-label", label);
  // A visible label, not only an accessible one: the word "Engine" is on screen.
  await expect(chip(page)).toContainText("Engine");
});

When("I open the engine selector", async ({ page }) => {
  await chip(page).click();
  await expect(page.getByTestId("engine-opencode")).toBeVisible();
});

When("I open the engine selector and pick {string} with the keyboard", async ({ page }, name: string) => {
  await chip(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name })).toBeVisible();
  for (let i = 0; i < 4 && (await page.getByRole("option", { name }).getAttribute("data-highlighted")) === null; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
});

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

When("I close the engine selector", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("engine-opencode")).toBeHidden();
});

When("I pick the engine {string} in the open selector", async ({ page }, name: string) => {
  await page.getByRole("option", { name }).click();
  await expect(chip(page)).toContainText(name);
});

When("I choose the engine {string}", async ({ page }, name: string) => {
  await chip(page).click();
  await page.getByRole("option", { name }).click();
  await expect(chip(page)).toContainText(name);
});

Then("the first prompt is refused with a message about a later version", async ({ page }) => {
  await expect(page.getByText(/later version/i).first()).toBeVisible({ timeout: 30_000 });
});

Then("the OpenCode session is tagged in its sidebar row", async ({ page }) => {
  await openDrawer(page);
  await expect(sidebarRow(page).first().getByTestId("engine-tag")).toHaveText("OpenCode");
  await expect(sidebarRow(page).first().getByTestId("engine-tag")).toBeVisible();
});

// The refused first prompt keeps the draft tab (the session exists and is listed); the header shows once the row is opened.
When("I open the first session row", async ({ page }) => {
  await openDrawer(page);
  await sidebarRow(page).first().click();
});

// Below sm the session header is not rendered (GH-165: the tab switcher says where the session is), so there is no header tag to see; recorded as an annotation, not skipped silently.
Then("the session header, where shown, has the tag {string}", async ({ page, $testInfo }, name: string) => {
  if (!(await page.getByTestId("session-header").isVisible())) return void $testInfo.annotations.push({ type: "no-header", description: "no session header at this width: the engine tag is not visible in the open session" });
  await expect(headerTag(page).first()).toHaveText(name);
  await expect(headerTag(page).first()).toBeVisible();
});

When("an OpenCode session {string} with the message {string} is created outside the app", async ({ project }, title: string, text: string) => {
  await createOpenCodeSession(BIN(), runDir(), project.path, title, text);
});

Then("the sidebar lists the OpenCode session {string} with the tag", async ({ page }, title: string) => {
  await openDrawer(page);
  const row = sidebarRow(page, title).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.getByTestId("engine-tag")).toHaveText("OpenCode");
});

When("I open the OpenCode session {string}", async ({ page }, title: string) => {
  await openDrawer(page);
  await sidebarRow(page, title).first().click();
});

Then("the conversation shows the user message {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("user-message").filter({ hasText: text })).toBeVisible({ timeout: 30_000 });
});

When("I set the OpenCode path setting to {string}", async ({ page }, path: string) => setOpenCodePath(page, path));

Then("the OpenCode status says it was not found", async ({ page }) => {
  await expect(page.getByTestId("settings-opencode-status")).toHaveText("Not found");
});

Then("the inline engine error offers {string}", async ({ page }, label: string) => {
  await expect(page.getByTestId("engine-error")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("engine-error-settings")).toHaveText(label);
});

When("I click the inline engine error button", async ({ page }) => {
  await page.getByTestId("engine-error-settings").click();
});

Then("Settings shows the OpenCode section", async ({ page }) => {
  await expect(page.getByTestId("settings-opencode")).toBeVisible();
  await expect(page.getByTestId("settings-opencode-path")).toBeVisible();
});

After({ name: "stop the OpenCode scenario daemon" }, async () => {
  await own?.stop();
  own = undefined;
});
