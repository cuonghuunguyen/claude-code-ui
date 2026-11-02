import { expect, type Locator, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const entry = (page: Page, rel: string): Locator => page.locator(`[data-testid="tree-entry"][data-path$="/${rel}"]`).first();
const bg = (row: Locator) => row.evaluate((e) => getComputedStyle(e).backgroundColor);

When("I click the tree row {string}", async ({ page }, rel: string) => void (await entry(page, rel).click()));

When("I move the pointer away from the tree", async ({ page }) => void (await page.mouse.move(700, 450, { steps: 5 })));

Then("the tree row {string} has the selected background", async ({ page }, rel: string) => {
  await expect.poll(() => bg(entry(page, rel))).not.toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);
});

Then("the tree row {string} has no selected background", async ({ page }, rel: string) => {
  await expect.poll(() => bg(entry(page, rel))).toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);
});
