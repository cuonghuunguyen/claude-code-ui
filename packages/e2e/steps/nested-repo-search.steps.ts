import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { promptBox } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

const put = (repo: string, file: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), "x\n");
};
const tree = (page: Page) => page.getByTestId("file-tree");
const entry = (page: Page, rel: string) => tree(page).locator(`[data-testid="tree-entry"][data-path$="/${rel}"]`);

Given("the nested repository {string} has the file {string}", async ({ project }, name: string, file: string) => {
  const repo = join(project.path, name);
  put(repo, file);
  git(repo, "add", file);
  git(repo, "commit", "-m", `add ${file}`);
});

Given("the nested repository {string} ignores {string} and has the file {string}", async ({ project }, name: string, ignored: string, file: string) => {
  const repo = join(project.path, name);
  writeFileSync(join(repo, ".gitignore"), `${ignored}\n`);
  put(repo, file); // left untracked: the ignore rule hides it
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-m", "ignore");
});

When("I filter the Files tree by {string}", async ({ page }, text: string) => {
  await page.getByTestId("tree-filter").fill(text);
});

Then("the Files filter shows the file {string}", async ({ page }, rel: string) => {
  await expect(entry(page, rel).first()).toBeVisible({ timeout: 30_000 });
});

Then("the Files filter does not show the file {string}", async ({ page }, rel: string) => {
  // A hit for another file proves the search ran.
  await expect(tree(page).getByTestId("tree-entry").first()).toBeVisible({ timeout: 30_000 });
  await expect(entry(page, rel)).toHaveCount(0);
});

When("I type {string} in the prompt box", async ({ page }, text: string) => {
  await promptBox(page).click();
  await page.keyboard.type(text);
});

Then("the mention picker lists {string}", async ({ page }, path: string) => {
  await expect(page.getByTestId("mention-picker").getByRole("option", { name: `@${path}`, exact: true })).toBeVisible({ timeout: 30_000 });
});

When("I choose the mention {string}", async ({ page }, path: string) => {
  await page.getByTestId("mention-picker").getByRole("option", { name: `@${path}`, exact: true }).click();
  await expect(promptBox(page)).toContainText(`@${path}`);
});
