import { expect } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

When("I press {string}", async ({ page }, key: string) => {
  await page.keyboard.press(key);
});

Then("the scrollWidth of the page is {int}", async ({ page }, w: number) => {
  const m = await page.evaluate(() => ({ root: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(m.root).toBe(w);
  expect(m.body).toBeLessThanOrEqual(w);
});
