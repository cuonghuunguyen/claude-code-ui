import { expect, type Page } from "@playwright/test";
import { Then } from "./fixtures.ts";
const menu = (page: Page) => page.getByTestId("branch-menu");

// A closing menu stays in the DOM during its exit animation: wait for it before the next menu opens.
Then("the branch menu is closed", async ({ page }) => {
  await expect(menu(page)).toHaveCount(0);
});
