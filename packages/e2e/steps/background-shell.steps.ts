import { expect } from "@playwright/test";
import { TURN_MS, toolCard } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

const button = (page: Parameters<typeof toolCard>[0], text: string) => toolCard(page, text).getByTestId("run-in-background");
const shells = (page: Parameters<typeof toolCard>[0]) => page.locator('[data-field="shells"]');

// The CLI registers the foreground task after about 3 s: the button shows then, not before.
When("I click Run in background on the {string} tool card", async ({ page, memo }, text: string) => {
  const b = button(page, text);
  await expect(b).toBeVisible({ timeout: 30_000 });
  memo.texts = await page.getByTestId("assistant-text").count();
  await b.click();
});

When("the Run in background button shows on the {string} tool card", async ({ page, memo }, text: string) => {
  await expect(button(page, text)).toBeVisible({ timeout: 30_000 });
  memo.texts = await page.getByTestId("assistant-text").count();
});

Then("the Run in background button is at least 44 px on the {string} tool card", async ({ page }, text: string) => {
  const box = await button(page, text).boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

When("I note the reply count", async ({ page, memo }) => {
  memo.texts = await page.getByTestId("assistant-text").count();
});

Then("the status bar shows {string}", async ({ page }, text: string) => {
  await expect(shells(page)).toContainText(text, { timeout: 15_000 });
});

Then("the status bar shows no shells", async ({ page }) => {
  await expect(shells(page)).toHaveCount(0, { timeout: 60_000 });
});

Then("Claude replies after the shell ended", async ({ page, memo }) => {
  await expect.poll(() => page.getByTestId("assistant-text").count(), { timeout: TURN_MS }).toBeGreaterThan(memo.texts ?? 0);
});

// Absent means absent after the registration delay too, so wait past it first.
Then("the {string} tool card has no Run in background button", async ({ page }, text: string) => {
  await expect(toolCard(page, text)).toBeVisible();
  await page.waitForTimeout(6_000);
  await expect(button(page, text)).toHaveCount(0);
});

Then("the {string} tool card has no Run in background button right away", async ({ page }, text: string) => {
  await expect(button(page, text)).toHaveCount(0);
});
