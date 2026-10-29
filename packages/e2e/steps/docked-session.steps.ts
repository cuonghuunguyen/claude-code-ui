import { expect, type Locator, type Page } from "@playwright/test";
import { TURN_MS } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

const panel = (page: Page, area: string) => page.getByTestId(`${area}-panel`);
const dockTabs = (page: Page) => page.locator("[data-docked-tab]");
const dockBody = (page: Page) => page.locator("[data-docked-session]:visible").first();
const dockPrompt = (page: Page) => dockBody(page).locator('textarea[aria-label="Prompt"]');
const mainPrompt = (page: Page) => page.getByTestId("session-area").locator('textarea[aria-label="Prompt"]:visible').first();
/** Session tabs of the strip: not the New session tab, not a pane tab. */
const stripSessions = (page: Page) => page.locator('[data-testid="tab-strip"] [data-testid="tab"]:not([data-tab-id="new"]):not([data-tab-id*=":"])');
let hash = "";

const type = async (box: Locator, text: string) => {
  await box.fill(text);
  await box.press("Enter");
};

When("I move the first session to the {string} panel from its tab menu", async ({ page }, area: string) => {
  await stripSessions(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: `Move to ${area} panel`, exact: true }).click();
});

Then("the tab strip has {int} session tab(s)", async ({ page }, n: number) => {
  await expect(stripSessions(page)).toHaveCount(n);
});

Then("the {string} panel has a selected session tab with a timeline and a prompt box", async ({ page }, area: string) => {
  await expect(panel(page, area).locator('[data-docked-tab][aria-selected="true"]')).toBeVisible();
  await expect(dockBody(page)).toBeVisible();
  await expect(dockPrompt(page)).toBeVisible();
});

Then("the {string} panel has a docked session tab", async ({ page }, area: string) => {
  await expect(panel(page, area).locator("[data-docked-tab]")).toHaveCount(1);
});

Then("no panel has a docked session tab", async ({ page }) => {
  await expect(dockTabs(page)).toHaveCount(0);
});

Then("the active session tab is not the docked session", async ({ page }) => {
  const docked = await dockTabs(page).first().getAttribute("data-docked-tab");
  const active = await page.locator('[data-testid="tab-strip"] [data-testid="tab"][data-active]').first().getAttribute("data-tab-id");
  expect(active).toBeTruthy();
  expect(active).not.toBe(docked);
});

When("I send {string} in the docked prompt box", async ({ page }, text: string) => {
  await dockTabs(page).first().click();
  await type(dockPrompt(page), text);
});

When("I send {string} in the main prompt box", async ({ page }, text: string) => {
  await type(mainPrompt(page), text);
});

Then("the docked session shows a reply", async ({ page }) => {
  await expect(dockBody(page).getByTestId("assistant-text").last()).toHaveText(/\S/, { timeout: TURN_MS });
});

Then("the docked turn has finished", async ({ page }) => {
  await expect(dockBody(page).locator('[data-testid="send"][data-state="idle"]')).toBeVisible({ timeout: TURN_MS });
});

Then("the main turn is still running", async ({ page }) => {
  await expect(page.getByTestId("session-area").getByTestId("toolbar-stop").first()).toBeVisible();
});

When("I press Escape in the docked prompt box", async ({ page }) => {
  await dockPrompt(page).focus();
  await page.keyboard.press("Escape");
});

When("I allow the permission request in the docked panel", async ({ page }) => {
  await dockBody(page).getByTestId("permission-panel").getByRole("button", { name: "Allow once" }).click({ timeout: TURN_MS });
});

When("I allow the permission request in the main area", async ({ page }) => {
  await page.getByTestId("session-area").getByTestId("permission-panel").getByRole("button", { name: "Allow once" }).click({ timeout: TURN_MS });
});

Then("the docked panel shows a permission request", async ({ page }) => {
  await expect(dockBody(page).getByTestId("permission-panel")).toBeVisible({ timeout: TURN_MS });
});

Then("the docked tab is marked {string}", async ({ page }, mark: string) => {
  await expect(dockTabs(page).first()).toContainText(mark);
});

When("I choose {string} in the docked tab menu", async ({ page }, label: string) => {
  await dockTabs(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: label, exact: true }).click();
});

When("I note the page hash", async ({ page }) => {
  hash = await page.evaluate(() => location.hash);
});

Then("the page hash is unchanged", async ({ page }) => {
  expect(await page.evaluate(() => location.hash)).toBe(hash);
});

When("I click a session in the sidebar that is docked", async ({ page }) => {
  const id = await dockTabs(page).first().getAttribute("data-docked-tab");
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await page.locator(`[data-testid="session-item"][data-session-id="${id}"]`).click();
});

Then("the tab bar lists {int} sessions", async ({ page }, n: number) => {
  // Wide-narrow (md and up): a tab each; a phone: the switcher's count.
  if (await page.getByTestId("tab-switcher").isVisible()) await expect(page.getByTestId("tab-switcher")).toContainText(String(n));
  else await expect(stripSessions(page)).toHaveCount(n);
});
