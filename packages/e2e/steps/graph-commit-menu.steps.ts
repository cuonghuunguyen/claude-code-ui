import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const ITEMS = { "Undo Commit": "commit-undo", "Revert Commit": "commit-revert", "Cherry-Pick": "commit-cherry-pick", "Reset Current Branch to Here…": "commit-reset" } as const;
const item = (page: import("@playwright/test").Page, name: string) => page.getByTestId(ITEMS[name as keyof typeof ITEMS]);

Given("the scratch project's main has the local commit {string} that adds {string}", async ({ project }, subject: string, file: string) => {
  appendFileSync(join(project.path, ".git", "info", "exclude"), ".claude/\n");
  writeFileSync(join(project.path, file), "work\n");
  git(project.path, "add", file);
  git(project.path, "commit", "-q", "-m", subject);
});

Given("the scratch project has a merge commit of the branch {string}", async ({ project }, branch: string) => {
  appendFileSync(join(project.path, ".git", "info", "exclude"), ".claude/\n");
  git(project.path, "checkout", "-q", "-b", branch);
  writeFileSync(join(project.path, "side.txt"), "side\n");
  git(project.path, "add", "side.txt");
  git(project.path, "commit", "-q", "-m", `${branch} work`);
  git(project.path, "checkout", "-q", "main");
  writeFileSync(join(project.path, "main.txt"), "main\n");
  git(project.path, "add", "main.txt");
  git(project.path, "commit", "-q", "-m", "main work");
  git(project.path, "merge", "-q", "--no-ff", "-m", `Merge branch '${branch}'`, branch);
});

Given("the scratch project's main has the commit {string} that changes {string} and an uncommitted edit of it", async ({ project }, subject: string, file: string) => {
  appendFileSync(join(project.path, ".git", "info", "exclude"), ".claude/\n");
  writeFileSync(join(project.path, file), "second\n");
  git(project.path, "commit", "-q", "-am", subject);
  writeFileSync(join(project.path, file), "uncommitted\n");
});

When("I open the commit menu on the row {string}", async ({ page }, subject: string) => {
  await page.getByTestId("graph-panel").getByTestId("commit-row").filter({ hasText: subject }).first().locator("span.truncate").last().click({ button: "right" });
  const menu = page.getByTestId("branch-menu");
  await expect(menu).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("commit-menu-head")).toBeVisible();
  await expect(page.getByTestId("commit-revert")).toBeVisible({ timeout: 30_000 });
});

When("I pick {string} in the commit menu", async ({ page }, name: string) => {
  await item(page, name).click();
});

Then("the commit menu item {string} is enabled", async ({ page }, name: string) => {
  await expect(item(page, name)).not.toHaveAttribute("data-disabled", /.*/);
});

Then("the commit menu item {string} is disabled and says {string}", async ({ page }, name: string, text: string) => {
  await expect(item(page, name)).toHaveAttribute("data-disabled", /.*/);
  await expect(item(page, name)).toContainText(text);
});

Then("the last commit of the project is {string}", async ({ project }, subject: string) => {
  await expect.poll(() => git(project.path, "log", "-1", "--format=%s"), { timeout: 30_000 }).toBe(subject);
});

Then("the file {string} is staged", async ({ project }, file: string) => {
  expect(git(project.path, "diff", "--cached", "--name-only").split("\n")).toContain(file);
});

When("the project commits what is staged as {string} and pushes", async ({ project }, subject: string) => {
  git(project.path, "commit", "-q", "-m", subject);
  git(project.path, "push", "-q", "origin", "main");
});

When("I pick the reset mode {string}", async ({ page }, mode: string) => {
  await page.getByTestId(`git-reset-${mode}`).check();
});

Then("the reset dialog shows the command {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("git-reset-dialog").getByTestId("git-command")).toContainText(text, { timeout: 30_000 });
});

Then("the reset dialog lists the lost file {string}", async ({ page }, file: string) => {
  await expect(page.getByTestId("git-reset-lose")).toContainText(file, { timeout: 30_000 });
});

When("I overwrite {string} on disk with {string}", async ({ project }, file: string, text: string) => {
  writeFileSync(join(project.path, file), `${text}\n`);
});

When("I confirm the reset dialog", async ({ page }) => {
  await page.getByTestId("git-reset-confirm").click();
});

Then("the work tree of the project is clean", async ({ project }) => {
  expect(git(project.path, "status", "--porcelain")).toBe("");
});
