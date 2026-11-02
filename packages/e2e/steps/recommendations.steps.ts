import { expect } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

Then("the modal shows the Jira hint", async ({ page }) => {
  await expect(page.getByTestId("rec-jira")).toBeVisible();
});

Then("the modal shows no Jira hint", async ({ page }) => {
  await expect(page.getByTestId("create-worktree-sources")).toBeVisible(); // the modal finished rendering
  await expect(page.getByTestId("rec-jira")).toHaveCount(0);
});

When("I click the Connect Jira hint", async ({ page }) => {
  await page.getByTestId("rec-jira-connect").click();
});

Then("Settings › Jira is open", async ({ page }) => {
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await expect(page.getByTestId("settings-jira")).toBeVisible();
});

When("I turn off Show recommendations", async ({ page }) => {
  await page.getByTestId("settings-recommendations").click();
});

Then("Show recommendations is off", async ({ page }) => {
  await expect(page.getByTestId("settings-recommendations")).toHaveAttribute("aria-checked", "false");
});
