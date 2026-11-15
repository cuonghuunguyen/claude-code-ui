import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const banner = (page: import("@playwright/test").Page) => page.getByTestId("conflict-banner");
const commitFile = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
};

/** `branch` and main both add `file` with different text. */
Given("the scratch project has the branch {string} that conflicts with main on {string}", async ({ project }, branch: string, file: string) => {
  appendFileSync(join(project.path, ".git", "info", "exclude"), ".claude/\n");
  git(project.path, "checkout", "-q", "main");
  git(project.path, "checkout", "-q", "-b", branch);
  commitFile(project.path, file, `${branch}\n`, `${branch} adds ${file}`);
  git(project.path, "checkout", "-q", "main");
  commitFile(project.path, file, "main\n", `main adds ${file}`);
});

When("I pick the branch menu item {string} and confirm its dialog", async ({ page }, item: string) => {
  await page.getByTestId(`branch-${item}`).click();
  await expect(page.getByTestId(`git-${item}-dialog`)).toBeVisible();
  await page.getByTestId(`git-${item}-confirm`).click();
});

When("I reload the Changes tab from disk", async ({ page }) => {
  await page.getByTestId("changes-panel").getByRole("button", { name: "Reload from disk" }).first().click();
});

Then("the conflict banner says {string} and lists {string}", async ({ page }, title: string, file: string) => {
  await expect(banner(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("conflict-title")).toHaveText(title);
  await expect(page.getByTestId("conflict-files")).toContainText(file);
});

Then("the conflict banner is not shown", async ({ page }) => {
  await expect(page.getByTestId("changes-panel")).toBeVisible();
  await expect(banner(page)).toHaveCount(0, { timeout: 30_000 });
});

Then("the commit box is not shown", async ({ page }) => {
  await expect(page.getByTestId("commit-box")).toHaveCount(0);
});

Then("the conflict banner and its buttons are inside the viewport", async ({ page }) => {
  const vw = page.viewportSize()!.width;
  for (const id of ["conflict-banner", "conflict-abort", "conflict-continue"]) {
    const b = await page.getByTestId(id).boundingBox();
    expect(b, id).not.toBeNull();
    expect(b!.x).toBeGreaterThanOrEqual(0);
    expect(b!.x + b!.width).toBeLessThanOrEqual(vw + 0.5);
  }
});

When("I click {string} in the conflict banner", async ({ page }, name: string) => {
  const id = { Continue: "conflict-continue", "Mark resolved": "conflict-continue", Abort: "conflict-abort", "Resolve with Claude": "conflict-resolve" }[name];
  await page.getByTestId(id!).click();
});

When("I resolve {string} on disk", async ({ project }, file: string) => {
  writeFileSync(join(project.path, file), "both\n");
});

Then("the project has a merge in progress", async ({ project }) => {
  git(project.path, "rev-parse", "-q", "--verify", "MERGE_HEAD");
});

Then("the last commit of the project is a merge of {string}", async ({ project }, branch: string) => {
  await expect.poll(() => git(project.path, "log", "-1", "--format=%P").split(" ").length, { timeout: 30_000 }).toBe(2);
  expect(git(project.path, "merge-base", "--is-ancestor", branch, "HEAD") === "").toBe(true);
});

Then("the file {string} has the text {string}", async ({ project }, file: string, text: string) => {
  await expect.poll(() => readFileSync(join(project.path, file), "utf8"), { timeout: 30_000 }).toBe(`${text}\n`);
});

Then("the project has {int} stash entry/entries", async ({ project }, n: number) => {
  expect(git(project.path, "stash", "list").split("\n").filter(Boolean)).toHaveLength(n);
});
