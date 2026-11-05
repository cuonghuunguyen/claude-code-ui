import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const panel = (page: import("@playwright/test").Page) => page.getByTestId("changes-panel");

Given("the scratch project has the new files {string}", async ({ project }, names: string) => {
  appendFileSync(join(project.path, ".git", "info", "exclude"), ".claude/\n");
  for (const f of names.split(", ")) writeFileSync(join(project.path, f), `${f}\n`);
});

Given("the scratch project has a pre-commit hook that prints {string} and fails", async ({ project }, text: string) => {
  const hook = join(project.path, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\necho "${text}"\nexit 1\n`);
  chmodSync(hook, 0o755);
});

When("I check the file {string} in the Changes tab", async ({ page }, name: string) => {
  await panel(page).locator(`[data-testid="commit-check"][data-path$="${name}"]`).check();
});

When("I type the commit message {string}", async ({ page }, text: string) => {
  await page.getByTestId("commit-message").fill(text);
});

When("I click {string} in the commit box", async ({ page }, name: string) => {
  await page.getByTestId(name === "Commit and Push" ? "commit-and-push" : "commit-button").click();
});

Then("the Changes result line says {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("changes-op-result")).toContainText(text, { timeout: 60_000 });
});

Then("the Changes error shows {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("changes-op-error")).toContainText(text, { timeout: 60_000 });
});

Then("the Changes list still has the file {string}", async ({ page }, name: string) => {
  await expect(panel(page).locator(`[data-testid="commit-check"][data-path$="${name}"]`)).toBeVisible({ timeout: 30_000 });
});

Then("the Changes list no longer has the file {string}", async ({ page }, name: string) => {
  await expect(panel(page).locator(`[data-testid="commit-check"][data-path$="${name}"]`)).toHaveCount(0, { timeout: 30_000 });
});

Then("the last commit of the project holds only {string}", async ({ project }, name: string) => {
  expect(git(project.path, "show", "--name-only", "--format=", "HEAD").split("\n")).toEqual([name]);
});

Then("the project has no new commit", async ({ project }) => {
  expect(git(project.path, "rev-list", "--count", "origin/main..HEAD")).toBe("0");
});

Then("the commit box and its buttons are inside the viewport", async ({ page }) => {
  const vw = page.viewportSize()!.width;
  for (const id of ["commit-message", "commit-and-push", "commit-button"]) {
    const b = await page.getByTestId(id).boundingBox();
    expect(b, id).not.toBeNull();
    expect(b!.x).toBeGreaterThanOrEqual(0);
    expect(b!.x + b!.width).toBeLessThanOrEqual(vw + 0.5);
  }
});
