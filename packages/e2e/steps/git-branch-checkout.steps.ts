import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

/** main holds a five-line `file`; `branch` changes its first line. */
Given("the scratch project has the branch {string} that edits the first line of {string}", async ({ project }, branch: string, file: string) => {
  appendFileSync(join(project.path, ".git", "info", "exclude"), ".claude/\n");
  const write = (first: string) => writeFileSync(join(project.path, file), `${first}\ntwo\nthree\nfour\nfive\n`);
  write("one");
  git(project.path, "add", file);
  git(project.path, "commit", "-q", "-m", `main adds ${file}`);
  git(project.path, "checkout", "-q", "-b", branch);
  write(branch);
  git(project.path, "commit", "-q", "-a", "-m", `${branch} edits ${file}`);
  git(project.path, "checkout", "-q", "main");
});

Given("the scratch project has the uncommitted text {string} in {string}", async ({ project }, text: string, file: string) => {
  writeFileSync(join(project.path, file), text.replace(/\\n/g, "\n"));
});

When("I open the branch menu on the commit row {string}", async ({ page }, subject: string) => {
  await page.getByTestId("graph-panel").getByTestId("commit-row").filter({ hasText: subject }).first().getByText(subject).click({ button: "right" });
  const menu = page.getByTestId("branch-menu");
  await expect(menu).toBeVisible({ timeout: 30_000 });
  await expect(menu.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 });
});

When("I create the branch {string} from the branch menu", async ({ page }, name: string) => {
  await page.getByTestId("branch-new").click();
  await expect(page.getByTestId("git-new-branch-checkout")).toBeChecked();
  await page.getByTestId("git-new-branch-name").fill(name);
  await page.getByTestId("git-new-branch-confirm").click();
});

When("I click the branch menu item {string}", async ({ page }, id: string) => {
  await page.getByTestId(id).click();
});

When("I confirm the Smart checkout dialog", async ({ page }) => {
  await expect(page.getByTestId("git-smart-checkout-dialog")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("git-smart-checkout-confirm").click();
});

Then("the Smart checkout dialog shows git's message about {string}", async ({ page }, file: string) => {
  const d = page.getByTestId("git-smart-checkout-dialog");
  await expect(d).toBeVisible({ timeout: 30_000 });
  await expect(d.getByTestId("git-smart-message")).toContainText(file);
});

Then("the project is on the branch {string}", async ({ project }, branch: string) => {
  await expect.poll(() => git(project.path, "symbolic-ref", "--short", "HEAD"), { timeout: 30_000 }).toBe(branch);
});

Then("the project branch {string} is at the commit {string}", async ({ project }, branch: string, subject: string) => {
  expect(git(project.path, "log", "-1", "--format=%s", branch)).toBe(subject);
});

Then("the project branch {string} tracks {string}", async ({ project }, branch: string, upstream: string) => {
  expect(git(project.path, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`)).toBe(upstream);
});

Then("the file {string} contains {string}", async ({ project }, file: string, text: string) => {
  await expect.poll(() => readFileSync(join(project.path, file), "utf8"), { timeout: 30_000 }).toContain(text);
});

When("I select the commit row {string}", async ({ page }, subject: string) => {
  await page.getByTestId("graph-panel").getByTestId("commit-row").filter({ hasText: subject }).first().getByText(subject).click();
  await expect(page.getByTestId("commit-details")).toContainText(subject, { timeout: 30_000 });
});

When("I open the branch menu on the chip {string} in the commit details", async ({ page }, ref: string) => {
  await page.getByTestId("commit-details").locator(`[data-testid="commit-ref"][data-ref="${ref}"]`).first().click({ button: "right" });
  const menu = page.getByTestId("branch-menu");
  await expect(menu).toBeVisible({ timeout: 30_000 });
  await expect(menu.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 });
});

Then("the branch menu offers a new branch from the short hash of {string}", async ({ page, project }, branch: string) => {
  await expect(page.getByTestId("branch-new")).toHaveText(`New branch from ${git(project.path, "rev-parse", branch).slice(0, 7)}…`);
});
