import { expect } from "@playwright/test";
import { Then } from "./fixtures.ts";

Then("no title skeleton shows in the sidebar or the tab strip", async ({ page }) => {
  await expect(page.getByTestId("tab-strip")).toBeVisible();
  // Rows are listed from the restored transcript before the check: a skeleton would stay for good.
  await expect(page.getByTestId("title-skeleton")).toHaveCount(0, { timeout: 15_000 });
});
