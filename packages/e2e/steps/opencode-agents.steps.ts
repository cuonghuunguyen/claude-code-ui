
import { expect, type Page } from "@playwright/test";
import { When } from "./fixtures.ts";
const mode = (page: Page) => page.getByTestId("mode-select");
/** A phone keeps agent, mode and model behind one button: opens it (only when its popup is not open yet). */
const settingsOpen = async (page: Page) => {
  const s = page.getByTestId("session-settings");
  if ((await s.isVisible()) && !(await page.getByTestId("session-settings-popup").isVisible())) await s.click();
};

When("I pick the permission mode {string}", async ({ page }, name: string) => {
  await settingsOpen(page);
  await mode(page).click();
  await page.getByRole("option", { name }).click();
  await expect(mode(page)).toHaveAttribute("aria-label", /Permission mode/);
  await expect(mode(page)).toContainText(name);
});
