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

Then("the last commit of the project is {string}", async ({ project }, subject: string) => {
  await expect.poll(() => git(project.path, "log", "-1", "--format=%s"), { timeout: 30_000 }).toBe(subject);
});
