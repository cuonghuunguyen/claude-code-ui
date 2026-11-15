import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const panel = (page: Page) => page.getByTestId("changes-panel");
const dialog = (page: Page) => page.getByTestId("rollback-dialog");
const hunks = (page: Page) => panel(page).getByTestId("hunk-rollback");
const lines = (n: number, edit: number[] = []) => Array.from({ length: n }, (_, i) => `line ${i + 1}${edit.includes(i + 1) ? " edited" : ""}\n`).join("");

Given("the scratch project has a committed 30-line file {string}", async ({ project }, name: string) => {
  writeFileSync(join(project.path, name), lines(30));
  git(project.path, "add", name);
  git(project.path, "commit", "-m", "add long");
});

Given("the scratch project has the edited file {string} and the new file {string}", async ({ project }, edited: string, added: string) => {
  writeFileSync(join(project.path, edited), "# Fixture\nedited\n");
  writeFileSync(join(project.path, added), "new\n");
});

When("I choose {string} in the menu of the Changes row {string}", async ({ page }, item: string, name: string) => {
  await panel(page).locator("li").filter({ has: page.locator(`[data-testid="commit-check"][data-path$="${name}"]`) }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: item, exact: true }).click();
});

When("I open the diff of {string} in the Changes tab", async ({ page }, name: string) => {
  await panel(page).locator("li").filter({ has: page.locator(`[data-testid="commit-check"][data-path$="${name}"]`) }).first().getByRole("button").first().click();
  await expect(hunks(page).first()).toBeVisible({ timeout: 30_000 });
});

Then("the Rollback dialog lists {string}", async ({ page }, names: string) => {
  const want = names.split(", ");
  await expect(dialog(page)).toBeVisible();
  const rows = page.getByTestId("rollback-file");
  await expect(rows).toHaveCount(want.length, { timeout: 30_000 });
  for (let i = 0; i < want.length; i++) await expect(rows.nth(i)).toContainText(want[i]!);
});

When("I confirm the Rollback dialog", async ({ page }) => {
  await page.getByTestId("rollback-confirm").click();
  await expect(dialog(page)).toBeHidden();
});

Then("the project file {string} holds {string}", async ({ project }, name: string, text: string) => {
  expect(readFileSync(join(project.path, name), "utf8")).toBe(text.replaceAll("\\n", "\n"));
});

Then("the project file {string} exists", async ({ project }, name: string) => {
  expect(existsSync(join(project.path, name))).toBe(true);
});

When("the project file {string} is overwritten with {string}", async ({ project }, name: string, text: string) => {
  writeFileSync(join(project.path, name), text.replaceAll("\\n", "\n"));
});
