import { expect } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const sw = (page: import("@playwright/test").Page) => page.getByTestId("settings-usageLimit-autoContinue");

When("I open Settings › Usage limits", async ({ page }) => {
  await page.locator('[data-testid="open-settings"]:visible').first().click();
  await page.getByTestId("settings-group-usageLimit").click();
  await expect(page.getByTestId("settings-usageLimit")).toBeVisible();
});

Then("the auto-continue switch is {word}", async ({ page }, state: string) => {
  await expect(sw(page)).toHaveAttribute("aria-checked", state === "on" ? "true" : "false");
});

When("I turn the auto-continue switch {word}", async ({ page }, state: string) => {
  const want = state === "on" ? "true" : "false";
  if ((await sw(page).getAttribute("aria-checked")) !== want) await sw(page).click();
  await expect(sw(page)).toHaveAttribute("aria-checked", want);
});
