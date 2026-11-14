import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const ITEMS = { "Compare with Local": "commit-compare", "Compare Before with Local": "commit-compare-before", "Edit Commit Message…": "commit-reword" } as const;
const item = (page: import("@playwright/test").Page, name: string) => page.getByTestId(ITEMS[name as keyof typeof ITEMS]);
const dialog = (page: import("@playwright/test").Page) => page.getByTestId("git-reword-dialog");
const subjects = (path: string) => git(path, "log", "--format=%s").split("\n");

Given("the scratch project's file {string} has an uncommitted edit", async ({ project }, file: string) => {
  appendFileSync(join(project.path, file), "edited in the work tree\n");
});

When("I pick {string} in the compare menu", async ({ page }, name: string) => {
  await item(page, name).click();
});

Then("the compare menu item {string} is disabled and says {string}", async ({ page }, name: string, text: string) => {
  await expect(item(page, name)).toHaveAttribute("data-disabled", /.*/, { timeout: 30_000 });
  await expect(item(page, name)).toContainText(text);
});

Then("the compare list shows the file {string}", async ({ page }, file: string) => {
  await expect(page.getByTestId("git-compare").getByTestId("compare-file").filter({ hasText: file }).first()).toBeVisible({ timeout: 30_000 });
});

When("I open the compare file {string}", async ({ page }, file: string) => {
  await page.getByTestId("git-compare").getByTestId("compare-file").filter({ hasText: file }).first().click();
});

Then("the compare diff is shown", async ({ page }) => {
  await expect(page.getByTestId("commit-file-diff")).toBeVisible({ timeout: 30_000 });
});

When("I go back from the compare file", async ({ page }) => {
  await page.getByTestId("commit-back").click();
});

When("I go back from the compare list", async ({ page }) => {
  await page.getByTestId("compare-back").click();
});

Then("the reword message is {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("git-reword-message")).toHaveValue(text, { timeout: 30_000 });
});

When("I type the reword message {string}", async ({ page }, text: string) => {
  const box = page.getByTestId("git-reword-message");
  await expect(box).toBeEnabled({ timeout: 30_000 });
  await box.fill(text);
});

Then("the reword dialog shows the command {string}", async ({ page }, text: string) => {
  await expect(dialog(page).getByTestId("git-command")).toContainText(text, { timeout: 30_000 });
});

Then("the reword dialog shows {int} commands", async ({ page }, n: number) => {
  const text = (await dialog(page).getByTestId("git-command").innerText()).trim();
  expect(text.split("\n")).toHaveLength(n);
});

When("I confirm the reword dialog", async ({ page }) => {
  await dialog(page).getByTestId("git-reword-confirm").click();
  await expect(dialog(page)).toHaveCount(0, { timeout: 60_000 });
});

Then("the commit row {string} exists", async ({ page }, subject: string) => {
  await expect(page.getByTestId("graph-panel").getByTestId("commit-row").filter({ hasText: subject }).first()).toBeVisible({ timeout: 30_000 });
});

Then("the project has no commit with the subject {string}", async ({ project }, text: string) => {
  expect(subjects(project.path).filter((s) => s.includes(text))).toEqual([]);
});

Then("the project's last two subjects are {string} and {string}", async ({ project }, last: string, before: string) => {
  expect(subjects(project.path).slice(0, 2)).toEqual([last, before]);
});
