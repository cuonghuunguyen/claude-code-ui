import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { REPO_ROOT } from "../support/daemon.ts";
import { pickPane, promptBox } from "../support/ui.ts";
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

/** The stylesheet link of an addon sets `--<name>-css: 1` on :root (theme.css of the example). */
const cssFlag = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(`--${n}-css`).trim(), name);

async function setAddonEnabled(page: Page, name: string, enabled: boolean): Promise<void> {
  await openAddons(page);
  const sw = addonRow(page, name).getByTestId("addons-enabled");
  if ((await sw.getAttribute("aria-checked")) !== String(enabled)) await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", String(enabled));
  await closeAddons(page);
}
When("I disable the addon {string}", async ({ page }, name: string) => setAddonEnabled(page, name, false));
When("I enable the addon {string}", async ({ page }, name: string) => setAddonEnabled(page, name, true));

Then("the addon stylesheet of {string} is applied", async ({ page }, name: string) => {
  await expect.poll(() => cssFlag(page, name)).toBe("1");
});
Then("the addon stylesheet of {string} is not applied", async ({ page }, name: string) => {
  await expect.poll(() => cssFlag(page, name)).toBe("");
});

const PANE_ID: Record<string, string> = { Stats: "addon:example:stats" };
const paneFrame = (page: Page) => page.frameLocator('[data-testid="addon-frame-example-pane"]');

When("I open the {string} addon pane in the side panel", async ({ page }, title: string) => {
  await pickPane(page, PANE_ID[title]!, page.getByTestId("side-panel"));
  await expect(page.getByTestId("addon-frame-example-pane")).toBeVisible();
});

Then("the addon pane shows the part counts of the session", async ({ page }) => {
  await expect(paneFrame(page).getByTestId("example-parts")).toHaveText(/\d+ parts/);
});

When("I click {string} in the addon pane", async ({ page }, label: string) => {
  await paneFrame(page).getByRole("button", { name: label, exact: true }).click();
});

Then("the status bar shows {string} status {string}", async ({ page }, addon: string, text: string) => {
  await expect(page.getByTestId(`addon-status-${addon}`)).toHaveText(text);
});

Then("the pane shows a refused error", async ({ page }) => {
  await expect(paneFrame(page).getByTestId("example-refused")).toContainText("Refused");
});

Then("the log of {string} lists {string}", async ({ page }, name: string, type: string) => {
  await expect(addonRow(page, name).getByTestId("addons-log")).toContainText(type);
});

Then("the pane switcher does not list {string}", async ({ page }, title: string) => {
  await expect(page.getByTestId("pane-session").first()).toBeAttached();
  await page.locator('[data-testid="pane-overflow"]:visible').first().click().catch(() => {});
  await expect(page.locator(`[data-testid="pane-${PANE_ID[title]}"]:visible`)).toHaveCount(0);
});

let userMessages = 0;
const userMessage = (page: Page) => page.locator('[data-testid="user-message"]:not([data-pending])');
When("I count the user messages", async ({ page }) => void (userMessages = await userMessage(page).count()));
Then("no new user message is shown", async ({ page }) => {
  await page.waitForTimeout(500);
  await expect(userMessage(page)).toHaveCount(userMessages);
});

const bandFrame = (page: Page) => page.getByTestId("addon-frame-example-band");
Then("the addon band of {string} is above the prompt box", async ({ page }) => {
  const band = bandFrame(page);
  await expect(band).toBeVisible();
  const [b, p] = [await band.boundingBox(), await promptBox(page).boundingBox()];
  expect(b!.y + b!.height).toBeLessThanOrEqual(p!.y);
});
Then("the band shows the turn count", async ({ page }) => {
  await expect(page.frameLocator('[data-testid="addon-frame-example-band"]').getByTestId("example-band")).toHaveText(/\d+ turns?/);
});

When("I type {string} in the prompt box", async ({ page }, text: string) => {
  await promptBox(page).fill(text);
});
Then("the command picker lists {string} with its description", async ({ page }, name: string) => {
  const row = page.getByRole("option").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Insert a sample prompt");
});
When("I run {string}", async ({ page }, text: string) => {
  await promptBox(page).fill(text);
  await promptBox(page).press("Enter");
});
Then("the prompt box contains {string}", async ({ page }, text: string) => {
  await expect(promptBox(page)).toHaveValue(text);
});
