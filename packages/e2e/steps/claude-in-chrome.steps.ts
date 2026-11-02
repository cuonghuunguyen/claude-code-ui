import { expect } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const sw = (page: import("@playwright/test").Page) => page.getByTestId("settings-chrome-enabled");

When("I open Settings › Claude in Chrome", async ({ page }) => {
  // A phone shows the sidebar, and its Settings button, in a drawer.
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-chrome").click();
  await expect(page.getByTestId("settings-chrome")).toBeVisible();
});

Then("the Claude in Chrome switch is {word}", async ({ page }, state: string) => {
  await expect(sw(page)).toHaveAttribute("aria-checked", state === "on" ? "true" : "false");
});

Then("the Claude in Chrome hint names the daemon's computer and the claude.ai account", async ({ page }) => {
  const hint = page.locator("#settings-chrome-enabled-hint");
  await expect(hint).toContainText("daemon");
  await expect(hint).toContainText("claude.ai");
});

When("I turn the Claude in Chrome switch {word}", async ({ page }, state: string) => {
  const want = state === "on" ? "true" : "false";
  if ((await sw(page).getAttribute("aria-checked")) !== want) await sw(page).click();
  await expect(sw(page)).toHaveAttribute("aria-checked", want);
});
