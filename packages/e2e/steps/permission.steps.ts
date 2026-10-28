import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { TOOL_STATUS, TURN_MS, toolCard } from "../support/ui.ts";
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

Then("the {string} tool call is {word}", async ({ page }, text: string, outcome: string) => {
  const status = TOOL_STATUS[outcome];
  if (!status) throw new Error(`unknown tool call outcome "${outcome}"; use one of ${Object.keys(TOOL_STATUS).join(", ")}`);
  await expect(toolCard(page, text)).toHaveAttribute("data-status", status, { timeout: TURN_MS });
});


Then("the file {string} exists in the project", async ({ project }, name: string) => {
  await expect.poll(() => existsSync(join(project.path, name)), { timeout: 15_000 }).toBe(true);
});

Then("the file {string} does not exist in the project", async ({ project }, name: string) => {
  expect(existsSync(join(project.path, name))).toBe(false);
});

Then("I see a question request", async ({ page }) => {
  await expect(page.getByTestId("question-panel")).toBeVisible({ timeout: TURN_MS });
});
