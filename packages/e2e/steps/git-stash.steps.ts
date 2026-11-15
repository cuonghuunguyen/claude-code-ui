import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

Given("the scratch project has the committed file {string} with the text {string}", async ({ project }, file: string, text: string) => {
  appendFileSync(join(project.path, ".git", "info", "exclude"), ".claude/\n");
  writeFileSync(join(project.path, file), `${text}\n`);
  git(project.path, "add", file);
  git(project.path, "commit", "-q", "-m", `add ${file}`);
});
When("I edit {string} on disk to {string}", async ({ project }, file: string, text: string) => {
  writeFileSync(join(project.path, file), `${text}\n`);
});

When("I open the Stashes section of the Graph", async ({ page }) => {
  const toggle = page.getByTestId("graph-stashes");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(page.getByTestId("stash-section")).toBeVisible();
});
When("I stash the changes with the message {string}", async ({ page }, message: string) => {
  await page.getByTestId("stash-push").click();
  await page.getByTestId("stash-message").fill(message);
  await page.getByTestId("git-stash-push-confirm").click();
});
const row = (page: import("@playwright/test").Page, message: string) => page.getByTestId("stash-row").filter({ hasText: message });
When("I click {string} on the stash {string}", async ({ page }, button: string, message: string) => {
  await row(page, message).getByTestId(`stash-${button.toLowerCase()}`).click();
});
Then("the stash {string} is listed", async ({ page }, message: string) => {
  await expect(row(page, message)).toHaveCount(1, { timeout: 30_000 });
});
Then("no stash is listed", async ({ page }) => {
  await expect(page.getByTestId("stash-section")).toContainText("No stashes", { timeout: 30_000 });
});
