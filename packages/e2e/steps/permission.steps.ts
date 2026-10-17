import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { TURN_MS, lastToolCard } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

When("I allow the permission request", async ({ page }) => {
  await page.getByTestId("permission-panel").getByRole("button", { name: "Allow once" }).click({ timeout: TURN_MS });
});

When("I deny the permission request", async ({ page }) => {
  await page.getByTestId("permission-panel").getByRole("button", { name: "Deny" }).click({ timeout: TURN_MS });
});

Then("I see a permission request", async ({ page }) => {
  await expect(page.getByTestId("permission-panel")).toBeVisible({ timeout: TURN_MS });
});

Then("the permission request is gone", async ({ page }) => {
  await expect(page.getByTestId("permission-panel")).toBeHidden();
});

Then("the tool call ended {string}", async ({ page }, status: string) => {
  await expect(lastToolCard(page)).toHaveAttribute("data-status", status, { timeout: TURN_MS });
});

Then("the tool call is running", async ({ page }) => {
  await expect(lastToolCard(page)).toHaveAttribute("data-status", "running", { timeout: TURN_MS });
});

Then("the file {string} exists in the project", async ({ project }, name: string) => {
  await expect.poll(() => existsSync(join(project.path, name)), { timeout: 15_000 }).toBe(true);
});

Then("the file {string} does not exist in the project", async ({ project }, name: string) => {
  expect(existsSync(join(project.path, name))).toBe(false);
});
