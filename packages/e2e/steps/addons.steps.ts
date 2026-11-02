import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { REPO_ROOT } from "../support/daemon.ts";
import { promptBox } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

// GH-516 addons. The daemon of a run persists across scenarios (one worker): every Given is idempotent.
export const EXAMPLE = join(REPO_ROOT, "examples", "addons", "example");
const dialog = (page: Page): Locator => page.getByTestId("addons-dialog");
export const addonRow = (page: Page, name: string): Locator => page.locator(`[data-testid="addons-row"][data-name="${name}"]`);

/** `/addons` in the prompt box opens the dialog (a dialog command is never sent). */
export async function openAddons(page: Page): Promise<void> {
  if (await dialog(page).isVisible()) return;
  await promptBox(page).fill("/addons");
  await promptBox(page).press("Enter");
  await expect(dialog(page)).toBeVisible();
}
const closeAddons = async (page: Page) => {
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
};
async function installExample(page: Page): Promise<void> {
  await page.getByTestId("addons-source-local").click();
  await page.getByTestId("addons-path").fill(EXAMPLE);
  await page.getByTestId("addons-install").click();
  await expect(page.getByTestId("addons-approve-card")).toBeVisible();
}
const approve = async (page: Page) => page.getByTestId("addons-approve").first().click();

Given("the example addon is not installed", async ({ page }) => {
  await openAddons(page);
  if (await addonRow(page, "example").count()) {
    await addonRow(page, "example").getByTestId("addons-uninstall").click();
    await page.getByTestId("addons-remove").click();
    await expect(addonRow(page, "example")).toHaveCount(0);
  }
  await closeAddons(page);
});

/** Installs, approves and enables the example addon when it is not yet enabled; the dialog is closed after. */
Given("the example addon is installed and enabled", async ({ page }) => {
  await openAddons(page);
  const row = addonRow(page, "example");
  if (!(await row.count())) {
    await installExample(page);
    await approve(page);
  } else if ((await row.getByTestId("addons-state").innerText()) === "Needs approval") await approve(page);
  else if ((await row.getByTestId("addons-state").innerText()) !== "Enabled") await row.getByTestId("addons-enabled").click();
  await expect(row.getByTestId("addons-state")).toHaveText("Enabled");
  await closeAddons(page);
});

When("I open the Addons dialog", async ({ page }) => openAddons(page));

When("I install the addon from the local folder of the example addon", async ({ page }) => installExample(page));

Then("the approval card lists the capabilities of the example addon", async ({ page }) => {
  await expect(page.getByTestId("addons-approve-card").getByTestId("addons-capability")).toHaveCount(10);
});

When("I approve the addon", async ({ page }) => approve(page));

Then("the addon {string} is enabled", async ({ page }, name: string) => {
  const row = addonRow(page, name);
  await expect(row.getByTestId("addons-state")).toHaveText("Enabled");
  await expect(row.getByTestId("addons-enabled")).toHaveAttribute("aria-checked", "true");
});
