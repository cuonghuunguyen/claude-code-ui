import { expect } from "@playwright/test";
import { Then } from "./fixtures.ts";
const generate = (page: import("@playwright/test").Page) => page.getByTestId("commit-generate");

Then("the Generate button is inside the viewport and 44 px high", async ({ page }) => {
  const b = await generate(page).boundingBox();
  expect(b).not.toBeNull();
  expect(b!.x).toBeGreaterThanOrEqual(0);
  expect(b!.x + b!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  expect(b!.height).toBeGreaterThanOrEqual(44);
});
