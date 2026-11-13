import { expect } from "@playwright/test";
import { Then } from "./fixtures.ts";

Then("no title skeleton shows in the sidebar or the tab strip", async ({ page }) => {
  await expect(page.getByTestId("tab-strip")).toBeVisible();
  // Guard for the restored path. The SDK title usually replaces the placeholder here; the placeholder case itself is proven by the unit test in optimistic.test.ts.
  await expect(page.getByTestId("title-skeleton")).toHaveCount(0, { timeout: 15_000 });
});
