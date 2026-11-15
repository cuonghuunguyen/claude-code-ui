import { expect } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

Then("the Graph shows the commit {string}", async ({ page }, subject: string) => {
  await expect(page.getByTestId("commit-row").filter({ hasText: subject }).first()).toBeVisible({ timeout: 30_000 });
});

When("I click Refresh in the Graph", async ({ page }) => {
  await page.getByTestId("graph-panel").getByRole("button", { name: "Refresh" }).click();
});
