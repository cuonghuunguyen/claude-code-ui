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

Given("the scratch project has long.txt edited at lines 3 and 25", async ({ project }) => {
  writeFileSync(join(project.path, "long.txt"), lines(30, [3, 25]));
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

Then("the Rollback option {string} is off", async ({ page }, _o: string) => {
  await expect(page.getByTestId("rollback-delete-added")).not.toBeChecked();
});

When("I turn the Rollback option {string} on", async ({ page }, _o: string) => {
  await page.getByTestId("rollback-delete-added").check();
});

When("I confirm the Rollback dialog", async ({ page }) => {
  await page.getByTestId("rollback-confirm").click();
  await expect(dialog(page)).toBeHidden();
});

Then("no Rollback dialog is shown", async ({ page }) => {
  await expect(dialog(page)).toHaveCount(0);
});

Then("the project file {string} holds {string}", async ({ project }, name: string, text: string) => {
  expect(readFileSync(join(project.path, name), "utf8")).toBe(text.replaceAll("\\n", "\n"));
});

Then("the project file {string} exists", async ({ project }, name: string) => {
  expect(existsSync(join(project.path, name))).toBe(true);
});

Then("the project file {string} does not exist", async ({ project }, name: string) => {
  expect(existsSync(join(project.path, name))).toBe(false);
});

When("the project file {string} is overwritten with {string}", async ({ project }, name: string, text: string) => {
  writeFileSync(join(project.path, name), text.replaceAll("\\n", "\n"));
});

Then("the diff of {string} has {int} hunk Rollback buttons", async ({ page }, _name: string, n: number) => {
  await expect(hunks(page)).toHaveCount(n, { timeout: 30_000 });
});

When("I click the hunk Rollback button number {int}", async ({ page }, n: number) => {
  await hunks(page).nth(n - 1).click();
});

Then("the project file {string} has line {int} {string} and line {int} {string}", async ({ project }, name: string, a: number, ta: string, b: number, tb: string) => {
  const l = readFileSync(join(project.path, name), "utf8").split("\n");
  expect(l[a - 1]).toBe(ta);
  expect(l[b - 1]).toBe(tb);
});

Then("the Files editor has the text {string} and {string}", async ({ page }, a: string, b: string) => {
  const ed = page.getByTestId("files-panel").locator(".cm-content").first();
  await expect(ed).toContainText(a, { timeout: 30_000 });
  await expect(ed).toContainText(b);
});

Then("every hunk Rollback button is inside the viewport", async ({ page }) => {
  const vw = page.viewportSize()!.width;
  const n = await hunks(page).count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const b = await hunks(page).nth(i).boundingBox();
    expect(b).not.toBeNull();
    expect(b!.x).toBeGreaterThanOrEqual(0);
    expect(b!.x + b!.width).toBeLessThanOrEqual(vw + 0.5);
  }
});

Then("the Rollback dialog is inside the viewport", async ({ page }) => {
  const { width, height } = page.viewportSize()!;
  const b = await dialog(page).boundingBox();
  expect(b).not.toBeNull();
  expect(b!.x).toBeGreaterThanOrEqual(0);
  expect(b!.x + b!.width).toBeLessThanOrEqual(width + 0.5);
  expect(b!.y + b!.height).toBeLessThanOrEqual(height + 0.5);
});
