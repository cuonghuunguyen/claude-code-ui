
import { expect } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Then, When } from "./fixtures.ts";

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

Then("the project is on the branch {string}", async ({ project }, branch: string) => {
  await expect.poll(() => git(project.path, "symbolic-ref", "--short", "HEAD"), { timeout: 30_000 }).toBe(branch);
});

Then("the project branch {string} is at the commit {string}", async ({ project }, branch: string, subject: string) => {
  expect(git(project.path, "log", "-1", "--format=%s", branch)).toBe(subject);
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

Then("the branch menu offers a new branch from {string}", async ({ page }, branch: string) => {
  await expect(page.getByTestId("branch-new")).toHaveText(`New branch from ${branch}…`);
});
