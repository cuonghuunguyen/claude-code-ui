
import { expect } from "@playwright/test";
import { Then } from "./fixtures.ts";

Then("the page is exactly 390px wide", async ({ page }) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
