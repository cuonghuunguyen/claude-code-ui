import { expect } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const dialog = (page: import("@playwright/test").Page) => page.getByTestId("git-new-tag-dialog").or(page.getByTestId("git-remove-tag-dialog"));
const originOf = (path: string) => git(path, "remote", "get-url", "origin");
const hasTag = (repo: string, name: string) => git(repo, "tag", "--list", name) === name;
const hasRemoteTag = (path: string, name: string) => git(originOf(path), "tag", "--list", name) === name;

Given("the scratch project has the tag {string} on origin and the tag {string} only locally", async ({ project }, pushed: string, local: string) => {
  git(project.path, "tag", pushed);
  git(project.path, "push", "-q", "origin", `refs/tags/${pushed}`);
  git(project.path, "tag", local);
});

When("I type the tag name {string}", async ({ page }, name: string) => {
  await page.getByTestId("git-new-tag-name").fill(name);
});

When("I type the tag message {string}", async ({ page }, message: string) => {
  await page.getByTestId("git-new-tag-message").fill(message);
});

Then("the tag dialog shows the command {string}", async ({ page }, text: string) => {
  await expect(dialog(page).getByTestId("git-command")).toContainText(text, { timeout: 30_000 });
});

When("I confirm the tag dialog", async ({ page }) => {
  await dialog(page).getByTestId(/^git-(new|remove)-tag-confirm$/).click();
  await expect(dialog(page)).toHaveCount(0);
});

When("I cancel the tag dialog", async ({ page }) => {
  await dialog(page).getByTestId(/^git-(new|remove)-tag-cancel$/).click();
  await expect(dialog(page)).toHaveCount(0);
});

Then("the tag {string} is a lightweight tag of the last commit", async ({ project }, name: string) => {
  expect(git(project.path, "cat-file", "-t", `refs/tags/${name}`)).toBe("commit");
  expect(git(project.path, "rev-parse", `refs/tags/${name}`)).toBe(git(project.path, "rev-parse", "HEAD"));
});

Then("the tag {string} is an annotated tag", async ({ project }, name: string) => {
  expect(git(project.path, "cat-file", "-t", `refs/tags/${name}`)).toBe("tag");
  expect(git(project.path, "tag", "-n1", "--list", name)).toContain("second release");
});

Then("the commit row {string} shows the tag chip {string}", async ({ page }, subject: string, tag: string) => {
  const row = page.getByTestId("graph-panel").getByTestId("commit-row").filter({ hasText: subject }).first();
  await expect(row.locator('[data-ref="refs/tags/' + tag + '"]')).toBeVisible({ timeout: 30_000 });
});

When("I open the context menu on the tag chip {string}", async ({ page }, tag: string) => {
  await page.getByTestId("graph-panel").locator(`[data-ref="refs/tags/${tag}"]`).first().click({ button: "right" });
  await expect(page.getByTestId("branch-menu")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tag-remove")).toBeVisible({ timeout: 30_000 });
});

When("I pick {string} in the tag chip menu", async ({ page }, name: string) => {
  expect(name).toBe("Remove Tag…");
  await page.getByTestId("tag-remove").click();
  await expect(page.getByTestId("git-remove-tag-dialog")).toBeVisible();
});

Then("the Remove Tag dialog has no remote option", async ({ page }) => {
  const d = page.getByTestId("git-remove-tag-dialog");
  // The remote check ends before the verdict: wait for its "Checking" text to go.
  await expect(d.getByText(/^Checking /)).toHaveCount(0, { timeout: 30_000 });
  await expect(d.locator('input[type="checkbox"]')).toHaveCount(0);
});

Then("the Remove Tag dialog offers {string} unchecked", async ({ page }, label: string) => {
  const box = page.getByTestId("git-remove-tag-dialog").getByLabel(label);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(box).not.toBeChecked();
});

When("I check {string} in the Remove Tag dialog", async ({ page }, label: string) => {
  await page.getByTestId("git-remove-tag-dialog").getByLabel(label).check();
});

Then("the project has no tag {string}", async ({ project }, name: string) => {
  expect(hasTag(project.path, name)).toBe(false);
});

Then("the origin has no tag {string}", async ({ project }, name: string) => {
  expect(hasRemoteTag(project.path, name)).toBe(false);
});

When("I start New Tag from the commit menu", async ({ page }) => {
  await page.getByTestId("tag-new").click();
  await expect(page.getByTestId("git-new-tag-dialog")).toBeVisible();
});

// The row's author column is hidden on a phone: right click the subject text.
When("I open the commit menu on the visible row {string}", async ({ page }, subject: string) => {
  await page.getByTestId("graph-panel").getByTestId("commit-row").filter({ hasText: subject }).first().locator("span.truncate", { hasText: subject }).first().click({ button: "right" });
  await expect(page.getByTestId("branch-menu")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tag-new")).toBeVisible({ timeout: 30_000 });
});

Then("the tag dialog command is shown whole", async ({ page }) => {
  const m = await dialog(page).getByTestId("git-command").evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, lines: el.textContent ?? "" }));
  expect(m.scroll).toBeLessThanOrEqual(m.client);
  expect(m.lines).toContain("git tag -d v1");
});
