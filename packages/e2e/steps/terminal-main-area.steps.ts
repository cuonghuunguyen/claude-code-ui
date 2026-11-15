
import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";
const view = (page: Page) => page.locator('[data-testid="terminal-view"]:visible').first();

When("I type {string} in the terminal", async ({ page }, cmd: string) => {
  await expect(view(page).locator(".xterm")).toBeVisible({ timeout: 30_000 });
  await view(page).locator(".xterm").click();
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await expect(view(page).locator(".xterm-rows")).toContainText(cmd.replace(/^echo /, ""), { timeout: 15_000 });
});

Then("the terminal shows {string}", async ({ page }, text: string) => {
  await expect(view(page).locator(".xterm-rows")).toContainText(text);
});

Then("the terminal shows {string} on a line of its own", async ({ page }, text: string) => {
  await expect(view(page).locator(".xterm-rows > div").filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) })).toHaveCount(1);
});
